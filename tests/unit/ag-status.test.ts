/**
 * Unit coverage for the shared ag-domain status resolver
 * (`src/components/ag/ag-status.tsx`).
 *
 * The module is the single source of truth for `ag status →
 * StatusBadge variant + label`. The pure functions (`agStatusVariant`,
 * `agStatusLabel`) and the data maps are what every ag page now resolves
 * against, so the contract worth locking is:
 *
 *   - each representative ag status resolves to the EXACT variant the
 *     pages used before consolidation (this was a DRY move, not a
 *     recolour — a wrong variant here silently changes a colour across
 *     multiple pages),
 *   - the label resolver returns the human label, and
 *   - an unknown status falls back sensibly (`neutral` variant, raw
 *     string label) rather than throwing or blanking.
 *
 * The `.tsx` module imports `next-intl` (`useTranslations`) and the
 * `StatusBadge` UI component at top level. This test runs under the
 * node project (no jsdom), so both are mocked away — the pure resolvers
 * under test use neither, so the mocks keep the test fast and isolated
 * from the React UI tree.
 */

jest.mock('next-intl', () => ({
    // P2.1c — `useLocale` is part of this module and these mocks did not
    // provide it, so the first component to call it threw
    // "useLocale is not a function". The mock was incomplete relative to the
    // module, not wrong about this suite: `useDateFormat()` needs the active
    // locale, and a partial barrel mock turns a new dependency into a crash
    // across every suite that stubs it.
    useLocale: () => 'en',
    useTranslations: () => {
        const t = (key: string) => key;
        t.has = () => false;
        return t;
    },
}));

jest.mock('@/components/ui/status-badge', () => ({
    // Minimal stand-in — the pure functions never touch it; the
    // component is exercised via React-render tests elsewhere.
    StatusBadge: () => null,
}));

import {
    agStatusVariant,
    agStatusLabel,
    AG_STATUS_VARIANTS,
    AG_STATUS_LABELS,
    type AgStatusEntity,
} from '@/components/ag/ag-status';

describe('agStatusVariant', () => {
    it('resolves the canonical variant for representative statuses', () => {
        // Crop plan lifecycle.
        expect(agStatusVariant('cropPlan', 'DRAFT')).toBe('neutral');
        expect(agStatusVariant('cropPlan', 'ACTIVE')).toBe('info');
        expect(agStatusVariant('cropPlan', 'COMPLETED')).toBe('success');
        expect(agStatusVariant('cropPlan', 'CANCELLED')).toBe('warning');

        // Season.
        expect(agStatusVariant('season', 'PLANNING')).toBe('neutral');
        expect(agStatusVariant('season', 'ACTIVE')).toBe('info');
        expect(agStatusVariant('season', 'CLOSED')).toBe('success');

        // Planting board.
        expect(agStatusVariant('planting', 'SOWN')).toBe('info');
        expect(agStatusVariant('planting', 'HARVESTING')).toBe('warning');
        expect(agStatusVariant('planting', 'HARVESTED')).toBe('success');

        // Field-operation parcel line (DONE → success, others neutral).
        expect(agStatusVariant('operationParcel', 'PENDING')).toBe('neutral');
        expect(agStatusVariant('operationParcel', 'DONE')).toBe('success');
        expect(agStatusVariant('operationParcel', 'SKIPPED')).toBe('neutral');

        // Grain bin kind.
        expect(agStatusVariant('bin', 'BIN')).toBe('info');
        expect(agStatusVariant('bin', 'STORAGE')).toBe('neutral');

        // Grain contract status + type.
        expect(agStatusVariant('contract', 'DELIVERED')).toBe('success');
        expect(agStatusVariant('contract', 'SETTLED')).toBe('success');
        expect(agStatusVariant('contract', 'CANCELLED')).toBe('warning');
        expect(agStatusVariant('contractType', 'SALE')).toBe('info');
        expect(agStatusVariant('contractType', 'PURCHASE')).toBe('neutral');
    });

    it('falls back to neutral for an unknown status', () => {
        expect(agStatusVariant('cropPlan', 'NOT_A_REAL_STATUS')).toBe('neutral');
        expect(agStatusVariant('contract', 'WHATEVER')).toBe('neutral');
    });

    it('falls back to neutral for null/undefined/empty status', () => {
        expect(agStatusVariant('cropPlan', null)).toBe('neutral');
        expect(agStatusVariant('cropPlan', undefined)).toBe('neutral');
        expect(agStatusVariant('cropPlan', '')).toBe('neutral');
    });
});

describe('agStatusLabel', () => {
    it('resolves the human label for representative statuses', () => {
        expect(agStatusLabel('cropPlan', 'DRAFT')).toBe('Draft');
        expect(agStatusLabel('cropPlan', 'CANCELLED')).toBe('Cancelled');
        expect(agStatusLabel('season', 'CLOSED')).toBe('Closed');
        expect(agStatusLabel('planting', 'TRANSPLANTED')).toBe('Transplanted');
        expect(agStatusLabel('operationParcel', 'DONE')).toBe('Done');
        expect(agStatusLabel('bin', 'STORAGE')).toBe('Storage');
        expect(agStatusLabel('contract', 'SETTLED')).toBe('Settled');
        expect(agStatusLabel('contractType', 'PURCHASE')).toBe('Purchase');
    });

    it('falls back to the raw status string for an unknown value', () => {
        expect(agStatusLabel('cropPlan', 'MYSTERY')).toBe('MYSTERY');
        expect(agStatusLabel('bin', 'SILO_XYZ')).toBe('SILO_XYZ');
    });

    it('returns an empty string for null/undefined/empty status', () => {
        expect(agStatusLabel('cropPlan', null)).toBe('');
        expect(agStatusLabel('cropPlan', undefined)).toBe('');
        expect(agStatusLabel('cropPlan', '')).toBe('');
    });
});

describe('AG_STATUS_VARIANTS / AG_STATUS_LABELS parity', () => {
    const entities = Object.keys(AG_STATUS_VARIANTS) as AgStatusEntity[];

    it('covers every documented ag entity', () => {
        expect(entities.sort()).toEqual(
            [
                'bin',
                'contract',
                'contractType',
                'cropPlan',
                'operationParcel',
                'planting',
                'season',
            ].sort(),
        );
    });

    it('has a matching label for every variant key (no orphan statuses)', () => {
        for (const entity of entities) {
            const variantKeys = Object.keys(AG_STATUS_VARIANTS[entity]).sort();
            const labelKeys = Object.keys(AG_STATUS_LABELS[entity]).sort();
            expect(labelKeys).toEqual(variantKeys);
        }
    });

    it('only ever maps to the five valid StatusBadge variants', () => {
        const valid = new Set(['neutral', 'info', 'success', 'warning', 'error']);
        for (const entity of entities) {
            for (const variant of Object.values(AG_STATUS_VARIANTS[entity])) {
                expect(valid.has(variant)).toBe(true);
            }
        }
    });
});
