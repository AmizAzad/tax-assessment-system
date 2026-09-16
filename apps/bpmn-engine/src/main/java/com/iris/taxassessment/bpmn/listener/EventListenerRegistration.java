package com.iris.taxassessment.bpmn.listener;

import org.flowable.common.engine.api.delegate.event.FlowableEngineEventType;
import org.flowable.common.engine.api.delegate.event.FlowableEventListener;
import org.flowable.spring.SpringProcessEngineConfiguration;
import org.flowable.spring.boot.EngineConfigurationConfigurer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Registers the event listener for the lifecycle events the read model needs.
 *
 * <p>A named set rather than everything: the engine emits a great many events,
 * and forwarding all of them would make the webhook a firehose the API has no
 * use for. These seven are what the register, the task inbox and the process
 * journey are built from.
 */
@Configuration
public class EventListenerRegistration {

    /** The events the API's read model is built from. */
    static final List<FlowableEngineEventType> FORWARDED = List.of(
            FlowableEngineEventType.PROCESS_STARTED,
            FlowableEngineEventType.PROCESS_COMPLETED,
            FlowableEngineEventType.PROCESS_CANCELLED,
            FlowableEngineEventType.TASK_CREATED,
            FlowableEngineEventType.TASK_COMPLETED,
            FlowableEngineEventType.ACTIVITY_STARTED,
            FlowableEngineEventType.ACTIVITY_COMPLETED);

    @Bean
    public EngineConfigurationConfigurer<SpringProcessEngineConfiguration> workflowEventsConfigurer(
            WorkflowEventListener listener) {
        return configuration -> {
            Map<String, List<FlowableEventListener>> typed = new LinkedHashMap<>();
            for (FlowableEngineEventType type : FORWARDED) {
                typed.put(type.name(), List.of(listener));
            }
            configuration.setTypedEventListeners(typed);
        };
    }
}
