/**
 * Every flag key this codebase gates on — #2009 option 1, the in-repo half.
 *
 * ## What this list is for
 *
 * A `FeatureFlag` row that does not exist is OFF by design, so a surface whose
 * key was never inserted is unreachable for everybody while looking perfectly
 * implemented. That is #2009's instance 3: `social.public-profile` gated 12
 * call sites, production held exactly one row, and every one of those surfaces
 * returned `notFound()` for months.
 *
 * Answering "does every key the code gates on have a row" needs BOTH sides,
 * and only one of them lives here. This is that one: the list a production
 * check compares against. It is a plain constant rather than a generated JSON
 * artifact because the comparison runs IN the image — `/api/readyz` is the
 * reporting surface — and a constant is already there.
 *
 * ## Why a list at all, when the keys are in the call sites
 *
 * Because a grep over the call sites gets the wrong answer, and #2291 is the
 * measurement. #2009 proposes:
 *
 *     grep -rhoP "(?:isFeatureEnabled|assertFeatureEnabled)\(\s*'\K[a-z0-9.-]+" src/
 *
 * which finds FOUR of the six keys below. Five call sites pass a CONSTANT
 * rather than a literal (`NOTIFICATIONS_SSE_FLAG`, `REALTIME_FLAG`,
 * `FARM_REGISTRATION_FLAG`, `GOOGLE_INTEGRATION_FLAG`) and are invisible to
 * it. Two keys exist only behind one — `integrations.google`, and
 * `notifications.sse`, which is the flag that REPLACED
 * `NEXT_PUBLIC_NOTIFICATIONS_SSE`, i.e. #2009's own instance 2. A check that
 * re-misses the class it was written for is worse than none, because it
 * reports coverage.
 *
 * So the list is explicit and `tests/guards/feature-flag-keys-are-complete.test.ts`
 * derives the real population from source — literals AND single-level
 * constants — and fails when the two disagree in either direction. A key
 * whose first argument it cannot resolve statically is a hard failure there
 * rather than a silent omission, which is the property that makes this list
 * worth comparing anything against.
 *
 * ## Adding a flag
 *
 * Add the key here in the same diff as the gate. The guard will tell you if
 * you forget; the production row is a separate, deliberate act — see
 * `docs/runbooks/` and the feature-flag console at
 * `/api/admin/feature-flags`.
 *
 * ## What this list does NOT say
 *
 * Nothing about whether a key SHOULD be enabled. A row present with
 * `enabled=false` is a legitimate state, and P2–P6 surfaces are dark-launch by
 * default, so a missing row can be the intended pre-launch state too. The
 * distinction this enables is "no row at all" versus "a row someone decided
 * about" — not on versus off.
 *
 * It also records nothing about which keys currently lack a row. A snapshot of
 * production state baked into the image would be stale the moment somebody
 * used the console, and reading the live table is the entire point; the
 * 2026-10-24 measurement lives on #2291.
 */

/**
 * Sorted, so a diff adding one is a one-line change rather than a reflow.
 *
 * Each key is gated by at least one call to `assertFeatureEnabled` /
 * `isFeatureEnabled` under `src/`. The guard holds that correspondence.
 */
export const REFERENCED_FLAG_KEYS = [
    'integrations.google',
    'notifications.sse',
    'social.farm-media',
    'social.farm-registration',
    'social.person-blocks',
    'social.public-profile',
] as const;

export type ReferencedFlagKey = (typeof REFERENCED_FLAG_KEYS)[number];
