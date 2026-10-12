/**
 * The suspension check for SERVER-RENDERED pages (#1657).
 *
 * ## Why this exists when `getSessionOrThrow` already checks
 *
 * P5.9 put `isAccountSuspended` in `getSessionOrThrow`, which all three ctx
 * resolvers call — so every API route is covered (and the nine that resolved
 * their own session were migrated in #1652). **No page was.**
 *
 * A server component does not call a ctx resolver. The tenant subtree's gate is
 * `getTenantServerContext`, and it takes the `userId` as a PARAMETER: a helper
 * handed an id cannot ask whether that id is allowed to be here. So a suspended
 * account could load `/t/{slug}/admin/billing` and have the farm's billing
 * state rendered server-side, along with rbac, the app layout's user row and
 * the `/tenants` picker.
 *
 * The Edge cannot cover it either, for P5.9's own reason: middleware runs on the
 * Edge and this deployment has neither Prisma nor Redis there.
 *
 * ## A redirect, not a 404
 *
 * Owner ruling: a suspended person sees a page that says so. The tenant layout
 * already answers `notFound()` for a non-member, and reusing that here would
 * tell a suspended farmer their farm does not exist — indistinguishable from a
 * typo in the URL, and nothing they could act on. `/suspended` carries the
 * sentence and a sign-out, which is the same thing the phone shows.
 *
 * ## The caller's `catch` is the hazard
 *
 * `redirect()` works by THROWING, with a `digest` of `NEXT_REDIRECT;…`. The
 * tenant layout wraps its context call in `try { … } catch { notFound() }`, so
 * a redirect raised inside would have been swallowed and turned into a 404 —
 * the exact outcome this ruling rejected, arriving by accident. That catch now
 * re-throws Next's control-flow errors; `isNextControlFlow` below is exported
 * so any other swallowing catch can do the same.
 *
 * The fail direction is inherited from `isAccountSuspended` and not re-decided
 * here: Postgres unreadable fails CLOSED, Redis unreadable falls through to
 * Postgres. A page that cannot read `User.suspendedAt` cannot render honestly.
 */
import { redirect } from 'next/navigation';

import { isAccountSuspended } from './suspension';

/** Where a suspended person is sent. One constant, two call sites and a test. */
export const SUSPENDED_PATH = '/suspended';

/**
 * Next signals `redirect()` and `notFound()` by throwing. Both must pass
 * through a `catch` untouched or the page answers the wrong thing.
 *
 * Matched on `digest`, which is the only stable surface — `sentry.ts` already
 * filters `NEXT_REDIRECT` the same way, so the convention is established here
 * rather than invented.
 */
export function isNextControlFlow(error: unknown): boolean {
    const digest = (error as { digest?: unknown } | null)?.digest;
    return (
        typeof digest === 'string' &&
        (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
    );
}

/**
 * Send a suspended account to `/suspended`. Returns normally otherwise.
 *
 * Takes the id rather than resolving a session because every caller already has
 * one — and asking for it keeps this honest about what it checks.
 */
export async function redirectIfSuspended(userId: string): Promise<void> {
    if (await isAccountSuspended(userId)) redirect(SUSPENDED_PATH);
}
