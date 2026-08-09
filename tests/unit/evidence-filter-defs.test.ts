/**
 * Epic 53 — Evidence filter config + URL sync integration.
 */

import {
    filterStateToUrlParams,
    parseUrlToFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
    buildEvidenceFilters,
    practiceOptionsFromPractices,
    EVIDENCE_FILTER_KEYS,
    EVIDENCE_STATUS_LABELS,
    EVIDENCE_TYPE_LABELS,
    evidenceFilterDefs,
} from '../../src/app/t/[tenantSlug]/(app)/evidence/filter-defs';
import { toApiSearchParams } from '../../src/lib/filters/url-sync';

describe('Evidence filter config', () => {
    it('manages exactly the keys the API understands (+ status widening)', () => {
        // B8 follow-up added `folder` to the Evidence filter set
        // when evidence folders shipped. The API GET route +
        // EvidenceListFilters + repository where-builder all honour
        // `folder` end-to-end (see b8-followup-evidence-folders ratchet).
        expect([...EVIDENCE_FILTER_KEYS].sort()).toEqual(
            ['practiceId', 'folder', 'status', 'type'].sort(),
        );
    });

    it('type / status are multi-select enum filters with static options', () => {
        const type = evidenceFilterDefs.getFilter('type');
        const status = evidenceFilterDefs.getFilter('status');
        expect(type.multiple).toBe(true);
        expect(status.multiple).toBe(true);
        expect((type.options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(EVIDENCE_TYPE_LABELS).sort(),
        );
        expect((status.options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(EVIDENCE_STATUS_LABELS).sort(),
        );
    });

    it('practiceId is an entity-ref filter (async options, shouldFilter=true)', () => {
        const practice = evidenceFilterDefs.getFilter('practiceId');
        expect(practice.options).toBeNull();
        expect(practice.shouldFilter).toBe(true);
    });

    it('every filter carries group + clearable reset behaviour', () => {
        for (const f of evidenceFilterDefs.filters) {
            expect(f.group).toBeDefined();
            expect(f.resetBehavior).toBe('clearable');
        }
    });
});

describe('practiceOptionsFromPractices', () => {
    it('builds a label with the code prefix and a short display label', () => {
        const opts = practiceOptionsFromPractices([
            { id: 'c1', name: 'Information Classification', code: 'A.5.12' },
            { id: 'c2', name: 'Custom policy', code: 'CUST-1' },
            { id: 'c3', name: 'No prefix' },
        ]);
        expect(opts[0].label).toBe('A.5.12: Information Classification');
        expect(opts[0].displayLabel).toBe('A.5.12');
        expect(opts.find((o) => o.value === 'c2')?.displayLabel).toBe('CUST-1');
        expect(opts.find((o) => o.value === 'c3')?.label).toBe('No prefix');
    });

    it('dedupes by id and sorts alphabetically', () => {
        const opts = practiceOptionsFromPractices([
            { id: 'zz', name: 'Zulu', code: 'Z.1' },
            { id: 'aa', name: 'Alpha', code: 'A.1' },
            { id: 'aa', name: 'Alpha duplicate', code: 'A.1' },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['aa', 'zz']);
    });
});

describe('buildEvidenceFilters', () => {
    it('injects practice options without mutating the static defs', () => {
        const live = buildEvidenceFilters([
            { id: 'c1', name: 'ISMS Scope', code: 'A.4.3' },
        ]);
        const practice = live.find((f) => f.key === 'practiceId');
        expect(practice?.options).toHaveLength(1);
        // Static defs still null — a new array was constructed.
        expect(evidenceFilterDefs.getFilter('practiceId').options).toBeNull();
    });
});

describe('Evidence URL round-trip', () => {
    it('roundtrips filter state → URL → state', () => {
        const initial: FilterState = {
            type: ['FILE'],
            status: ['APPROVED', 'SUBMITTED'],
            practiceId: ['c1', 'c2'],
        };
        const params = filterStateToUrlParams(initial);
        expect(params.get('type')).toBe('FILE');
        expect(params.get('status')).toBe('APPROVED,SUBMITTED');
        expect(params.get('practiceId')).toBe('c1,c2');

        const parsed = parseUrlToFilterState(params, EVIDENCE_FILTER_KEYS);
        expect(parsed).toEqual(initial);
    });

    it('API fetch params include q and filter state together', () => {
        const state: FilterState = { type: ['LINK'] };
        const params = toApiSearchParams(state, { search: 'soc2' });
        expect(params.get('type')).toBe('LINK');
        expect(params.get('q')).toBe('soc2');
    });

    it('unmanaged URL keys are stripped by parseUrlToFilterState', () => {
        const raw = new URLSearchParams({
            type: 'FILE',
            irrelevant: 'skip-me',
        });
        const parsed = parseUrlToFilterState(raw, EVIDENCE_FILTER_KEYS);
        expect(parsed.type).toEqual(['FILE']);
        expect(parsed).not.toHaveProperty('irrelevant');
    });
});
