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
        // GRC teardown phase 2 removed the `practiceId` facet with the
        // Practice model.
        expect([...EVIDENCE_FILTER_KEYS].sort()).toEqual(
            ['folder', 'status', 'type'].sort(),
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

    it('every filter carries group + clearable reset behaviour', () => {
        for (const f of evidenceFilterDefs.filters) {
            expect(f.group).toBeDefined();
            expect(f.resetBehavior).toBe('clearable');
        }
    });
});

describe('buildEvidenceFilters', () => {
    it('injects folder options without mutating the static defs', () => {
        // Folder is the one facet whose options are still derived at render
        // time; `practiceId` went with the Practice model. The
        // no-mutation half of this assertion is the part worth keeping —
        // the builder must return a NEW array, or a second call would
        // accumulate options.
        const live = buildEvidenceFilters([
            { folder: 'Sprays 2026' },
            { folder: 'Sprays 2026' },
            { folder: null },
        ]);
        const folder = live.find((f) => f.key === 'folder');
        // 'Sprays 2026' deduped, plus the __none__ pseudo-bucket.
        expect(folder?.options).toHaveLength(2);
        // Static defs still null — a new array was constructed.
        expect(evidenceFilterDefs.getFilter('folder').options).toBeNull();
    });
});

describe('Evidence URL round-trip', () => {
    it('roundtrips filter state → URL → state', () => {
        // `practiceId` left the managed key set with the Practice model;
        // `folder` keeps the multi-value round-trip covered, which is the
        // part of this test that actually exercises the comma-join.
        const initial: FilterState = {
            type: ['FILE'],
            status: ['APPROVED', 'SUBMITTED'],
            folder: ['Sprays 2026', 'Harvest 2026'],
        };
        const params = filterStateToUrlParams(initial);
        expect(params.get('type')).toBe('FILE');
        expect(params.get('status')).toBe('APPROVED,SUBMITTED');
        expect(params.get('folder')).toBe('Sprays 2026,Harvest 2026');

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
