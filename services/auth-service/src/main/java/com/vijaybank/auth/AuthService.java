package com.vijaybank.auth;

import com.nimbusds.jwt.JWTClaimsSet;
import com.vijaybank.auth.web.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);
    private static final Pattern CUSTOMER_ID = Pattern.compile("VB\\d{6}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final CredentialRepository credentials;
    private final PasswordEncoder encoder;
    private final StringRedisTemplate redis;
    private final JwtService jwt;
    private final EventPublisher events;
    private final AuthProperties props;

    public AuthService(CredentialRepository credentials, PasswordEncoder encoder, StringRedisTemplate redis,
            JwtService jwt, EventPublisher events, AuthProperties props) {
        this.credentials = credentials;
        this.encoder = encoder;
        this.redis = redis;
        this.jwt = jwt;
        this.events = events;
        this.props = props;
    }

    public record LoginResult(String loginToken, long otpExpiresInSeconds) {
    }

    public record Tokens(String accessToken, long expiresInSeconds, String refreshToken, String customerId) {
    }

    /** Step 1: password check. On success an OTP is sent and a short-lived login token returned. */
    public LoginResult login(String customerId, String password) {
        if (customerId == null || !CUSTOMER_ID.matcher(customerId).matches() || password == null) {
            throw invalidCredentials();
        }
        var cred = credentials.find(customerId).orElse(null);
        if (cred == null) {
            events.publish("auth.login.failed", customerId, Map.of("reason", "UNKNOWN_CUSTOMER"));
            throw invalidCredentials();
        }
        Instant now = Instant.now();
        if (cred.lockedUntil() != null) {
            if (cred.lockedUntil().isAfter(now)) {
                throw new ApiException(HttpStatus.LOCKED, "ACCOUNT_LOCKED",
                        "Your login is locked after too many failed attempts. Try again later.",
                        Map.of("lockedUntil", cred.lockedUntil().toString()));
            }
            credentials.resetFailures(customerId); // lock expired: start counting again
        }
        if (!encoder.matches(password, cred.passwordHash())) {
            int failed = credentials.recordFailure(customerId);
            if (failed >= props.maxFailedLogins()) {
                Instant until = now.plus(props.lockDuration());
                credentials.lock(customerId, until);
                log.warn("login locked customerId={} failedAttempts={}", customerId, failed);
                events.publish("auth.account.locked", customerId, Map.of("lockedUntil", until.toString()));
                throw new ApiException(HttpStatus.LOCKED, "ACCOUNT_LOCKED",
                        "Your login is locked after too many failed attempts. Try again later.",
                        Map.of("lockedUntil", until.toString()));
            }
            events.publish("auth.login.failed", customerId, Map.of("reason", "WRONG_PASSWORD", "failedAttempts", failed));
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS",
                    "Customer ID or password is incorrect.",
                    Map.of("attemptsRemaining", props.maxFailedLogins() - failed));
        }
        credentials.resetFailures(customerId);

        String otp = "%06d".formatted(RANDOM.nextInt(1_000_000));
        String loginToken = randomToken();
        String key = "login:" + loginToken;
        redis.opsForHash().putAll(key, Map.of("customerId", customerId, "otpHash", sha256(otp), "attempts", "0"));
        redis.expire(key, props.otpTtl());

        // The OTP travels only to the (simulated) SMS gateway; it is never logged here.
        events.publish("auth.otp.requested", customerId, Map.of(
                "purpose", "LOGIN", "channel", "SMS", "otp", otp,
                "expiresInSeconds", props.otpTtl().toSeconds()));
        log.info("otp sent customerId={}", customerId);
        return new LoginResult(loginToken, props.otpTtl().toSeconds());
    }

    /** Step 2: OTP check. Issues the access and refresh tokens. */
    public Tokens verifyOtp(String loginToken, String otp) {
        if (loginToken == null || otp == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "loginToken and otp are required.");
        }
        String key = "login:" + loginToken;
        Map<Object, Object> pending = redis.opsForHash().entries(key);
        if (pending.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "OTP_EXPIRED", "The OTP has expired. Please log in again.");
        }
        long attempts = redis.opsForHash().increment(key, "attempts", 1);
        String customerId = (String) pending.get("customerId");
        boolean matches = MessageDigest.isEqual(
                sha256(otp).getBytes(StandardCharsets.UTF_8),
                ((String) pending.get("otpHash")).getBytes(StandardCharsets.UTF_8));
        if (!matches) {
            if (attempts >= props.otpMaxAttempts()) {
                redis.delete(key);
                events.publish("auth.login.failed", customerId, Map.of("reason", "OTP_ATTEMPTS_EXCEEDED"));
                throw new ApiException(HttpStatus.UNAUTHORIZED, "OTP_ATTEMPTS_EXCEEDED",
                        "Too many wrong OTPs. Please log in again.");
            }
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_OTP", "The OTP is incorrect.",
                    Map.of("attemptsRemaining", props.otpMaxAttempts() - attempts));
        }
        redis.delete(key);
        credentials.markLogin(customerId);
        events.publish("auth.login.succeeded", customerId, Map.of("method", "PASSWORD_OTP"));
        log.info("login succeeded customerId={}", customerId);
        return issueTokens(customerId);
    }

    public Tokens refresh(String refreshToken) {
        if (refreshToken == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "refreshToken is required.");
        }
        // Refresh tokens are single-use: each refresh rotates to a new one.
        String customerId = redis.opsForValue().getAndDelete("refresh:" + refreshToken);
        if (customerId == null) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "SESSION_EXPIRED", "Your session has expired. Please log in again.");
        }
        return issueTokens(customerId);
    }

    public void logout(String bearer, String refreshToken) {
        JWTClaimsSet claims = bearer == null ? null : jwt.verify(bearer);
        if (claims != null && claims.getExpirationTime() != null) {
            Duration ttl = Duration.between(Instant.now(), claims.getExpirationTime().toInstant());
            if (!ttl.isNegative() && !ttl.isZero()) {
                redis.opsForValue().set("deny:" + claims.getJWTID(), "1", ttl);
            }
            events.publish("auth.logout", claims.getSubject(), Map.of());
        }
        if (refreshToken != null) {
            redis.delete("refresh:" + refreshToken);
        }
    }

    public boolean createCredential(String customerId, String password) {
        if (customerId == null || !CUSTOMER_ID.matcher(customerId).matches() || password == null || password.length() < 8) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "customerId must look like VB123456 and password must have at least 8 characters.");
        }
        return credentials.create(customerId, encoder.encode(password));
    }

    private Tokens issueTokens(String customerId) {
        var access = jwt.issue(customerId);
        String refresh = randomToken();
        redis.opsForValue().set("refresh:" + refresh, customerId, props.refreshTokenTtl());
        return new Tokens(access.value(), props.accessTokenTtl().toSeconds(), refresh, customerId);
    }

    private static ApiException invalidCredentials() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Customer ID or password is incorrect.");
    }

    private static String randomToken() {
        byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
