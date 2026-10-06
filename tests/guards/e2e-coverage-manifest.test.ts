/**
 * E2E coverage manifest — quality roadmap P4 first wave.
 *
 * Four UI surfaces were explicitly deferred to browser/E2E
 * verification because their assurance is shaped by real user
 * interaction, not source structure: the search-affordance kill
 * sweep, the tenant switcher, FilterToolbar coverage, and
 * `<EntityDetailLayout>`. P4 lands the first meaningful wave of
 * E2E for each.
 *
 * This manifest makes the coverage VISIBLE — and prevents one of
 * the four specs from being silently deleted, dropping a surface
 * back into ambiguous "deferred" status. Each entry pins:
 *   - the spec file (must exist), and
 *   - a structural anchor in the spec body (must be present), so a
 *     rename-and-gut regression is caught.
 *
 * Adding a new surface to this list locks it in the same shape;
 * removing one is a deliberate, reviewed act, not a drive-by.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

interface E2EManifestEntry {
    /** The browser-shaped surface this entry locks. */
    surface: string;
    /** Relative path under `tests/e2e/`. */
    spec: string;
    /** Substring that MUST appear in the spec body. Catches a
     *  rename-and-gut: the file still exists but no longer carries
     *  the canonical assertion. */
    anchor: string;
}

const E2E_MANIFEST: ReadonlyArray<E2EManifestEntry> = [
    {
        surface: 'Search affordance — Ctrl+K palette, no rogue searchbars',
        spec: 'tests/e2e/search-affordances.spec.ts',
        anchor: 'command-palette-input',
    },
    {
        surface: 'Tenant switcher — trigger opens, lists the current tenant',
        spec: 'tests/e2e/tenant-switcher.spec.ts',
        anchor: 'top-chrome-tenant-switcher',
    },
    {
        surface: 'FilterToolbar — apply/clear chip round-trips through URL',
        spec: 'tests/e2e/filter-toolbar-coverage.spec.ts',
        anchor: 'clear filters',
    },
    {
        surface: 'EntityDetailLayout — breadcrumbs / header / body render',
        spec: 'tests/e2e/entity-detail-layout.spec.ts',
        anchor: 'entity-detail-header',
    },
    // P2.9 (#1193) — not a P4 surface, registered here because this manifest
    // is the repo's mechanism for "a spec cannot be silently deleted or
    // gutted". The mobile axe gate is worth exactly that: it is the only
    // real-browser accessibility scan at a phone viewport, and before it
    // existed the desktop gate's 7 green scans read as full coverage. A
    // deleted file produces no failing check anywhere else — absence reads as
    // success.
    //
    // The anchor is the DESCRIBE TITLE carrying the tag, not the bare
    // `@mobile` token. `playwright.config.ts` routes on the tag appearing in
    // a test's full title, so stripping it from the describe stops the spec
    // running on both phone projects while every assertion inside it still
    // passes on nothing. A bare `@mobile` anchor does NOT catch that: that
    // spec's own docblock says the word several times, so deleting the live
    // tag left the anchor satisfied and the gate dead — measured, which is
    // why the anchor is the whole title.
    {
        surface: 'Mobile axe sweep — 0 serious findings at a phone viewport',
        spec: 'tests/e2e/mobile/a11y-mobile.spec.ts',
        anchor: "test.describe('a11y — mobile viewport @mobile'",
    },
];

describe('E2E coverage manifest (quality roadmap P4 first wave)', () => {
    it.each(E2E_MANIFEST.map((e) => [e.surface, e]))(
        '%s — spec exists',
        (_surface, entry) => {
            const e = entry as E2EManifestEntry;
            const abs = path.join(ROOT, e.spec);
            expect(fs.existsSync(abs)).toBe(true);
        },
    );

    it.each(E2E_MANIFEST.map((e) => [e.surface, e]))(
        '%s — spec body carries the canonical assertion',
        (_surface, entry) => {
            const e = entry as E2EManifestEntry;
            const body = fs.readFileSync(path.join(ROOT, e.spec), 'utf8');
            expect(body).toContain(e.anchor);
        },
    );

    it('the manifest pins every deferred P4 surface, plus the P2.9 mobile axe gate', () => {
        // The scope is locked here so a future PR cannot quietly drop an
        // entry. It was exactly the four P4 surfaces; P2.9 added a fifth for
        // the reason written beside it. Adding a sixth lifts the count — a
        // visible line in the diff, which is the point.
        expect(E2E_MANIFEST).toHaveLength(5);
        // Every entry must name a DISTINCT spec, or two surfaces could be
        // riding one file and deleting it would cost one failing assertion
        // rather than two.
        expect(new Set(E2E_MANIFEST.map((e) => e.spec)).size).toBe(E2E_MANIFEST.length);
    });
});
