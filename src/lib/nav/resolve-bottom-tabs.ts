/**
 * The bottom bar's tab list — the CROSS-CLIENT contract, in one pure function.
 *
 * `User.bottomTabOrder` is shared state: the same account draws a bottom bar on
 * the web and in the iOS app, and the two must agree or the user's own
 * arrangement appears to change when they switch device. The storage shape is
 * specified in `@/lib/account/bottom-tabs` and the HTTP semantics in the
 * OpenAPI description; what lives HERE is the rendering half, which neither of
 * those covers and which is where the two clients could silently diverge.
 *
 * Agreed with the Agrent-iOS session on 2026-10-04, who read it back out of
 * `Agrent/Tabs/BottomTabsStore.swift` rather than from memory, and ruled on by
 * the owner where we differed. The table:
 *
 * | stored value                     | web          | iOS          |
 * |----------------------------------|--------------|--------------|
 * | `null` (never chosen)            | defaults     | defaults     |
 * | `[]` (deliberately cleared)      | **no bar**   | **defaults** |
 * | non-empty, some ids unreachable  | drop them    | drop them    |
 * | non-empty, NOTHING resolves      | defaults     | defaults     |
 * | more than 5 resolve              | first 5      | first 5      |
 * | fewer than 5 resolve             | show fewer   | show fewer   |
 *
 * ── the one deliberate platform difference ──
 *
 * `[]` is the only row where the clients differ, and it is deliberate. On iOS
 * the tab bar IS the navigation, so zero tabs is a blank screen with only a
 * menu; their store falls back to defaults. The web has a sidebar and a drawer,
 * so an empty bottom bar costs the user nothing and honours what they asked
 * for. The iOS editor cannot even save `[]` (Save is disabled on an empty
 * list), so iOS only ever MEETS this value, never writes one.
 *
 * ── why `[]` and "nothing resolved" are not the same case ──
 *
 * Both end with an empty list, and treating them alike is the obvious
 * simplification — but they mean opposite things. `[]` is a statement: the user
 * cleared the bar. "Everything I picked is gated off" is an accident of a role
 * or module change, and the user never asked for it. Collapsing them would
 * silently delete the bottom bar from someone whose permissions changed, with
 * nothing on screen to explain it and no way to get it back from the bar
 * itself. So intent is honoured and accident falls back.
 *
 * ── resolve BEFORE clamping ──
 *
 * The order matters whenever an unreachable id sits inside the first five.
 * Clamping first would spend a slot on a tab that then drops out, so a user
 * with six choices and one gated-out would see four tabs while their sixth
 * choice sat unused. Resolving first lets that sixth move up.
 *
 * ── a preference, never a grant ──
 *
 * `available` must be the caller's LIVE permission- and module-gated nav, so
 * this is re-resolved on every render. A list validated once at write time
 * would go on offering a tab the member may no longer reach. This function
 * cannot widen access: it only ever returns items that were already in
 * `available`.
 */

/** Slots in the bar. Matches `prefix(5)` in the iOS store. */
export const BOTTOM_TAB_LIMIT = 5;

/**
 * The default arrangement, as tenant-relative href suffixes.
 *
 * Shared vocabulary with iOS, whose ids are the same path strings
 * (`case dashboard = "/dashboard"`), not bare names.
 */
export const DEFAULT_BOTTOM_TAB_SUFFIXES: readonly string[] = [
    '/dashboard',
    '/farm-tasks',
    '/locations',
    '/journal',
    '/exchange',
];

/** The shape this needs off a nav item; the real one carries label/icon/badge. */
interface HasHref {
    href: string;
}

/**
 * Pick the items named by `suffixes`, in that order, out of `available`.
 *
 * Suffix matching (rather than equality) is what makes the stored vocabulary
 * independent of the `/t/<slug>` prefix `tenantHref()` bakes into every href.
 *
 * An item is used at most ONCE. The stored vocabulary admits suffixes that nest
 * — `/costs` is a suffix of `/grain/costs` — so without this a saved list
 * containing both would resolve to the same nav item twice and render a
 * duplicate tab with a duplicate React key.
 */
function pick<T extends HasHref>(suffixes: readonly string[], available: readonly T[]): T[] {
    const out: T[] = [];
    const used = new Set<string>();
    for (const suffix of suffixes) {
        const match = available.find((it) => it.href.endsWith(suffix) && !used.has(it.href));
        if (match) {
            used.add(match.href);
            out.push(match);
        }
    }
    return out;
}

/**
 * Resolve the bar's tabs for one render.
 *
 * @param saved     `User.bottomTabOrder` as stored — `null` when never chosen.
 * @param available The caller's live, already-gated nav items.
 */
export function resolveBottomTabs<T extends HasHref>(
    saved: readonly string[] | null,
    available: readonly T[],
): T[] {
    const defaults = () => pick(DEFAULT_BOTTOM_TAB_SUFFIXES, available).slice(0, BOTTOM_TAB_LIMIT);

    // Never chosen.
    if (saved === null) return defaults();

    // Deliberately cleared. The one row where web and iOS differ, on purpose.
    if (saved.length === 0) return [];

    const resolved = pick(saved, available);

    // Chosen, but nothing they chose is reachable any more — an accident, not a
    // request for an empty bar.
    if (resolved.length === 0) return defaults();

    return resolved.slice(0, BOTTOM_TAB_LIMIT);
}
