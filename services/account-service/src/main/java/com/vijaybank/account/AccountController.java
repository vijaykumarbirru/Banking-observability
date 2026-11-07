package com.vijaybank.account;

import com.vijaybank.account.AccountRepository.Account;
import com.vijaybank.account.web.ApiException;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {

    record CreateAccount(String accountNo, String customerId, String type, String branch, String ifsc,
            String nickname, LocalDate openedOn) {
    }

    private final AccountRepository accounts;
    private final LedgerClient ledger;
    private final JdbcTemplate jdbc;

    public AccountController(AccountRepository accounts, LedgerClient ledger, JdbcTemplate jdbc) {
        this.accounts = accounts;
        this.ledger = ledger;
        this.jdbc = jdbc;
    }

    @GetMapping("/accounts")
    public List<Map<String, Object>> list(@RequestHeader(value = "X-Customer-Id", required = false) String customerId) {
        requireCustomer(customerId);
        List<Account> owned = accounts.byCustomer(customerId);
        Map<String, LedgerClient.Balance> balances = ledger.balances(owned.stream().map(Account::accountNo).toList())
                .stream().collect(Collectors.toMap(LedgerClient.Balance::accountNo, Function.identity()));
        return owned.stream().map(a -> view(a, balances.get(a.accountNo()))).toList();
    }

    @GetMapping("/accounts/{accountNo}")
    public Map<String, Object> get(@RequestHeader(value = "X-Customer-Id", required = false) String customerId,
            @PathVariable String accountNo) {
        Account a = owned(customerId, accountNo);
        var balance = ledger.balances(List.of(accountNo)).stream().findFirst().orElse(null);
        return view(a, balance);
    }

    @GetMapping("/accounts/{accountNo}/transactions/recent")
    public List<Map<String, Object>> recent(@RequestHeader(value = "X-Customer-Id", required = false) String customerId,
            @PathVariable String accountNo, @RequestParam(defaultValue = "5") int limit) {
        owned(customerId, accountNo);
        return ledger.entries(accountNo, Math.min(Math.max(limit, 1), 20));
    }

    /** Internal (not routed by the gateway): used by the seed job and, later, account opening. */
    @PostMapping("/internal/accounts")
    public ResponseEntity<Map<String, Object>> create(@RequestBody CreateAccount req) {
        if (req.accountNo() == null || req.customerId() == null || req.type() == null
                || req.branch() == null || req.ifsc() == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "accountNo, customerId, type, branch and ifsc are required.");
        }
        boolean created = accounts.create(new Account(req.accountNo(), req.customerId(), req.type(), "ACTIVE",
                req.branch(), req.ifsc(), req.nickname(), req.openedOn()));
        return ResponseEntity.status(created ? HttpStatus.CREATED : HttpStatus.OK)
                .body(Map.of("accountNo", req.accountNo(), "created", created));
    }

    @GetMapping("/health/live")
    public Map<String, String> live() {
        return Map.of("status", "UP");
    }

    @GetMapping("/health/ready")
    public ResponseEntity<Map<String, String>> ready() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            return ResponseEntity.ok(Map.of("status", "UP"));
        } catch (RuntimeException e) {
            return ResponseEntity.status(503).body(Map.of("status", "DOWN"));
        }
    }

    private static void requireCustomer(String customerId) {
        if (customerId == null || customerId.isBlank()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Login required.");
        }
    }

    /** Returns the account only if it belongs to the caller; otherwise behaves as if it does not exist. */
    private Account owned(String customerId, String accountNo) {
        requireCustomer(customerId);
        return accounts.find(accountNo)
                .filter(a -> a.customerId().equals(customerId))
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found."));
    }

    private static Map<String, Object> view(Account a, LedgerClient.Balance balance) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("accountNo", a.accountNo());
        m.put("maskedAccountNo", "XXXXXX" + a.accountNo().substring(Math.max(0, a.accountNo().length() - 4)));
        m.put("type", a.type());
        m.put("status", a.status());
        m.put("nickname", a.nickname());
        m.put("branch", a.branch());
        m.put("ifsc", a.ifsc());
        m.put("openedOn", a.openedOn().toString());
        m.put("balancePaise", balance == null ? null : balance.balancePaise());
        m.put("currency", balance == null ? "INR" : balance.currency());
        return m;
    }
}
