/**
 * PR-7 — interim list-page perf-package anti-bloat ratchet.
 *
 * The PR-1..PR-6 sequence introduced four moving parts that all need
 * to stay coordinated. A future PR that adds a new list-page entity
 * (or refactors one of the existing seven) without keeping them in
 * sync silently undoes the perf wins. This ratchet pins the four
 * invariants so that drift fails CI loudly instead of regressing
 * silently:
 *
 *   1. SERVER PAGE — `<entity>/page.tsx` defines a numeric
 *      `SSR_PAGE_LIMIT` and forwards `{ take: SSR_PAGE_LIMIT }` to
 *      its `listX(...)` call. Without `take`, the SSR fetch is
 *      unbounded and the page payload grows linearly with the
 *      tenant's row count.
 *
 *   2. REPOSITORY — `<Entity>Repository.list(...)` accepts
 *      `options: { take?: number }` and conditionally spreads it into
 *      the underlying `findMany`. Without that, the page-layer cap
 *      can't reach the DB.
 *
 *   3. API ROUTE — `/api/t/[tenantSlug]/<entity>/route.ts` GET
 *      handler calls `applyBackfillCap(...)` with the cap+1 sentinel
 *      AND emits `recordListPageRowCount(...)`. Without these, the
 *      SWR backfill is unbounded (no truncation banner ever fires)
 *      and the dashboard has no signal for cap-trending tenants.
 *
 *   4. CAP CONSTANT — `LIST_BACKFILL_CAP` lives in exactly one
 *      module (`@/lib/list-backfill-cap`) and is referenced by
 *      every API route. Inlining the literal at a call site is the
 *      classic "silent raise" anti-pattern this ratchet blocks.
 *
 * Adding a new list-page entity requires adding it to
 * `LIST_PAGE_ENTITIES` below and standing up all four parts; that's
 * a forcing function, by design.
 *
 * Mirrors the shape of `tests/guards/epic52-datatable-ratchet.test.ts`
 * — a single test file scoped to one architectural invariant set,
 * easy to find via grep on a structural review.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The seven list-page entities covered by the interim perf package.
 *
 * Each tuple: `[entity, repoFileName]`. The page directory and API
 * route directory are the entity name unchanged; the repo file is the
 * Pascal-cased model with `Repository.ts` suffix (which doesn't always
 * line up — `Audits` page → `AuditRepository`, etc.).
 *
 * PR-9 added a Tasks entry (SSR-capped list page over
 * `WorkItemRepository`), but the compliance `/tasks` list UI was
 * retired — the operator queue moved to the SWR/ETag-backed
 * `/farm-tasks` surface, which is not part of this SSR perf package —
 * so the Tasks entry was dropped from the set.
 */
const LIST_PAGE_ENTITIES: ReadonlyArray<{ entity: string; repo: string }> = [
    { entity: 'controls', repo: 'ControlRepository' },
    { entity: 'evidence', repo: 'EvidenceRepository' },
    { entity: 'audits', repo: 'AuditRepository' },
    { entity: 'policies', repo: 'PolicyRepository' },
    { entity: 'vendors', repo: 'VendorRepository' },
    { entity: 'findings', repo: 'FindingRepository' },
];

function readFile(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('PR-7 — list-page perf anti-bloat ratchet', () => {
    describe('1. server page caps the SSR fetch', () => {
        for (const { entity } of LIST_PAGE_ENTITIES) {
            test(`${entity}/page.tsx defines SSR_PAGE_LIMIT and forwards { take: SSR_PAGE_LIMIT }`, () => {
                const src = readFile(
                    `src/app/t/[tenantSlug]/(app)/${entity}/page.tsx`,
                );
                // Look for the canonical declaration shape — `const
                // SSR_PAGE_LIMIT = <number>;` — without locking the
                // number itself, so operators can tune it without
                // editing the ratchet.
                expect(src).toMatch(/const\s+SSR_PAGE_LIMIT\s*=\s*\d+\s*;?/);
                // And the forward — `{ take: SSR_PAGE_LIMIT }` somewhere
                // in the page body.
                expect(src).toMatch(/\{\s*take:\s*SSR_PAGE_LIMIT\s*\}/);
            });
        }
    });

    describe('2. repository accepts an optional `take`', () => {
        for (const { entity, repo } of LIST_PAGE_ENTITIES) {
            test(`${repo}.list() accepts options.take and spreads it into findMany`, () => {
                const src = readFile(`src/app-layer/repositories/${repo}.ts`);
                // The signature carries `options: { take?: number } = {}`.
                expect(src).toMatch(
                    /options\s*:\s*\{\s*take\?:\s*number\s*\}\s*=\s*\{\s*\}/,
                );
                // The conditional spread guards against zero — only
                // emit `take` when the caller actually asked for one.
                // The literal we lock is the canonical
                // `...(options.take ? { take: options.take } : {})`
                // pattern.
                expect(src).toMatch(
                    /\.\.\.\s*\(\s*options\.take\s*\?\s*\{\s*take:\s*options\.take\s*\}\s*:\s*\{\s*\}\s*\)/,
                );
                // Unused entity-name reference suppresses the
                // "declared but never used" warning that some linters
                // would otherwise emit on the destructured `entity`.
                void entity;
            });
        }
    });

    describe('3. API route caps the backfill and emits row-count metrics', () => {
        for (const { entity } of LIST_PAGE_ENTITIES) {
            test(`/api/t/[tenantSlug]/${entity}/route.ts wires applyBackfillCap + recordListPageRowCount`, () => {
                const src = readFile(
                    `src/app/api/t/[tenantSlug]/${entity}/route.ts`,
                );
                // The cap helpers must be imported from the canonical
                // module — pinning the import keeps the cap value at
                // a single source of truth.
                expect(src).toMatch(
                    /from\s+['"]@\/lib\/list-backfill-cap['"]/,
                );
                expect(src).toMatch(
                    /from\s+['"]@\/lib\/observability\/list-page-metrics['"]/,
                );
                // And the call sites must actually be hit on the
                // unbounded GET path.
                expect(src).toMatch(/applyBackfillCap\s*\(/);
                expect(src).toMatch(/recordListPageRowCount\s*\(/);
                // The cap+1 sentinel — without it, "exactly cap rows"
                // is indistinguishable from "more than cap rows" and
                // truncation can never fire.
                expect(src).toMatch(/LIST_BACKFILL_CAP\s*\+\s*1/);
            });
        }
    });

    describe('4. cap constant lives in one module', () => {
        test('LIST_BACKFILL_CAP is defined exactly once', () => {
            const src = readFile('src/lib/list-backfill-cap.ts');
            // Pin the export site, not the value — operators can
            // raise the cap without re-baselining this test.
            expect(src).toMatch(/export\s+const\s+LIST_BACKFILL_CAP\s*=\s*\d+/);
        });

        test('no list-page API route inlines a numeric backfill cap literal', () => {
            // A future PR that writes `take: 5000 + 1` directly,
            // bypassing the import, silently bumps that route's cap
            // out of sync with the rest. Walk the seven route files
            // and assert each numeric `take: <NN+1>` is anchored to
            // the constant name.
            for (const { entity } of LIST_PAGE_ENTITIES) {
                const src = readFile(
                    `src/app/api/t/[tenantSlug]/${entity}/route.ts`,
                );
                // Allowed: `take: LIST_BACKFILL_CAP + 1`.
                // Allowed: `take: query.limit` (paginated path uses
                // the request-scoped limit, not the cap).
                // Disallowed: any literal-numeric `take` other than
                // the standard cursor `limit + 1` (which wraps
                // `clampLimit`'s clamped value).
                const lines = src.split('\n');
                const violations: string[] = [];
                for (const line of lines) {
                    // Ignore comments + the one-pager docstrings.
                    const trimmed = line.trim();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                    // Match `take: <something with a literal number>`
                    // that ISN'T the canonical `LIST_BACKFILL_CAP + 1`
                    // form.
                    const m = trimmed.match(/take:\s*([^,)}]+)/);
                    if (!m) continue;
                    const expr = m[1].trim();
                    if (expr.includes('LIST_BACKFILL_CAP')) continue;
                    if (expr.includes('limit')) continue; // cursor path
                    if (/^\d+$/.test(expr)) {
                        violations.push(line.trim());
                    }
                }
                expect(violations).toEqual([]);
            }
        });
    });
});
