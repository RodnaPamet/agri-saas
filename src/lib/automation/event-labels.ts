/**
 * Human-readable metadata for automation events (Automation Epic 3).
 *
 * Drives the rule-builder UI: Step 1 (trigger picker — label + description +
 * domain grouping) and Step 2 (condition builder — the filter fields a given
 * event payload exposes). Pure data; imports the event NAMES from the leaf
 * `events` module (never the @/app-layer/automation barrel, which would drag
 * server-only OpenTelemetry into this client-bundled file).
 */
import { AUTOMATION_EVENTS, type AutomationEventName } from '@/app-layer/automation/events';

export type FilterFieldType = 'string' | 'number' | 'enum';

export interface FilterFieldDef {
    field: string;
    label: string;
    type: FilterFieldType;
    /** Allowed values when `type === 'enum'`. */
    options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface EventLabel {
    name: AutomationEventName;
    label: string;
    description: string;
    /** Domain group for the trigger picker. */
    domain: 'Risk' | 'Control testing' | 'Control' | 'Policy' | 'Vendor' | 'Evidence' | 'Schedule' | 'Onboarding' | 'Task' | 'Issue' | 'Field operations';
    /** Payload fields a condition can filter on. */
    filterFields: ReadonlyArray<FilterFieldDef>;
}

const SEVERITY_OPTS = [
    { value: 'LOW', label: 'Low' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HIGH', label: 'High' },
    { value: 'CRITICAL', label: 'Critical' },
] as const;

export const EVENT_LABELS: Record<AutomationEventName, EventLabel> = {
    [AUTOMATION_EVENTS.TEST_PLAN_CREATED]: {
        name: AUTOMATION_EVENTS.TEST_PLAN_CREATED,
        label: 'Test plan created',
        description: 'A control test plan is created.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_PLAN_UPDATED]: {
        name: AUTOMATION_EVENTS.TEST_PLAN_UPDATED,
        label: 'Test plan updated',
        description: 'A control test plan is edited.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_PLAN_PAUSED]: {
        name: AUTOMATION_EVENTS.TEST_PLAN_PAUSED,
        label: 'Test plan paused',
        description: 'A control test plan is paused.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_PLAN_RESUMED]: {
        name: AUTOMATION_EVENTS.TEST_PLAN_RESUMED,
        label: 'Test plan resumed',
        description: 'A paused control test plan resumes.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_RUN_CREATED]: {
        name: AUTOMATION_EVENTS.TEST_RUN_CREATED,
        label: 'Test run started',
        description: 'A control test run begins.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_RUN_COMPLETED]: {
        name: AUTOMATION_EVENTS.TEST_RUN_COMPLETED,
        label: 'Test run completed',
        description: 'A control test run finishes.',
        domain: 'Control testing',
        filterFields: [
            { field: 'outcome', label: 'Outcome', type: 'string' },
        ],
    },
    [AUTOMATION_EVENTS.TEST_RUN_FAILED]: {
        name: AUTOMATION_EVENTS.TEST_RUN_FAILED,
        label: 'Test run failed',
        description: 'A control test run fails.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_EVIDENCE_LINKED]: {
        name: AUTOMATION_EVENTS.TEST_EVIDENCE_LINKED,
        label: 'Test evidence linked',
        description: 'Evidence is attached to a control test run.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TEST_EVIDENCE_UNLINKED]: {
        name: AUTOMATION_EVENTS.TEST_EVIDENCE_UNLINKED,
        label: 'Test evidence unlinked',
        description: 'Evidence is detached from a control test run.',
        domain: 'Control testing',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.SCHEDULE]: {
        name: AUTOMATION_EVENTS.SCHEDULE,
        label: 'On a schedule',
        description: 'Fire N days before a target entity’s due date (evidence retention, control-test due, exception expiry).',
        domain: 'Schedule',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.CONTROL_STATUS_CHANGED]: {
        name: AUTOMATION_EVENTS.CONTROL_STATUS_CHANGED,
        label: 'Control status changed',
        description: 'A control moves between implementation states.',
        domain: 'Control',
        filterFields: [
            { field: 'toStatus', label: 'New status', type: 'string' },
            { field: 'fromStatus', label: 'Old status', type: 'string' },
        ],
    },
    [AUTOMATION_EVENTS.POLICY_REVIEW_DUE]: {
        name: AUTOMATION_EVENTS.POLICY_REVIEW_DUE,
        label: 'Policy review due',
        description: 'A policy has passed its scheduled review date.',
        domain: 'Policy',
        filterFields: [
            { field: 'daysOverdue', label: 'Days overdue', type: 'number' },
        ],
    },
    [AUTOMATION_EVENTS.VENDOR_ASSESSMENT_OVERDUE]: {
        name: AUTOMATION_EVENTS.VENDOR_ASSESSMENT_OVERDUE,
        label: 'Vendor assessment overdue',
        description: 'A vendor review or contract renewal has passed its deadline.',
        domain: 'Vendor',
        filterFields: [
            { field: 'kind', label: 'Deadline kind', type: 'string' },
            { field: 'daysOverdue', label: 'Days overdue', type: 'number' },
        ],
    },
    [AUTOMATION_EVENTS.EVIDENCE_EXPIRING]: {
        name: AUTOMATION_EVENTS.EVIDENCE_EXPIRING,
        label: 'Evidence expiring',
        description: 'Evidence is approaching its retention/expiry date.',
        domain: 'Evidence',
        filterFields: [
            { field: 'controlId', label: 'Linked control', type: 'string' },
        ],
    },
    [AUTOMATION_EVENTS.EVIDENCE_EXPIRED]: {
        name: AUTOMATION_EVENTS.EVIDENCE_EXPIRED,
        label: 'Evidence expired',
        description: 'Evidence has passed its expiry date.',
        domain: 'Evidence',
        filterFields: [
            { field: 'controlId', label: 'Linked control', type: 'string' },
        ],
    },
    [AUTOMATION_EVENTS.ONBOARDING_STARTED]: {
        name: AUTOMATION_EVENTS.ONBOARDING_STARTED,
        label: 'Onboarding started',
        description: 'A tenant onboarding flow begins.',
        domain: 'Onboarding',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.ONBOARDING_STEP_COMPLETED]: {
        name: AUTOMATION_EVENTS.ONBOARDING_STEP_COMPLETED,
        label: 'Onboarding step completed',
        description: 'A step in onboarding is finished.',
        domain: 'Onboarding',
        filterFields: [{ field: 'step', label: 'Step', type: 'string' }],
    },
    [AUTOMATION_EVENTS.ONBOARDING_FINISHED]: {
        name: AUTOMATION_EVENTS.ONBOARDING_FINISHED,
        label: 'Onboarding finished',
        description: 'Onboarding completes.',
        domain: 'Onboarding',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.ONBOARDING_RESTARTED]: {
        name: AUTOMATION_EVENTS.ONBOARDING_RESTARTED,
        label: 'Onboarding restarted',
        description: 'Onboarding is restarted.',
        domain: 'Onboarding',
        filterFields: [],
    },
    [AUTOMATION_EVENTS.TASK_CREATED]: {
        name: AUTOMATION_EVENTS.TASK_CREATED,
        label: 'Task created',
        description: 'A task is created.',
        domain: 'Task',
        filterFields: [
            { field: 'priority', label: 'Priority', type: 'enum', options: [
                { value: 'P0', label: 'P0' },
                { value: 'P1', label: 'P1' },
                { value: 'P2', label: 'P2' },
                { value: 'P3', label: 'P3' },
            ] },
        ],
    },
    [AUTOMATION_EVENTS.TASK_STATUS_CHANGED]: {
        name: AUTOMATION_EVENTS.TASK_STATUS_CHANGED,
        label: 'Task status changed',
        description: 'A task moves between states.',
        domain: 'Task',
        filterFields: [{ field: 'toStatus', label: 'New status', type: 'string' }],
    },
    [AUTOMATION_EVENTS.ISSUE_CREATED]: {
        name: AUTOMATION_EVENTS.ISSUE_CREATED,
        label: 'Issue created',
        description: 'An issue is opened.',
        domain: 'Issue',
        filterFields: [
            { field: 'severity', label: 'Severity', type: 'enum', options: SEVERITY_OPTS },
        ],
    },
    [AUTOMATION_EVENTS.ISSUE_STATUS_CHANGED]: {
        name: AUTOMATION_EVENTS.ISSUE_STATUS_CHANGED,
        label: 'Issue status changed',
        description: 'An issue moves between states.',
        domain: 'Issue',
        filterFields: [{ field: 'toStatus', label: 'New status', type: 'string' }],
    },
    [AUTOMATION_EVENTS.SPRAY_JOB_STARTED]: {
        name: AUTOMATION_EVENTS.SPRAY_JOB_STARTED,
        label: 'Spray job started',
        description: 'A field operation (spray / fertilise / seed) is created over one or more parcels.',
        domain: 'Field operations',
        filterFields: [
            {
                field: 'operationType',
                label: 'Operation type',
                type: 'enum',
                options: [
                    { value: 'SPRAY', label: 'Spray' },
                    { value: 'FERTILIZE', label: 'Fertilise' },
                    { value: 'SEED', label: 'Seed' },
                    { value: 'OTHER', label: 'Other' },
                ],
            },
            { field: 'parcelCount', label: 'Parcel count', type: 'number' },
        ],
    },
    [AUTOMATION_EVENTS.OPERATION_PARCEL_MARKED]: {
        name: AUTOMATION_EVENTS.OPERATION_PARCEL_MARKED,
        label: 'Parcel marked',
        description: 'An operator marks a prescription parcel done, skipped, or back to pending.',
        domain: 'Field operations',
        filterFields: [
            {
                field: 'status',
                label: 'Parcel status',
                type: 'enum',
                options: [
                    { value: 'PENDING', label: 'Pending' },
                    { value: 'DONE', label: 'Done' },
                    { value: 'SKIPPED', label: 'Skipped' },
                ],
            },
        ],
    },
    [AUTOMATION_EVENTS.HARVEST_YIELD_RECORDED]: {
        name: AUTOMATION_EVENTS.HARVEST_YIELD_RECORDED,
        label: 'Harvest yield recorded',
        description: 'A harvest production total is recorded against a planting, field, or season.',
        domain: 'Field operations',
        filterFields: [
            { field: 'commodity', label: 'Commodity', type: 'string' },
            { field: 'grossTonnes', label: 'Gross tonnes', type: 'number' },
        ],
    },
};

/** Builder Step 1 — trigger options grouped by domain. */
export function eventOptionsByDomain(): Array<{
    domain: EventLabel['domain'];
    events: EventLabel[];
}> {
    const groups = new Map<EventLabel['domain'], EventLabel[]>();
    for (const ev of Object.values(EVENT_LABELS)) {
        const list = groups.get(ev.domain) ?? [];
        list.push(ev);
        groups.set(ev.domain, list);
    }
    return Array.from(groups.entries()).map(([domain, events]) => ({ domain, events }));
}

export function filterFieldsForEvent(name: string): ReadonlyArray<FilterFieldDef> {
    return EVENT_LABELS[name as AutomationEventName]?.filterFields ?? [];
}
