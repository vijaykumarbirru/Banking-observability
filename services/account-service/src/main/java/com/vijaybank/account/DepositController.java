package com.vijaybank.account;

import com.vijaybank.account.LedgerClient.Leg;
import com.vijaybank.account.web.ApiException;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.sql.Date;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Fixed deposits. Opening moves money from a savings/current account into the
 * FD_POOL ledger account; closing pays principal plus interest back.
 * Rates are fictional and illustrative.
 */
@RestController
public class DepositController {

    private static final Logger log = LoggerFactory.getLogger(DepositController.class);
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    private static final long MIN_PAISE = 10_000L * 100;
    private static final long MAX_PAISE = 1_00_00_000L * 100;

    /** Tenure in months -> annual rate in basis points. */
    static final Map<Integer, Integer> RATES = new LinkedHashMap<>(Map.of(6, 650, 12, 710, 24, 725, 36, 740, 60, 700));

    record OpenRequest(String fundingAccountNo, long amountPaise, int tenureMonths) {
    }

    record SeedRequest(String customerId, String fundingAccountNo, long amountPaise, int tenureMonths) {
    }

    private final JdbcTemplate jdbc;
    private final AccountRepository accounts;
    private final LedgerClient ledger;
    private final EventPublisher events;

    public DepositController(JdbcTemplate jdbc, AccountRepository accounts, LedgerClient ledger, EventPublisher events) {
        this.jdbc = jdbc;
        this.accounts = accounts;
        this.ledger = ledger;
        this.events = events;
    }

    @GetMapping("/deposits/rates")
    public List<Map<String, Object>> rates() {
        return RATES.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .map(e -> Map.<String, Object>of("tenureMonths", e.getKey(), "rateBps", e.getValue()))
                .toList();
    }

    @GetMapping("/deposits")
    public List<Map<String, Object>> list(@RequestHeader(value = "X-Customer-Id", required = false) String customerId) {
        requireCustomer(customerId);
        return jdbc.queryForList("SELECT * FROM fixed_deposits WHERE customer_id = ? ORDER BY status, created_at DESC", customerId)
                .stream().map(DepositController::view).toList();
    }

    @PostMapping("/deposits")
    public ResponseEntity<Map<String, Object>> open(@RequestHeader(value = "X-Customer-Id", required = false) String customerId,
            @RequestHeader(value = "Idempotency-Key", required = false) String key, @RequestBody OpenRequest req) {
        requireCustomer(customerId);
        if (key == null || key.isBlank() || key.length() > 80) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "An Idempotency-Key header is required.");
        }
        var existing = jdbc.queryForList("SELECT * FROM fixed_deposits WHERE customer_id = ? AND idempotency_key = ?", customerId, key);
        if (!existing.isEmpty()) {
            return ResponseEntity.ok(view(existing.get(0)));
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(openDeposit(customerId, key, req.fundingAccountNo(), req.amountPaise(), req.tenureMonths()));
    }

    @PostMapping("/deposits/{id}/close")
    public Map<String, Object> close(@RequestHeader(value = "X-Customer-Id", required = false) String customerId, @PathVariable UUID id) {
        requireCustomer(customerId);
        var rows = jdbc.queryForList("SELECT * FROM fixed_deposits WHERE id = ? AND customer_id = ?", id, customerId);
        if (rows.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "DEPOSIT_NOT_FOUND", "Deposit not found.");
        }
        var fd = rows.get(0);
        if (!"ACTIVE".equals(fd.get("status"))) {
            return view(fd);
        }
        LocalDate today = LocalDate.now(IST);
        LocalDate start = ((Date) fd.get("start_date")).toLocalDate();
        long principal = (Long) fd.get("principal_paise");
        int rateBps = (Integer) fd.get("rate_bps");
        long days = ChronoUnit.DAYS.between(start, today);
        // Premature closure: simple interest at the contract rate minus 1%, nothing in the first 7 days.
        long interest = days < 7 ? 0 : BigDecimal.valueOf(principal)
                .multiply(BigDecimal.valueOf(Math.max(0, rateBps - 100)))
                .multiply(BigDecimal.valueOf(days))
                .divide(BigDecimal.valueOf(10_000L * 365), 0, RoundingMode.HALF_UP).longValue();
        String fdNo = (String) fd.get("fd_no");
        String account = (String) fd.get("funding_account");

        // Claim the deposit first so two concurrent closes cannot pay out twice.
        if (jdbc.update("UPDATE fixed_deposits SET status = 'CLOSING' WHERE id = ? AND status = 'ACTIVE'", id) == 0) {
            return view(jdbc.queryForMap("SELECT * FROM fixed_deposits WHERE id = ?", id));
        }
        var legs = new java.util.ArrayList<Leg>();
        legs.add(new Leg("FD_POOL", "DEBIT", principal, "FD CLOSURE " + fdNo));
        if (interest > 0) {
            legs.add(new Leg("INTEREST_EXPENSE", "DEBIT", interest, "FD INTEREST " + fdNo));
        }
        legs.add(new Leg(account, "CREDIT", principal + interest, "FD CLOSURE PROCEEDS " + fdNo));
        try {
            ledger.post("fd-close:" + id, "FD_CLOSURE", fdNo, null, legs);
        } catch (ApiException e) {
            if (e.status().is4xxClientError()) {
                jdbc.update("UPDATE fixed_deposits SET status = 'ACTIVE' WHERE id = ? AND status = 'CLOSING'", id); // nothing was posted
            }
            throw e; // on 503 the outcome is unknown: stays CLOSING until reconciled (ledger key makes a retry safe)
        }
        jdbc.update("UPDATE fixed_deposits SET status = 'CLOSED', closed_on = ?, payout_paise = ? WHERE id = ?",
                Date.valueOf(today), principal + interest, id);
        publish("deposit.closed", customerId, Map.of("fdNo", fdNo, "payoutPaise", principal + interest,
                "interestPaise", interest, "accountNo", account));
        log.info("deposit closed fdNo={} interestPaise={}", fdNo, interest);
        return view(jdbc.queryForMap("SELECT * FROM fixed_deposits WHERE id = ?", id));
    }

    /** Internal: seed job. */
    @PostMapping("/internal/deposits")
    public Map<String, Object> seed(@RequestBody SeedRequest req) {
        return openDeposit(req.customerId(), "seed:" + req.fundingAccountNo(), req.fundingAccountNo(), req.amountPaise(), req.tenureMonths());
    }

    private Map<String, Object> openDeposit(String customerId, String key, String fundingAccountNo, long amount, int tenure) {
        Integer rateBps = RATES.get(tenure);
        if (rateBps == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_TENURE", "Choose a tenure of 6, 12, 24, 36 or 60 months.");
        }
        if (amount < MIN_PAISE || amount > MAX_PAISE) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "AMOUNT_OUT_OF_RANGE",
                    "A fixed deposit must be between ₹10,000 and ₹1,00,00,000.");
        }
        var account = accounts.find(fundingAccountNo == null ? "" : fundingAccountNo)
                .filter(a -> a.customerId().equals(customerId))
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found."));

        LocalDate start = LocalDate.now(IST);
        LocalDate maturity = start.plusMonths(tenure);
        long maturityAmount = maturityAmount(amount, rateBps, tenure);
        UUID id = UUID.randomUUID();
        String fdNo = "FD" + start.format(DateTimeFormatter.ofPattern("yyMMdd")) + "%06d".formatted(ThreadLocalRandom.current().nextInt(1_000_000));

        try {
            jdbc.update("""
                    INSERT INTO fixed_deposits (id, fd_no, customer_id, idempotency_key, funding_account, principal_paise, rate_bps,
                      tenure_months, start_date, maturity_date, maturity_amount_paise, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPENING')""",
                    id, fdNo, customerId, key, account.accountNo(), amount, rateBps, tenure, Date.valueOf(start), Date.valueOf(maturity), maturityAmount);
        } catch (DuplicateKeyException e) {
            return view(jdbc.queryForMap("SELECT * FROM fixed_deposits WHERE customer_id = ? AND idempotency_key = ?", customerId, key));
        }
        try {
            ledger.post("fd-open:" + id, "FD_OPEN", fdNo, null, List.of(
                    new Leg(account.accountNo(), "DEBIT", amount, "FD BOOKED " + fdNo),
                    new Leg("FD_POOL", "CREDIT", amount, "FD BOOKED " + fdNo)));
        } catch (ApiException e) {
            if (e.status().is4xxClientError()) {
                jdbc.update("DELETE FROM fixed_deposits WHERE id = ? AND status = 'OPENING'", id); // nothing was posted
            }
            throw e;
        }
        jdbc.update("UPDATE fixed_deposits SET status = 'ACTIVE' WHERE id = ?", id);
        publish("deposit.opened", customerId, Map.of("fdNo", fdNo, "principalPaise", amount, "rateBps", rateBps,
                "tenureMonths", tenure, "maturityDate", maturity.toString(), "maturityAmountPaise", maturityAmount,
                "accountNo", account.accountNo()));
        log.info("deposit opened fdNo={} principalPaise={} tenureMonths={}", fdNo, amount, tenure);
        return view(jdbc.queryForMap("SELECT * FROM fixed_deposits WHERE id = ?", id));
    }

    /** Quarterly compounding: A = P (1 + r/4)^(4t). */
    static long maturityAmount(long principalPaise, int rateBps, int tenureMonths) {
        BigDecimal quarterly = BigDecimal.ONE.add(BigDecimal.valueOf(rateBps).divide(BigDecimal.valueOf(40_000), MathContext.DECIMAL64));
        BigDecimal factor = BigDecimal.valueOf(Math.pow(quarterly.doubleValue(), tenureMonths / 3.0));
        return BigDecimal.valueOf(principalPaise).multiply(factor).setScale(0, RoundingMode.HALF_UP).longValue();
    }

    private void publish(String type, String customerId, Map<String, Object> data) {
        try {
            events.publish(type, customerId, data);
        } catch (RuntimeException e) {
            log.error("could not publish {}", type, e); // notification only; the deposit itself is done
        }
    }

    private static void requireCustomer(String customerId) {
        if (customerId == null || customerId.isBlank()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Login required.");
        }
    }

    private static Map<String, Object> view(Map<String, Object> r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("depositId", r.get("id"));
        m.put("fdNo", r.get("fd_no"));
        m.put("fundingAccountNo", r.get("funding_account"));
        m.put("principalPaise", r.get("principal_paise"));
        m.put("rateBps", r.get("rate_bps"));
        m.put("tenureMonths", r.get("tenure_months"));
        m.put("startDate", r.get("start_date").toString());
        m.put("maturityDate", r.get("maturity_date").toString());
        m.put("maturityAmountPaise", r.get("maturity_amount_paise"));
        m.put("status", r.get("status"));
        m.put("closedOn", r.get("closed_on") == null ? null : r.get("closed_on").toString());
        m.put("payoutPaise", r.get("payout_paise"));
        return m;
    }
}
