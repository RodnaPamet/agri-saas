/**
 * Epic 53 — filter UI primitive verification.
 *
 * Covers the three reusable components that back `FilterSelect` and every
 * list-page toolbar:
 *
 *   1. FilterScroll        — scrollable content container with bottom fade
 *   2. FilterRangePanel    — min/max range editor (logic via filter-range-utils)
 *   3. FilterList          — active filter pill list with remove-one / clear-all
 *
 * jest runs under `testEnvironment: 'node'` with tsconfig `jsx: "preserve"`, so
 * we cannot `require(...)` a `.tsx` file at runtime (the existing filter
 * foundation guard explains why). This suite therefore splits verification in
 * two:
 *
 *   - **Logic tests** require the extracted `.ts` helpers (`filter-range-utils`,
 *     `types`) and exercise the pure behavior that drives the range inputs and
 *     the active-filter normaliser.
 *
 *   - **Contract tests** read each primitive's source and assert structural
 *     invariants (required props, a11y markers, keyboard hook wiring,
 *     token-backed classes) so a refactor can't silently drop a feature.
 *
 * The goal: catch regressions in the *observable contract* of each primitive
 * without a second jest environment.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    normalizeRangeBounds,
    rangeTokenBounds,
    sanitizeNumericDraft,
    storageToDraft,
} from '../../src/components/ui/filter/filter-range-utils';
import {
    encodeRangeToken,
    normalizeActiveFilter,
    parseRangeToken,
    type ActiveFilter,
} from '../../src/components/ui/filter/types';

const FILTER_DIR = path.resolve(__dirname, '../../src/components/ui/filter');
const read = (f: string) => fs.readFileSync(path.join(FILTER_DIR, f), 'utf-8');

// ─── 1. FilterRangePanel — pure input behaviour (filter-range-utils) ──

describe('FilterRangePanel — range input behaviour', () => {
    describe('normalizeRangeBounds', () => {
        it('returns an empty object when both bounds are missing', () => {
            expect(normalizeRangeBounds()).toEqual({});
            expect(normalizeRangeBounds(undefined, undefined)).toEqual({});
        });

        it('passes a one-sided range through untouched', () => {
            expect(normalizeRangeBounds(5, undefined)).toEqual({ min: 5 });
            expect(normalizeRangeBounds(undefined, 50)).toEqual({ max: 50 });
        });

        it('accepts a correctly ordered pair as-is', () => {
            expect(normalizeRangeBounds(3, 7)).toEqual({ min: 3, max: 7 });
            expect(normalizeRangeBounds(3, 3)).toEqual({ min: 3, max: 3 });
        });

        it('swaps inverted bounds so downstream encoders always see min≤max', () => {
            expect(normalizeRangeBounds(7, 3)).toEqual({ min: 3, max: 7 });
        });

        it('handles zero correctly (not confused with undefined)', () => {
            expect(normalizeRangeBounds(0, 5)).toEqual({ min: 0, max: 5 });
            expect(normalizeRangeBounds(-5, 0)).toEqual({ min: -5, max: 0 });
        });
    });

    describe('rangeTokenBounds', () => {
        // The pill's label logic reads its bounds through this. Both range
        // KINDS share the `"lo|hi"` token but not its alphabet, and reading
        // a date token numerically yields NaN on both sides — which is how a
        // date pill would come to display the raw
        // `"2026-08-01|2026-08-12"` instead of a window.
        it('reads numeric bounds for a numeric range', () => {
            expect(rangeTokenBounds('30|70', false)).toEqual({ lo: '30', hi: '70' });
            expect(rangeTokenBounds('30|', false)).toEqual({ lo: '30', hi: null });
            expect(rangeTokenBounds('|70', false)).toEqual({ lo: null, hi: '70' });
            expect(rangeTokenBounds('|', false)).toEqual({ lo: null, hi: null });
        });

        it('reads ISO bounds for a date range', () => {
            expect(rangeTokenBounds('2026-08-01|2026-08-12', true)).toEqual({
                lo: '2026-08-01',
                hi: '2026-08-12',
            });
            expect(rangeTokenBounds('2026-08-01|', true)).toEqual({
                lo: '2026-08-01',
                hi: null,
            });
        });

        it('would have reported a date token as EMPTY under the numeric reader', () => {
            // The regression this helper exists to prevent, stated as a
            // test rather than a comment.
            expect(Number.isFinite(Number('2026-08-01'))).toBe(false);
            expect(rangeTokenBounds('2026-08-01|2026-08-12', false)).toEqual({
                lo: null,
                hi: null,
            });
        });

        it('treats a malformed side as ABSENT, not as "NaN"', () => {
            // A hand-edited URL should degrade to "no min", not render the
            // string NaN into the pill. The server rejects the same token.
            expect(rangeTokenBounds('abc|70', false)).toEqual({ lo: null, hi: '70' });
            expect(rangeTokenBounds('2026-8-1|2026-08-12', true)).toEqual({
                lo: null,
                hi: '2026-08-12',
            });
        });
    });

    describe('storageToDraft', () => {
        it('returns empty string for undefined storage', () => {
            expect(storageToDraft(undefined, 1)).toBe('');
            expect(storageToDraft(undefined, 100)).toBe('');
        });

        it('truncates to integer at scale=1', () => {
            expect(storageToDraft(42, 1)).toBe('42');
            expect(storageToDraft(42.9, 1)).toBe('42');
            expect(storageToDraft(-3.5, 1)).toBe('-3');
        });

        it('divides by displayScale and drops redundant trailing zeros', () => {
            expect(storageToDraft(500, 100)).toBe('5'); // $5.00 → '5'
            expect(storageToDraft(550, 100)).toBe('5.5'); // $5.50 → '5.5'
            expect(storageToDraft(512, 100)).toBe('5.12'); // $5.12 → '5.12'
        });

        it('rounds to two decimal places before normalising', () => {
            // 333 / 100 = 3.33 exactly.
            expect(storageToDraft(333, 100)).toBe('3.33');
            // 1 / 3 ≈ 0.003333... at scale=1000 → toFixed(2)=0.00 → '0'.
            expect(storageToDraft(3, 1000)).toBe('0');
        });

        it('handles zero at any scale', () => {
            expect(storageToDraft(0, 1)).toBe('0');
            expect(storageToDraft(0, 100)).toBe('0');
        });
    });

    describe('sanitizeNumericDraft', () => {
        it('returns the empty string verbatim (no-op for cleared inputs)', () => {
            expect(sanitizeNumericDraft('', 1)).toBe('');
            expect(sanitizeNumericDraft('', 100)).toBe('');
        });

        it('at scale=1, strips every non-digit character', () => {
            expect(sanitizeNumericDraft('1a2b3', 1)).toBe('123');
            expect(sanitizeNumericDraft('4.2', 1)).toBe('42');
            expect(sanitizeNumericDraft('abc', 1)).toBe('');
            expect(sanitizeNumericDraft('-5', 1)).toBe('5'); // minus stripped at integer mode
        });

        it('at scale>1, allows a single decimal point and collapses duplicates', () => {
            expect(sanitizeNumericDraft('3.14', 100)).toBe('3.14');
            expect(sanitizeNumericDraft('3.14.15', 100)).toBe('3.1415');
            expect(sanitizeNumericDraft('1..2', 100)).toBe('1.2');
            expect(sanitizeNumericDraft('abc.5', 100)).toBe('.5');
        });

        it('at scale>1, strips non-numeric/non-dot characters', () => {
            expect(sanitizeNumericDraft('5.2%', 100)).toBe('5.2');
            expect(sanitizeNumericDraft('1,234.56', 100)).toBe('1234.56');
        });

        it('preserves digits while removing disallowed characters regardless of scale', () => {
            // A user typing currency-like strings should still produce a usable draft.
            expect(sanitizeNumericDraft('$ 42.99', 100)).toBe('42.99');
            expect(sanitizeNumericDraft('$ 42.99', 1)).toBe('4299');
        });
    });

    describe('end-to-end: display input → encode → decode → normalise', () => {
        it('round-trips a well-formed range through the encoder + normaliser', () => {
            // User types "3" and "7" at scale=10 → storage units 30 / 70
            const minStorage = Number(sanitizeNumericDraft('3', 10)) * 10;
            const maxStorage = Number(sanitizeNumericDraft('7', 10)) * 10;
            const normalised = normalizeRangeBounds(minStorage, maxStorage);
            const token = encodeRangeToken(normalised.min, normalised.max);
            expect(token).toBe('30|70');
            expect(parseRangeToken(token)).toEqual({ min: 30, max: 70 });
        });

        it('swaps inverted user input before encoding to the URL', () => {
            // User accidentally typed max first, then a smaller min.
            const inverted = normalizeRangeBounds(70, 30);
            expect(inverted).toEqual({ min: 30, max: 70 });
            expect(encodeRangeToken(inverted.min, inverted.max)).toBe('30|70');
        });

        it('emits the sentinel token "|" when the user clears both ends', () => {
            expect(encodeRangeToken(undefined, undefined)).toBe('|');
            expect(parseRangeToken('|')).toEqual({});
        });
    });
});

// ─── 2. FilterList — active filter normaliser ───────────────────────

describe('FilterList — active filter normalisation', () => {
    it('keeps an already-normalised active filter untouched', () => {
        const f: ActiveFilter = { key: 'status', values: ['OPEN'], operator: 'IS' };
        expect(normalizeActiveFilter(f)).toEqual(f);
    });

    it('upgrades { key, value } legacy singular to { key, values, operator: "IS" }', () => {
        // `ActiveFilterInput` is a union that includes the legacy singular shape,
        // so the normaliser accepts it directly without a type assertion.
        expect(normalizeActiveFilter({ key: 'status', value: 'OPEN' })).toEqual({
            key: 'status',
            values: ['OPEN'],
            operator: 'IS',
        });
    });

    it('chooses IS vs IS_ONE_OF based on values length when operator is missing', () => {
        expect(normalizeActiveFilter({ key: 'tag', values: ['a'] })).toEqual({
            key: 'tag',
            values: ['a'],
            operator: 'IS',
        });
        expect(normalizeActiveFilter({ key: 'tag', values: ['a', 'b'] })).toEqual({
            key: 'tag',
            values: ['a', 'b'],
            operator: 'IS_ONE_OF',
        });
    });
});

// ─── 3. Source-level contract tests ─────────────────────────────────
//
// React tsx can't be loaded in the node-env jest runner. These contract tests
// read the source to pin the observable structure — props, a11y markers,
// keyboard wiring, token-backed classes — so a refactor can't silently drop
// any of them.

describe('FilterScroll — primitive contract', () => {
    const src = read('filter-scroll.tsx');

    it('is a `forwardRef` component rendered as a client primitive', () => {
        expect(src).toMatch(/^"use client"/);
        expect(src).toMatch(/forwardRef</);
        expect(src).toMatch(/FilterScroll\.displayName\s*=\s*"FilterScroll"/);
    });

    it('accepts children via PropsWithChildren (generic composition API)', () => {
        expect(src).toMatch(/PropsWithChildren/);
    });

    it('emits an overflow-y-scroll container sized for a bounded menu', () => {
        expect(src).toMatch(/max-h-\[50vh\]/);
        expect(src).toMatch(/overflow-y-scroll/);
        expect(src).toMatch(/scrollbar-hide/);
    });

    it('renders a bottom-fade gradient indicating more content below', () => {
        expect(src).toMatch(/pointer-events-none/);
        expect(src).toMatch(/bg-gradient-to-t from-white/);
    });

    it('updates the fade opacity from useScrollProgress (not a fixed value)', () => {
        expect(src).toMatch(/useScrollProgress/);
        expect(src).toMatch(/opacity:\s*1\s*-\s*Math\.pow\(scrollProgress,\s*2\)/);
    });
});

describe('FilterRangePanel — primitive contract', () => {
    const src = read('filter-range-panel.tsx');

    it('is rendered as a client primitive', () => {
        expect(src).toMatch(/^"use client"/);
    });

    it('consumes the extracted pure utils (no in-file duplicate copies)', () => {
        expect(src).toMatch(/from ['"]\.\/filter-range-utils['"]/);
        // The helpers must NOT also live in this file (drift sentinel).
        expect(src).not.toMatch(/function normalizeRangeBounds\(/);
        expect(src).not.toMatch(/function storageToDraft\(/);
        expect(src).not.toMatch(/function sanitizeNumericDraft\(/);
    });

    it('exports the public panel type with the documented prop surface', () => {
        expect(src).toMatch(/export type FilterRangePanelProps\s*=\s*\{/);
        for (const prop of ['filter', 'activeToken', 'onApply', 'onBack']) {
            expect(src).toContain(prop);
        }
        // Optional props carrying documented callbacks.
        expect(src).toMatch(/onClear\?\s*:\s*\(\)\s*=>\s*void/);
        expect(src).toMatch(/onCloseOuter\?\s*:\s*\(\)\s*=>\s*void/);
        expect(src).toMatch(/scrollRef\?\s*:\s*Ref<HTMLDivElement/);
    });

    it('delegates scrolling to the shared FilterScroll primitive', () => {
        expect(src).toMatch(/import \{ FilterScroll \} from ['"]\.\/filter-scroll['"]/);
        expect(src).toMatch(/<FilterScroll\b/);
    });

    it('encodes/decodes the range token through the shared codec in types.ts', () => {
        expect(src).toMatch(/encodeRangeToken/);
        expect(src).toMatch(/parseRangeToken/);
    });
});

describe('FilterList — primitive contract', () => {
    const src = read('filter-list.tsx');

    it('accepts the four remove/select handlers documented as its public API', () => {
        // Source-level prop-shape contract — must exist exactly so consumers
        // can wire in their own state without guessing names.
        expect(src).toMatch(/onRemove:\s*\(key:\s*string/);
        expect(src).toMatch(/onRemoveFilter\?:\s*\(key:\s*string\)\s*=>\s*void/);
        expect(src).toMatch(/onRemoveAll:\s*\(\)\s*=>\s*void/);
        expect(src).toMatch(/onSelect\?:\s*\(/);
        expect(src).toMatch(/onToggleOperator\?:\s*\(key:\s*string\)\s*=>\s*void/);
    });

    it('binds Escape to clear-all via the shared keyboard-shortcut hook', () => {
        expect(src).toMatch(/useKeyboardShortcut\(\s*['"]Escape['"]/);
        // Priority 1 lets nested listeners pre-empt a blanket Escape handler.
        expect(src).toMatch(/priority:\s*1/);
    });

    it('renders a labelled Clear Filters button with an ESC keyboard hint', () => {
        // The label is i18n-routed (ui.filter.clearFilters = "Clear Filters").
        expect(src).toMatch(/t\(["']clearFilters["']\)/);
        // The visible ESC kbd hint doubles as a keyboard-affordance cue.
        expect(src).toMatch(/<kbd[\s\S]*?ESC[\s\S]*?<\/kbd>/);
    });

    it('wraps the pill row in AnimatedSizeContainer so add/remove animates height', () => {
        expect(src).toMatch(/AnimatedSizeContainer/);
        expect(src).toMatch(/AnimatePresence/);
    });

    it('routes every pill remove through either onRemoveFilter (whole filter) or onRemove (single value)', () => {
        expect(src).toMatch(/onRemoveFilter\s*\?\s*onRemoveFilter\(filterKey\)\s*:\s*onRemove\(filterKey,\s*token\)/);
    });

    it('falls back to the shared normalizeActiveFilter for back-compat shapes', () => {
        expect(src).toMatch(/normalizeActiveFilter/);
    });

    it('layout is responsive: horizontal on ≥sm, wrapping on narrow viewports', () => {
        expect(src).toMatch(/flex-wrap/);
        expect(src).toMatch(/sm:flex-nowrap/);
    });
});

// ─── 4. Toolbar integration sanity ──────────────────────────────────

describe('Toolbar integration — the three primitives compose cleanly', () => {
    it('filter-list pulls AnimatedSizeContainer from the shared ui layer (not a duplicate)', () => {
        const src = read('filter-list.tsx');
        expect(src).toMatch(/from ['"]\.\.\/animated-size-container['"]/);
    });

    it('filter-select and filter-list both reach the same FilterRangePanel/FilterScroll primitives', () => {
        const list = read('filter-list.tsx');
        const select = read('filter-select.tsx');
        expect(list).toMatch(/\.\/filter-range-panel/);
        expect(select).toMatch(/\.\/filter-range-panel/);
        expect(select).toMatch(/\.\/filter-scroll/);
    });

    it('no primitive page-scopes its styling — all use the shared cn + token classes', () => {
        for (const f of ['filter-scroll.tsx', 'filter-range-panel.tsx', 'filter-list.tsx']) {
            const src = read(f);
            // No hard-coded hex colours — those would escape the token system.
            expect(src).not.toMatch(/#[0-9a-fA-F]{6}/);
        }
    });
});
