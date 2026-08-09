/**
 * Typed domain-event contracts for the automation layer.
 *
 * Where `events.ts` is the *string* catalogue, this file is the
 * *shape* catalogue: one discriminated-union member per event with
 * its own `data` payload. Producers get compile-time guarantees:
 * emitting `TEST_PLAN_CREATED` with the wrong `data` shape is a type
 * error, not a silently non-firing rule later.
 *
 * Shared metadata (tenantId, actor, entity, timestamp) lives on the
 * base shape so every event carries what the bus, dispatcher, and
 * execution history all need without each producer re-stamping it.
 */

import type { AutomationEventName } from './events';

/**
 * Metadata every automation event carries, regardless of type.
 * - `tenantId` is stamped by the bus from RequestContext; producers
 *   never set it manually, so cross-tenant leakage is impossible at
 *   the contract layer.
 * - `emittedAt` is stamped by the bus at emit time. Stable across
 *   downstream handlers and execution rows.
 * - `stableKey` is optional; when present, the dispatcher derives the
 *   execution idempotencyKey from (ruleId, event, stableKey) so a
 *   retried producer never double-fires.
 */
export interface AutomationEventMetadata {
    tenantId: string;
    entityType: string;
    entityId: string;
    actorUserId: string | null;
    emittedAt: Date;
    stableKey?: string;
}

// ─── Per-event payload shapes ──────────────────────────────────────────

export interface TestPlanCreatedData {
    name: string;
    controlId: string;
}
export interface TestPlanUpdatedData {
    changedFields: string[];
}
export interface TestPlanStatusChangedData {
    fromStatus: string;
    toStatus: string;
}
export interface TestRunCreatedData {
    testPlanId: string;
}
export interface TestRunCompletedData {
    testPlanId: string;
    result: string;
}
export interface TestRunFailedData {
    findingSummary: string | null;
}
export interface TestEvidenceLinkedData {
    testRunId: string;
    kind: string;
}
export interface TestEvidenceUnlinkedData {
    testRunId: string;
}

export interface EvidenceExpiringData {
    title: string;
    controlId: string | null;
    retentionUntil: string | null;
}
export interface EvidenceExpiredData {
    title: string;
    controlId: string | null;
    expiredAt: string | null;
}

export interface ScheduleFiredData {
    /** The allowlisted target entity type that came due. */
    target: string;
    /** The entity's due-date field value (ISO). */
    dueAt: string | null;
    /** Days-before-due the rule was configured to fire. */
    offsetDays: number;
}

export interface ControlStatusChangedData {
    fromStatus: string;
    toStatus: string;
}
export interface PolicyReviewDueData {
    title: string;
    nextReviewAt: string | null;
    daysOverdue: number;
}
export interface VendorAssessmentOverdueData {
    vendorName: string;
    /** REVIEW_OVERDUE | RENEWAL_OVERDUE — which deadline lapsed. */
    kind: string;
    daysOverdue: number;
}

export interface OnboardingStartedData {
    /** Empty by design — event name carries the meaning. */
    readonly _?: never;
}
export interface OnboardingStepCompletedData {
    step: string;
}
export interface OnboardingFinishedData {
    readonly _?: never;
}
export interface OnboardingRestartedData {
    readonly _?: never;
}

export interface TaskCreatedData {
    /** Ticket key (e.g. "TSK-42"); null for legacy tasks that predate keying. */
    key: string | null;
    title: string;
    type: string;
    severity: string;
    priority: string;
    assigneeUserId: string | null;
    controlId: string | null;
}
export interface TaskStatusChangedData {
    fromStatus: string;
    toStatus: string;
    resolution: string | null;
}

export interface IssueCreatedData {
    /** Ticket key; null for legacy issues that predate keying. */
    key: string | null;
    title: string;
    severity: string;
    status: string;
    assigneeUserId: string | null;
}
export interface IssueStatusChangedData {
    fromStatus: string;
    toStatus: string;
}

// ─── Ag field workflows ────────────────────────────────────────────────
export interface SprayJobStartedData {
    taskId: string;
    /** Task key; null for legacy tasks that predate keying. */
    taskKey: string | null;
    locationId: string;
    /** SPRAY | FERTILIZE | SEED | OTHER */
    operationType: string;
    parcelCount: number;
    productItemId: string;
    assigneeUserId: string;
}
export interface OperationParcelMarkedData {
    taskId: string;
    operationParcelId: string;
    parcelId: string;
    /** PENDING | DONE | SKIPPED */
    status: string;
    /** True when this mark resolved the whole job (no PENDING parcels left). */
    jobResolved: boolean;
}
export interface HarvestYieldRecordedData {
    yieldRecordId: string;
    commodity: string | null;
    grossTonnes: number | null;
    areaHa: number | null;
    plantingId: string | null;
    seasonId: string | null;
    /**
     * Which surface recorded it. A harvest logged in the journal can now
     * mint its yield record alongside the stock lot, so the same event
     * arrives from two places — a rule that cares (e.g. one that also
     * inspects the lot) can tell them apart, and one that does not can
     * ignore this. Absent on records typed directly on /grain/yield.
     */
    source?: 'journal_harvest';
    /** The journal HARVEST entry that minted it, when source is journal. */
    logEntryId?: string;
    /**
     * The record was DELETED — production the farm no longer claims. Update
     * and delete emit this event too, because a corrected or retracted
     * tonnage is news to a rule watching production (arguably more than the
     * original, since a figure someone acted on has moved).
     */
    retracted?: boolean;
}

// ─── Discriminated union ───────────────────────────────────────────────
//
// The whole point: `event` is the tag; `data` narrows off it. Any
// handler that checks `evt.event === 'TEST_PLAN_CREATED'` gets
// `TestPlanCreatedData` on `evt.data` automatically.

export type AutomationDomainEvent =
    | (AutomationEventMetadata & { event: 'TEST_PLAN_CREATED'; data: TestPlanCreatedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_UPDATED'; data: TestPlanUpdatedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_PAUSED'; data: TestPlanStatusChangedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_RESUMED'; data: TestPlanStatusChangedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_CREATED'; data: TestRunCreatedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_COMPLETED'; data: TestRunCompletedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_FAILED'; data: TestRunFailedData })
    | (AutomationEventMetadata & { event: 'TEST_EVIDENCE_LINKED'; data: TestEvidenceLinkedData })
    | (AutomationEventMetadata & { event: 'TEST_EVIDENCE_UNLINKED'; data: TestEvidenceUnlinkedData })
    | (AutomationEventMetadata & { event: 'EVIDENCE_EXPIRING'; data: EvidenceExpiringData })
    | (AutomationEventMetadata & { event: 'EVIDENCE_EXPIRED'; data: EvidenceExpiredData })
    | (AutomationEventMetadata & { event: 'SCHEDULE'; data: ScheduleFiredData })
    | (AutomationEventMetadata & { event: 'CONTROL_STATUS_CHANGED'; data: ControlStatusChangedData })
    | (AutomationEventMetadata & { event: 'POLICY_REVIEW_DUE'; data: PolicyReviewDueData })
    | (AutomationEventMetadata & { event: 'VENDOR_ASSESSMENT_OVERDUE'; data: VendorAssessmentOverdueData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_STARTED'; data: OnboardingStartedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_STEP_COMPLETED'; data: OnboardingStepCompletedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_FINISHED'; data: OnboardingFinishedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_RESTARTED'; data: OnboardingRestartedData })
    | (AutomationEventMetadata & { event: 'TASK_CREATED'; data: TaskCreatedData })
    | (AutomationEventMetadata & { event: 'TASK_STATUS_CHANGED'; data: TaskStatusChangedData })
    | (AutomationEventMetadata & { event: 'ISSUE_CREATED'; data: IssueCreatedData })
    | (AutomationEventMetadata & { event: 'ISSUE_STATUS_CHANGED'; data: IssueStatusChangedData })
    | (AutomationEventMetadata & { event: 'SPRAY_JOB_STARTED'; data: SprayJobStartedData })
    | (AutomationEventMetadata & { event: 'OPERATION_PARCEL_MARKED'; data: OperationParcelMarkedData })
    | (AutomationEventMetadata & { event: 'HARVEST_YIELD_RECORDED'; data: HarvestYieldRecordedData });

// Compile-time assertion: union membership equals the string catalogue.
// If a new catalogue entry is added without a contract, this line
// becomes a TypeScript error.
type _CatalogueConsistency = Exclude<
    AutomationEventName,
    AutomationDomainEvent['event']
>;

const _catalogueCheck: _CatalogueConsistency extends never ? true : false = true;

// ─── Producer-facing emit shape ────────────────────────────────────────
//
// What a usecase actually hands to the bus — metadata minus the
// fields the bus itself stamps (tenantId + emittedAt). Keeps usecases
// from accidentally forging another tenant's id.

export type EmitAutomationEvent = {
    [E in AutomationDomainEvent as E['event']]: Omit<
        E,
        'tenantId' | 'emittedAt'
    >;
}[AutomationDomainEvent['event']];

/**
 * Narrow a raw persisted/unknown event to a specific variant.
 * Useful for dispatcher code that loaded an AutomationExecution row
 * and needs to narrow by `triggerEvent`.
 */
export function isEvent<E extends AutomationDomainEvent['event']>(
    evt: AutomationDomainEvent,
    name: E
): evt is Extract<AutomationDomainEvent, { event: E }> {
    return evt.event === name;
}
