package com.vijaybank.auth;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class CredentialRepository {

    public record Credential(String customerId, String passwordHash, int failedAttempts, Instant lockedUntil) {
    }

    private final JdbcTemplate jdbc;

    public CredentialRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Credential> find(String customerId) {
        return jdbc.query(
                "SELECT customer_id, password_hash, failed_attempts, locked_until FROM credentials WHERE customer_id = ?",
                (rs, i) -> {
                    Timestamp locked = rs.getTimestamp("locked_until");
                    return new Credential(rs.getString("customer_id"), rs.getString("password_hash"),
                            rs.getInt("failed_attempts"), locked == null ? null : locked.toInstant());
                },
                customerId).stream().findFirst();
    }

    /** Creates the credential if it does not exist yet; returns true when created. */
    public boolean create(String customerId, String passwordHash) {
        return jdbc.update(
                "INSERT INTO credentials (customer_id, password_hash) VALUES (?, ?) ON CONFLICT DO NOTHING",
                customerId, passwordHash) == 1;
    }

    public int recordFailure(String customerId) {
        return jdbc.queryForObject(
                "UPDATE credentials SET failed_attempts = failed_attempts + 1 WHERE customer_id = ? RETURNING failed_attempts",
                Integer.class, customerId);
    }

    public void lock(String customerId, Instant until) {
        jdbc.update("UPDATE credentials SET locked_until = ? WHERE customer_id = ?", Timestamp.from(until), customerId);
    }

    public void resetFailures(String customerId) {
        jdbc.update("UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE customer_id = ?", customerId);
    }

    public void markLogin(String customerId) {
        jdbc.update("UPDATE credentials SET last_login_at = now() WHERE customer_id = ?", customerId);
    }
}
