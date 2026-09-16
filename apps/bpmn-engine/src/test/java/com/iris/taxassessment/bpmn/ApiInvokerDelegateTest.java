package com.iris.taxassessment.bpmn;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.runtime.ProcessInstance;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The apiInvoker delegate, exercised inside a real engine.
 *
 * <p>Plan reference: V2 section 5.3; ADR-002.
 *
 * <p>A stub HTTP server stands in for the API, so the test asserts what the
 * delegate actually puts on the wire -- headers, body, idempotency key -- and
 * how it reacts to each class of response. A mocked delegate would prove
 * nothing about the thing the plan singles out.
 */
@SpringBootTest
@ActiveProfiles("test")
class ApiInvokerDelegateTest {

    private static HttpServer server;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Every request the stub received, for assertions. */
    private static final List<RecordedRequest> RECEIVED = new CopyOnWriteArrayList<>();

    /** Status the stub returns next. Mutated per test. */
    private static final AtomicInteger RESPONSE_STATUS = new AtomicInteger(200);
    private static volatile String responseBody = "{\"ok\":true}";

    record RecordedRequest(String method, String path, String body, Map<String, String> headers) {}

    @BeforeAll
    static void startStub() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> headers = new java.util.HashMap<>();
            exchange.getRequestHeaders()
                    .forEach((key, values) -> headers.put(key.toLowerCase(), values.get(0)));

            RECEIVED.add(new RecordedRequest(
                    exchange.getRequestMethod(), exchange.getRequestURI().getPath(), body, headers));

            int status = RESPONSE_STATUS.get();
            byte[] payload = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, payload.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(payload);
            }
        });
        server.start();
    }

    @AfterAll
    static void stopStub() {
        server.stop(0);
    }

    @DynamicPropertySource
    static void apiBaseUrl(DynamicPropertyRegistry registry) {
        registry.add("tas.api.base-url", () -> "http://localhost:" + server.getAddress().getPort());
    }

    @Autowired private RepositoryService repositoryService;
    @Autowired private RuntimeService runtimeService;
    @Autowired private HistoryService historyService;

    private void deployTestProcess() {
        repositoryService.createDeployment()
                .addClasspathResource("test-api-invoker.bpmn20.xml")
                .deploy();
    }

    private void reset(int status, String body) {
        RECEIVED.clear();
        RESPONSE_STATUS.set(status);
        responseBody = body;
    }

    @Test
    void callsTheConfiguredEndpointAndCompletes() throws Exception {
        reset(200, "{\"netPayable\":\"1234.50\"}");
        deployTestProcess();

        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
                "apiInvokerTest", "TA-2026-00000001", Map.of("caseId", 42));

        assertThat(RECEIVED).hasSize(1);
        RecordedRequest request = RECEIVED.get(0);
        assertThat(request.method()).isEqualTo("POST");
        assertThat(request.path()).isEqualTo("/api/v1/test");

        // The process ran to completion: a service task that calls out is not
        // a wait state.
        assertThat(runtimeService.createProcessInstanceQuery()
                .processInstanceId(instance.getId()).singleResult()).isNull();

        // The response was stored in the declared output variable, parsed, so
        // a later gateway can branch on a field of it.
        var historic = historyService.createHistoricVariableInstanceQuery()
                .processInstanceId(instance.getId())
                .variableName("apiResult")
                .singleResult();
        assertThat(historic).isNotNull();
        assertThat(historic.getValue()).isInstanceOf(Map.class);
        assertThat(((Map<?, ?>) historic.getValue()).get("netPayable")).isEqualTo("1234.50");
    }

    @Test
    void sendsCorrelationAndIdempotencyHeaders() {
        reset(200, "{}");
        deployTestProcess();

        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
                "apiInvokerTest", "TA-2026-00000002", Map.of());

        RecordedRequest request = RECEIVED.get(0);
        // Without an idempotency key, a retried generateNotice issues a second
        // notice and a retried postLiability posts twice.
        assertThat(request.headers()).containsKey("idempotency-key");
        assertThat(request.headers().get("idempotency-key")).isNotBlank();
        assertThat(request.headers().get("x-process-instance-id")).isEqualTo(instance.getId());
        assertThat(request.headers().get("x-business-key")).isEqualTo("TA-2026-00000002");
        assertThat(request.headers().get("content-type")).isEqualTo("application/json");
    }

    @Test
    void derivesADifferentIdempotencyKeyPerProcessInstance() {
        reset(200, "{}");
        deployTestProcess();

        runtimeService.startProcessInstanceByKey("apiInvokerTest", "TA-A", Map.of());
        runtimeService.startProcessInstanceByKey("apiInvokerTest", "TA-B", Map.of());

        assertThat(RECEIVED).hasSize(2);
        String first = RECEIVED.get(0).headers().get("idempotency-key");
        String second = RECEIVED.get(1).headers().get("idempotency-key");
        // Two genuinely different pieces of work must not dedupe against each
        // other.
        assertThat(first).isNotEqualTo(second);
    }

    @Test
    void includesProcessContextInTheDefaultBody() throws Exception {
        reset(200, "{}");
        deployTestProcess();

        runtimeService.startProcessInstanceByKey(
                "apiInvokerTest", "TA-2026-00000003", Map.of("caseId", 99, "taxTypeCode", "CIT"));

        Map<?, ?> body = MAPPER.readValue(RECEIVED.get(0).body(), Map.class);
        assertThat(body.get("businessKey")).isEqualTo("TA-2026-00000003");
        assertThat(body.get("activityId")).isEqualTo("callApi");
        assertThat(((Map<?, ?>) body.get("variables")).get("caseId")).isEqualTo(99);
        assertThat(((Map<?, ?>) body.get("variables")).get("taxTypeCode")).isEqualTo("CIT");
    }

    @Test
    void raisesABpmnErrorOnAPermanentFailure() {
        // A 4xx will be rejected again on retry, so it must not be retried. It
        // becomes a BPMN error the process can route to a manual task.
        reset(422, "{\"error\":\"rule set not effective for the period\"}");
        deployTestProcess();

        assertThatThrownBy(() ->
                runtimeService.startProcessInstanceByKey("apiInvokerTest", "TA-FAIL-4XX", Map.of()))
                .hasMessageContaining("API_INVOCATION_FAILED");
    }

    @Test
    void throwsForRetryOnATransientFailure() {
        // A 5xx is transient: throw so Flowable's async executor retries with
        // backoff rather than abandoning the case.
        reset(503, "{\"error\":\"temporarily unavailable\"}");
        deployTestProcess();

        assertThatThrownBy(() ->
                runtimeService.startProcessInstanceByKey("apiInvokerTest", "TA-FAIL-5XX", Map.of()))
                .hasMessageContaining("503");
    }
}
