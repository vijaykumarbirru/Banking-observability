package com.vijaybank.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.text.ParseException;
import java.time.Instant;
import java.util.Date;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Issues RS256 access tokens. The key pair lives in memory: a restart rotates
 * the key and invalidates existing sessions, which is acceptable for the lab.
 * The API gateway verifies tokens with the public key from {@link #jwks()}.
 */
@Service
public class JwtService {

    public static final String ISSUER = "vijaybank-auth";

    public record AccessToken(String value, String jti, Instant expiresAt) {
    }

    private final RSAKey key;
    private final AuthProperties props;

    public JwtService(AuthProperties props) throws JOSEException {
        this.props = props;
        this.key = new RSAKeyGenerator(2048)
                .keyID(UUID.randomUUID().toString())
                .keyUse(KeyUse.SIGNATURE)
                .algorithm(JWSAlgorithm.RS256)
                .generate();
    }

    public AccessToken issue(String customerId) {
        Instant now = Instant.now();
        Instant exp = now.plus(props.accessTokenTtl());
        String jti = UUID.randomUUID().toString();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer(ISSUER)
                .subject(customerId)
                .jwtID(jti)
                .issueTime(Date.from(now))
                .expirationTime(Date.from(exp))
                .build();
        SignedJWT jwt = new SignedJWT(
                new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID()).type(JOSEObjectType.JWT).build(),
                claims);
        try {
            jwt.sign(new RSASSASigner(key));
        } catch (JOSEException e) {
            throw new IllegalStateException("token signing failed", e);
        }
        return new AccessToken(jwt.serialize(), jti, exp);
    }

    /** Returns the verified claims, or null when the token is not ours or is malformed. */
    public JWTClaimsSet verify(String token) {
        try {
            SignedJWT jwt = SignedJWT.parse(token);
            if (!jwt.verify(new RSASSAVerifier(key.toRSAPublicKey()))) {
                return null;
            }
            return jwt.getJWTClaimsSet();
        } catch (ParseException | JOSEException e) {
            return null;
        }
    }

    public Map<String, Object> jwks() {
        return new JWKSet(key.toPublicJWK()).toJSONObject();
    }
}
