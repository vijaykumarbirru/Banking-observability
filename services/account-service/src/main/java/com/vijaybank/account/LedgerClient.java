package com.vijaybank.account;

import com.vijaybank.account.web.ApiException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Reads balances and entries from ledger-service, forwarding the request ID. */
@Component
public class LedgerClient {

    private static final Logger log = LoggerFactory.getLogger(LedgerClient.class);

    public record Balance(String accountNo, long balancePaise, String currency) {
    }

    private final RestClient http;

    public LedgerClient(@Value("${vijaybank.ledger-url}") String baseUrl) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(2));
        factory.setReadTimeout(Duration.ofSeconds(5));
        this.http = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory)
                .requestInterceptor((req, body, exec) -> {
                    String rid = MDC.get("requestId");
                    if (rid != null) {
                        req.getHeaders().set("X-Request-Id", rid);
                    }
                    return exec.execute(req, body);
                })
                .build();
    }

    public List<Balance> balances(List<String> accountNos) {
        if (accountNos.isEmpty()) {
            return List.of();
        }
        try {
            return http.get().uri("/internal/balances?accounts={a}", String.join(",", accountNos))
                    .retrieve().body(new ParameterizedTypeReference<>() { });
        } catch (RestClientException e) {
            throw unavailable(e);
        }
    }

    public List<Map<String, Object>> entries(String accountNo, int limit) {
        try {
            return http.get().uri("/internal/accounts/{no}/entries?limit={l}", accountNo, limit)
                    .retrieve().body(new ParameterizedTypeReference<>() { });
        } catch (RestClientException e) {
            throw unavailable(e);
        }
    }

    private static ApiException unavailable(RestClientException e) {
        log.error("ledger-service call failed", e);
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "LEDGER_UNAVAILABLE",
                "Balances are temporarily unavailable. Please try again shortly.");
    }
}
