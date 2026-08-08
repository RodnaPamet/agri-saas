/**
 * Epic 60 — Automation foundation barrel.
 *
 * App-layer entry point for the event-driven automation data model.
 * Import from here (not the individual files) so future module
 * reshuffling is opaque to callers.
 */

export { AutomationRuleRepository } from './AutomationRuleRepository';
export { AutomationExecutionRepository } from './AutomationExecutionRepository';
export {
    getAutomationBus,
    resetAutomationBus,
    emitAutomationEvent,
} from './automation-bus';
export type {
    AutomationBus,
    AutomationDispatcher,
    AutomationEventHandler,
    Unsubscribe,
} from './automation-bus';
export { matchesFilter } from './filters';
export { isFilterGroup } from './types';
export {
    installAutomationBusDispatcher,
    bullmqAutomationDispatcher,
    toDispatchPayload,
} from './bus-bootstrap';
export { isEvent } from './event-contracts';
export type {
    AutomationDomainEvent,
    AutomationEventMetadata,
    EmitAutomationEvent,
    TestPlanCreatedData,
    TestPlanUpdatedData,
    TestPlanStatusChangedData,
    TestRunCreatedData,
    TestRunCompletedData,
    TestRunFailedData,
    TestEvidenceLinkedData,
    TestEvidenceUnlinkedData,
    OnboardingStartedData,
    OnboardingStepCompletedData,
    OnboardingFinishedData,
    OnboardingRestartedData,
    TaskCreatedData,
    TaskStatusChangedData,
    IssueCreatedData,
    IssueStatusChangedData,
    SprayJobStartedData,
    OperationParcelMarkedData,
    HarvestYieldRecordedData,
} from './event-contracts';
export {
    assertCanReadAutomation,
    assertCanManageAutomation,
    assertCanExecuteAutomation,
    assertCanReadAutomationHistory,
} from './policies';
export {
    AUTOMATION_EVENTS,
    AUTOMATION_EVENT_NAMES,
    isKnownAutomationEvent,
} from './events';
export type { AutomationEventName } from './events';
export type {
    AutomationActionConfig,
    AutomationExecutionListFilters,
    AutomationRuleListFilters,
    AutomationTriggerFilter,
    FilterOperator,
    FilterCondition,
    FilterGroup,
    LegacyTriggerFilter,
    CreateAutomationRuleInput,
    CreateTaskActionConfig,
    NotifyUserActionConfig,
    RecordAutomationExecutionCompletionInput,
    RecordAutomationExecutionStartInput,
    UpdateAutomationRuleInput,
    UpdateStatusActionConfig,
    WebhookActionConfig,
} from './types';
