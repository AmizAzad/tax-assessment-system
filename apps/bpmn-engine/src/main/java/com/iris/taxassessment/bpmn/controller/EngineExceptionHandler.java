package com.iris.taxassessment.bpmn.controller;

import org.flowable.common.engine.api.FlowableIllegalArgumentException;
import org.flowable.common.engine.api.FlowableObjectNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * Engine conditions the API expects, answered as HTTP rather than as crashes.
 *
 * <p>Plan reference: V2 section 5.1; ADR-002.
 *
 * <p>Starting an instance of a definition that was never deployed, or
 * messaging an instance that is not waiting for that message, are states the
 * API is built to tolerate: it logs them and the case is worked by hand. They
 * reached the servlet container as unhandled exceptions, so each one printed
 * a full stack trace under ERROR and answered 500, which read as the engine
 * failing when it was the deployment step that had not been done.
 *
 * <p>Anything not listed here is still a genuine fault and still surfaces as
 * one.
 */
@RestControllerAdvice
public class EngineExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(EngineExceptionHandler.class);

    @ExceptionHandler(FlowableObjectNotFoundException.class)
    public ResponseEntity<Map<String, Object>> notFound(FlowableObjectNotFoundException error) {
        String message = error.getMessage();
        if (message != null && message.startsWith("No process definition found")) {
            // Deployment is an act, not a boot step, so a fresh engine has
            // nothing to start until an administrator deploys.
            message += ". Deploy it as an administrator: the Process Modeller's Deploy button, "
                    + "or POST /api/v1/processes/deploy/standard on the API (npm run bpmn:deploy).";
        }
        log.warn("{}", message);
        return body(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, Object>> notWaiting(IllegalStateException error) {
        log.debug("{}", error.getMessage());
        return body(HttpStatus.CONFLICT, "NOT_WAITING", error.getMessage());
    }

    @ExceptionHandler(FlowableIllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(FlowableIllegalArgumentException error) {
        log.warn("{}", error.getMessage());
        return body(HttpStatus.BAD_REQUEST, "BAD_REQUEST", error.getMessage());
    }

    private static ResponseEntity<Map<String, Object>> body(HttpStatus status, String code, String message) {
        return ResponseEntity.status(status).body(Map.of(
                "status", status.value(),
                "error", code,
                "message", message == null ? "" : message));
    }
}
