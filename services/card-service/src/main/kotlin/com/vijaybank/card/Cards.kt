package com.vijaybank.card

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import java.sql.ResultSet
import java.time.LocalDate
import java.util.UUID
import kotlin.random.Random

/** Card controls a customer may change, all amounts in paise. */
data class Controls(
    val atmLimitPaise: Long,
    val posLimitPaise: Long,
    val onlineLimitPaise: Long,
    val internationalEnabled: Boolean,
    val contactlessEnabled: Boolean,
)

data class Card(
    val id: UUID,
    val customerId: String,
    val accountNo: String?,
    val type: String, // DEBIT or CREDIT
    val variant: String,
    val last4: String, // the full card number is never stored
    val holderName: String,
    val expiryMonth: Int,
    val expiryYear: Int,
    val status: String, // ACTIVE, BLOCKED (temporary) or HOTLISTED (lost/stolen, permanent)
    val blockReason: String?,
    val controls: Controls,
    val creditLimitPaise: Long?,
    val outstandingPaise: Long?,
    val statementDueDate: LocalDate?,
) {
    /** The highest values a customer may set; increases above the current value need an OTP. */
    fun caps(): Controls = if (type == "CREDIT") {
        val limit = creditLimitPaise ?: 0
        Controls(limit / 5, limit, limit, true, true)
    } else {
        Controls(1_00_000_00, 5_00_000_00, 5_00_000_00, true, true)
    }

    fun view(): Map<String, Any?> = linkedMapOf(
        "cardId" to id,
        "type" to type,
        "variant" to variant,
        "network" to "VijayPay",
        "maskedNumber" to "XXXX XXXX XXXX $last4",
        "holderName" to holderName,
        "expiry" to "%02d/%02d".format(expiryMonth, expiryYear % 100),
        "accountNo" to accountNo,
        "status" to status,
        "blockReason" to blockReason,
        "controls" to controls,
        "caps" to caps(),
        "creditLimitPaise" to creditLimitPaise,
        "outstandingPaise" to outstandingPaise,
        "availableCreditPaise" to creditLimitPaise?.let { it - (outstandingPaise ?: 0) },
        "minimumDuePaise" to outstandingPaise?.let { maxOf(it / 20, if (it > 0) 200_00 else 0).coerceAtMost(it) },
        "statementDueDate" to statementDueDate?.toString(),
    )
}

class CardRepository(url: String, user: String, password: String) {
    private val ds = HikariDataSource(HikariConfig().apply {
        jdbcUrl = url
        username = user
        this.password = password
        maximumPoolSize = 8
        initializationFailTimeout = -1 // start even if Postgres is not up yet
    })

    fun migrate() {
        repeat(30) { attempt ->
            try {
                ds.connection.use { c ->
                    c.createStatement().execute(
                        """
                        CREATE TABLE IF NOT EXISTS cards (
                          id                    UUID PRIMARY KEY,
                          customer_id           VARCHAR(16) NOT NULL,
                          account_no            VARCHAR(20),
                          type                  VARCHAR(6) NOT NULL,
                          variant               VARCHAR(40) NOT NULL,
                          last4                 CHAR(4) NOT NULL,
                          holder_name           VARCHAR(60) NOT NULL,
                          expiry_month          INT NOT NULL,
                          expiry_year           INT NOT NULL,
                          status                VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
                          block_reason          VARCHAR(12),
                          atm_limit_paise       BIGINT NOT NULL,
                          pos_limit_paise       BIGINT NOT NULL,
                          online_limit_paise    BIGINT NOT NULL,
                          international_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                          contactless_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
                          credit_limit_paise    BIGINT,
                          outstanding_paise     BIGINT,
                          statement_due_date    DATE,
                          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
                          UNIQUE (customer_id, type, account_no)
                        );
                        CREATE INDEX IF NOT EXISTS cards_customer ON cards (customer_id);
                        """.trimIndent(),
                    )
                }
                return
            } catch (e: Exception) {
                if (attempt == 29) throw e
                Thread.sleep(2000)
            }
        }
    }

    fun ping(): Boolean = runCatching { ds.connection.use { it.isValid(2) } }.getOrDefault(false)

    fun byCustomer(customerId: String): List<Card> = query(
        "SELECT * FROM cards WHERE customer_id = ? ORDER BY type DESC, created_at", customerId,
    )

    fun find(id: UUID, customerId: String): Card? = query(
        "SELECT * FROM cards WHERE id = ? AND customer_id = ?", id, customerId,
    ).firstOrNull()

    /** Changes status only from an expected state; returns false if the card was not in it. */
    fun setStatus(id: UUID, from: String, to: String, reason: String?): Boolean = update(
        "UPDATE cards SET status = ?, block_reason = ? WHERE id = ? AND status = ?", to, reason, id, from,
    ) == 1

    fun setControls(id: UUID, c: Controls) = update(
        """UPDATE cards SET atm_limit_paise = ?, pos_limit_paise = ?, online_limit_paise = ?,
           international_enabled = ?, contactless_enabled = ? WHERE id = ?""",
        c.atmLimitPaise, c.posLimitPaise, c.onlineLimitPaise, c.internationalEnabled, c.contactlessEnabled, id,
    )

    fun insert(customerId: String, accountNo: String?, type: String, holderName: String, creditLimit: Long?, outstanding: Long?): Boolean {
        val credit = type == "CREDIT"
        val now = LocalDate.now()
        return update(
            """INSERT INTO cards (id, customer_id, account_no, type, variant, last4, holder_name, expiry_month, expiry_year,
                 atm_limit_paise, pos_limit_paise, online_limit_paise, international_enabled, contactless_enabled,
                 credit_limit_paise, outstanding_paise, statement_due_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING""",
            UUID.randomUUID(), customerId, accountNo, type,
            if (credit) "Saffron Rewards Credit" else "Saffron Platinum Debit",
            "%04d".format(Random.nextInt(10_000)), holderName.uppercase(),
            Random.nextInt(1, 13), now.year + 4,
            if (credit) (creditLimit ?: 0) / 10 else 40_000_00,
            if (credit) (creditLimit ?: 0) / 2 else 1_00_000_00,
            if (credit) (creditLimit ?: 0) / 2 else 1_00_000_00,
            false, true,
            creditLimit, outstanding, if (credit) now.plusDays(18) else null,
        ) == 1
    }

    private fun query(sql: String, vararg args: Any?): List<Card> = ds.connection.use { c ->
        c.prepareStatement(sql).use { st ->
            args.forEachIndexed { i, a -> st.setObject(i + 1, a) }
            st.executeQuery().use { rs -> generateSequence { if (rs.next()) rs.toCard() else null }.toList() }
        }
    }

    private fun update(sql: String, vararg args: Any?): Int = ds.connection.use { c ->
        c.prepareStatement(sql).use { st ->
            args.forEachIndexed { i, a -> st.setObject(i + 1, if (a is LocalDate) java.sql.Date.valueOf(a) else a) }
            st.executeUpdate()
        }
    }

    private fun ResultSet.toCard() = Card(
        id = getObject("id", UUID::class.java),
        customerId = getString("customer_id"),
        accountNo = getString("account_no"),
        type = getString("type"),
        variant = getString("variant"),
        last4 = getString("last4"),
        holderName = getString("holder_name"),
        expiryMonth = getInt("expiry_month"),
        expiryYear = getInt("expiry_year"),
        status = getString("status"),
        blockReason = getString("block_reason"),
        controls = Controls(
            getLong("atm_limit_paise"), getLong("pos_limit_paise"), getLong("online_limit_paise"),
            getBoolean("international_enabled"), getBoolean("contactless_enabled"),
        ),
        creditLimitPaise = getObject("credit_limit_paise") as Long?,
        outstandingPaise = getObject("outstanding_paise") as Long?,
        statementDueDate = getDate("statement_due_date")?.toLocalDate(),
    )
}
