package com.iris.taxassessment.bpmn;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The BPMN engine service.
 *
 * <p>Plan reference: V2 sections 2.3, 5; ADR-002.
 *
 * <p>Deliberately thin: it sequences work, fires timers and tracks tasks. All
 * business meaning lives in the API. No tax logic here, ever.
 */
@SpringBootApplication
public class BpmnEngineApplication {
    public static void main(String[] args) {
        SpringApplication.run(BpmnEngineApplication.class, args);
    }
}
