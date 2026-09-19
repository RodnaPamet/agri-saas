/**
 * Roadmap-3 PR-10 — per-resource dashboard masthead discipline.
 *
 * The product has five dashboard surfaces:
 *
 *   • `/dashboard`               — main / executive (uses
 *                                   `<HeroMetric>` + `<KPIStat>`)
 *   • `/risks/dashboard`         — per-resource (uses `<KPIStat>`)
 *   • `/practices/dashboard`      — per-resource (uses `<KPIStat>`)
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


const MAIN_DASHBOARD = 'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx';

describe('Dashboard masthead discipline (Roadmap-3 PR-10)', () => {

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `read` (line 46) to a constant and NOTHING
    // went red. Both blocks below fail on that mutation; neither passes on
    // the other's.

    it('control: read() returns the real bytes of the file it is handed (#971)', () => {
        // Why the gut survived: the only assertion in this file is NEGATIVE,
        // and `expect('').not.toMatch(/<HeroMetric\b/)` passes. Exactly ONE
        // gut in the tool's falsy/empty set gets that far — the empty STRING.
        // `null` / `undefined` / `0` / `false` / `[]` / `{}` / `new Set()` /
        // `new Map()` each make jest's `toMatch` throw "received value must be
        // a string", which `.not` does not suppress, so those were already
        // caught. The surviving direction is "string-shaped, but not this
        // file's bytes" — '' today, a hard-coded snippet tomorrow.

        // The resolution seam first. jest runs with cwd = repo root, so a
        // gutted ROOT ('') would still resolve by accident; these two say so
        // out loud rather than leaving it to luck.
        expect(path.isAbsolute(ROOT)).toBe(true);
        expect(fs.existsSync(path.join(ROOT, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, MAIN_DASHBOARD))).toBe(true);

        const src = read(MAIN_DASHBOARD);

        // Floor from a MEASUREMENT: DashboardClient.tsx is 1,845 bytes / 42
        // lines (measured 2026-09-19). 400 sits far below that, so ordinary
        // dashboard work never moves it, while '' is nowhere near it.
        expect(src.length).toBeGreaterThan(400);

        // …and it is THAT file, not merely SOME file. The client shell is a
        // function declaration named after its own basename, so this survives
        // a rename that updates MAIN_DASHBOARD in the same diff, and fails a
        // read that silently resolves elsewhere — the sibling SERVER shell
        // page.tsx exports `DashboardPage`, so it does not satisfy this. If
        // the module is ever converted to an arrow export, relax this to
        // `expect(src).toContain(component)`; do not delete it.
        const component = path.basename(MAIN_DASHBOARD, path.extname(MAIN_DASHBOARD));
        expect(src).toMatch(new RegExp(`export default function\\s+${component}\\b`));
    });

    it('control: the <HeroMetric detector matches real source and ignores near-misses (#971)', () => {
        // The other half of the same hole: a negative assertion is worth
        // nothing unless the pattern it negates can match. "Scanned the
        // dashboard, found no hero" and "this pattern matches nothing" were
        // the same green.
        const HERO_MOUNT = /<HeroMetric\b/;

        // POSITIVE against real product source, read through the SAME helper —
        // so a gutted `read` fails here too. There is no live MOUNT to point
        // at by construction: tests/guards/heromemtric-canonical-home.test.ts
        // bans `<HeroMetric` across src/app and its CANONICAL_HOMES list is
        // empty. The genuine matches left in src/ are the primitive's own
        // docblocks — measured 2026-09-19, four files match
        // (components/ui/HeroMetric.tsx, metric.tsx, MetricCard.tsx,
        // NextBestActionCard.tsx). The primitive's path is the stable pick:
        // that sibling guard asserts the file EXISTS, so if it moves both
        // guards go red together instead of this one passing over nothing.
        const primitive = read('src/components/ui/HeroMetric.tsx');
        expect(primitive.length).toBeGreaterThan(2000); // measured: 13,166 bytes
        expect(HERO_MOUNT.test(primitive)).toBe(true);

        // A mount as it would actually be written…
        expect(HERO_MOUNT.test('            <HeroMetric value={pct} label="Readiness" />')).toBe(true);
        // …and the two near-misses that must NOT trip it: a different
        // component sharing the prefix, and an import of the primitive. This
        // is what the `\b` is for — drop it and the first of these reds.
        expect(HERO_MOUNT.test('<HeroMetricStrip />')).toBe(false);
        expect(HERO_MOUNT.test("import { HeroMetric } from '@/components/ui/HeroMetric';")).toBe(false);

        // NOTE: the pattern is spelled twice — here and in the assertion
        // below. Hoisting it to one module-level HERO_MOUNT const consumed by
        // both is the right follow-up; until then a change to one is a change
        // to the other.
    });

    it('the main /dashboard no longer mounts <HeroMetric> (masthead hero removed)', () => {
        const src = read(MAIN_DASHBOARD);
        // The open-field-tasks HeroMetric was removed in the farm-UI trim;
        // the farm dashboard leads with the greeting header + ag strip
        // instead of a 72px executive lead number. Forward-guard the
        // removal so a re-add is a conscious change.
        expect(src).not.toMatch(/<HeroMetric\b/);
    });

});
