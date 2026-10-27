/**
 * The route collector finds every `route.ts` on disk — checked INDEPENDENTLY
 * (#2421).
 *
 * ## The gap this closes
 *
 * `openapi-paths-complete` already claims "every route on disk is in the
 * inventory", and `route-inventory-ledger` claims "a path cannot leave
 * silently". Both are real guards and both were green while
 * `GET /api/t/{tenantSlug}/ortho/coverage` existed, served traffic, and
 * appeared in neither.
 *
 * They were green because they ask the question THROUGH the thing that was
 * wrong. `scripts/lib/api-routes.ts` skipped any directory named
 * `node_modules`, `.next`, `.git`, `dist` or `coverage` — a defensive list
 * aimed at build artefacts, applied to a walk that starts at `src/app/api`
 * where no artefact can appear. `coverage` is also a perfectly ordinary URL
 * segment, so the route directory was skipped, the collector reported one
 * fewer file, and every consumer agreed with it perfectly.
 *
 * A guard that derives its population from the collector cannot catch a
 * collector that under-collects. So this one walks the tree itself, with no
 * exclusions at all, and compares.
 *
 * ## What the existing guards DO catch, stated precisely
 *
 * Measured by restoring the bug after the route was registered: the ledger
 * guard then fails too, on "every live path in the inventory still exists on
 * disk" — because the ledger now holds a path the crippled collector cannot
 * see, which reads as a path having LEFT.
 *
 * So the existing guard catches the regression once the route is in the
 * ledger, and was blind to it before — which is exactly when it mattered, and
 * is the window this file closes. Worth writing down rather than claiming the
 * older guards see nothing: they see the second occurrence, not the first.
 *
 * ## Why a COUNT and not a set difference
 *
 * Both, actually — the count is what fails loudly and the names are what make
 * it actionable. A count alone would say "one short" and leave somebody
 * bisecting 400 directories; names alone would not notice the collector
 * inventing a path that no file backs.
 */
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import {
    API_REL,
    NON_SURFACE_ROUTE_FILES,
    ROOT,
    routePathTemplates,
} from '../../scripts/lib/api-routes';

/**
 * Every `route.ts` on disk — through the SHARED collector, with the skip list
 * explicitly emptied.
 *
 * `skipDirs: []` is the load-bearing argument, and it was nearly the trap this
 * file exists to describe. `collectSourceFiles`' own
 * `DEFAULT_SKIP_DIRS` is `['node_modules', '.next', 'dist', 'coverage',
 * '.git']` — the SAME list, including the same `coverage`. Calling it with
 * defaults would have inherited the identical blind spot and made this guard a
 * restatement of the thing it checks, green while the route stayed hidden
 * (`[[a-crosscheck-in-the-old-method]]`).
 *
 * Emptying it is safe here and measured: repo-wide, exactly two TRACKED files
 * sit under a directory with one of those names — this route and
 * `tests/fixtures/coverage/barrel-probe.ts` — and the walk below is rooted at
 * `src/app/api`, where a real build artefact cannot appear.
 *
 * Going through the shared helper rather than a hand-rolled `readdirSync` also
 * buys the `floor`, which refuses an empty population outright instead of
 * letting every comparison below hold trivially. The first version of this
 * file walked by hand and `no-NEW-guard-collects-files-by-hand` caught it,
 * correctly.
 */
function everyRouteFile(): string[] {
    return collectSourceFiles({
        roots: [API_REL],
        extensions: ['.ts'],
        skipDirs: [],
        floor: 300,
    })
        .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
        .filter((rel) => rel.endsWith('/route.ts'));
}

/** `src/app/api/t/[tenantSlug]/x/route.ts` → `/api/t/{tenantSlug}/x`. */
function toTemplate(rel: string): string {
    return (
        '/' +
        rel
            .replace(/^src\/app\//, '')
            .replace(/\/route\.ts$/, '')
            .replace(/\[\.\.\.(\w+)\]/g, '{$1}')
            .replace(/\[(\w+)\]/g, '{$1}')
    );
}

describe('the route collector sees every route file (#2421)', () => {
    const onDisk = everyRouteFile();

    it('finds a population at all — the floor', () => {
        // Without this, a walk that resolved nothing would make every
        // comparison below hold trivially.
        expect(onDisk.length).toBeGreaterThan(300);
    });

    it('the collector collects exactly the files on disk, minus the declared non-surfaces', () => {
        const expected = onDisk.filter((f) => !NON_SURFACE_ROUTE_FILES.has(f));
        const collected = routePathTemplates();

        const expectedTemplates = new Set(expected.map(toTemplate));
        const collectedTemplates = new Set(collected);

        const missed = [...expectedTemplates].filter((t) => !collectedTemplates.has(t)).sort();
        const invented = [...collectedTemplates].filter((t) => !expectedTemplates.has(t)).sort();

        // Named, not just counted: "one short" sends somebody through 400
        // directories, and `ortho/coverage` is what it actually was.
        expect({ missed, invented }).toEqual({ missed: [], invented: [] });
        expect(collected.length).toBe(expected.length);
    });

    it('a directory whose NAME looks like a build artefact is still walked', () => {
        // The specific regression. `coverage` was skipped by name; `dist` and
        // `node_modules` would have been too, and any of the three is a legal
        // URL segment. This asserts the rule is about ROUTABILITY, not names.
        const walked = everyRouteFile();
        for (const name of ['coverage', 'dist', 'node_modules']) {
            const underThatName = walked.filter((f) => f.includes(`/${name}/`));
            // Whatever exists under such a name must be collected, not skipped.
            for (const f of underThatName) {
                expect(routePathTemplates()).toContain(toTemplate(f));
            }
        }
        // And the control: at least one such directory exists today, so this
        // case is not vacuous. If the ortho coverage route is ever renamed and
        // nothing replaces it, this fails and asks for a fixture instead of
        // quietly passing forever.
        expect(walked.some((f) => /\/(coverage|dist|node_modules)\//.test(f))).toBe(true);
    });
});
