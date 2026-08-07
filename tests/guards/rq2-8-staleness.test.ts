/**
 * RQ2-8 — staleness-engine ratchet.
 *
 * Regression classes guarded:
 *
 *   - the dashboard losing its stale-assessments widget (the rot
 *     goes silent again);
 *   - the detector conflating coverage gaps with staleness (a
 *     signal-less risk must stay un-flagged — flooding the widget
 *     with every un-reviewed risk buries the actionable rot);
 *   - the loader regressing into per-risk queries (N+1 over the
 *     register);
 *   - the endpoint growing a mutation verb.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const lib = read('src/lib/risk-staleness.ts');
const usecase = read('src/app-layer/usecases/risk-staleness.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/staleness/route.ts');
const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const dashboardOrchestrator = read('src/app-layer/usecases/risk-dashboard.ts');

describe('RQ2-8 — staleness engine', () => {
    test('the dashboard mounts the widget behind the rot gate', () => {
        // RQ3-9 — the dashboard now reads from the orchestrator
        // (`/risks/dashboard`) rather than firing its own
        // `/risks/staleness` fetch. The widget still renders from
        // the `staleness` slot of the payload; the orchestrator
        // pulls it via getRiskStaleness on the server.
        expect(dashboardOrchestrator).toMatch(/getRiskStaleness/);
        expect(dashboard).toMatch(/staleness\.staleCount > 0/);
        expect(dashboard).toMatch(/risk-staleness-widget/);
    });

    test('absence of data is not staleness (the no-noise contract)', () => {
        // The detector starts from an empty reasons list and only
        // pushes on positive signals — no default-stale branch.
        expect(lib).toMatch(/const reasons: StalenessReason\[\] = \[\];/);
        expect(lib).not.toMatch(/stale:\s*true,\s*reasons:\s*\[\]/);
        // CONTROLS_MOVED_SINCE requires an assessed residual.
        expect(lib).toMatch(/signals\.lastResidualAt !== null &&/);
    });

    test('the loader stays batched — groupBy + in-memory maps, no per-risk reads', () => {
        expect(usecase).toMatch(/riskScoreEvent\.groupBy/);
        expect(usecase).toMatch(/kriReading\.groupBy/); // RQ3-7 batched KRI read
        expect(usecase).toMatch(/_max/);
        // The only loops are over in-memory arrays; no awaited query
        // INSIDE a loop body. The check brace-matches each `for (...)`
        // header to the end of ITS block and asserts no `await db.`
        // inside — the prior `[\s\S]*?await db\.` form false-flagged a
        // file with two functions that each legitimately batch THEN
        // loop (RQ3-7 added the second). This brace-aware form only
        // catches a genuine read inside the loop.
        const NO_AWAIT_DB_IN_LOOP = (src: string): boolean => {
            // Match loop HEADERS only (`for (` / `while (`), not the
            // word "for" in prose comments.
            const headerRe = /\b(?:for|while)\s*\(/g;
            let m: RegExpExecArray | null;
            while ((m = headerRe.exec(src)) !== null) {
                const i = m.index;
                const brace = src.indexOf('{', i);
                if (brace === -1) break;
                // Walk to the matching close brace.
                let depth = 1;
                let j = brace + 1;
                for (; j < src.length && depth > 0; j++) {
                    if (src[j] === '{') depth++;
                    else if (src[j] === '}') depth--;
                }
                const body = src.slice(brace + 1, j - 1);
                if (/await\s+db\./.test(body)) return false;
                headerRe.lastIndex = brace + 1;
            }
            return true;
        };
        expect(NO_AWAIT_DB_IN_LOOP(usecase)).toBe(true);
    });

    test('the endpoint stays GET-only', () => {
        expect(route).toMatch(/export const GET = withApiErrorHandling/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(route).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });

    test('the age ceiling is a named, shared constant', () => {
        expect(lib).toMatch(/export const MAX_ASSESSMENT_AGE_DAYS = 180/);
        expect(usecase).toMatch(/MAX_ASSESSMENT_AGE_DAYS/);
    });
});
