package com.iris.taxassessment.bpmn;

import com.iris.taxassessment.bpmn.controller.EngineExceptionHandler;
import org.flowable.common.engine.api.FlowableObjectNotFoundException;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What the engine answers when asked for something it does not have.
 *
 * <p>A missing definition used to escape as an unhandled 500 with a stack
 * trace; the API tolerated it, but the log read as an engine crash rather than
 * as a deployment step not yet done.
 */
class EngineExceptionHandlerTest {

    private final EngineExceptionHandler handler = new EngineExceptionHandler();

    @Test
    void anUndeployedDefinitionIsANotFoundThatSaysHowToDeploy() {
        ResponseEntity<Map<String, Object>> response = handler.notFound(
                new FlowableObjectNotFoundException("No process definition found for key 'TAX_ASSESSMENT_MAIN'"));

        assertThat(response.getStatusCode().value()).isEqualTo(404);
        assertThat(String.valueOf(response.getBody().get("message")))
                .contains("TAX_ASSESSMENT_MAIN")
                .contains("deploy/standard");
    }

    @Test
    void anInstanceNotWaitingForAMessageIsAConflict() {
        ResponseEntity<Map<String, Object>> response = handler.notWaiting(
                new IllegalStateException("Instance 42 is not waiting for message CASE_ASSIGN"));

        assertThat(response.getStatusCode().value()).isEqualTo(409);
        assertThat(response.getBody()).containsEntry("error", "NOT_WAITING");
    }
}
