/**
 * Automation Rules tab — filter configuration (Automation Epic 1).
 *
 * Keys: status, triggerEvent, actionType. Filtering is applied in-memory
 * over the fetched rule list (rule counts are small — tens, not
 * thousands), so multi-select values never need to round-trip as query
 * params. The shared filter-defs machinery still drives the toolbar UI.
 */
import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import { CircleDot, Zap, Wrench } from 'lucide-react';
// Import the leaf events module, NOT the @/app-layer/automation barrel: the
// barrel re-exports automation-bus → observability → OpenTelemetry, which
// drags the Node-only `async_hooks` into this client-bundled file and breaks
// the Next build. `events.ts` is pure constants.
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';

export const RULE_STATUS_LABELS = {
    DRAFT: 'Draft',
    ENABLED: 'Enabled',
    DISABLED: 'Disabled',
    ARCHIVED: 'Archived',
} as const;

export const RULE_ACTION_LABELS = {
    NOTIFY_USER: 'Notify user',
    CREATE_TASK: 'Create task',
    UPDATE_STATUS: 'Update status',
    WEBHOOK: 'Webhook',
} as const;

/** Trigger-event options derived from the canonical event catalog. */
const TRIGGER_OPTIONS = AUTOMATION_EVENT_NAMES.map((name) => ({
    value: name,
    label: name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
}));

const STATIC_DEFS = {
    status: {
        label: 'Status',
        description: 'Rule lifecycle state.',
        group: 'Attributes',
        icon: CircleDot,
        options: optionsFromEnum(RULE_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    triggerEvent: {
        label: 'Trigger',
        description: 'The domain event the rule subscribes to.',
        group: 'Attributes',
        icon: Zap,
        options: TRIGGER_OPTIONS,
        multiple: true,
        resetBehavior: 'clearable',
    },
    actionType: {
        label: 'Action',
        description: 'What the rule does when it fires.',
        group: 'Attributes',
        icon: Wrench,
        options: optionsFromEnum(RULE_ACTION_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const ruleFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const RULE_FILTER_KEYS = ruleFilterDefs.filterKeys;

export function buildRuleFilters() {
    return ruleFilterDefs.filters;
}
