package com.iris.taxassessment.bpmn.listener;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.flowable.common.engine.api.delegate.event.FlowableEngineEntityEvent;
import org.flowable.common.engine.api.delegate.event.FlowableEngineEvent;
import org.flowable.common.engine.api.delegate.event.FlowableEvent;
import org.flowable.common.engine.api.delegate.event.FlowableEventListener;
import org.flowable.common.engine.api.delegate.event.FlowableEventType;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.identitylink.api.IdentityLink;
import org.flowable.common.engine.api.delegate.event.FlowableEngineEventType;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Publishes engine lifecycle events to the API.
 *
 * <p>Plan reference: V2 sections 5.1, 5.4, 5.5; ADR-002.
 *
 * <p>The API keeps a read model from these events so that the register, the
 * task inbox and the audit timeline can be answered in one SQL statement
 * alongside domain data. The engine's own tables remain the engine's business.
 *
 * <h2>This delivery is best-effort, and that is a known trade-off</h2>
 *
 * <p>Delivery is retried a few times and then given up on. It deliberately
 * does <em>not</em> fail the engine transaction: a webhook that can roll back a
 * process transition would make the API's availability a precondition for the
 * engine making progress, which is worse than a read model that briefly lags.
 *
 * <p>The consequences are handled elsewhere, by design:
 * <ul>
 *   <li>a reconciliation job compares engine state with the read model and
 *       alerts on divergence (plan 5.5)</li>
 *   <li>the <em>domain event ledger</em>, not this read model, is the audit
 *       system of record (plan 19.2)</li>
 * </ul>
 */
@Component
public class WorkflowEventListener implements FlowableEventListener {

    private static final Logger log = LoggerFactory.getLogger(WorkflowEventListener.class);
    private static final int MAX_ATTEMPTS = 3;

    /**
     * Resolved lazily, on purpose.
     *
     * <p>This listener configures the engine, and the engine creates
     * RuntimeService -- injecting it directly is a constructor cycle Spring
     * cannot resolve. ObjectProvider defers the lookup to the first event, by
     * which time the engine exists.
     */
    private final ObjectProvider<RuntimeService> runtimeServiceProvider;

    /**
     * Also lazily provided, and for the same reason as RuntimeService: a
     * listener that the engine constructs cannot take an engine service
     * directly without a constructor cycle.
     */
    private final ObjectProvider<TaskService> taskServiceProvider;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private final String webhookUrl;
    private final boolean enabled;

    public WorkflowEventListener(
            ObjectProvider<RuntimeService> runtimeServiceProvider,
            ObjectProvider<TaskService> taskServiceProvider,
            @Value("${tas.webhook.url}") String webhookUrl,
            @Value("${tas.webhook.enabled:true}") boolean enabled) {
        this.runtimeServiceProvider = runtimeServiceProvider;
        this.taskServiceProvider = taskServiceProvider;
        this.webhookUrl = webhookUrl;
        this.enabled = enabled;
    }

    @PostConstruct
    void announce() {
        log.info("Workflow events {} -> {}", enabled ? "enabled" : "disabled", webhookUrl);
    }

    @Override
    public void onEvent(FlowableEvent event) {
        if (!enabled || !(event instanceof FlowableEngineEvent engineEvent)) {
            return;
        }

        FlowableEventType type = event.getType();
        Map<String, Object> payload = new HashMap<>();
        payload.put("eventType", type.name());
        payload.put("occurredAt", Instant.now().toString());
        payload.put("processInstanceId", engineEvent.getProcessInstanceId());
        payload.put("processDefinitionId", engineEvent.getProcessDefinitionId());
        payload.put("executionId", engineEvent.getExecutionId());

        if (FlowableEngineEventType.PROCESS_STARTED.equals(type)
                || FlowableEngineEventType.PROCESS_COMPLETED.equals(type)
                || FlowableEngineEventType.PROCESS_CANCELLED.equals(type)) {
            enrichProcess(engineEvent, payload);
        }

        if (event instanceof FlowableEngineEntityEvent entityEvent
                && entityEvent.getEntity() instanceof Task task) {
            payload.put("taskId", task.getId());
            payload.put("taskName", task.getName());
            payload.put("taskDefinitionKey", task.getTaskDefinitionKey());
            payload.put("assignee", task.getAssignee());
            payload.put("dueDate", task.getDueDate());

            // The candidate groups are the whole point of a task inbox: the
            // API filters what an officer sees by the roles they hold. Without
            // them every task is created with no roles and appears in nobody's
            // inbox, which is indistinguishable from no work existing.
            //
            // Read through the identity links rather than from the definition,
            // so a group added at runtime is reflected too.
            payload.put("candidateGroups", candidateGroupsOf(task));
        }

        if (FlowableEngineEventType.ACTIVITY_STARTED.equals(type)
                || FlowableEngineEventType.ACTIVITY_COMPLETED.equals(type)) {
            // Activity id is carried on the event for activity types.
            payload.put("activityId", stringOf(engineEvent, "getActivityId"));
            payload.put("activityName", stringOf(engineEvent, "getActivityName"));
            payload.put("activityType", stringOf(engineEvent, "getActivityType"));
        }

        deliver(payload);
    }

    private void enrichProcess(FlowableEngineEvent event, Map<String, Object> payload) {
        try {
            RuntimeService runtimeService = runtimeServiceProvider.getIfAvailable();
            if (runtimeService == null) {
                return;
            }
            ProcessInstance instance = runtimeService.createProcessInstanceQuery()
                    .processInstanceId(event.getProcessInstanceId())
                    .singleResult();
            if (instance != null) {
                payload.put("businessKey", instance.getBusinessKey());
                payload.put("processDefinitionKey", instance.getProcessDefinitionKey());
            }
        } catch (Exception ignored) {
            // A completed instance is already gone from the runtime query. The
            // API can still correlate on processInstanceId.
        }
    }

    private void deliver(Map<String, Object> payload) {
        String body;
        try {
            body = objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            log.error("Could not serialise workflow event", e);
            return;
        }

        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(webhookUrl))
                        .timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();

                HttpResponse<String> response =
                        httpClient.send(request, HttpResponse.BodyHandlers.ofString());

                if (response.statusCode() < 300) {
                    return;
                }
                log.warn("Workflow event delivery attempt {} returned {}", attempt, response.statusCode());
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                log.warn("Workflow event delivery attempt {} failed: {}", attempt, e.getMessage());
            }
        }

        // Given up. The read model will lag until reconciliation repairs it;
        // failing the engine transaction here would be worse.
        log.error("Gave up delivering workflow event {} for instance {} after {} attempts",
                payload.get("eventType"), payload.get("processInstanceId"), MAX_ATTEMPTS);
    }

    /**
     * The groups a task is offered to.
     *
     * Returned as a list of role codes. An empty list is reported as such
     * rather than omitted: the API treats a task with no roles as a defect
     * worth logging, and it cannot do that if the field is simply absent.
     */
    private List<String> candidateGroupsOf(Task task) {
        TaskService taskService = taskServiceProvider.getIfAvailable();
        if (taskService == null) {
            return List.of();
        }
        try {
            return taskService.getIdentityLinksForTask(task.getId()).stream()
                    .filter(link -> link.getGroupId() != null)
                    .map(IdentityLink::getGroupId)
                    .distinct()
                    .toList();
        } catch (RuntimeException exception) {
            log.warn("Could not read candidate groups for task {}: {}",
                    task.getId(), exception.toString());
            return List.of();
        }
    }

    private static String stringOf(Object target, String getter) {
        try {
            Object value = target.getClass().getMethod(getter).invoke(target);
            return value == null ? null : String.valueOf(value);
        } catch (Exception notPresent) {
            return null;
        }
    }

    /**
     * Delivery happens outside the engine transaction.
     *
     * <p>Returning true here would let a slow or failing API hold an engine
     * transaction open.
     */
    @Override
    public boolean isFailOnException() {
        return false;
    }

    @Override
    public boolean isFireOnTransactionLifecycleEvent() {
        return false;
    }

    @Override
    public String getOnTransaction() {
        return null;
    }
}
