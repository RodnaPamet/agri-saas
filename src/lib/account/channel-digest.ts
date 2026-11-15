/**
 * The caller's own channel-digest opt-in (#2941, P9.7 stage C).
 *
 * ## It is ADDITIVE, and the wording of the control has to say so
 *
 * Opting in ADDS the 07:15 recap; it does not suppress per-event pushes. The
 * person who wants batching INSTEAD sets
 * `UserNotificationPreference.delivery = DAILY_DIGEST`, which is a different
 * control on a different model — per (user, farm), where this is per user.
 *
 * That split is deliberate and the two must not be collapsed. A channel has no
 * farm, so a per-farm preference cannot express "digest my channel activity";
 * and `resolvePersonDelivery` takes the STRICTEST preference across a person's
 * farms, so routing the channel digest through it would let one farm's setting
 * silence a person-scoped surface that farm has nothing to do with.
 *
 * ## Why this is an `/api/account/` route and not a tenant one
 *
 * The column is on `User` and the surface it governs is person-scoped. A
 * `/api/t/{slug}/…` route would run `runInTenantContext`, which sets
 * `app.actor_user_id` and deliberately not `app.user_id` (#1664) — and it
 * would also make the same person's answer depend on which farm they happened
 * to have open, for a setting that has no farm.
 */
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

/**
 * `{ optIn: boolean }`, and the key is REQUIRED.
 *
 * `.strict()` so a client that sends `{ optin: true }` or a stale field name
 * is refused rather than silently writing nothing and answering 200 — a
 * switch that reports success and changes no column is the worst available
 * outcome for a notification setting, because the person then believes they
 * opted in and simply never hears anything.
 */
export const ChannelDigestOptInSchema = z.object({
    optIn: z.boolean(),
}).strict();

export type ChannelDigestOptIn = z.infer<typeof ChannelDigestOptInSchema>;

/**
 * Persist the caller's own opt-in.
 *
 * Turning the digest OFF deliberately leaves `channelDigestSentOn` alone. That
 * column is a send LEDGER, not a preference: clearing it would let somebody
 * who opts out and back in on the same morning receive a second banner for a
 * day they had already been sent. Opting out stops the next digest, which is
 * what the control promises; it does not rewrite what already happened.
 */
export async function updateOwnChannelDigestOptIn(
    userId: string,
    optIn: boolean,
): Promise<{ optIn: boolean }> {
    const updated = await prisma.user.update({
        where: { id: userId },
        data: { channelDigestOptIn: optIn },
        select: { channelDigestOptIn: true },
    });
    return { optIn: updated.channelDigestOptIn };
}
