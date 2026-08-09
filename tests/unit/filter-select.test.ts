/**
 * Epic 53 — FilterSelect contract & decision logic.
 *
 * Two-track verification:
 *
 * 1. **Pure decision helpers** (`filter-select-utils.ts`) — the logic that
 *    drives single/multi-select, per-filter empty states, range token
 *    resolution, and option-membership lookup. Directly testable.
 *
 * 2. **Component contract** (`filter-select.tsx`) — source-level invariants
 *    that pin the observable UX: `cmdk` wired with `loop`, keyboard shortcut
 *    `"f"` to open, Escape cascade (range → back → close), single-select
 *    closes the popover, range panel invoked for `type: "range"` filters,
 *    filter count badge on the trigger, `Enter` on empty input falls through
 *    to `onEmptySubmit`.
 *
 * As with the other filter test suites we stay in node-env jest and rely on
 * source inspection for the React portion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import { ListFilter } from 'lucide-react';
import {
    activeRangeTokenFor,
    hasAppliedRange,
    isEmptyStateObject,
    isOptionSelectedIn,
    isSingleSelect,
    resolveEmptyStateFor,
} from '../../src/components/ui/filter/filter-select-utils';
import {
    encodeRangeToken,
    type ActiveFilterInput,
    type Filter,
} from '../../src/components/ui/filter/types';

const SELECT_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/components/ui/filter/filter-select.tsx'),
    'utf-8',
);

// ─── helpers ─────────────────────────────────────────────────────────

const mkFilter = (overrides: Partial<Filter> = {}): Filter => ({
    key: 'status',
    label: 'Status',
    icon: ListFilter,
    options: [
        { value: 'OPEN', label: 'Open' },
        { value: 'CLOSED', label: 'Closed' },
    ],
    ...overrides,
});

// ═══ 1. PURE DECISION HELPERS ════════════════════════════════════════

describe('isSingleSelect — filter multi/single-select decision', () => {
    it('returns false for a nullish filter', () => {
        expect(isSingleSelect(null)).toBe(false);
        expect(isSingleSelect(undefined)).toBe(false);
    });

    it('returns true when the filter explicitly opts into singleSelect', () => {
        expect(isSingleSelect({ singleSelect: true, multiple: true })).toBe(true);
        // Even in advanced mode, explicit singleSelect wins.
        expect(
            isSingleSelect({ singleSelect: true, multiple: true }, { isAdvancedFilter: true }),
        ).toBe(true);
    });

    it('returns true in simple mode when the filter is not marked multiple', () => {
        expect(isSingleSelect({ multiple: false })).toBe(true);
        expect(isSingleSelect({})).toBe(true);
    });

    it('returns false in simple mode when the filter is marked multiple', () => {
        expect(isSingleSelect({ multiple: true })).toBe(false);
    });

    it('returns false in advanced mode regardless of multiple', () => {
        expect(isSingleSelect({ multiple: false }, { isAdvancedFilter: true })).toBe(false);
        expect(isSingleSelect({ multiple: true }, { isAdvancedFilter: true })).toBe(false);
    });
});

describe('isEmptyStateObject / resolveEmptyStateFor', () => {
    it('treats string / undefined / null as NOT a record', () => {
        expect(isEmptyStateObject('no results')).toBe(false);
        // Record path is only hit when we have a bare plain object.
        expect(isEmptyStateObject(null)).toBe(false);
    });

    it('treats a ReactElement as NOT a record (isValidElement guard)', () => {
        // React 19 changed the element symbol from
        // `Symbol.for('react.element')` to
        // `Symbol.for('react.transitional.element')`. Build a real
        // element via `React.createElement` so the test stays
        // version-agnostic — the implementation calls `isValidElement`,
        // which is the canonical way to recognise an element regardless
        // of which internal symbol the runtime uses.
        const el = React.createElement('div') as unknown as React.ReactNode;
        expect(isEmptyStateObject(el)).toBe(false);
    });

    it('treats a plain object as a record (per-filter override map)', () => {
        expect(isEmptyStateObject({ status: 'nothing', owner: 'none' })).toBe(true);
    });

    it('resolveEmptyStateFor: falls back when emptyState is undefined', () => {
        expect(resolveEmptyStateFor(undefined, null)).toBe('No matching options');
        expect(resolveEmptyStateFor(undefined, 'owner', 'Pick someone')).toBe('Pick someone');
    });

    it('resolveEmptyStateFor: returns a scalar emptyState verbatim', () => {
        expect(resolveEmptyStateFor('global empty', 'owner')).toBe('global empty');
    });

    it('resolveEmptyStateFor: routes by selectedFilterKey when the map has an entry', () => {
        const map = { status: 'No statuses match', default: 'Nothing matches' };
        expect(resolveEmptyStateFor(map, 'status')).toBe('No statuses match');
    });

    it('resolveEmptyStateFor: falls back to the "default" bucket then to the literal fallback', () => {
        const map = { default: 'Pick a filter first' };
        expect(resolveEmptyStateFor(map, null)).toBe('Pick a filter first');

        const empty: Record<string, import('react').ReactNode> = {};
        expect(resolveEmptyStateFor(empty, null, 'hello')).toBe('hello');
    });
});

describe('isOptionSelectedIn — active-filter membership', () => {
    const active: ActiveFilterInput[] = [
        { key: 'status', values: ['OPEN', 'CLOSED'], operator: 'IS_ONE_OF' },
        { key: 'owner', value: 'u1' },
    ];

    it('returns false for undefined activeFilters', () => {
        expect(isOptionSelectedIn(undefined, 'status', 'OPEN')).toBe(false);
    });

    it('returns false when the key has no active entry', () => {
        expect(isOptionSelectedIn(active, 'category', 'TECH')).toBe(false);
    });

    it('returns true when the value is among the key\'s normalised values', () => {
        expect(isOptionSelectedIn(active, 'status', 'OPEN')).toBe(true);
        expect(isOptionSelectedIn(active, 'status', 'CLOSED')).toBe(true);
    });

    it('returns false when the value exists for a different key', () => {
        expect(isOptionSelectedIn(active, 'owner', 'OPEN')).toBe(false);
    });

    it('handles legacy singular { key, value } entries via normalizeActiveFilter', () => {
        expect(isOptionSelectedIn(active, 'owner', 'u1')).toBe(true);
        expect(isOptionSelectedIn(active, 'owner', 'u2')).toBe(false);
    });
});

describe('hasAppliedRange / activeRangeTokenFor', () => {
    it('hasAppliedRange: rejects the empty sentinel', () => {
        expect(hasAppliedRange('|')).toBe(false);
        expect(hasAppliedRange(undefined)).toBe(false);
        expect(hasAppliedRange(null)).toBe(false);
    });

    it('hasAppliedRange: accepts one-sided ranges', () => {
        expect(hasAppliedRange('30|')).toBe(true);
        expect(hasAppliedRange('|70')).toBe(true);
        expect(hasAppliedRange(encodeRangeToken(5))).toBe(true);
    });

    it('hasAppliedRange: accepts two-sided ranges', () => {
        expect(hasAppliedRange('30|70')).toBe(true);
    });

    it('activeRangeTokenFor: undefined when filter is not a range', () => {
        const enumFilter = mkFilter({ type: 'default' });
        expect(
            activeRangeTokenFor(enumFilter, [{ key: 'status', values: ['30|70'], operator: 'IS' }]),
        ).toBeUndefined();
    });

    it('activeRangeTokenFor: undefined when active list has no entry for the key', () => {
        const rangeFilter = mkFilter({ key: 'score', type: 'range', options: null });
        expect(activeRangeTokenFor(rangeFilter, [])).toBeUndefined();
    });

    it('activeRangeTokenFor: returns the first value when present', () => {
        const rangeFilter = mkFilter({ key: 'score', type: 'range', options: null });
        expect(
            activeRangeTokenFor(rangeFilter, [
                { key: 'score', values: ['30|70'], operator: 'IS' },
            ]),
        ).toBe('30|70');
    });

    it('activeRangeTokenFor: tolerates the legacy { key, value } shape', () => {
        const rangeFilter = mkFilter({ key: 'score', type: 'range', options: null });
        expect(
            activeRangeTokenFor(rangeFilter, [{ key: 'score', value: '30|70' }]),
        ).toBe('30|70');
    });
});

// ═══ 2. FILTER SELECT — SOURCE CONTRACT ══════════════════════════════

describe('FilterSelect — component public contract', () => {
    it('exports a FilterSelect function + FilterSelectProps-compatible prop surface', () => {
        expect(SELECT_SRC).toMatch(/export function FilterSelect\(/);
        // Every documented public prop must appear in the props type literal.
        for (const prop of [
            'filters',
            'onSelect',
            'onRemove',
            'onRemoveFilter',
            'onOpenFilter',
            'onSearchChange',
            'onSelectedFilterChange',
            'activeFilters',
            'askAI',
            'isAdvancedFilter',
            'children',
            'emptyState',
            'className',
        ]) {
            expect(SELECT_SRC).toContain(prop);
        }
    });

    it('uses cmdk\'s Command with `loop` so keyboard nav wraps at list edges', () => {
        expect(SELECT_SRC).toMatch(/from ['"]cmdk['"]/);
        expect(SELECT_SRC).toMatch(/<Command\b[\s\S]*?\bloop\b/);
    });

    it('binds the "f" keyboard shortcut to open the picker when closed', () => {
        expect(SELECT_SRC).toMatch(/useKeyboardShortcut\(\s*['"]f['"]/);
        expect(SELECT_SRC).toMatch(/enabled:\s*!isOpen/);
    });

    it('renders a visible F kbd hint on the top-level input', () => {
        expect(SELECT_SRC).toMatch(/<kbd[\s\S]*?>[\s\S]*?F[\s\S]*?<\/kbd>/);
    });

    it('Escape cascade: range-with-bounds → close; drill-in → back; top-level → close', () => {
        // Range path: when both bounds are set, Escape closes rather than drilling back.
        expect(SELECT_SRC).toMatch(/selectedFilter\?\.type === ['"]range['"]/);
        expect(SELECT_SRC).toMatch(/goBackOrClose/);
        expect(SELECT_SRC).toMatch(/onEscapeKeyDown/);
    });

    it('CommandInput treats Escape / empty-Backspace as goBackOrClose', () => {
        expect(SELECT_SRC).toMatch(/e\.key === ['"]Escape['"]/);
        expect(SELECT_SRC).toMatch(/e\.key === ['"]Backspace['"][\s\S]*?Delete/);
        // Both paths must preventDefault to stop cmdk from swallowing the key.
        expect(SELECT_SRC).toMatch(/e\.preventDefault\(\)/);
    });

    it('single-select closes the popover after selection; multi-select stays open', () => {
        expect(SELECT_SRC).toMatch(/if\s*\(\s*singleSelect\s*\)\s*setIsOpen\(\s*false\s*\)/);
    });

    it('uses isSingleSelect() helper exclusively (no inline duplicate of the decision)', () => {
        expect(SELECT_SRC).toMatch(/isSingleSelect\(/);
        // Drift sentinel — the old inline expression must not reappear verbatim.
        expect(SELECT_SRC).not.toMatch(
            /selectedFilter\?\.singleSelect \|\|\s*\(!isAdvancedFilter && !selectedFilter\?\.multiple\)/,
        );
    });

    it('invokes the FilterRangePanel for range filters, the cmdk list otherwise', () => {
        expect(SELECT_SRC).toMatch(/<FilterRangePanel\b/);
        // Range branch keys on selectedFilter.type === "range".
        expect(SELECT_SRC).toMatch(/selectedFilter\?\.type === ['"]range['"][\s\S]*?FilterRangePanel/);
    });

    it('scrolls the option list through the shared FilterScroll primitive', () => {
        expect(SELECT_SRC).toMatch(/<FilterScroll\b/);
        expect(SELECT_SRC).toMatch(/from ['"]\.\/filter-scroll['"]/);
    });

    it('filter count badge appears on the trigger when activeFilters is non-empty', () => {
        expect(SELECT_SRC).toMatch(/activeFilters\?\.length/);
        // Token-aware badge (Epic 53 gap remediation): brand fill + inverted
        // content colour so the count flips correctly under the theme toggle.
        expect(SELECT_SRC).toMatch(/bg-brand-emphasis[^"]*text-content-inverted/);
    });

    it('CommandInput onEmptySubmit routes to selectOption(search) or askAI fallback', () => {
        expect(SELECT_SRC).toMatch(/onEmptySubmit/);
        expect(SELECT_SRC).toMatch(/selectOption\(search\)/);
        // askAI short-circuits the empty submit — pin the branching so it doesn't drift.
        expect(SELECT_SRC).toMatch(/askAI/);
    });

    it('notifies the parent of search + selectedFilter changes', () => {
        expect(SELECT_SRC).toMatch(/onSearchChange\?\.\(search\)/);
        expect(SELECT_SRC).toMatch(/onSelectedFilterChange\?\.\(selectedFilterKey\)/);
    });

    it('maintains list dimensions across async option loads (no layout jump)', () => {
        // The component snapshots listContainer dimensions into a ref so the
        // loading spinner fills the same box.
        expect(SELECT_SRC).toMatch(/listDimensions/);
        expect(SELECT_SRC).toMatch(/LoadingSpinner/);
    });

    it('respects `shouldFilter` so server-filtered option lists bypass cmdk\'s local filter', () => {
        expect(SELECT_SRC).toMatch(/shouldFilter/);
        expect(SELECT_SRC).toMatch(/selectedFilter\.shouldFilter !== false/);
    });

    it('honours `hideInFilterDropdown` in the top-level filter list', () => {
        expect(SELECT_SRC).toMatch(/!filter\.hideInFilterDropdown/);
    });

    it('inserts a CommandSeparator after filters marked `separatorAfter`', () => {
        expect(SELECT_SRC).toMatch(/filter\.separatorAfter/);
        expect(SELECT_SRC).toMatch(/Command\.Separator/);
    });

    it('range clear routes through onRemoveFilter (both URL params) or onRemove(token)', () => {
        // The range "Clear" button must prefer onRemoveFilter to scrub both
        // min/max URL params in one action.
        expect(SELECT_SRC).toMatch(/onRemoveFilter\s*\?\s*onRemoveFilter\(/);
        expect(SELECT_SRC).toMatch(/onRemove\(\s*selectedFilter\.key/);
    });

    it('is config-driven — no page-specific filter keys hardcoded in the source', () => {
        // Guard against someone smuggling in entity-specific logic.
        for (const token of ['practices', 'risks', 'policies', 'vendors', 'evidence', 'tasks']) {
            // Allow the literal word in comments, but not as a hardcoded key branch.
            expect(SELECT_SRC).not.toMatch(
                new RegExp(`(selectedFilterKey|filter\\.key)\\s*===\\s*['\"]${token}['\"]`),
            );
        }
    });
});

// ═══ 3. POPOVER / FOCUS INTEGRATION ══════════════════════════════════

describe('FilterSelect — popover + focus integration', () => {
    it('is wrapped in the shared Popover primitive (not a bespoke modal)', () => {
        expect(SELECT_SRC).toMatch(/from ['"]\.\.\/popover['"]/);
        expect(SELECT_SRC).toMatch(/<Popover\b/);
    });

    it('passes Escape handling via Popover.onEscapeKeyDown (focus semantics preserved)', () => {
        expect(SELECT_SRC).toMatch(/onEscapeKeyDown=\{/);
    });

    it('wraps the content in AnimatedSizeContainer so drill-in / back animate height', () => {
        expect(SELECT_SRC).toMatch(/AnimatedSizeContainer/);
        // height is animated; width only on non-mobile to avoid horizontal jank.
        expect(SELECT_SRC).toMatch(/width=\{\s*!isMobile\s*\}/);
        expect(SELECT_SRC).toMatch(/\bheight\b/);
    });
});
