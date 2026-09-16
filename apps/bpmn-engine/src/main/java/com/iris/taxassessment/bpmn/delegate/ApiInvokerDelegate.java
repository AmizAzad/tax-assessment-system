package com.iris.taxassessment.bpmn.delegate;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.flowable.common.engine.api.delegate.Expression;
import org.flowable.engine.delegate.BpmnError;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.iris.taxassessment.bpmn.auth.ServiceAccountTokenProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

/**
 * A generic service task that calls back into the API.
 *
 * <p>Plan reference: V2 section 5.3; ADR-002.
 *
 * <p>This is the component the plan singles out. In the platform V1 was
 * written against, service tasks could only update a status, so calling an
 * arbitrary API from a process was impossible and every system step had to be
 * faked as an auto-completed user task. The plan calls for building this in
 * Phase 1 rather than deferring it, and this is it.
 *
 * <p>Authored in BPMN as:
 *
 * <pre>{@code
 * <serviceTask id="calculate" flowable:delegateExpression="${apiInvoker}">
 *   <extensionElements>
 *     <flowable:field name="endpoint">
 *       <flowable:string>/api/v1/cases/${caseId}/calculate</flowable:string>
 *     </flowable:field>
 *     <flowable:field name="method"><flowable:string>POST</flowable:string></flowable:field>
 *     <flowable:field name="outputVariable">
 *       <flowable:string>calculationResult</flowable:string>
 *     </flowable:field>
 *   </extensionElements>
 * </serviceTask>
 * }</pre>
 *
 * <h2>Idempotency</h2>
 *
 * <p>Flowable retries a failed async job. Without an idempotency key, a retried
 * {@code generateNotice} issues a second notice and a retried
 * {@code postLiability} posts the liability twice. The key is derived from the
 * process instance and the activity id, so every retry of the same step
 * carries the same key and the API can dedupe.
 *
 * <h2>Failure handling</h2>
 *
 * <p>A 4xx is a permanent failure: retrying a rejected request will be rejected
 * again. It raises a {@link BpmnError} so the process can route to a manual
 * exception task. A 5xx or a timeout is transient and throws, letting
 * Flowable's async executor retry with backoff.
 */
@Component("apiInvoker")
public class ApiInvokerDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(ApiInvokerDelegate.class);

    /** Raised for a permanent failure, so a process can catch it and route to a manual task. */
    public static final String ERROR_CODE_PERMANENT = "API_INVOCATION_FAILED";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient;
    private final String apiBaseUrl;
    private final ServiceAccountTokenProvider tokens;

    // Populated by Flowable from <flowable:field> elements.
    private Expression endpoint;
    private Expression method;
    private Expression inputExpression;
    private Expression outputVariable;
    private Expression timeoutSeconds;

    public ApiInvokerDelegate(
            @Value("${tas.api.base-url:http://localhost:3000}") String apiBaseUrl,
            ServiceAccountTokenProvider tokens) {
        this.apiBaseUrl = apiBaseUrl;
        this.tokens = tokens;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public void execute(DelegateExecution execution) {
        String resolvedEndpoint = requireString(endpoint, execution, "endpoint");
        String httpMethod = optionalString(method, execution, "POST").toUpperCase();
        String body = buildRequestBody(execution);
        String idempotencyKey = idempotencyKeyFor(execution);
        int timeout = parseTimeout(optionalString(timeoutSeconds, execution, "30"));

        URI uri = URI.create(apiBaseUrl + resolvedEndpoint);

        log.info("apiInvoker {} {} [process={} activity={} idempotency={}]",
                httpMethod, resolvedEndpoint, execution.getProcessInstanceId(),
                execution.getCurrentActivityId(), idempotencyKey);

        HttpRequest.Builder request = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(Duration.ofSeconds(timeout))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", idempotencyKey)
                // Correlates the call with the process instance that made it,
                // so an API trace can be tied back to a workflow step.
                .header("X-Correlation-Id", execution.getProcessInstanceId())
                .header("X-Process-Instance-Id", execution.getProcessInstanceId())
                .header("X-Business-Key", nullSafe(execution.getProcessInstanceBusinessKey()));

        // Fetched per call, and cached by the provider until shortly before
        // it expires. A token captured once at construction would work until
        // the first expiry and then fail every service task in every process.
        String token = tokens.token();
        if (token != null && !token.isBlank()) {
            request.header("Authorization", "Bearer " + token);
        }

        request.method(httpMethod, body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body));

        HttpResponse<String> response;
        try {
            response = httpClient.send(request.build(), HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ApiInvocationException("Interrupted calling " + resolvedEndpoint, interrupted);
        } catch (Exception transientFailure) {
            // Network-level failure. Transient by assumption: let the async
            // executor retry rather than failing the process instance.
            throw new ApiInvocationException(
                    "Transient failure calling " + resolvedEndpoint, transientFailure);
        }

        int status = response.statusCode();

        if (status >= 400 && status < 500) {
            // Permanent. Retrying a rejected request gets it rejected again, so
            // surface it as a BPMN error the process can route on.
            log.warn("apiInvoker permanent failure {} {} -> {}", httpMethod, resolvedEndpoint, status);
            throw new BpmnError(ERROR_CODE_PERMANENT,
                    "API returned " + status + " for " + httpMethod + " " + resolvedEndpoint);
        }

        if (status >= 500) {
            throw new ApiInvocationException(
                    "API returned " + status + " for " + httpMethod + " " + resolvedEndpoint, null);
        }

        storeOutput(execution, response.body());
    }

    /**
     * The request body.
     *
     * <p>When {@code inputExpression} is set, its resolved value is sent.
     * Otherwise the process variables that the API needs are sent, which keeps
     * simple service tasks free of boilerplate.
     */
    private String buildRequestBody(DelegateExecution execution) {
        if (inputExpression != null) {
            Object resolved = inputExpression.getValue(execution);
            if (resolved == null) {
                return null;
            }
            if (resolved instanceof String text) {
                return text;
            }
            return writeJson(resolved);
        }

        Map<String, Object> variables = execution.getVariables();
        return writeJson(Map.of(
                "processInstanceId", execution.getProcessInstanceId(),
                "businessKey", nullSafe(execution.getProcessInstanceBusinessKey()),
                "activityId", nullSafe(execution.getCurrentActivityId()),
                "variables", variables));
    }

    /**
     * Store the response, if the task asked for it.
     *
     * <p>A JSON object is stored as a Map so a later gateway can branch on a
     * field of it; anything else is stored as the raw string.
     */
    private void storeOutput(DelegateExecution execution, String responseBody) {
        if (outputVariable == null) {
            return;
        }
        String variableName = String.valueOf(outputVariable.getValue(execution));
        if (variableName.isBlank()) {
            return;
        }
        if (responseBody == null || responseBody.isBlank()) {
            execution.setVariable(variableName, null);
            return;
        }
        try {
            execution.setVariable(variableName, objectMapper.readValue(responseBody, Map.class));
        } catch (Exception notJson) {
            execution.setVariable(variableName, responseBody);
        }
    }

    /**
     * A key stable across retries of the same step, distinct across different steps.
     *
     * <p>Process instance plus activity id: Flowable retries the same activity
     * of the same instance, so both retries produce the same key and the API
     * returns the stored result instead of acting twice.
     */
    private String idempotencyKeyFor(DelegateExecution execution) {
        String seed = execution.getProcessInstanceId() + ":" + execution.getCurrentActivityId();
        return UUID.nameUUIDFromBytes(seed.getBytes()).toString();
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new ApiInvocationException("Could not serialise request body", e);
        }
    }

    private String requireString(Expression expression, DelegateExecution execution, String name) {
        if (expression == null) {
            throw new ApiInvocationException(
                    "Service task is missing the required field '" + name + "'", null);
        }
        Object value = expression.getValue(execution);
        if (value == null || String.valueOf(value).isBlank()) {
            throw new ApiInvocationException("Field '" + name + "' resolved to empty", null);
        }
        return String.valueOf(value);
    }

    private String optionalString(Expression expression, DelegateExecution execution, String fallback) {
        if (expression == null) {
            return fallback;
        }
        Object value = expression.getValue(execution);
        return value == null || String.valueOf(value).isBlank() ? fallback : String.valueOf(value);
    }

    private int parseTimeout(String raw) {
        try {
            int parsed = Integer.parseInt(raw);
            return parsed > 0 && parsed <= 300 ? parsed : 30;
        } catch (NumberFormatException e) {
            return 30;
        }
    }

    private static String nullSafe(String value) {
        return value == null ? "" : value;
    }

    /** Transient failure: Flowable retries. */
    public static class ApiInvocationException extends RuntimeException {
        public ApiInvocationException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    // --- setters used by Flowable field injection ---
    public void setEndpoint(Expression endpoint) { this.endpoint = endpoint; }
    public void setMethod(Expression method) { this.method = method; }
    public void setInputExpression(Expression inputExpression) { this.inputExpression = inputExpression; }
    public void setOutputVariable(Expression outputVariable) { this.outputVariable = outputVariable; }
    public void setTimeoutSeconds(Expression timeoutSeconds) { this.timeoutSeconds = timeoutSeconds; }
}
