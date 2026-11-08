package com.vijaybank.auth;

import com.nimbusds.jwt.JWTClaimsSet;
import com.vijaybank.auth.web.ApiException;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
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

    // OTP outcomes as a metric (Prometheus: vijaybank_otp_verifications_total{purpose, result}).
    // Never add the customer ID as an attribute: one series per customer would explode the metric.
    private static final LongCounter OTP_VERIFICATIONS = GlobalOpenTelemetry.getMeter("vijaybank.auth")
            .counterBuilder("vijaybank.otp.verifications")
            .setDescription("OTP verification attempts by purpose and result")
            .build();
    private static final AttributeKey<String> PURPOSE = AttributeKey.stringKey("purpose");
    private static final AttributeKey<String> RESULT = AttributeKey.stringKey("result");
    private static final List<String> RESULTS = List.of("SUCCESS", "INVALID_OTP", "OTP_EXPIRED", "OTP_ATTEMPTS_EXCEEDED");
    // OTPs sent (Prometheus: vijaybank_otp_sent_total{purpose}).
    private static final LongCounter OTP_SENT = GlobalOpenTelemetry.getMeter("vijaybank.auth")
            .counterBuilder("vijaybank.otp.sent")
            .setDescription("OTPs sent by purpose")
            .build();
    // Purposes the services use today; their series exist from start-up so the first OTP is counted.
    private static final List<String> PURPOSES = List.of("LOGIN", "BENEFICIARY", "TRANSFER", "BILLPAY", "CARD_UNBLOCK", "CARD_CONTROLS");

    static {
        PURPOSES.forEach(purpose -> {
            OTP_SENT.add(0, Attributes.of(PURPOSE, purpose));
            initOtpSeries(purpose);
        });
    }

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
        OTP_SENT.add(1, Attributes.of(PURPOSE, "LOGIN"));
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
            recordOtp("LOGIN", "OTP_EXPIRED");
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
                recordOtp("LOGIN", "OTP_ATTEMPTS_EXCEEDED");
                throw new ApiException(HttpStatus.UNAUTHORIZED, "OTP_ATTEMPTS_EXCEEDED",
                        "Too many wrong OTPs. Please log in again.");
            }
            recordOtp("LOGIN", "INVALID_OTP");
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_OTP", "The OTP is incorrect.",
                    Map.of("attemptsRemaining", props.otpMaxAttempts() - attempts));
        }
        redis.delete(key);
        recordOtp("LOGIN", "SUCCESS");
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

    /**
     * Step-up OTP for a sensitive action (transfer, new beneficiary) by an
     * already logged-in customer. Returns a reference the caller verifies later.
     */
    public LoginResult sendStepUpOtp(String customerId, String purpose, Map<String, Object> details) {
        if (customerId == null || purpose == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "customerId and purpose are required.");
        }
        String otp = "%06d".formatted(RANDOM.nextInt(1_000_000));
        String ref = randomToken();
        String key = "stepup:" + ref;
        redis.opsForHash().putAll(key, Map.of("customerId", customerId, "purpose", purpose,
                "otpHash", sha256(otp), "attempts", "0"));
        redis.expire(key, props.otpTtl());

        Map<String, Object> data = new java.util.LinkedHashMap<>(details == null ? Map.of() : details);
        data.put("purpose", purpose);
        data.put("channel", "SMS");
        data.put("otp", otp);
        data.put("expiresInSeconds", props.otpTtl().toSeconds());
        events.publish("auth.otp.requested", customerId, data);
        initOtpSeries(purpose);
        OTP_SENT.add(1, Attributes.of(PURPOSE, purpose));
        log.info("step-up otp sent customerId={} purpose={}", customerId, purpose);
        return new LoginResult(ref, props.otpTtl().toSeconds());
    }

    /** Verifies a step-up OTP. The OTP is single-use and bound to the customer and purpose. */
    public void verifyStepUpOtp(String otpRef, String customerId, String purpose, String otp) {
        if (otpRef == null || otp == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "otpRef and otp are required.");
        }
        String key = "stepup:" + otpRef;
        Map<Object, Object> pending = redis.opsForHash().entries(key);
        if (pending.isEmpty() || !pending.get("customerId").equals(customerId)
                || (purpose != null && !pending.get("purpose").equals(purpose))) {
            recordOtp(purpose, "OTP_EXPIRED");
            throw new ApiException(HttpStatus.UNAUTHORIZED, "OTP_EXPIRED", "The OTP has expired. Please start again.");
        }
        long attempts = redis.opsForHash().increment(key, "attempts", 1);
        boolean matches = MessageDigest.isEqual(
                sha256(otp).getBytes(StandardCharsets.UTF_8),
                ((String) pending.get("otpHash")).getBytes(StandardCharsets.UTF_8));
        if (!matches) {
            if (attempts >= props.otpMaxAttempts()) {
                redis.delete(key);
                recordOtp(purpose, "OTP_ATTEMPTS_EXCEEDED");
                throw new ApiException(HttpStatus.UNAUTHORIZED, "OTP_ATTEMPTS_EXCEEDED", "Too many wrong OTPs. Please start again.");
            }
            recordOtp(purpose, "INVALID_OTP");
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_OTP", "The OTP is incorrect.",
                    Map.of("attemptsRemaining", props.otpMaxAttempts() - attempts));
        }
        redis.delete(key);
        recordOtp(purpose, "SUCCESS");
    }

    private static void recordOtp(String purpose, String result) {
        OTP_VERIFICATIONS.add(1, Attributes.of(PURPOSE, purpose == null ? "UNKNOWN" : purpose, RESULT, result));
    }

    /**
     * Starts every result series for a purpose at 0, so the first failure shows up in
     * increase()/rate() instead of being the series' first sample.
     */
    private static void initOtpSeries(String purpose) {
        for (String result : RESULTS) {
            OTP_VERIFICATIONS.add(0, Attributes.of(PURPOSE, purpose, RESULT, result));
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
