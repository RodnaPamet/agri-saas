/**
 * A handle must never be able to shadow a real route — P6.6 (#1815).
 *
 * `/f/[handle]` is a dynamic segment, and Next resolves a STATIC sibling
 * before a dynamic one. So the day somebody adds `src/app/f/directory/`, a
 * farm already holding the handle `directory` stops being served: its page
 * returns the new route instead, no error is raised, and the only signal is
 * an owner reporting that their link broke. P6.8's directory page is the live
 * candidate, which is what makes this worth a guard rather than a comment.
 *
 * The list cannot be hand-kept, because a hand-kept list goes stale exactly
 * when it matters — at the moment someone adds the route. So this derives the
 * siblings from the route tree and fails if one of them is not reserved.
 *
 * ## Why the population comes from `collectSourceFiles`
 *
 * There are no static siblings today, so the set this asserts over is EMPTY,
 * and an empty set passes any assertion about its members forever. The route
 * children are therefore derived from `collectSourceFiles`, which refuses an
 * empty result and names a renamed root instead of scanning zero files — the
 * emptiness is then a FILTER over a population known to be non-empty, not an
 * unexamined collector returning nothing. `floor: 2` is the live count
 * (`page.tsx` and `opengraph-image.tsx`), kept closer to reality than a bare
 * `1` so a selector that ate most of the tree still fails.
 *
 * Two tests below exist only to prove this guard can fail: one feeds the
 * comparison a synthetic sibling, and one asserts `[handle]` is in the
 * derived children at all.
 */
import path from 'node:path';

import { REPO_ROOT, collectSourceFiles } from '../helpers/collect-files';
import { isReservedHandle } from '@/lib/public-profile/handle';

const FARM_ROUTE_ROOT = 'src/app/f';

/** Every directory directly under `src/app/f`, derived from its own files. */
function routeChildren(): string[] {
    const files = collectSourceFiles({ roots: [FARM_ROUTE_ROOT], floor: 2 });
    const prefix = path.join(REPO_ROOT, FARM_ROUTE_ROOT) + path.sep;
    const children = files
        .map((file) => file.slice(prefix.length).split(path.sep))
        // More than one component means the first is a DIRECTORY. A file
        // sitting directly in `src/app/f` (a `layout.tsx`, say) is not a
        // route segment a handle could collide with.
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0]);
    return [...new Set(children)].sort();
}

/**
 * The children occupying a literal URL segment. `[handle]` is the dynamic one
 * and `(group)` segments are invisible in the URL, so neither can be shadowed
 * by a handle.
 */
function staticSiblings(): string[] {
    return routeChildren().filter((name) => !name.startsWith('[') && !name.startsWith('('));
}

function unreservedAmong(names: readonly string[]): string[] {
    return names.filter((name) => !isReservedHandle(name));
}

describe('a handle cannot shadow a route under /f/', () => {
    it('reserves every static sibling of [handle]', () => {
        expect(unreservedAmong(staticSiblings())).toEqual([]);
    });

    it('would fail if a static sibling were added unreserved', () => {
        // The positive control. The real population of SIBLINGS is empty
        // today, so without this the assertion above is green whatever the
        // reserved list contains — including empty.
        expect(unreservedAmong(['directory'])).toEqual(['directory']);
        expect(unreservedAmong(['search', 'admin'])).toEqual(['search']);
    });

    it('derives the route children it filters, and [handle] is among them', () => {
        // Guards the other way this goes quietly wrong: a renamed or
        // restructured `/f/` would leave `staticSiblings()` empty for a
        // reason that has nothing to do with the property under test.
        expect(routeChildren()).toContain('[handle]');
    });
});
