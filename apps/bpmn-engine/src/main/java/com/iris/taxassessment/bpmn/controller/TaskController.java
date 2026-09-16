package com.iris.taxassessment.bpmn.controller;

import jakarta.validation.constraints.NotBlank;
import org.flowable.engine.TaskService;
import org.flowable.task.api.Task;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * User task operations.
 *
 * <p>Plan reference: V2 section 5.1.
 *
 * <p>The API keeps its own read model of active tasks and serves the officer's
 * inbox from there, so this surface exists for completion and for
 * reconciliation, not as the query path. Querying the engine on every inbox
 * render would make the engine a hot dependency of an interactive screen.
 */
@RestController
@RequestMapping("/api/task")
public class TaskController {

    private final TaskService taskService;

    public TaskController(TaskService taskService) {
        this.taskService = taskService;
    }

    @GetMapping("/{taskId}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String taskId) {
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(describe(task));
    }

    /** Tasks for an instance. Used by reconciliation, not by the inbox. */
    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list(
            @RequestParam("processInstanceId") String processInstanceId) {
        return ResponseEntity.ok(
                taskService.createTaskQuery()
                        .processInstanceId(processInstanceId)
                        .list()
                        .stream()
                        .map(TaskController::describe)
                        .toList());
    }

    /**
     * Complete a task.
     *
     * <p>The API has already persisted the submission and written the domain
     * event inside its own transaction before calling this. If this call then
     * fails, the reconciliation job detects the divergence -- which is the
     * accepted trade-off of an engine that owns state we do not (ADR-002).
     */
    @PostMapping("/{taskId}/complete")
    public ResponseEntity<Map<String, Object>> complete(
            @PathVariable String taskId,
            @RequestBody(required = false) CompleteRequest request) {

        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task == null) {
            return ResponseEntity.notFound().build();
        }

        Map<String, Object> variables = new HashMap<>();
        if (request != null && request.variables() != null) {
            variables.putAll(request.variables());
        }
        // The gateway convention: {stepCode: {action, data}} (plan 5.2).
        if (request != null && request.stepCode() != null && request.actionCode() != null) {
            variables.put(request.stepCode(), Map.of(
                    "action", request.actionCode(),
                    "data", request.data() == null ? Map.of() : request.data()));
        }

        taskService.complete(taskId, variables);
        return ResponseEntity.ok(Map.of("completed", true, "taskId", taskId));
    }

    @PostMapping("/{taskId}/claim")
    public ResponseEntity<Map<String, Object>> claim(
            @PathVariable String taskId,
            @RequestParam("assignee") @NotBlank String assignee) {
        taskService.claim(taskId, assignee);
        return ResponseEntity.ok(Map.of("claimed", true, "assignee", assignee));
    }

    /** Release a claim, so a task can be picked up by someone else. */
    @PostMapping("/{taskId}/unclaim")
    public ResponseEntity<Map<String, Object>> unclaim(@PathVariable String taskId) {
        taskService.unclaim(taskId);
        return ResponseEntity.ok(Map.of("unclaimed", true));
    }

    private static Map<String, Object> describe(Task task) {
        Map<String, Object> described = new HashMap<>();
        described.put("taskId", task.getId());
        described.put("name", task.getName());
        described.put("taskDefinitionKey", task.getTaskDefinitionKey());
        described.put("processInstanceId", task.getProcessInstanceId());
        described.put("assignee", task.getAssignee());
        described.put("createTime", task.getCreateTime());
        described.put("dueDate", task.getDueDate());
        return described;
    }

    public record CompleteRequest(
            String stepCode,
            String actionCode,
            Map<String, Object> data,
            Map<String, Object> variables) {}
}
