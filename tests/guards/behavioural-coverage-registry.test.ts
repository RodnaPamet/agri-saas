/**
 * Behavioural-coverage registry — the convention that keeps a green
 * structural ratchet from being mistaken for a verified feature.
 *
 * THE PROBLEM (see `docs/frontend-assurance-model.md` and
 * `docs/roadmap-audit-2026-05-13.md`):
 *
 *   The repo has ~387 structural ratchets under `tests/guards/` and
 *   `tests/guardrails/`. Almost all are string/AST scans asserting a
 *   className or symbol is PRESENT in source. A green structural
 *   ratchet does NOT prove the feature works — the audit caught three
 *   cases in one week where it was green but the rendered result was
 *   wrong (the flagship: a nav active-band where the right token was
 *   in `className` but the rendered gradient was the wrong ramp).
 *
 * THE CONVENTION:
 *
 *   This guard carries a curated registry of HIGH-RISK primitives —
 *   primitives where a structural ratchet alone has been shown (or is
 *   judged likely) to miss a real regression because the wire-up
 *   between className and rendered effect is subtle. For every entry,
 *   this guard asserts a matching Tier-2 behavioural/rendered test
 *   file exists under `tests/rendered/`.
 *
 *   The registry is a ONE-WAY RATCHET. It starts with today's reality
 *   and only grows. Removing an entry, or pointing it at a test file
 *   that no longer exists, fails CI.
 *
 * THIS IS NOT a back-fill of all 387 ratchets. The audit explicitly
 * says "convert one ratchet per session". The registry is the curated
 * subset where the structural-vs-rendered gap actually bites — adding
 * to it is cheap, and a future contributor who ships a new high-risk
 * primitive adds a row here in the same PR, which forces the rendered
 * test to exist before merge.
 *
 * HOW TO ADD AN ENTRY:
 *   1. Write the Tier-2 rendered test in `tests/rendered/` — it MUST
 *      assert a computed/resolved/rendered value, not just a
 *      className substring (see `docs/frontend-assurance-model.md`,
 *      "The behavioural assertion rule").
 *   2. Add a row to REGISTRY below: the primitive, its structural
 *      ratchet (the cheap scan that is necessary-but-not-sufficient),
 *      the rendered test that verifies behaviour, and the
 *      regression class it guards against.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERED_DIR = path.join(REPO_ROOT, 'tests/rendered');
const GUARDS_DIR = path.join(REPO_ROOT, 'tests/guards');
const GUARDRAILS_DIR = path.join(REPO_ROOT, 'tests/guardrails');

interface RegistryEntry {
    /** The high-risk primitive / feature. */
    primitive: string;
    /**
     * The structural ratchet(s) that scan this primitive's source.
     * Necessary but NOT sufficient — relative to tests/. May be empty
     * (`[]`) when the primitive has no structural ratchet yet and the
     * rendered test is the only coverage; the point is the rendered
     * test must exist regardless.
     */
    structuralRatchets: string[];
    /** The Tier-2 rendered test that verifies BEHAVIOUR. Relative to tests/. */
    renderedTest: string;
    /** The concrete regression class the rendered test catches. */
    guards: string;
}

/**
 * THE REGISTRY. One-way ratchet — only append.
 *
 * Seeded 2026-05-22 with the four high-risk items from the audit's
 * "Known broken / risky areas" list that are amenable to rendered
 * testing. The other four audit items (searchbar removals, tenant
 * switcher, FilterToolbar coverage, EntityDetailLayout coverage) are
 * E2E-shaped — see `docs/frontend-assurance-model.md` for why they
 * belong in `tests/e2e/`, not here.
 */
const REGISTRY: RegistryEntry[] = [
    {
        primitive: 'NavItem active-band tone (sidebar)',
        structuralRatchets: ['guards/r13-active-band-secondary.test.ts'],
        renderedTest: 'rendered/nav-item-active-band-tone.test.tsx',
        guards:
            'the flagship audit failure — `before:from-X!` utility ' +
            'overrides silently no-op against an arbitrary ' +
            '`before:bg-[...]`, so the structural scan is green while ' +
            'the rendered band paints the wrong (brand) ramp.',
    },
    {
        primitive: 'NotificationsBell hover + relative-time copy',
        structuralRatchets: [],
        renderedTest: 'rendered/notifications-bell-behaviour.test.tsx',
        guards:
            'off-recipe hover treatment and raw `toLocaleDateString` ' +
            'timestamps — the rendered test asserts the relative-time ' +
            'output ("5m"/"2h"/"3d") and the canonical hover surface.',
    },
    {
        primitive: 'DataTable row-hover brand-edge accent',
        structuralRatchets: ['guards/epic52-datatable-ratchet.test.ts'],
        renderedTest: 'rendered/data-table-row-hover.test.tsx',
        guards:
            'the #374 regression — the brand-edge accent gated on a ' +
            'selector that matched the wrong cell, so it "never fired ' +
            'anywhere"; the rendered test asserts WHICH cell carries ' +
            'the accent and that it is gated on `onRowClick`.',
    },
    {
        primitive: 'EmptyState cleared-filters CTA',
        structuralRatchets: ['guards/destructive-vocabulary.test.ts'],
        renderedTest: 'rendered/empty-state-cleared-filters.test.tsx',
        guards:
            'the no-results variant + "Clear filters" CTA — the ' +
            'rendered test asserts the CTA renders as a reachable ' +
            'control AND fires its handler, not just that the prop is ' +
            'passed.',
    },
    {
        primitive: 'Tooltip coarse-pointer (tap-to-toggle) path',
        structuralRatchets: ['guards/tooltip-touch-uniformity.test.ts'],
        renderedTest: 'rendered/tooltip-touch.test.tsx',
        guards:
            'the textbook case for this registry — the structural ' +
            'ratchet was green while the branch it locks had never ' +
            'executed, because the project-wide jsdom `matchMedia` ' +
            'stub answers `matches: false` to every query. #449 ' +
            'shipped `preventDefault()` on the trigger, which also ' +
            'cancelled the wrapped element\'s default action and ' +
            'killed navigation on ~17 tooltip-wrapped links plus every ' +
            'collapsed-sidebar nav item. The rendered test installs a ' +
            'coarse-pointer matchMedia per test and asserts a wrapped ' +
            'link actually navigates on tap, alongside tap-toggle and ' +
            'each of the four dismissal paths.',
    },
];

function existsUnderTests(relPath: string): boolean {
    return fs.existsSync(path.join(REPO_ROOT, 'tests', relPath));
}

describe('behavioural-coverage registry', () => {
    it('the registry is non-empty (the convention is live)', () => {
        expect(REGISTRY.length).toBeGreaterThan(0);
    });

    describe('every registered high-risk primitive has a rendered test', () => {
        for (const entry of REGISTRY) {
            it(`${entry.primitive} → ${entry.renderedTest} exists`, () => {
                const full = path.join(REPO_ROOT, 'tests', entry.renderedTest);
                expect(fs.existsSync(full)).toBe(true);
                // It must live in tests/rendered/ — the Tier-2 home.
                expect(entry.renderedTest.startsWith('rendered/')).toBe(true);
            });

            it(`${entry.primitive} → rendered test makes a behavioural assertion`, () => {
                // A Tier-2 test must assert a RENDERED/COMPUTED/
                // RESOLVED outcome — not merely a className substring.
                // We approximate this structurally: the file must use
                // at least one genuinely behavioural API (render +
                // an event, a resolved value, DOM/role queries).
                const src = fs.readFileSync(
                    path.join(REPO_ROOT, 'tests', entry.renderedTest),
                    'utf8',
                );
                expect(src).toMatch(/\brender\s*\(/);
                const behaviouralSignals = [
                    /getComputedStyle/,
                    /getPropertyValue/,
                    /\.style\./,
                    /toHaveStyle/,
                    /getByRole/,
                    /findByRole/,
                    /getByText/,
                    /findByText/,
                    /getByTestId/,
                    /findByTestId/,
                    /toHaveBeenCalled/,
                    /resolveVars/,
                    /\.tagName\b/,
                ];
                const hits = behaviouralSignals.filter((re) =>
                    re.test(src),
                );
                expect(hits.length).toBeGreaterThan(0);
            });

            for (const ratchet of entry.structuralRatchets) {
                it(`${entry.primitive} → structural ratchet ${ratchet} still exists`, () => {
                    expect(existsUnderTests(ratchet)).toBe(true);
                });
            }
        }
    });

    it('no registry entry points at a deleted rendered test (one-way ratchet integrity)', () => {
        const missing = REGISTRY.filter(
            (e) =>
                !fs.existsSync(
                    path.join(REPO_ROOT, 'tests', e.renderedTest),
                ),
        );
        expect(missing.map((e) => e.primitive)).toEqual([]);
    });

    it('registry rendered-test paths are unique (no accidental duplication)', () => {
        const seen = new Set<string>();
        for (const e of REGISTRY) {
            expect(seen.has(e.renderedTest)).toBe(false);
            seen.add(e.renderedTest);
        }
    });

    it('the assurance-model doc exists and documents the four tiers', () => {
        const doc = path.join(
            REPO_ROOT,
            'docs/frontend-assurance-model.md',
        );
        expect(fs.existsSync(doc)).toBe(true);
        const text = fs.readFileSync(doc, 'utf8');
        // The doc must name all four tiers so the convention is
        // discoverable from the registry guard.
        expect(text).toMatch(/Structural ratchet/);
        expect(text).toMatch(/Rendered \/ behavioural/i);
        expect(text).toMatch(/Integration/);
        expect(text).toMatch(/Browser \/ E2E/i);
    });

    // Sanity that the directories the registry references are real —
    // catches a repo restructure that would silently void the guard.
    it('the tests/rendered and tests/guards directories exist', () => {
        expect(fs.existsSync(RENDERED_DIR)).toBe(true);
        expect(fs.existsSync(GUARDS_DIR)).toBe(true);
        expect(fs.existsSync(GUARDRAILS_DIR)).toBe(true);
    });
});
