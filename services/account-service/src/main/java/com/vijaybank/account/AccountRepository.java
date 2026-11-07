package com.vijaybank.account;

import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class AccountRepository {

    public record Account(String accountNo, String customerId, String type, String status, String branch,
            String ifsc, String nickname, LocalDate openedOn) {
    }

    private static final RowMapper<Account> ROW = (rs, i) -> new Account(
            rs.getString("account_no"), rs.getString("customer_id"), rs.getString("type"), rs.getString("status"),
            rs.getString("branch"), rs.getString("ifsc"), rs.getString("nickname"),
            rs.getDate("opened_on").toLocalDate());

    private final JdbcTemplate jdbc;

    public AccountRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Account> byCustomer(String customerId) {
        return jdbc.query("SELECT * FROM accounts WHERE customer_id = ? ORDER BY type DESC, account_no", ROW, customerId);
    }

    public Optional<Account> find(String accountNo) {
        return jdbc.query("SELECT * FROM accounts WHERE account_no = ?", ROW, accountNo).stream().findFirst();
    }

    public boolean create(Account a) {
        return jdbc.update("""
                INSERT INTO accounts (account_no, customer_id, type, branch, ifsc, nickname, opened_on)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING""",
                a.accountNo(), a.customerId(), a.type(), a.branch(), a.ifsc(), a.nickname(),
                Date.valueOf(a.openedOn() == null ? LocalDate.now() : a.openedOn())) == 1;
    }
}
