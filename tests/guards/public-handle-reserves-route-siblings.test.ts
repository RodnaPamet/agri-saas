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
 * The check is one composition of three selectors, and each has its own
 * control, because a guard whose real population is empty can only be proven
 * live piece by piece: `routeChildren` is proven by asserting `[handle]` is
 * among its results, `staticAmong` by handing it a population containing a
 * sibling, and `unreservedAmong` by handing it an unreserved name.
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
 *
 * Takes the children rather than calling `routeChildren()` itself, and that
 * is not a style choice. A zero-argument `staticSiblings()` can be gutted to
 * `return []` with every assertion here still green — `selector-teeth` caught
 * exactly that on the first revision of this file — and no control over the
 * real tree can disprove it, because the real tree HAS no static siblings. A
 * selector that takes its population can be given one.
 */
function staticAmong(children: readonly string[]): string[] {
    return children.filter((name) => !name.startsWith('[') && !name.startsWith('('));
}

function unreservedAmong(names: readonly string[]): string[] {
    return names.filter((name) => !isReservedHandle(name));
}

describe('a handle cannot shadow a route under /f/', () => {
    it('reserves every static sibling of [handle]', () => {
        expect(unreservedAmong(staticAmong(routeChildren()))).toEqual([]);
    });

    it('selects a static sibling out of a population that has one', () => {
        // Control for `staticAmong`. The real siblings set is empty, so this
        // is the only way to show the filter can select at all — and that it
        // drops the two segment kinds a handle cannot collide with.
        expect(staticAmong(['[handle]', 'directory', '(marketing)'])).toEqual(['directory']);
        expect(staticAmong(['[handle]'])).toEqual([]);
    });

    it('would fail if a static sibling were added unreserved', () => {
        // Control for `unreservedAmong`. Without it the first assertion is
        // green whatever the reserved list contains — including empty.
        expect(unreservedAmong(['directory'])).toEqual(['directory']);
        expect(unreservedAmong(['search', 'admin'])).toEqual(['search']);
    });

    it('derives the route children it filters, and [handle] is among them', () => {
        // Control for `routeChildren`, and it guards the other way this goes
        // quietly wrong: a renamed or restructured `/f/` would empty the
        // composition for a reason that has nothing to do with the property
        // under test.
        expect(routeChildren()).toContain('[handle]');
    });
});
