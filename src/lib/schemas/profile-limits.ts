/**
 * The display-name bound, in a LEAF module.
 *
 * `DISPLAY_NAME_MAX` lived in `lib/account/profile.ts`, which imports
 * `@/lib/prisma` — and `@/lib/prisma` reads `Prisma.dmmf` at module load. When
 * `src/lib/schemas/index.ts` needed the bound for the shared
 * `UpdateOwnProfileRequest` body (#3080), importing it from there would have
 * dragged Prisma into the schema barrel, which `'use client'` components
 * import.
 *
 * So the constant moved DOWN rather than the import going UP — the same fix,
 * for the same reason, as `farm-limits.ts` (#1555) and `errors/unique-violation.ts`
 * (#1500). This module imports nothing, which is the property that makes it
 * safe for both sides to depend on; `account/profile.ts` re-exports it so
 * existing importers are unchanged.
 *
 * ## What this did NOT fix, because I claimed otherwise
 *
 * The first version of this docblock said "The Build failed, which is the good
 * outcome". It did not. I read a CI monitor event naming `Build` as a failure,
 * found `Module not found: Can't resolve '@valkey/valkey-glide' in bullmq` in
 * the Build log, and attributed it to this import chain. Both halves were
 * wrong: that warning occurs SIX times in a Build job whose conclusion is
 * `success`, so it is pre-existing noise, and the Build job I inspected had
 * conclusion `success` too — the monitor was reporting stale check-runs left
 * on the PR by a superseded head.
 *
 * The move is still right, on the repo's own written rule rather than on a
 * failure: a value needed by a client-reachable module does not get to live
 * behind an import that pulls in Prisma. It is a correctness fix with no
 * symptom, which is the kind most worth recording honestly — the next reader
 * would otherwise go looking for a Build failure that never happened.
 */

/** Max length of the composed display name. Enforced at the schema AND in the usecase. */
export const DISPLAY_NAME_MAX = 100;
