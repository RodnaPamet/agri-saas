'use client';

/**
 * The single client sign-out path.
 *
 * ## Why a wrapper rather than five edits
 *
 * The CLIENT `signOut()` from `next-auth/react` was called from three
 * places — the user menu, the app shell, the command palette. Purging on
 * sign-out means every one of them has to do it, and a fourth added later
 * has to remember. That is the shape of a rule nobody keeps, so the rule
 * is a function instead, and `tests/guards/sign-out-purges.test.ts` bans
 * the raw client call outside this module.
 *
 * ## The two sign-outs this CANNOT cover, stated rather than hidden
 *
 * `/no-tenant` and `/tenants` are SERVER components. They call the
 * `signOut` compat shim in `src/auth.ts`, which is a server-side
 * `redirect()` to the NextAuth signout endpoint — there is no browser
 * context there, so no client storage can be cleared. A user signing out
 * from either page keeps whatever their device had cached until the
 * retention sweep ages it out.
 *
 * That is a real hole and a small one: both pages are reached only when a
 * user has no tenant access or is choosing between tenants, so the device
 * has little tenant data cached at that point. Closing it properly means
 * making those buttons client components, which is a UI change rather
 * than a storage one, and does not belong in this diff.
 *
 * ## What it purges, and what it deliberately does not
 *
 * `sweepClientStores({ maxAgeMs: 0 })` — the same sweep that runs on a
 * timer, at its strongest setting. It clears CACHES: field snapshots,
 * the persistent SWR buckets, and the tenant Cache Storage buckets.
 *
 * It does **not** touch the outbox, and that is the whole reason this is
 * safe to run at sign-out at all. Queued field work exists nowhere else;
 * deleting it would be unrecoverable, it would race the flush loop, and
 * clearing the manifest alongside the queue is exactly the shape the loss
 * detector reads as "this phone deleted your work". Since the queue is
 * bound to the operator who queued it, another operator signing in cannot
 * send it either — it is held, visibly, until its owner returns.
 *
 * So the honest summary of what sign-out now does: everything this device
 * cached is gone; everything it still owes the server is kept.
 *
 * ## Ordering and failure
 *
 * The purge runs BEFORE `signOut`, so a sign-out that never completes
 * (offline, and this app is used offline by design) still leaves the
 * device clean — which is the point of purging at all. The cost of that
 * ordering is one refetch if the sign-out then fails and the operator
 * stays, which is the correct thing to trade.
 *
 * The purge is raced against a short budget so a wedged Cache Storage
 * cannot strand someone on a screen they are trying to leave. Sign-out
 * proceeds regardless; a stuck purge must never become a stuck sign-out.
 */
import { signOut } from 'next-auth/react';
import { sweepClientStores } from '@/lib/offline/client-data-retention';

/** Longest the purge may delay the sign-out it precedes. */
export const PURGE_BUDGET_MS = 2_000;

export interface SignOutOptions {
    callbackUrl?: string;
}

export async function signOutAndPurge(options: SignOutOptions = {}): Promise<void> {
    const { callbackUrl = '/login' } = options;
    try {
        await Promise.race([
            sweepClientStores({ maxAgeMs: 0 }),
            new Promise((resolve) => setTimeout(resolve, PURGE_BUDGET_MS)),
        ]);
    } catch {
        // sweepClientStores never throws, but a wedged browser API might.
        // A failed purge must not block the sign-out it precedes.
    }
    await signOut({ callbackUrl });
}
