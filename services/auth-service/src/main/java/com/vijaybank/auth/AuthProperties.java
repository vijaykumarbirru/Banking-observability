package com.vijaybank.auth;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("vijaybank.auth")
public record AuthProperties(
        Duration accessTokenTtl,
        Duration refreshTokenTtl,
        Duration otpTtl,
        int otpMaxAttempts,
        int maxFailedLogins,
        Duration lockDuration) {
}
