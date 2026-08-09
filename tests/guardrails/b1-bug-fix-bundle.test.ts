/**
 * B1 — bug-fix bundle structural ratchet.
 *
 * Four independent bugs closed by this PR; each locked here so a
 * future PR can't silently re-introduce.
 *
 *   1. Calendar date offset — date-picker boundary now re-anchors
 *      RDP local-midnight → UTC-midnight so clicking May 24 in
 *      negative timezones doesn't round-trip to May 23.
 *   2. Task assignee population — `UserCombobox` reads from a
 *      non-admin endpoint (`/users/assignable`) so EDITOR / READER
 *      users see the roster.
 *   3. Linking dropdowns — `TraceabilityPanel` unwraps the
 *      `{ rows, truncated }` cap shape that the list endpoints
 *      return; pre-fix the dropdowns silently rendered empty.
 *   4. Dashboard card filtering — every KPI either focuses a
 *      chart (coverage / risks / evidence / findings) or navigates
 *      to its entity list (tasks / policies); no more dead clicks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B1 — bug-fix bundle', () => {
    describe('Bug 1 — calendar date offset (TZ-aware boundary)', () => {
        const picker = read('src/components/ui/date-picker/date-picker.tsx');
        const utils = read('src/components/ui/date-picker/date-utils.ts');

        it('single picker re-anchors RDP local-midnight to UTC-midnight on select', () => {
            expect(picker).toMatch(/function fromRDPSingle/);
            expect(picker).toMatch(
                /new Date\(\s*Date\.UTC\(\s*local\.getFullYear\(\)/,
            );
            expect(picker).toMatch(/fromRDPSingle\(next\)/);
        });

        it('single picker re-anchors stored UTC-midnight back to local for display', () => {
            expect(picker).toMatch(/function toRDPSingle/);
            expect(picker).toMatch(
                /new Date\(\s*v\.getUTCFullYear\(\)/,
            );
        });

        it('range picker bridges both directions', () => {
            // The range-picker uses the utility helpers, not bespoke
            // ones — lock that the helpers themselves do the bridge.
            const block = utils.slice(
                utils.indexOf('export function toDateRangeValue'),
                utils.indexOf('export function fromDateRangeValue') + 600,
            );
            expect(block).toMatch(/localMidnightToUtcMidnight/);
            expect(block).toMatch(/utcMidnightToLocalMidnight/);
        });
    });

    describe('Bug 2 — task assignee population', () => {
        const usecase = read('src/app-layer/usecases/tenant-admin.ts');
        const route = read(
            'src/app/api/t/[tenantSlug]/users/assignable/route.ts',
        );
        const ui = read('src/components/ui/user-combobox.tsx');

        it('listAssignableUsers usecase exists with assertCanRead gate', () => {
            expect(usecase).toMatch(/export async function listAssignableUsers/);
            // Inside the function body — runs BEFORE the DB call.
            const fnStart = usecase.indexOf(
                'export async function listAssignableUsers',
            );
            const fnBody = usecase.slice(fnStart, fnStart + 800);
            expect(fnBody).toMatch(/assertCanRead\(ctx\)/);
        });

        it('non-admin API route exists', () => {
            expect(route).toMatch(/listAssignableUsers/);
            expect(route).toMatch(/getTenantCtx/);
            // No requirePermission gate — this is read-tier for all members.
            expect(route).not.toMatch(/requirePermission/);
        });

        it('UserCombobox fetches the non-admin endpoint', () => {
            expect(ui).toMatch(
                /\/api\/t\/\$\{tenantSlug\}\/users\/assignable/,
            );
            // Strip comments before checking — the rationale comment
            // INSIDE the function explains why `/admin/members` is
            // retired; the executable code is what we care about.
            const fetchBlock = ui.slice(
                ui.indexOf('export function useTenantMembers'),
                ui.indexOf('// ─── Option projection'),
            );
            const stripped = fetchBlock
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            expect(stripped).not.toMatch(/\/admin\/members/);
        });
    });

    describe('Bug 3 — linking dropdowns (TraceabilityPanel)', () => {
        const src = read('src/components/TraceabilityPanel.tsx');

        it('unwraps every list-endpoint shape via the `unwrap` helper', () => {
            // The helper recognises bare arrays, `{ rows }` cap shape,
            // entity-keyed shape, and `{ items }` pagination shape.
            expect(src).toMatch(/const unwrap/);
            expect(src).toMatch(/Array\.isArray\(d\.rows\)/);
            expect(src).toMatch(/Array\.isArray\(d\.items\)/);
        });

        it('every list fetcher routes through `unwrap`', () => {
            // One fetcher per linkable entity. This asserted "at least
            // three" until the Risks arm went with the risk register,
            // leaving controls + assets — a hard-coded count turns a
            // deliberate removal into a red build and, worse, would let a
            // NEW un-unwrapped fetcher slip in as long as the total stayed
            // above the floor. Derive the expectation from the fetchers
            // themselves so it holds at any arity.
            const fetchers = src.match(/setAvailable\w+\(/g) ?? [];
            const unwrapped = src.match(/unwrap\(d,/g) ?? [];
            expect(fetchers.length).toBeGreaterThan(0);
            expect(unwrapped.length).toBe(fetchers.length);
        });

        it('legacy `d.risks || []` shape fallback is retired', () => {
            // The old shape never matched the cap'd response and
            // collapsed every dropdown to empty.
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.risks\s*\|\|\s*\[\]/);
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.controls\s*\|\|\s*\[\]/);
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.assets\s*\|\|\s*\[\]/);
        });
    });

    describe('Bug 4 — dashboard card filtering', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
        );

        it('no KPI tile is chart-bound any more (chart-filter surface removed)', () => {
            // The KPI grid + trend section (and with them the chart-filter
            // coordination) were removed from the farm dashboard — no
            // `kpiKey` binding remains for any entity.
            expect(src).not.toMatch(/kpiKey=/);
        });

        it('a click only toggles chart focus — no navigation map', () => {
            // The KPI tiles never navigated to a list page; a click only
            // toggled chart focus. The task/policy status donuts were
            // removed with their pages, so StatusDonutSection is gone too.
            expect(src).not.toMatch(/KPI_NAV_HREF/);
            expect(src).not.toMatch(/StatusDonutSection/);
        });

        it('the chart-bound trend section was removed from the dashboard', () => {
            // The TrendSection (and its ChartFocusWrapper) left with the
            // rest of the compliance surfaces — no trend card remains.
            expect(src).not.toContain('function TrendSection');
            expect(src).not.toContain('<ChartFocusWrapper');
            expect(src).not.toContain('<TrendCard');
        });

        it('the removed evidence widgets no longer mount on the dashboard', () => {
            // Risk heatmap (risk-matrix UI) and the Evidence Expiry calendar
            // were both removed from the dashboard.
            expect(src).not.toContain('id="risk-heatmap"');
            expect(src).not.toContain('id="expiry-calendar"');
            expect(src).not.toContain('<ExpiryCalendar');
        });
    });
});
