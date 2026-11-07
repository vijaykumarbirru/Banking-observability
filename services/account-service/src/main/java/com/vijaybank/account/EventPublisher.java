package com.vijaybank.account;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;

/** Publishes domain events to the vijaybank.events topic exchange and waits for the broker's confirm. */
@Component
public class EventPublisher {

    static final String EXCHANGE = "vijaybank.events";

    private final RabbitTemplate rabbit;

    public EventPublisher(RabbitTemplate rabbit) {
        this.rabbit = rabbit;
    }

    public void publish(String type, String customerId, Map<String, Object> data) {
        String eventId = UUID.randomUUID().toString();
        String requestId = MDC.get("requestId");
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("eventId", eventId);
        event.put("type", type);
        event.put("occurredAt", Instant.now().toString());
        event.put("customerId", customerId);
        event.put("requestId", requestId);
        event.put("data", data);

        rabbit.invoke(t -> {
            t.convertAndSend(EXCHANGE, type, event, m -> {
                m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                m.getMessageProperties().setMessageId(eventId);
                if (requestId != null) {
                    m.getMessageProperties().setHeader("x-request-id", requestId);
                }
                return m;
            });
            t.waitForConfirmsOrDie(5_000);
            return null;
        });
    }
}
