package com.vijaybank.auth;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {

    record LoginRequest(String customerId, String password) {
    }

    record OtpRequest(String loginToken, String otp) {
    }

    record RefreshRequest(String refreshToken) {
    }

    record CredentialRequest(String customerId, String password) {
    }

    private final AuthService auth;
    private final JwtService jwt;

    public AuthController(AuthService auth, JwtService jwt) {
        this.auth = auth;
        this.jwt = jwt;
    }

    @PostMapping("/auth/login")
    public Map<String, Object> login(@RequestBody LoginRequest req) {
        var result = auth.login(req.customerId(), req.password());
        return Map.of(
                "loginToken", result.loginToken(),
                "otpExpiresInSeconds", result.otpExpiresInSeconds(),
                "message", "An OTP has been sent to your registered mobile number.");
    }

    @PostMapping("/auth/otp/verify")
    public AuthService.Tokens verify(@RequestBody OtpRequest req) {
        return auth.verifyOtp(req.loginToken(), req.otp());
    }

    @PostMapping("/auth/refresh")
    public AuthService.Tokens refresh(@RequestBody RefreshRequest req) {
        return auth.refresh(req.refreshToken());
    }

    @PostMapping("/auth/logout")
    public ResponseEntity<Void> logout(@RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody(required = false) RefreshRequest req) {
        String bearer = authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7) : null;
        auth.logout(bearer, req == null ? null : req.refreshToken());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/.well-known/jwks.json")
    public Map<String, Object> jwks() {
        return jwt.jwks();
    }

    record StepUpRequest(String customerId, String purpose, Map<String, Object> details) {
    }

    record StepUpVerifyRequest(String otpRef, String customerId, String purpose, String otp) {
    }

    /** Internal: step-up OTP for transfers and beneficiaries (called by transfer-service). */
    @PostMapping("/internal/otp/send")
    public Map<String, Object> sendOtp(@RequestBody StepUpRequest req) {
        var result = auth.sendStepUpOtp(req.customerId(), req.purpose(), req.details());
        return Map.of("otpRef", result.loginToken(), "expiresInSeconds", result.otpExpiresInSeconds());
    }

    @PostMapping("/internal/otp/verify")
    public Map<String, Object> verifyOtp(@RequestBody StepUpVerifyRequest req) {
        auth.verifyStepUpOtp(req.otpRef(), req.customerId(), req.purpose(), req.otp());
        return Map.of("verified", true);
    }

    /** Internal (not routed by the gateway): used by the seed job. */
    @PostMapping("/internal/credentials")
    public ResponseEntity<Map<String, Object>> createCredential(@RequestBody CredentialRequest req) {
        boolean created = auth.createCredential(req.customerId(), req.password());
        return ResponseEntity.status(created ? HttpStatus.CREATED : HttpStatus.OK)
                .body(Map.of("customerId", req.customerId(), "created", created));
    }
}
