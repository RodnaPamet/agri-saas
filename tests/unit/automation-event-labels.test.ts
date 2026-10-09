/**
 * Automation Epic 3 — event-label metadata.
 *
 * The builder's Step 1 (trigger picker, grouped by domain) and Step 2
 * (condition fields) read from EVENT_LABELS. Lock the grouping + the
 * filter-field lookup.
 */
import {
    EVENT_LABELS,
    eventOptionsByDomain,
    filterFieldsForEvent,
} from '@/lib/automation/event-labels';
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';

describe('event-labels', () => {
    it('has a label entry for every catalog event', () => {
        for (const name of AUTOMATION_EVENT_NAMES) {
            expect(EVENT_LABELS[name]).toBeDefined();
            expect(EVENT_LABELS[name].label.length).toBeGreaterThan(0);
        }
    });

    it('groups events by domain', () => {
        const groups = eventOptionsByDomain();
        const domains = groups.map((g) => g.domain);
        expect(domains).toContain('Task');
        // every event lands in exactly one group
        const total = groups.reduce((n, g) => n + g.events.length, 0);
        expect(total).toBe(AUTOMATION_EVENT_NAMES.length);
    });

    it('returns filter fields for an event that has them, [] otherwise', () => {
        const taskFields = filterFieldsForEvent('TASK_CREATED');
        expect(taskFields.some((f) => f.field === 'priority')).toBe(true);
        expect(filterFieldsForEvent('NONEXISTENT_EVENT')).toEqual([]);
    });

    it('enum filter fields carry options', () => {
        const pri = filterFieldsForEvent('TASK_CREATED').find((f) => f.field === 'priority');
        expect(pri?.type).toBe('enum');
        expect(pri?.options?.length).toBeGreaterThan(0);
    });
});
