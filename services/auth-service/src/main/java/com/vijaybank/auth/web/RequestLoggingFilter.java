package com.vijaybank.auth.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Puts requestId / customerId into the logging context and writes one access-log line per request. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger("access");

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String requestId = req.getHeader("X-Request-Id");
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString().replace("-", "");
        }
        MDC.put("requestId", requestId);
        String customerId = req.getHeader("X-Customer-Id");
        if (customerId != null) {
            MDC.put("customerId", customerId);
        }
        res.setHeader("X-Request-Id", requestId);
        long start = System.nanoTime();
        try {
            chain.doFilter(req, res);
        } finally {
            if (!req.getRequestURI().startsWith("/health")) {
                log.info("request method={} path={} status={} durationMs={}", req.getMethod(), req.getRequestURI(),
                        res.getStatus(), (System.nanoTime() - start) / 1_000_000);
            }
            MDC.clear();
        }
    }
}
