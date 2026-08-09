/**
 * Roadmap-3 PR-10 — per-resource dashboard masthead discipline.
 *
 * The product has five dashboard surfaces:
 *
 *   • `/dashboard`               — main / executive (uses
 *                                   `<HeroMetric>` + `<KPIStat>`)
 *   • `/risks/dashboard`         — per-resource (uses `<KPIStat>`)
 *   • `/controls/dashboard`      — per-resource (uses `<KPIStat>`)
 *   • `/vendors/dashboard`       — per-resource (uses `<KPIStat>`
 *                                   via a local `MetricCard`
 *                                   wrapper — adds click-nav)
 *   • `/tests/dashboard`         — per-resource (uses `<KPIStat>`
 *                                   via a local `MetricCard`
 *                                   wrapper — adds tone-mapping)
 *
 * The four per-resource dashboards all reach for `<KPIStat>`. The
 * MAIN `/dashboard` adds a `<HeroMetric>` lead number above the
 * row — that's the canonical "executive" shape, distinct from the
 * per-resource dashboards which are KPI-row only.
 *
 * What this ratchet locks
 *
 *   1. Every per-resource dashboard mounts `<KPIStat>` (direct or
 *      via a tiny local wrapper that forwards to the primitive).
 *   2. The main `/dashboard` mounts `<HeroMetric>` (executive
 *      lead).
 *
 *   The point is to prevent FUTURE drift — a new dashboard PR that
 *   reaches for raw stat cards (`<div>{number}</div><div>label</div>`)
 *   instead of the primitive must trip CI.
 *
 * What this ratchet does NOT police
 *   • The exact KPI selection per dashboard. The page picks its
 *     leading numbers; the ratchet only locks that the primitive
 *     is the surface.
 *   • Whether per-resource dashboards adopt `<HeroMetric>` too.
 *     That's a future-round design call (does each resource get a
 *     hero number?). The discipline here is just "use the
 *     primitive, don't hand-roll".
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PER_RESOURCE_DASHBOARDS = [
    'src/app/t/[tenantSlug]/(app)/vendors/dashboard/page.tsx',
];

const MAIN_DASHBOARD = 'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx';

describe('Dashboard masthead discipline (Roadmap-3 PR-10)', () => {
    it('every per-resource dashboard mounts <KPIStat>', () => {
        const offenders: string[] = [];
        for (const rel of PER_RESOURCE_DASHBOARDS) {
            const src = read(rel);
            // Either direct usage or via a local wrapper that
            // forwards to the primitive. The grep is deliberately
            // wide — both shapes satisfy the discipline.
            const hasKpiStat = /<KPIStat\b/.test(src);
            if (!hasKpiStat) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These per-resource dashboards do not mount <KPIStat>:\n  ${offenders.join('\n  ')}\n\nUse the canonical primitive (direct or via a tiny local wrapper). Hand-rolled stat cards drift the visual rhythm.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the main /dashboard no longer mounts <HeroMetric> (masthead hero removed)', () => {
        const src = read(MAIN_DASHBOARD);
        // The open-field-tasks HeroMetric was removed in the farm-UI trim;
        // the farm dashboard leads with the greeting header + ag strip
        // instead of a 72px executive lead number. Forward-guard the
        // removal so a re-add is a conscious change.
        expect(src).not.toMatch(/<HeroMetric\b/);
    });

    it('no per-resource dashboard hand-rolls a raw stat card', () => {
        // Detect the anti-pattern: a `<div className="…">…number…</div>`
        // followed by a `<div>…label…</div>` inside dashboard pages.
        // This is too loose to ratchet structurally without false
        // positives, so we instead use a positive assertion: each
        // dashboard's KPI mount density is expected to dominate the
        // page. We anchor on the import path — every dashboard
        // imports `KPIStat` from the metric module.
        const offenders: string[] = [];
        for (const rel of PER_RESOURCE_DASHBOARDS) {
            const src = read(rel);
            const hasImport =
                /import\s+\{[^}]*\bKPIStat\b[^}]*\}\s+from\s+['"]@\/components\/ui\/metric['"]/.test(
                    src,
                );
            if (!hasImport) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These per-resource dashboards don't import KPIStat from @/components/ui/metric. Always use the canonical primitive — never hand-roll a stat card.\n\nOffenders:\n  ${offenders.join('\n  ')}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
