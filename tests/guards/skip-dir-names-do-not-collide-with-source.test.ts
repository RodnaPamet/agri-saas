/**
 * No NEW source directory is named after a build artefact — #2421, again.
 *
 * ## This has already cost one production incident
 *
 * `scripts/lib/api-routes.ts` skipped any directory called `node_modules`,
 * `.next`, `.git`, `dist` or `coverage`. The walk starts at `src/app/api`,
 * where a build artefact cannot legitimately appear, so the list was purely
 * defensive — but `coverage` is also a perfectly ordinary URL segment, and
 * `GET /api/t/{tenantSlug}/ortho/coverage` was therefore invisible to the route
 * inventory AND to `openapi-paths-complete`, whose whole claim is "every route
 * on disk is accounted for". It served traffic and appeared in neither.
 * `route-collector-sees-every-route-file` records that in full, and the fix
 * there replaced the name list with Next's own structural rule.
 *
 * ## The same list still exists in tests/helpers/collect-files.ts
 *
 * `DEFAULT_SKIP_DIRS` is `['node_modules', '.next', 'dist', 'coverage',
 * '.git']`, and **92 guard files include `.ts` and rely on it** — only two pass
 * an explicit `skipDirs`. Measured 2026-10-31.
 *
 * The default is NOT changed here, deliberately. Narrowing it would newly
 * expose `tests/fixtures/coverage/barrel-probe.ts` — a hand-crafted fixture —
 * to the three guards that walk the `tests` root, and a fixture is exactly the
 * kind of file written to contain the patterns guards ban. Changing a default
 * that 92 callers depend on, to fix a hazard with two known instances, is not a
 * trade to make silently.
 *
 * What is cheap is making the collision LOUD. Every instance below is recorded
 * with what it costs; a new one fails this guard, which is the signal that was
 * missing when `ortho/coverage` was added.
 */
import { readdirSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The names `DEFAULT_SKIP_DIRS` excludes. Spelled here rather than imported so
 * this guard still fails if somebody edits the helper's list — importing it
 * would make the expectation agree with whatever the code says, which is the
 * shape of a check that cannot fail.
 */
const SKIPPED_NAMES = ['node_modules', '.next', 'dist', 'coverage', '.git'] as const;

/** Roots that `collectSourceFiles` callers actually walk. */
const WALKED_ROOTS = ['src', 'tests', 'scripts', 'prisma'] as const;

/**
 * Known collisions, each with what it costs. A `.ts` or `.tsx` file under one
 * of these is INVISIBLE to any caller relying on the default skips.
 */
const KNOWN: Readonly<Record<string, string>> = {
    'src/app/api/t/[tenantSlug]/ortho/coverage':
        'The orthophoto coverage API (#2421). `coverage` is a URL segment here, not a build '
        + 'artefact. Holds 1 `.ts` file, so every guard whose extensions include `.ts` and '
        + 'which relies on DEFAULT_SKIP_DIRS cannot see it. This directory is why the route '
        + 'was missing from the inventory and from the OpenAPI spec while serving traffic.',
    'tests/fixtures/coverage':
        'Fixture directory for `coverage-barrel-exclusion` (`barrel-probe.ts`). Holds 1 `.ts` '
        + 'file. Being skipped is BENIGN and arguably desirable here — it is a hand-crafted '
        + 'fixture, and fixtures are written to contain the patterns guards ban. This is the '
        + 'entry that makes narrowing the default a real trade rather than a free win.',
};

function collisions(): string[] {
    const found: string[] = [];
    for (const root of WALKED_ROOTS) {
        const walk = (dir: string): void => {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return; // a root this repo does not have is not a collision
            }
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                // Never descend into a REAL node_modules — that is the one name
                // on the list which is unambiguously an artefact.
                if (e.name === 'node_modules') continue;
                const rel = path.relative(REPO_ROOT, path.join(dir, e.name));
                if ((SKIPPED_NAMES as readonly string[]).includes(e.name)) found.push(rel);
                walk(path.join(dir, e.name));
            }
        };
        walk(path.join(REPO_ROOT, root));
    }
    return found.sort();
}

describe('skip-dir names do not collide with real source directories (#2421)', () => {
    const FOUND = collisions();

    it('[skip-dir-collisions] ranges over a real set of roots', () => {
        console.log(
            `[skip-dir-collisions] ${WALKED_ROOTS.length} walked root(s), `
                + `${SKIPPED_NAMES.length} skipped name(s), ${FOUND.length} collision(s), `
                + `${Object.keys(KNOWN).length} recorded`,
        );
        // The walk must have found the roots at all. Without this, a renamed
        // root reports zero collisions and reads as healthy — the defect this
        // whole family is about.
        expect(WALKED_ROOTS.length).toBeGreaterThanOrEqual(4);
        expect(FOUND.length).toBeGreaterThan(0);
    });

    it('every collision is recorded with what it costs', () => {
        const unrecorded = FOUND.filter((f) => !(f in KNOWN));
        expect({
            message:
                'A source directory is named after a build artefact in DEFAULT_SKIP_DIRS. '
                + 'Any guard whose extensions include its files AND which relies on the '
                + 'default skips cannot see them — silently. Rename the directory, or record '
                + 'it here with what being invisible costs. See #2421 for what this cost '
                + 'the first time.',
            unrecorded,
        }).toEqual({
            message:
                'A source directory is named after a build artefact in DEFAULT_SKIP_DIRS. '
                + 'Any guard whose extensions include its files AND which relies on the '
                + 'default skips cannot see them — silently. Rename the directory, or record '
                + 'it here with what being invisible costs. See #2421 for what this cost '
                + 'the first time.',
            unrecorded: [],
        });
    });

    it('no recorded entry has gone stale', () => {
        // The other direction: a directory that was renamed or deleted leaves a
        // reason nobody needs, and the list stops describing the repo.
        const present = new Set(FOUND);
        expect(Object.keys(KNOWN).filter((k) => !present.has(k))).toEqual([]);
    });

    it('each recorded entry carries a substantive reason', () => {
        for (const [dir, why] of Object.entries(KNOWN)) {
            expect({ dir, explained: why.length > 120 }).toEqual({ dir, explained: true });
        }
    });
});
