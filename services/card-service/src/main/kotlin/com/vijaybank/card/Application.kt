// card-service: debit and credit cards. Blocking is instant (no OTP, so a
// customer with a lost card is never slowed down); unblocking, raising a
// limit or enabling international use needs a step-up OTP.
package com.vijaybank.card

import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.rabbitmq.client.AMQP
import com.rabbitmq.client.Channel
import com.rabbitmq.client.ConnectionFactory
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.jackson.jackson
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.callid.CallId
import io.ktor.server.plugins.callid.callId
import io.ktor.server.plugins.callid.callIdMdc
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.header
import io.ktor.server.request.path
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory
import org.slf4j.event.Level
import com.fasterxml.jackson.databind.ObjectMapper
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation as ClientNegotiation

class ApiException(val status: HttpStatusCode, val code: String, message: String, val details: Map<String, Any?> = emptyMap()) :
    RuntimeException(message)

private val log = LoggerFactory.getLogger("card-service")
private fun env(key: String, def: String) = System.getenv(key)?.takeIf { it.isNotBlank() } ?: def

data class BlockRequest(val reason: String? = null)
data class OtpStart(val purpose: String? = null)
data class UnblockRequest(val otpRef: String? = null, val otp: String? = null)
data class ControlsRequest(
    val otpRef: String? = null,
    val otp: String? = null,
    val atmLimitPaise: Long,
    val posLimitPaise: Long,
    val onlineLimitPaise: Long,
    val internationalEnabled: Boolean,
    val contactlessEnabled: Boolean,
)
data class SeedRequest(val customerId: String, val accountNo: String?, val type: String, val holderName: String,
                       val creditLimitPaise: Long? = null, val outstandingPaise: Long? = null)

/** Publishes card.* events with publisher confirms. */
class Events(private val factory: ConnectionFactory) {
    private val mapper = ObjectMapper().registerModule(JavaTimeModule())
    private var channel: Channel? = null

    @Synchronized
    fun publish(type: String, customerId: String, requestId: String?, data: Map<String, Any?>) {
        val eventId = UUID.randomUUID().toString()
        val body = mapper.writeValueAsBytes(mapOf("eventId" to eventId, "type" to type, "occurredAt" to Instant.now().toString(),
            "customerId" to customerId, "requestId" to requestId, "data" to data))
        val props = AMQP.BasicProperties.Builder().contentType("application/json").deliveryMode(2).messageId(eventId)
            .headers(mapOf("x-request-id" to (requestId ?: ""))).build()
        try {
            val ch = channel?.takeIf { it.isOpen } ?: factory.newConnection("card-service").createChannel().also {
                it.confirmSelect()
                channel = it
            }
            ch.basicPublish("vijaybank.events", type, props, body)
            ch.waitForConfirmsOrDie(5000)
        } catch (e: Exception) {
            channel = null
            log.error("could not publish {}", type, e) // notification only; the card change itself is done
        }
    }
}

fun main() {
    embeddedServer(Netty, port = env("PORT", "8091").toInt(), module = Application::module).start(wait = true)
}

fun Application.module() {
    val repo = CardRepository(
        env("DATABASE_URL", "jdbc:postgresql://postgres:5432/card"), env("DATABASE_USER", "card_svc"), env("DATABASE_PASSWORD", "card_pw"),
    )
    repo.migrate()
    val events = Events(ConnectionFactory().apply {
        host = env("RABBITMQ_HOST", "rabbitmq")
        username = env("RABBITMQ_USER", "vijaybank")
        password = env("RABBITMQ_PASSWORD", "vijaybank_pw")
        isAutomaticRecoveryEnabled = true
    })
    val authUrl = env("AUTH_URL", "http://auth-service:8081")
    val http = HttpClient(CIO) {
        install(ClientNegotiation) { jackson() }
        install(HttpTimeout) { requestTimeoutMillis = 5000 }
        expectSuccess = false
    }

    install(CallId) {
        retrieveFromHeader("X-Request-Id")
        generate { UUID.randomUUID().toString().replace("-", "") }
        replyToHeader("X-Request-Id")
    }
    install(CallLogging) {
        level = Level.INFO
        callIdMdc("requestId")
        mdc("customerId") { it.request.header("X-Customer-Id") }
        filter { !it.request.path().startsWith("/health") }
    }
    install(ContentNegotiation) {
        jackson {
            registerModule(JavaTimeModule())
            disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        }
    }
    install(StatusPages) {
        exception<ApiException> { call, e ->
            call.respond(e.status, mapOf("error" to mapOf("code" to e.code, "message" to e.message, "requestId" to call.callId) + e.details))
        }
        exception<Throwable> { call, e ->
            log.error("unhandled error", e)
            call.respond(HttpStatusCode.InternalServerError, mapOf("error" to mapOf("code" to "INTERNAL_ERROR",
                "message" to "Something went wrong. Please try again.", "requestId" to call.callId)))
        }
    }

    fun ApplicationCall.customer(): String =
        request.header("X-Customer-Id")?.takeIf { it.isNotBlank() } ?: throw ApiException(HttpStatusCode.Unauthorized, "UNAUTHENTICATED", "Login required.")

    suspend fun ApplicationCall.card(): Card {
        val id = runCatching { UUID.fromString(parameters["id"]) }.getOrNull()
            ?: throw ApiException(HttpStatusCode.NotFound, "CARD_NOT_FOUND", "Card not found.")
        return withContext(Dispatchers.IO) { repo.find(id, customer()) }
            ?: throw ApiException(HttpStatusCode.NotFound, "CARD_NOT_FOUND", "Card not found.")
    }

    /** Verifies a step-up OTP with auth-service; its error (INVALID_OTP, OTP_EXPIRED…) is passed through. */
    suspend fun ApplicationCall.verifyOtp(otpRef: String?, otp: String?, purpose: String) {
        if (otpRef == null || otp == null) throw ApiException(HttpStatusCode.Unauthorized, "OTP_REQUIRED", "Please confirm with the OTP sent to your mobile.")
        val res = http.post("$authUrl/internal/otp/verify") {
            contentType(ContentType.Application.Json)
            header("X-Request-Id", callId)
            setBody(mapOf("otpRef" to otpRef, "customerId" to customer(), "purpose" to purpose, "otp" to otp))
        }
        if (res.status.value in 400..499) {
            @Suppress("UNCHECKED_CAST")
            val err = (res.body<Map<String, Any?>>()["error"] as? Map<String, Any?>).orEmpty()
            throw ApiException(res.status, err["code"] as? String ?: "INVALID_OTP", err["message"] as? String ?: "OTP verification failed.",
                err.filterKeys { it !in setOf("code", "message", "requestId") })
        }
        if (!res.status.isSuccess()) throw ApiException(HttpStatusCode.ServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "Could not verify the OTP. Please try again.")
    }

    routing {
        get("/health/live") { call.respond(mapOf("status" to "UP")) }
        get("/health/ready") {
            if (repo.ping()) call.respond(mapOf("status" to "UP")) else call.respond(HttpStatusCode.ServiceUnavailable, mapOf("status" to "DOWN"))
        }

        get("/cards") {
            val cid = call.customer()
            call.respond(withContext(Dispatchers.IO) { repo.byCustomer(cid) }.map { it.view() })
        }

        post("/cards/{id}/block") {
            val card = call.card()
            val reason = (call.receive<BlockRequest>().reason ?: "TEMPORARY").uppercase()
            if (reason !in setOf("TEMPORARY", "LOST", "STOLEN", "DAMAGED")) throw ApiException(HttpStatusCode.BadRequest, "INVALID_REQUEST", "Choose a reason: temporary, lost, stolen or damaged.")
            val target = if (reason == "TEMPORARY") "BLOCKED" else "HOTLISTED"
            if (card.status == "HOTLISTED") throw ApiException(HttpStatusCode.Conflict, "CARD_HOTLISTED", "This card is already permanently blocked.")
            val moved = withContext(Dispatchers.IO) { repo.setStatus(card.id, card.status, target, reason) }
            if (moved) {
                log.info("card blocked cardId={} reason={}", card.id, reason)
                events.publish("card.blocked", card.customerId, call.callId, mapOf("cardId" to card.id, "last4" to card.last4,
                    "type" to card.type, "reason" to reason, "permanent" to (target == "HOTLISTED")))
            }
            call.respond(withContext(Dispatchers.IO) { repo.find(card.id, card.customerId) }!!.view())
        }

        post("/cards/{id}/otp") {
            val card = call.card()
            val purpose = call.receive<OtpStart>().purpose ?: "CARD_CONTROLS"
            if (purpose !in setOf("CARD_UNBLOCK", "CARD_CONTROLS")) throw ApiException(HttpStatusCode.BadRequest, "INVALID_REQUEST", "Unknown purpose.")
            val res = http.post("$authUrl/internal/otp/send") {
                contentType(ContentType.Application.Json)
                header("X-Request-Id", call.callId)
                setBody(mapOf("customerId" to card.customerId, "purpose" to purpose, "details" to mapOf("last4" to card.last4, "cardType" to card.type)))
            }
            if (!res.status.isSuccess()) throw ApiException(HttpStatusCode.ServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "Could not send the OTP. Please try again.")
            call.respond(res.body<Map<String, Any?>>())
        }

        post("/cards/{id}/unblock") {
            val card = call.card()
            val req = call.receive<UnblockRequest>()
            when (card.status) {
                "HOTLISTED" -> throw ApiException(HttpStatusCode.Conflict, "CARD_HOTLISTED", "Cards reported lost or stolen cannot be unblocked. A replacement will be sent.")
                "ACTIVE" -> return@post call.respond(card.view())
            }
            call.verifyOtp(req.otpRef, req.otp, "CARD_UNBLOCK")
            if (withContext(Dispatchers.IO) { repo.setStatus(card.id, "BLOCKED", "ACTIVE", null) }) {
                events.publish("card.unblocked", card.customerId, call.callId, mapOf("cardId" to card.id, "last4" to card.last4, "type" to card.type))
            }
            call.respond(withContext(Dispatchers.IO) { repo.find(card.id, card.customerId) }!!.view())
        }

        put("/cards/{id}/controls") {
            val card = call.card()
            if (card.status != "ACTIVE") throw ApiException(HttpStatusCode.Conflict, "CARD_NOT_ACTIVE", "Unblock the card before changing its controls.")
            val req = call.receive<ControlsRequest>()
            val next = Controls(req.atmLimitPaise, req.posLimitPaise, req.onlineLimitPaise, req.internationalEnabled, req.contactlessEnabled)
            val caps = card.caps()
            if (listOf(next.atmLimitPaise, next.posLimitPaise, next.onlineLimitPaise).any { it < 0 } ||
                next.atmLimitPaise > caps.atmLimitPaise || next.posLimitPaise > caps.posLimitPaise || next.onlineLimitPaise > caps.onlineLimitPaise
            ) throw ApiException(HttpStatusCode.UnprocessableEntity, "LIMIT_OUT_OF_RANGE", "A limit is above what this card allows.", mapOf("caps" to caps))
            val cur = card.controls
            // Lowering limits or switching features off is always safe; anything that raises risk needs an OTP.
            val riskier = next.atmLimitPaise > cur.atmLimitPaise || next.posLimitPaise > cur.posLimitPaise ||
                next.onlineLimitPaise > cur.onlineLimitPaise || (next.internationalEnabled && !cur.internationalEnabled) ||
                (next.contactlessEnabled && !cur.contactlessEnabled)
            if (riskier) call.verifyOtp(req.otpRef, req.otp, "CARD_CONTROLS")
            withContext(Dispatchers.IO) { repo.setControls(card.id, next) }
            events.publish("card.limit.changed", card.customerId, call.callId, mapOf("cardId" to card.id, "last4" to card.last4,
                "type" to card.type, "controls" to next, "otpVerified" to riskier))
            call.respond(withContext(Dispatchers.IO) { repo.find(card.id, card.customerId) }!!.view())
        }

        post("/internal/cards") {
            val r = call.receive<SeedRequest>()
            val created = withContext(Dispatchers.IO) { repo.insert(r.customerId, r.accountNo, r.type, r.holderName, r.creditLimitPaise, r.outstandingPaise) }
            call.respond(mapOf("created" to created))
        }
    }
    log.info("card-service ready")
}
