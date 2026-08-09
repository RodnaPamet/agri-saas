/**
 * Hydration-fetch ratchet for the practices list page.
 *
 * The SSR path returns the initial list, hydrates the client, and
 * the client's `useQuery` is supposed to honour that payload until
 * `staleTime` elapses. If `initialDataUpdatedAt` is set to `0` (or
 * `staleTime` is unset on practices), React Query treats the SSR data
 * as instantly stale and fires a duplicate `GET /practices` on
 * hydration. The page also narrows the server-side `_count` aggregate
 * to the two keys the list view actually reads — bloating it back to
 * six is a silent perf regression.
 *
 * (The tasks list arm was retired 2026-07-25 when the compliance
 * `/tasks` UI was replaced by `/farm-tasks`.)
 *
 * This guardrail catches all three regressions structurally so
 * future refactors can't reintroduce them without an explicit diff.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('list-page hydration shape', () => {
    const practicesClient = read(
        'src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx',
    );

    test('PracticesClient sets initialDataUpdatedAt + staleTime on the list useQuery', () => {
        expect(practicesClient).toMatch(/initialDataUpdatedAt:\s*filtersMatchInitial\s*\?\s*Date\.now\(\)/);
        expect(practicesClient).toMatch(/staleTime:\s*30_000/);
    });

    test('the practices client does not use the regression shape `initialDataUpdatedAt: 0` standalone', () => {
        // The literal "initialDataUpdatedAt: 0," with no ternary is the
        // pre-fix shape. Allow it to appear only inside the ternary fallback.
        const badShape = /initialDataUpdatedAt:\s*0\s*[,\n}]/;
        expect(practicesClient).not.toMatch(badShape);
    });
});

describe('PracticeRepository list `_count` projection', () => {
    const repo = read('src/app-layer/repositories/PracticeRepository.ts');

    // Both `list()` and `listPaginated()` feed the same client surface
    // (PracticesClient renders `_count?.practiceTasks` and
    // `_count?.evidenceLinks` only — see PracticesClient.tsx:411,616).
    // Fetching the other four (`evidence`, `risks`, `assets`,
    // `contributors`) costs a correlated subquery per row and the
    // values are dropped. Lock the projection.
    //
    // PR-3 hoisted the list-shape into a shared `practiceListSelect`
    // constant referenced by both functions, so the literal now
    // appears once at module scope rather than twice in line. The
    // anti-bloat invariant (only the two consumed keys) is unchanged.
    const ALLOWED = /_count:\s*\{\s*select:\s*\{\s*practiceTasks:\s*true,\s*evidenceLinks:\s*true\s*\}\s*\}/g;

    test('list-shape exposes only the consumed _count keys (practiceTasks + evidenceLinks)', () => {
        const matches = repo.match(ALLOWED) ?? [];
        // One declaration in the shared `practiceListSelect` constant.
        expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test('list-shape constant is referenced by list() and listPaginated()', () => {
        // The performance fix only sticks if both list paths actually
        // reach the trimmed shape. PR-3 introduced a shared constant —
        // pin its name so a future refactor can't drop one reference.
        const listFnIndex = repo.indexOf('static async list(');
        const detailIndex = repo.indexOf('static async getById(');
        const listSection = repo.slice(listFnIndex, detailIndex);
        const refs = listSection.match(/practiceListSelect/g) ?? [];
        expect(refs.length).toBe(2);
    });

    test('no list-shape _count includes the unused four keys', () => {
        // `getById` (detail read) intentionally keeps the wider _count
        // because the detail page renders all four. Scope this check to
        // the list-shape constant + the two list functions, slicing
        // before `getById`.
        const listSection = repo.slice(0, repo.indexOf('static async getById('));
        expect(listSection).not.toMatch(/contributors:\s*true/);
        expect(listSection).not.toMatch(/assets:\s*true/);
        // `evidence: true` and `risks: true` are also dropped — but both
        // names recur as relations elsewhere, so assert via the known-bad
        // wide-shape literal instead.
        expect(listSection).not.toMatch(
            /_count:\s*\{\s*select:\s*\{\s*evidence:\s*true,\s*risks:\s*true,\s*assets:\s*true/,
        );
    });
});
