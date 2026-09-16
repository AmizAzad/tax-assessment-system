package com.iris.taxassessment.bpmn.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Obtains the engine's own access token.
 *
 * <p>Plan reference: V2 sections 5.3, 6.1; ADR-002, ADR-003.
 *
 * <h2>Why a service account rather than a shared secret</h2>
 *
 * <p>The delegate previously sent a static string as a bearer token. The API
 * verifies Keycloak-issued JWTs, so every call was refused with a 401, and the
 * process turned that into an unhandled error and failed to start.
 *
 * <p>The shortcut would have been to teach the API to accept that string and
 * skip authorisation. That gives the engine unlimited access to every endpoint
 * on the strength of a value in a config file, and leaves nothing in the audit
 * trail to distinguish it from a person. Instead the engine authenticates as
 * itself, holds one role, and that role is granted only the routes the shipped
 * process definition calls.
 *
 * <h2>Caching, and why it expires early</h2>
 *
 * <p>A token is fetched once and reused until shortly before it expires.
 * Refreshing sixty seconds early avoids the case where a token passes the
 * check here and expires in flight, which would surface as an intermittent 401
 * on a service task and be extremely tedious to diagnose.
 *
 * <h2>Why failures are loud</h2>
 *
 * <p>If a token cannot be obtained, every service task in every process will
 * fail. That is worth an error in the log rather than a silent fallback to an
 * unauthenticated call, which would produce the same 401 the fallback was
 * meant to avoid.
 */
@Component
public class ServiceAccountTokenProvider {

    private static final Logger log = LoggerFactory.getLogger(ServiceAccountTokenProvider.class);

    /** Refreshed this long before the token actually expires. */
    private static final Duration EXPIRY_MARGIN = Duration.ofSeconds(60);

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient;
    private final ReentrantLock lock = new ReentrantLock();

    private final String tokenUrl;
    private final String clientId;
    private final String clientSecret;
    private final String staticToken;

    private String cachedToken;
    private Instant expiresAt = Instant.EPOCH;

    public ServiceAccountTokenProvider(
            @Value("${tas.auth.token-url:}") String tokenUrl,
            @Value("${tas.auth.client-id:tas-bpmn}") String clientId,
            @Value("${tas.auth.client-secret:}") String clientSecret,
            @Value("${tas.api.service-token:}") String staticToken) {
        this.tokenUrl = tokenUrl;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        // Retained only so a test harness can inject a token directly. It is
        // not a supported deployment configuration.
        this.staticToken = staticToken;
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    /**
     * A bearer token for the API, or {@code null} if none is configured.
     *
     * <p>Null rather than an exception when nothing is configured at all: a
     * deployment running the engine against an API with authentication
     * disabled is a legitimate test setup, and the call will fail on its own
     * merits if it is not.
     */
    public String token() {
        if (!staticToken.isBlank()) {
            return staticToken;
        }
        if (tokenUrl.isBlank() || clientSecret.isBlank()) {
            return null;
        }

        lock.lock();
        try {
            if (cachedToken != null && Instant.now().isBefore(expiresAt)) {
                return cachedToken;
            }
            return fetch();
        } finally {
            lock.unlock();
        }
    }

    private String fetch() {
        String form = "grant_type=client_credentials"
                + "&client_id=" + urlEncode(clientId)
                + "&client_secret=" + urlEncode(clientSecret);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(tokenUrl))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form, StandardCharsets.UTF_8))
                .build();

        try {
            HttpResponse<String> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                log.error(
                        "Could not obtain a service token for {}: HTTP {}. Every service task "
                                + "will fail until this is fixed.",
                        clientId,
                        response.statusCode());
                return null;
            }

            var payload = objectMapper.readTree(response.body());
            String token = payload.path("access_token").asText(null);
            long expiresIn = payload.path("expires_in").asLong(300L);

            if (token == null || token.isBlank()) {
                log.error("The token endpoint returned no access_token for {}", clientId);
                return null;
            }

            cachedToken = token;
            expiresAt = Instant.now().plusSeconds(expiresIn).minus(EXPIRY_MARGIN);
            log.info("Obtained a service token for {}, valid for {}s", clientId, expiresIn);
            return cachedToken;

        } catch (Exception exception) {
            // Interrupted status restored: swallowing it would leave the
            // executor thread in a state later code cannot reason about.
            if (exception instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            log.error("Could not obtain a service token for {}: {}", clientId, exception.toString());
            return null;
        }
    }

    private static String urlEncode(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
