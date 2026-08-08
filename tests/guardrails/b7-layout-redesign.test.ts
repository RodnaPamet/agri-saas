/**
 * B7 — Layout redesign ratchet.
 *
 *   1. Large-monitor responsiveness: AppShell carries the
 *      `2xl:max-w-screen-2xl` + `3xl:max-w-none` cascade so wide
 *      monitors actually use the screen real estate. The `3xl`
 *      breakpoint is registered in tailwind.config.js.
 *   2. LeftAccordionRail primitive exists and meets the contract
 *      the user briefed: quiet (default no-open sections),
 *      click-only expansion (no hover auto-open), orientation-
 *      style organisation of the adjacent table.
 *   3. ListPageShell.Body accepts both `aside` (right rail) and
 *      `leftRail` slots; the rails sit OUTSIDE the table card
 *      via `gap-section` separation, not the legacy
 *      `gap-default` flush positioning.
 *   4. The canonical Controls list mounts a "Browse" AsidePanel that
 *      groups controls by framework-tagged CATEGORY in a collapsible
 *      accordion (was: Status / Type / Owner filter sections). The
 *      rail navigates; it no longer filters the table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B7 — layout redesign', () => {
    describe('Large-monitor responsiveness', () => {
        const shell = read('src/components/layout/AppShell.tsx');
        const tailwind = read('tailwind.config.js');

        it('AppShell cascades max-width past 7xl on wide monitors', () => {
            expect(shell).toMatch(/max-w-7xl/);
            expect(shell).toMatch(/2xl:max-w-screen-2xl/);
            expect(shell).toMatch(/3xl:max-w-none/);
        });

        it('tailwind.config.js registers the 3xl breakpoint', () => {
            expect(tailwind).toMatch(/['"]3xl['"]:\s*['"]1792px['"]/);
        });
    });

    describe('LeftAccordionRail primitive', () => {
        const src = read('src/components/ui/left-accordion-rail.tsx');

        it('exports the primitive + section type', () => {
            expect(src).toMatch(/export function LeftAccordionRail/);
            expect(src).toMatch(/export interface LeftAccordionRailSection/);
        });

        it('defaults to zero open sections (quiet)', () => {
            // Default state: `new Set(defaultOpenIds ?? [])` — if
            // the consumer doesn't seed it, the rail mounts silent.
            expect(src).toMatch(
                /new Set\(defaultOpenIds \?\? \[\]\)/,
            );
        });

        it('expand is click-only — no hover auto-open', () => {
            // The button toggle handler is `onClick`, not
            // `onMouseEnter` / `onFocus`. The chevron transition
            // is the only motion path.
            expect(src).toMatch(/onClick=\{\(\) => toggle\(section\.id\)\}/);
            expect(src).not.toMatch(/onMouseEnter=\{[\s\S]{0,80}toggle\(/);
            expect(src).not.toMatch(/onFocus=\{[\s\S]{0,80}toggle\(/);
        });

        it('renders aria-expanded + aria-controls (a11y)', () => {
            expect(src).toMatch(/aria-expanded=\{isOpen\}/);
            expect(src).toMatch(/aria-controls=\{contentId\}/);
        });
    });

    describe('ListPageShell.Body accepts both rails + separates them', () => {
        const shell = read('src/components/layout/ListPageShell.tsx');
        // T04 i18n — the rail <aside> markup (its aria-label is the shell's
        // only translated string) moved to a `'use client'` leaf so the
        // shell stays a shared server-compatible primitive. The slot props
        // + the gap-section container stay on the shell; the rendered rail
        // test-ids are asserted against the leaf.
        const rail = read('src/components/layout/ListPageShellRail.tsx');

        it('ListPageShellBodyProps declares leftRail + aside', () => {
            expect(shell).toMatch(/leftRail\?:\s*ReactNode/);
            expect(shell).toMatch(/aside\?:\s*ReactNode/);
        });

        it('rails sit OUTSIDE the table card with `gap-section`', () => {
            // The two-rail body row uses `gap-section`, the
            // generous breathing space — pre-B7 the flush
            // `gap-default` read as "rail embedded into the
            // table area". The rail's wrapper is `flex-shrink-0
            // xl:self-start` so it tracks the body's top.
            expect(shell).toMatch(/gap-section/);
            // The shell threads both rails through the leaf…
            expect(shell).toMatch(/<ListPageShellRail\s+kind="orientation"\s+testId="list-page-left-rail"/);
            expect(shell).toMatch(/<ListPageShellRail\s+kind="context"\s+testId="list-page-aside"/);
            // …and the leaf renders a real <aside> carrying that test-id +
            // the `flex-shrink-0 xl:self-start` wrapper class.
            expect(rail).toMatch(/<aside[\s\S]*?data-testid=\{testId\}/);
            expect(rail).toMatch(/flex-shrink-0 xl:self-start/);
        });
    });

    describe('Controls list mounts a category-accordion browse aside', () => {
        // 2026-06-05 — the Browse rail was reworked from Status / Type
        // / Owner FILTER sections into a CATEGORY accordion. Each
        // control's framework-native category is derived via
        // `categorizeControl` (ISO 27001 → granular Annex domain;
        // other frameworks → their persisted category); the rail
        // renders one collapsible <Accordion> section per category,
        // tagged with the framework it belongs to. Expanding a
        // section reveals the controls in it — each with a status tag
        // and a click-to-navigate to the control detail page. The
        // rail NAVIGATES; it no longer filters the table.
        const src = read(
            'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
        );

        it('mounts an AsidePanel browse rail (NOT a LeftAccordionRail)', () => {
            // i18n batch T07 — the rail title routes through next-intl
            // (`t('list.browse')`); assert the key is wired AND the en.json
            // value preserves the "Browse" copy.
            expect(src).toMatch(/<AsidePanel\b[\s\S]{0,200}title=\{t\('list\.browse'\)\}/);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            expect(require('../../messages/en.json').controls.list.browse).toBe('Browse');
            // The legacy left-rail wiring is gone — the import +
            // the JSX must both disappear so a future "move it back
            // left" PR fails this ratchet loudly.
            expect(src).not.toMatch(/import \{[\s\S]{0,200}LeftAccordionRail/);
            expect(src).not.toMatch(/leftRail=\{orientationRail\}/);
            expect(src).not.toMatch(/<LeftAccordionRail\b/);
        });

        it('threads a composed aside (selection + browse + ai) to EntityListPage', () => {
            // The aside slot now receives a composed React node that
            // stacks selection-summary + browse + AI-assist panels.
            expect(src).toMatch(/aside=\{composedAside\}/);
        });

        it('groups controls by framework-tagged category in an accordion', () => {
            // Categories are DERIVED (not a stored single string) via
            // the shared taxonomy module, then rendered as collapsible
            // accordion sections. Each section carries its framework
            // tag so a multi-framework control set stays legible.
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,120}categorizeControl[\s\S]{0,120}\}\s*from\s*['"]@\/lib\/controls\/control-taxonomy['"]/,
            );
            expect(src).toMatch(/<Accordion\s+type="multiple"/);
            expect(src).toMatch(/data-category-group=/);
            expect(src).toMatch(/data-framework-tag=/);
        });

        it('rail NAVIGATES (status tag per control) — it does not filter', () => {
            // Status is now a per-control tag (StatusBadge) inside the
            // expanded rows; clicking a row routes to the control
            // detail page. The legacy filter wiring is gone, so a
            // future "make the rail filter again" PR fails CI.
            expect(src).toMatch(/data-control-id=\{c\.id\}/);
            // <AccordionContent appears once — the next StatusBadge /
            // router.push after it is unambiguously the rail's.
            expect(src).toMatch(/<AccordionContent[\s\S]{0,1600}StatusBadge/);
            expect(src).toMatch(/<AccordionContent[\s\S]{0,1600}router\.push/);
            expect(src).not.toMatch(/data-rail-section-value/);
            expect(src).not.toMatch(/filterCtx\.set\(/);
        });
    });

    describe('Controls table — `Category` column (framework-tagged)', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
        );

        it('column-visibility list includes Category before Status', () => {
            // Anchor on the controlColumnList block — the Category
            // entry must appear before the Status entry so the
            // default-visible column order reads Code · Title ·
            // Category · Status.
            const start = src.indexOf('const controlColumnList');
            expect(start).toBeGreaterThan(0);
            const slice = src.slice(start, start + 1200);
            const catIdx = slice.indexOf("id: 'category'");
            const statusIdx = slice.indexOf("id: 'status'");
            expect(catIdx).toBeGreaterThan(0);
            expect(statusIdx).toBeGreaterThan(catIdx);
        });

        it('column derives the category via categorizeControl under header "Category"', () => {
            // The category is DERIVED per-control (framework-tagged
            // granular domain), not read from a single stored string —
            // so the column matches the Browse rail's grouping.
            // T07 i18n — the header moved to t('list.colCategory'); assert
            // the t() reference AND the en.json value stays "Category".
            expect(src).toMatch(
                /id:\s*['"]category['"][\s\S]{0,200}header:\s*t\(['"]list\.colCategory['"]\)/,
            );
            expect(JSON.parse(read('messages/en.json')).controls.list.colCategory).toBe('Category');
            expect(src).toMatch(
                /accessorFn:\s*\(c\)\s*=>\s*categorizeControl\(c\)/,
            );
        });
    });
});
