package com.iris.taxassessment.bpmn.controller;

import jakarta.validation.constraints.NotBlank;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.runtime.ProcessInstance;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Process deployment and instance lifecycle.
 *
 * <p>Plan reference: V2 section 5.1.
 *
 * <p>Note what is <em>not</em> here: validation of the BPMN itself. A
 * definition is validated by the API before it is sent (the role-less user
 * task check, plan section 5.5), because the rule is a business rule and the
 * API is where it can be tested and where a rejection can be explained. By the
 * time XML reaches this controller it is expected to be publishable.
 */
@RestController
@RequestMapping("/api/process")
public class ProcessController {

    private static final Logger log = LoggerFactory.getLogger(ProcessController.class);

    private final RepositoryService repositoryService;
    private final RuntimeService runtimeService;

    public ProcessController(RepositoryService repositoryService, RuntimeService runtimeService) {
        this.repositoryService = repositoryService;
        this.runtimeService = runtimeService;
    }

    /** Deploy a process definition. */
    @PostMapping(value = "/deploy", consumes = MediaType.APPLICATION_XML_VALUE)
    public ResponseEntity<Map<String, Object>> deploy(
            @RequestParam("name") @NotBlank String name,
            @RequestBody String workflowXml) {

        // Duplicate filtering makes a redeploy of an unchanged file a no-op
        // rather than a new version, so "deploy the standard definition" can
        // be run as often as setup needs without versions piling up.
        Deployment deployment = repositoryService.createDeployment()
                .name(name)
                .addBytes(name + ".bpmn20.xml", workflowXml.getBytes(StandardCharsets.UTF_8))
                .enableDuplicateFiltering()
                .deploy();

        // A filtered deployment is the earlier one, so its definition is
        // found by the deployment id it hands back, exactly as a new one is.
        List<ProcessDefinition> definitions = repositoryService
                .createProcessDefinitionQuery()
                .deploymentId(deployment.getId())
                .list();

        if (definitions.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "The deployment contained no process definition"));
        }

        ProcessDefinition definition = definitions.get(0);
        log.info("Deployed {} as {} v{}", name, definition.getKey(), definition.getVersion());

        return ResponseEntity.ok(Map.of(
                "deploymentId", deployment.getId(),
                "processDefinitionId", definition.getId(),
                "processDefinitionKey", definition.getKey(),
                "version", definition.getVersion()));
    }

    /** Start an instance. The business key is always the case number. */
    @PostMapping("/start")
    public ResponseEntity<Map<String, Object>> start(@RequestBody StartRequest request) {
        ProcessInstance instance = runtimeService.startProcessInstanceByKey(
                request.processDefinitionKey(),
                request.businessKey(),
                request.variables() == null ? Map.of() : request.variables());

        log.info("Started {} instance {} for business key {}",
                request.processDefinitionKey(), instance.getId(), request.businessKey());

        return ResponseEntity.ok(Map.of(
                "processInstanceId", instance.getId(),
                "processDefinitionId", instance.getProcessDefinitionId(),
                "businessKey", request.businessKey(),
                "ended", instance.isEnded()));
    }

    /** Current variables for an instance. */
    @GetMapping("/{processInstanceId}/variables")
    public ResponseEntity<Map<String, Object>> variables(@PathVariable String processInstanceId) {
        return ResponseEntity.ok(runtimeService.getVariables(processInstanceId));
    }

    /**
     * Correlate a message to a waiting instance.
     *
     * <p>How an objection reaches its parent case: the API sends a message,
     * Flowable matches it to the instance holding that business key.
     */
    @PostMapping("/{processInstanceId}/message")
    public ResponseEntity<Map<String, Object>> message(
            @PathVariable String processInstanceId,
            @RequestBody MessageRequest request) {

        runtimeService.messageEventReceived(
                request.messageName(),
                findExecution(processInstanceId, request.messageName()),
                request.variables() == null ? Map.of() : request.variables());

        return ResponseEntity.ok(Map.of("delivered", true));
    }

    /** Cancel an instance, recording why. */
    @DeleteMapping("/{processInstanceId}")
    public ResponseEntity<Map<String, Object>> cancel(
            @PathVariable String processInstanceId,
            @RequestParam(value = "reason", defaultValue = "Cancelled by the API") String reason) {

        runtimeService.deleteProcessInstance(processInstanceId, reason);
        log.info("Cancelled instance {}: {}", processInstanceId, reason);
        return ResponseEntity.ok(Map.of("cancelled", true));
    }

    private String findExecution(String processInstanceId, String messageName) {
        var execution = runtimeService.createExecutionQuery()
                .processInstanceId(processInstanceId)
                .messageEventSubscriptionName(messageName)
                .singleResult();
        if (execution == null) {
            throw new IllegalStateException(
                    "Instance " + processInstanceId + " is not waiting for message " + messageName);
        }
        return execution.getId();
    }

    public record StartRequest(
            @NotBlank String processDefinitionKey,
            @NotBlank String businessKey,
            Map<String, Object> variables) {}

    public record MessageRequest(@NotBlank String messageName, Map<String, Object> variables) {}
}
