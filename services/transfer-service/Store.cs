using Dapper;
using Npgsql;

namespace VijayBank.Transfers;

public sealed class Beneficiary
{
    public Guid Id { get; set; }
    public string CustomerId { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Nickname { get; set; }
    public string AccountNo { get; set; } = "";
    public string Ifsc { get; set; } = "";
    public string BankName { get; set; } = "";
    public string Type { get; set; } = "";
    public string Status { get; set; } = "";
    public string? OtpRef { get; set; }
    public DateTime? ActivatesAt { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class Transfer
{
    public Guid Id { get; set; }
    public string CustomerId { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public string Reference { get; set; } = "";
    public string Mode { get; set; } = "";
    public string FromAccount { get; set; } = "";
    public string ToAccount { get; set; } = "";
    public string ToIfsc { get; set; } = "";
    public Guid? BeneficiaryId { get; set; }
    public string BeneficiaryName { get; set; } = "";
    public long AmountPaise { get; set; }
    public string? Remarks { get; set; }
    public string Status { get; set; } = "";
    public string? FailureReason { get; set; }
    public int? FraudScore { get; set; }
    public string? FraudRules { get; set; }
    public string? OtpRef { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}

public sealed class Store(NpgsqlDataSource db)
{
    static Store() => DefaultTypeMap.MatchNamesWithUnderscores = true;

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS beneficiaries (
          id            UUID PRIMARY KEY,
          customer_id   VARCHAR(16) NOT NULL,
          name          VARCHAR(100) NOT NULL,
          nickname      VARCHAR(40),
          account_no    VARCHAR(20) NOT NULL,
          ifsc          VARCHAR(11) NOT NULL,
          bank_name     VARCHAR(60) NOT NULL,
          type          VARCHAR(10) NOT NULL,
          status        VARCHAR(12) NOT NULL,
          otp_ref       TEXT,
          activates_at  TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at    TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS beneficiaries_unique
          ON beneficiaries (customer_id, account_no, ifsc) WHERE deleted_at IS NULL AND status = 'ACTIVE';

        CREATE TABLE IF NOT EXISTS transfers (
          id                UUID PRIMARY KEY,
          customer_id       VARCHAR(16) NOT NULL,
          idempotency_key   VARCHAR(80) NOT NULL,
          reference         VARCHAR(24) NOT NULL UNIQUE,
          mode              VARCHAR(5) NOT NULL,
          from_account      VARCHAR(20) NOT NULL,
          to_account        VARCHAR(20) NOT NULL,
          to_ifsc           VARCHAR(11) NOT NULL,
          beneficiary_id    UUID,
          beneficiary_name  VARCHAR(100) NOT NULL,
          amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
          remarks           VARCHAR(60),
          status            VARCHAR(14) NOT NULL,
          failure_reason    VARCHAR(60),
          fraud_score       INT,
          fraud_rules       TEXT,
          otp_ref           TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at      TIMESTAMPTZ,
          UNIQUE (customer_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS transfers_customer_created ON transfers (customer_id, created_at DESC);
        """;

    public async Task Migrate()
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var conn = await db.OpenConnectionAsync();
                await conn.ExecuteAsync(Schema);
                return;
            }
            catch (NpgsqlException) when (attempt < 30)
            {
                await Task.Delay(2000);
            }
        }
    }

    public async Task<bool> Ping()
    {
        try
        {
            await using var conn = await db.OpenConnectionAsync();
            return await conn.ExecuteScalarAsync<int>("SELECT 1") == 1;
        }
        catch (NpgsqlException)
        {
            return false;
        }
    }

    // ---------------------------------------------------------------- beneficiaries

    public async Task<List<Beneficiary>> Beneficiaries(string customerId)
    {
        await using var conn = await db.OpenConnectionAsync();
        return (await conn.QueryAsync<Beneficiary>(
            "SELECT * FROM beneficiaries WHERE customer_id = @customerId AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name",
            new { customerId })).ToList();
    }

    public async Task<Beneficiary?> Beneficiary(Guid id, string customerId)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleOrDefaultAsync<Beneficiary>(
            "SELECT * FROM beneficiaries WHERE id = @id AND customer_id = @customerId AND deleted_at IS NULL",
            new { id, customerId });
    }

    public async Task<bool> HasActiveBeneficiary(string customerId, string accountNo, string ifsc)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<bool>("""
            SELECT EXISTS (SELECT 1 FROM beneficiaries WHERE customer_id = @customerId AND account_no = @accountNo
                           AND ifsc = @ifsc AND status = 'ACTIVE' AND deleted_at IS NULL)
            """, new { customerId, accountNo, ifsc });
    }

    public async Task InsertBeneficiary(Beneficiary b)
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteAsync("""
            INSERT INTO beneficiaries (id, customer_id, name, nickname, account_no, ifsc, bank_name, type, status, otp_ref, activates_at, created_at)
            VALUES (@Id, @CustomerId, @Name, @Nickname, @AccountNo, @Ifsc, @BankName, @Type, @Status, @OtpRef, @ActivatesAt, @CreatedAt)
            """, b);
    }

    public async Task<bool> ActivateBeneficiary(Guid id, DateTime activatesAt)
    {
        await using var conn = await db.OpenConnectionAsync();
        try
        {
            return await conn.ExecuteAsync(
                "UPDATE beneficiaries SET status = 'ACTIVE', otp_ref = NULL, activates_at = @activatesAt WHERE id = @id AND status = 'PENDING'",
                new { id, activatesAt }) == 1;
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new ApiException(409, "BENEFICIARY_EXISTS", "This beneficiary is already added.");
        }
    }

    public async Task<bool> DeleteBeneficiary(Guid id, string customerId)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteAsync(
            "UPDATE beneficiaries SET deleted_at = now() WHERE id = @id AND customer_id = @customerId AND deleted_at IS NULL",
            new { id, customerId }) == 1;
    }

    // ---------------------------------------------------------------- transfers

    public async Task<Transfer?> Transfer(Guid id, string customerId)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleOrDefaultAsync<Transfer>(
            "SELECT * FROM transfers WHERE id = @id AND customer_id = @customerId", new { id, customerId });
    }

    public async Task<Transfer?> TransferByKey(string customerId, string key)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleOrDefaultAsync<Transfer>(
            "SELECT * FROM transfers WHERE customer_id = @customerId AND idempotency_key = @key", new { customerId, key });
    }

    public async Task<List<Transfer>> Transfers(string customerId, int limit)
    {
        await using var conn = await db.OpenConnectionAsync();
        return (await conn.QueryAsync<Transfer>(
            "SELECT * FROM transfers WHERE customer_id = @customerId AND status <> 'OTP_REQUIRED' ORDER BY created_at DESC LIMIT @limit",
            new { customerId, limit })).ToList();
    }

    /// <summary>Inserts the transfer; returns false when the idempotency key was already used.</summary>
    public async Task<bool> InsertTransfer(Transfer t)
    {
        await using var conn = await db.OpenConnectionAsync();
        try
        {
            await conn.ExecuteAsync("""
                INSERT INTO transfers (id, customer_id, idempotency_key, reference, mode, from_account, to_account, to_ifsc,
                  beneficiary_id, beneficiary_name, amount_paise, remarks, status, otp_ref, created_at, updated_at)
                VALUES (@Id, @CustomerId, @IdempotencyKey, @Reference, @Mode, @FromAccount, @ToAccount, @ToIfsc,
                  @BeneficiaryId, @BeneficiaryName, @AmountPaise, @Remarks, @Status, @OtpRef, @CreatedAt, @UpdatedAt)
                """, t);
            return true;
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation && e.ConstraintName!.Contains("idempotency"))
        {
            return false;
        }
    }

    /// <summary>Atomically moves a transfer from one status to another; false if it was not in <paramref name="from"/>.</summary>
    public async Task<bool> Move(Guid id, string from, string to, string? reason = null, int? fraudScore = null,
        string? fraudRules = null, bool completed = false)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteAsync("""
            UPDATE transfers SET status = @to, updated_at = now(),
              failure_reason = COALESCE(@reason, failure_reason),
              fraud_score = COALESCE(@fraudScore, fraud_score),
              fraud_rules = COALESCE(@fraudRules, fraud_rules),
              completed_at = CASE WHEN @completed THEN now() ELSE completed_at END
            WHERE id = @id AND status = @from
            """, new { id, from, to, reason, fraudScore, fraudRules, completed }) == 1;
    }

    public async Task SetOtpRef(Guid id, string otpRef)
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteAsync("UPDATE transfers SET otp_ref = @otpRef, updated_at = now() WHERE id = @id", new { id, otpRef });
    }

    /// <summary>Money already committed today (IST) to non-own transfers, excluding one transfer.</summary>
    public async Task<long> UsedToday(string customerId, DateTime istMidnightUtc, Guid? excluding = null)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<long>("""
            SELECT COALESCE(SUM(amount_paise), 0) FROM transfers
            WHERE customer_id = @customerId AND mode <> 'OWN' AND status IN ('PROCESSING', 'COMPLETED')
              AND created_at >= @istMidnightUtc AND (@excluding::uuid IS NULL OR id <> @excluding)
            """, new { customerId, istMidnightUtc, excluding });
    }

    public async Task<long> SentToBeneficiarySince(Guid beneficiaryId, DateTime since, Guid? excluding = null)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<long>("""
            SELECT COALESCE(SUM(amount_paise), 0) FROM transfers
            WHERE beneficiary_id = @beneficiaryId AND status IN ('PROCESSING', 'COMPLETED') AND created_at >= @since
              AND (@excluding::uuid IS NULL OR id <> @excluding)
            """, new { beneficiaryId, since, excluding });
    }

    public async Task<int> RecentTransferCount(string customerId, DateTime since)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<int>("""
            SELECT count(*) FROM transfers
            WHERE customer_id = @customerId AND status IN ('PROCESSING', 'COMPLETED', 'BLOCKED') AND created_at >= @since
            """, new { customerId, since });
    }

    public async Task<bool> SentToBankBefore(string customerId, string bankCode, Guid excluding)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<bool>("""
            SELECT EXISTS (SELECT 1 FROM transfers WHERE customer_id = @customerId AND left(to_ifsc, 4) = @bankCode
                           AND status IN ('PROCESSING', 'COMPLETED') AND id <> @excluding)
            """, new { customerId, bankCode, excluding });
    }
}
