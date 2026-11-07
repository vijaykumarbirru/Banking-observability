namespace VijayBank.Transfers;

public sealed record AddBeneficiaryRequest(string? Name, string? AccountNo, string? Ifsc, string? Nickname);
public sealed record SeedBeneficiaryRequest(string CustomerId, string Name, string AccountNo, string Ifsc, string? Nickname, DateTime? ActiveSince);
public sealed record OtpRequest(string? Otp);
public sealed record CreateTransferRequest(string? FromAccountNo, string? Mode, Guid? BeneficiaryId, string? ToAccountNo, long AmountPaise, string? Remarks);

/// <summary>Beneficiary and transfer workflows. See docs/DESIGN.md sections 4 and 5.</summary>
public sealed class TransferLogic(Store store, Downstream downstream, EventBus events, IConfiguration config, ILogger<TransferLogic> log)
{
    private TimeSpan Cooling => TimeSpan.FromMinutes(config.GetValue("BENEFICIARY_COOLING_MINUTES", 30));

    // ---------------------------------------------------------------- beneficiaries

    public async Task<Beneficiary> AddBeneficiary(string customerId, AddBeneficiaryRequest req)
    {
        var name = req.Name?.Trim();
        var accountNo = req.AccountNo?.Trim();
        var ifsc = req.Ifsc?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(name) || name.Length > 100) throw Invalid("Beneficiary name is required.");
        if (accountNo is null || !Rules.AccountNo().IsMatch(accountNo)) throw Invalid("Account number must be 9 to 18 digits.");
        if (ifsc is null || !Rules.Ifsc().IsMatch(ifsc)) throw Invalid("IFSC must look like VIJB0000101.");
        if (await store.HasActiveBeneficiary(customerId, accountNo, ifsc))
            throw new ApiException(409, "BENEFICIARY_EXISTS", "This beneficiary is already added.");

        var internalBank = Rules.IsInternal(ifsc);
        if (internalBank)
        {
            var acct = await downstream.Account(accountNo);
            if (acct is null || acct.Status != "ACTIVE" || acct.Ifsc != ifsc)
                throw new ApiException(422, "ACCOUNT_NOT_FOUND", "No active VijayBank account matches this number and IFSC.");
            if (acct.CustomerId == customerId)
                throw new ApiException(422, "OWN_ACCOUNT", "This is your own account. Use 'Own account' transfer instead.");
        }

        var b = new Beneficiary
        {
            Id = Guid.NewGuid(), CustomerId = customerId, Name = name, Nickname = req.Nickname?.Trim(),
            AccountNo = accountNo, Ifsc = ifsc, BankName = Rules.BankName(ifsc),
            Type = internalBank ? "INTERNAL" : "EXTERNAL", Status = "PENDING", CreatedAt = DateTime.UtcNow,
        };
        var (otpRef, _) = await downstream.SendOtp(customerId, "BENEFICIARY",
            new { beneficiaryName = name, accountNoMasked = Rules.Mask(accountNo), bankName = b.BankName });
        b.OtpRef = otpRef;
        await store.InsertBeneficiary(b);
        log.LogInformation("beneficiary pending otp {BeneficiaryId} type={Type}", b.Id, b.Type);
        return b;
    }

    public async Task<Beneficiary> ConfirmBeneficiary(string customerId, Guid id, string? otp)
    {
        var b = await store.Beneficiary(id, customerId) ?? throw NotFound("Beneficiary not found.");
        if (b.Status != "PENDING" || b.OtpRef is null) throw new ApiException(409, "ALREADY_CONFIRMED", "This beneficiary is already confirmed.");
        await downstream.VerifyOtp(b.OtpRef, customerId, "BENEFICIARY", otp ?? "");
        var activatesAt = DateTime.UtcNow + Cooling;
        if (!await store.ActivateBeneficiary(id, activatesAt))
            throw new ApiException(409, "ALREADY_CONFIRMED", "This beneficiary is already confirmed.");
        b.Status = "ACTIVE";
        b.ActivatesAt = activatesAt;
        events.Publish("beneficiary.added", customerId, new
        {
            beneficiaryId = b.Id, beneficiaryName = b.Name, accountNoMasked = Rules.Mask(b.AccountNo),
            bankName = b.BankName, activatesAt, coolingMinutes = (int)Cooling.TotalMinutes,
        });
        return b;
    }

    public async Task SeedBeneficiary(SeedBeneficiaryRequest req)
    {
        if (await store.HasActiveBeneficiary(req.CustomerId, req.AccountNo, req.Ifsc)) return;
        await store.InsertBeneficiary(new Beneficiary
        {
            Id = Guid.NewGuid(), CustomerId = req.CustomerId, Name = req.Name, Nickname = req.Nickname,
            AccountNo = req.AccountNo, Ifsc = req.Ifsc, BankName = Rules.BankName(req.Ifsc),
            Type = Rules.IsInternal(req.Ifsc) ? "INTERNAL" : "EXTERNAL", Status = "ACTIVE",
            ActivatesAt = req.ActiveSince ?? DateTime.UtcNow.AddDays(-30),
            CreatedAt = (req.ActiveSince ?? DateTime.UtcNow.AddDays(-30)).AddMinutes(-30),
        });
    }

    // ---------------------------------------------------------------- transfers

    /// <summary>Validates the request and sends the step-up OTP. Repeating the same Idempotency-Key returns the original transfer.</summary>
    public async Task<(Transfer Transfer, bool Replayed)> Create(string customerId, string? idempotencyKey, CreateTransferRequest req)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 80)
            throw Invalid("An Idempotency-Key header (max 80 characters) is required.");
        if (await store.TransferByKey(customerId, idempotencyKey) is { } existing) return (existing, true);

        var mode = req.Mode?.ToUpperInvariant() ?? "";
        if (!Rules.Modes.Contains(mode)) throw Invalid("Mode must be OWN, INTRA, IMPS, NEFT or RTGS.");
        if (Rules.CheckAmount(mode, req.AmountPaise) is { } amountError) throw new ApiException(422, "AMOUNT_OUT_OF_RANGE", amountError);
        if (req.Remarks is { Length: > 60 }) throw Invalid("Remarks can be at most 60 characters.");

        var from = await OwnedActiveAccount(customerId, req.FromAccountNo);
        string toAccount, toIfsc, beneficiaryName;
        Beneficiary? beneficiary = null;

        if (mode == "OWN")
        {
            var to = await OwnedActiveAccount(customerId, req.ToAccountNo);
            if (to.AccountNo == from.AccountNo) throw Invalid("Choose two different accounts.");
            (toAccount, toIfsc, beneficiaryName) = (to.AccountNo, to.Ifsc, "Own account " + Rules.Mask(to.AccountNo));
        }
        else
        {
            beneficiary = req.BeneficiaryId is { } bid
                ? await store.Beneficiary(bid, customerId)
                : null;
            if (beneficiary is not { Status: "ACTIVE" }) throw new ApiException(422, "BENEFICIARY_NOT_FOUND", "Choose a confirmed beneficiary.");
            if (beneficiary.ActivatesAt > DateTime.UtcNow)
                throw new ApiException(422, "BENEFICIARY_COOLING",
                    "This beneficiary was added recently and can receive money after the cooling period.",
                    new() { ["activatesAt"] = beneficiary.ActivatesAt });
            if (beneficiary.Type == "INTERNAL" && mode != "INTRA")
                throw new ApiException(422, "WRONG_MODE", "Use 'VijayBank account' for beneficiaries in VijayBank.");
            if (beneficiary.Type == "EXTERNAL" && mode == "INTRA")
                throw new ApiException(422, "WRONG_MODE", "Choose IMPS, NEFT or RTGS for other banks.");
            (toAccount, toIfsc, beneficiaryName) = (beneficiary.AccountNo, beneficiary.Ifsc, beneficiary.Name);
        }

        var transfer = new Transfer
        {
            Id = Guid.NewGuid(), CustomerId = customerId, IdempotencyKey = idempotencyKey, Reference = Rules.NewReference(mode),
            Mode = mode, FromAccount = from.AccountNo, ToAccount = toAccount, ToIfsc = toIfsc,
            BeneficiaryId = beneficiary?.Id, BeneficiaryName = beneficiaryName, AmountPaise = req.AmountPaise,
            Remarks = req.Remarks?.Trim(), Status = "OTP_REQUIRED", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        };
        await CheckLimits(transfer, beneficiary);
        var balance = await downstream.Balance(from.AccountNo);
        if (balance < transfer.AmountPaise) throw new ApiException(422, "INSUFFICIENT_FUNDS", "Insufficient balance in the selected account.");

        if (!await store.InsertTransfer(transfer))
        {
            // A concurrent request with the same key won the race.
            return ((await store.TransferByKey(customerId, idempotencyKey))!, true);
        }
        var (otpRef, _) = await downstream.SendOtp(customerId, "TRANSFER", new
        {
            amountPaise = transfer.AmountPaise, beneficiaryName, mode, accountNoMasked = Rules.Mask(toAccount),
        });
        await store.SetOtpRef(transfer.Id, otpRef);
        transfer.OtpRef = otpRef;
        log.LogInformation("transfer awaiting otp {TransferId} mode={Mode} amountPaise={Amount}", transfer.Id, mode, transfer.AmountPaise);
        return (transfer, false);
    }

    /// <summary>Verifies the OTP, runs the fraud check and moves the money.</summary>
    public async Task<Transfer> Confirm(string customerId, Guid id, string? otp)
    {
        var t = await store.Transfer(id, customerId) ?? throw NotFound("Transfer not found.");
        if (t.Status != "OTP_REQUIRED" || t.OtpRef is null) return t; // already confirmed: return current state

        await downstream.VerifyOtp(t.OtpRef, customerId, "TRANSFER", otp ?? "");
        if (!await store.Move(t.Id, "OTP_REQUIRED", "PROCESSING"))
            return (await store.Transfer(id, customerId))!;

        try
        {
            var beneficiary = t.BeneficiaryId is { } bid ? await store.Beneficiary(bid, customerId) : null;
            await CheckLimits(t, beneficiary, excludeSelf: true);

            if (t.Mode != "OWN" && !await PassesFraudCheck(t, beneficiary)) return (await store.Transfer(id, customerId))!;

            await MoveMoney(t);
        }
        catch (ApiException e) when (e.Status is 422 or 503 && e.Code is not ("TRANSFER_BLOCKED" or "OUTCOME_UNKNOWN"))
        {
            await store.Move(t.Id, "PROCESSING", "FAILED", e.Code);
            TryPublish("transfer.rejected", customerId, View.EventData(t, e.Code));
            throw;
        }
        return (await store.Transfer(id, customerId))!;
    }

    private async Task<bool> PassesFraudCheck(Transfer t, Beneficiary? beneficiary)
    {
        var now = DateTime.UtcNow;
        var fraud = await downstream.Score(new
        {
            transferId = t.Id, customerId = t.CustomerId, mode = t.Mode, amountPaise = t.AmountPaise,
            beneficiaryAgeHours = beneficiary is null ? (double?)null : (now - beneficiary.CreatedAt).TotalHours,
            recentTransferCount10m = await store.RecentTransferCount(t.CustomerId, now.AddMinutes(-10)) - 1,
            firstTransferToBank = !await store.SentToBankBefore(t.CustomerId, t.ToIfsc[..4], t.Id),
        });
        // Fail closed: no money leaves the bank without a fraud decision.
        if (fraud is null) throw new ApiException(503, "FRAUD_CHECK_UNAVAILABLE", "We could not verify this transfer right now. Please try again shortly.");

        if (fraud.Decision == "BLOCK")
        {
            await store.Move(t.Id, "PROCESSING", "BLOCKED", "FRAUD_SUSPECTED", fraud.Score, string.Join(",", fraud.Rules));
            TryPublish("transfer.blocked", t.CustomerId, View.EventData(t, "FRAUD_SUSPECTED"));
            log.LogWarning("transfer blocked by fraud check {TransferId} score={Score}", t.Id, fraud.Score);
            throw new ApiException(422, "TRANSFER_BLOCKED",
                "This transfer was stopped by our security checks. Please contact customer care if it is genuine.",
                new() { ["transferId"] = t.Id, ["reference"] = t.Reference });
        }
        await store.Move(t.Id, "PROCESSING", "PROCESSING", null, fraud.Score, string.Join(",", fraud.Rules));
        return true;
    }

    /// <summary>
    /// Posts to the ledger. A timeout or 5xx means the posting may or may not have happened, so the
    /// transfer must stay PROCESSING (never FAILED) until reconciled; retrying with the same
    /// idempotency key is safe.
    /// </summary>
    private async Task Post(Transfer t, string type, string debit, string credit, string debitNarration, string creditNarration)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await downstream.Post($"transfer:{t.Id}", type, t.Reference, debit, credit, t.AmountPaise, debitNarration, creditNarration);
                return;
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException
                                      || e is ApiException { Code: "DEPENDENCY_UNAVAILABLE" })
            {
                if (attempt < 2) continue;
                log.LogError(e, "ledger outcome unknown for transfer {TransferId}; left PROCESSING for reconciliation", t.Id);
                throw new ApiException(503, "OUTCOME_UNKNOWN",
                    "Your transfer is being processed. Check its status shortly before trying again.",
                    new() { ["transferId"] = t.Id, ["reference"] = t.Reference });
            }
        }
    }

    private void TryPublish(string type, string customerId, object data)
    {
        try
        {
            events.Publish(type, customerId, data);
        }
        catch (Exception e)
        {
            log.LogError(e, "could not publish {EventType}", type);
        }
    }

    private async Task MoveMoney(Transfer t)
    {
        switch (t.Mode)
        {
            case "OWN":
            case "INTRA":
                await Post(t, t.Mode == "OWN" ? "OWN_TRANSFER" : "INTRA_TRANSFER", t.FromAccount, t.ToAccount,
                    $"TRF TO {t.BeneficiaryName.ToUpperInvariant()}/{t.Reference}",
                    $"TRF FROM A/C {Rules.Mask(t.FromAccount)}/{t.Reference}");
                await store.Move(t.Id, "PROCESSING", "COMPLETED", completed: true);
                TryPublish("transfer.completed", t.CustomerId, View.EventData(t));
                if (t.Mode == "INTRA" && await downstream.Account(t.ToAccount) is { } receiver)
                {
                    TryPublish("transfer.credited", receiver.CustomerId, new
                    {
                        transferId = t.Id, reference = t.Reference, amountPaise = t.AmountPaise,
                        toAccountNoMasked = Rules.Mask(t.ToAccount), fromAccountNoMasked = Rules.Mask(t.FromAccount),
                    });
                }
                break;
            default:
                // Debit now into the clearing account; settlement-worker completes or reverses it.
                await Post(t, t.Mode + "_TRANSFER", t.FromAccount, t.Mode + "_CLEARING",
                    $"{t.Mode}/{t.Reference}/{t.BeneficiaryName.ToUpperInvariant()}", $"{t.Mode} OUTWARD {t.Reference}");
                // Not best-effort: settlement depends on this event. If it cannot be published the transfer
                // stays PROCESSING with money in clearing (a transactional outbox would close this gap).
                events.Publish("transfer.debited", t.CustomerId, View.EventData(t));
                break;
        }
        log.LogInformation("transfer posted {TransferId} mode={Mode}", t.Id, t.Mode);
    }

    private async Task CheckLimits(Transfer t, Beneficiary? beneficiary, bool excludeSelf = false)
    {
        if (t.Mode == "OWN") return;
        var now = DateTime.UtcNow;
        var used = await store.UsedToday(t.CustomerId, Rules.IstMidnightUtc(now), excludeSelf ? t.Id : null);
        if (used + t.AmountPaise > Rules.DailyLimit)
            throw new ApiException(422, "DAILY_LIMIT_EXCEEDED", "This transfer exceeds your daily limit of ₹10,00,000.",
                new() { ["remainingPaise"] = Math.Max(0, Rules.DailyLimit - used) });

        if (beneficiary?.ActivatesAt is { } activated && now < activated + Rules.NewBeneficiaryWindow)
        {
            var sent = await store.SentToBeneficiarySince(beneficiary.Id, activated, excludeSelf ? t.Id : null);
            if (sent + t.AmountPaise > Rules.NewBeneficiaryLimit)
                throw new ApiException(422, "NEW_BENEFICIARY_LIMIT",
                    "You can send up to ₹50,000 to a new beneficiary in the first 24 hours.",
                    new() { ["remainingPaise"] = Math.Max(0, Rules.NewBeneficiaryLimit - sent) });
        }
    }

    private async Task<AccountInfo> OwnedActiveAccount(string customerId, string? accountNo)
    {
        var acct = string.IsNullOrEmpty(accountNo) ? null : await downstream.Account(accountNo);
        if (acct is null || acct.CustomerId != customerId) throw new ApiException(404, "ACCOUNT_NOT_FOUND", "Account not found.");
        if (acct.Status != "ACTIVE") throw new ApiException(422, "ACCOUNT_INACTIVE", "This account cannot be used for transfers.");
        return acct;
    }

    public async Task<object> Limits(string customerId)
    {
        var used = await store.UsedToday(customerId, Rules.IstMidnightUtc(DateTime.UtcNow));
        return new { dailyLimitPaise = Rules.DailyLimit, usedTodayPaise = used, remainingTodayPaise = Math.Max(0, Rules.DailyLimit - used) };
    }

    private static ApiException Invalid(string message) => new(400, "INVALID_REQUEST", message);
    private static ApiException NotFound(string message) => new(404, "NOT_FOUND", message);
}

/// <summary>Public JSON shapes.</summary>
public static class View
{
    public static object Of(Transfer t) => new
    {
        transferId = t.Id, reference = t.Reference, mode = t.Mode, status = t.Status, failureReason = t.FailureReason,
        fromAccountNo = t.FromAccount, toAccountNoMasked = Rules.Mask(t.ToAccount), toIfsc = t.ToIfsc,
        beneficiaryName = t.BeneficiaryName, amountPaise = t.AmountPaise, remarks = t.Remarks,
        createdAt = t.CreatedAt, completedAt = t.CompletedAt,
    };

    public static object Of(Beneficiary b) => new
    {
        beneficiaryId = b.Id, name = b.Name, nickname = b.Nickname, accountNoMasked = Rules.Mask(b.AccountNo),
        ifsc = b.Ifsc, bankName = b.BankName, type = b.Type, status = b.Status, activatesAt = b.ActivatesAt,
        canReceive = b.Status == "ACTIVE" && b.ActivatesAt <= DateTime.UtcNow,
    };

    /// <summary>Event payload shared by all transfer.* events (consumed by notification, settlement, audit).</summary>
    public static object EventData(Transfer t, string? reason = null) => new
    {
        transferId = t.Id, reference = t.Reference, mode = t.Mode, amountPaise = t.AmountPaise,
        fromAccountNo = t.FromAccount, toAccountNo = t.ToAccount, toIfsc = t.ToIfsc,
        beneficiaryName = t.BeneficiaryName, reason,
    };
}
