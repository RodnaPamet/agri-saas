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
 * `{ optIn: boolean }`, and THE KEY IS REQUIRED — which is the whole control.
 *
 * A misspelled key is what this guards against. `{ optin: true }` would, under
 * an optional or defaulted field, parse to `{}`, read `undefined`, write
 * `false` and answer 200 — so the person is told their opt-in was saved and
 * then never hears anything. That is the worst available outcome for a
 * notification setting, because an opt-in that silently means "off" produces
 * exactly the observable of a working feature nobody has enabled.
 *
 * Requiring the key is SUFFICIENT for that, because zod strips unknown keys:
 * `{ optin: true }` becomes `{}` and fails as missing. This was `.strict()`
 * first, on the stated reasoning that strictness is what catches the
 * misspelling — and a mutation proved otherwise: removing `.strict()` left
 * every case green, because the refusal was always coming from the required
 * key. So the claim was true and its mechanism was not.
 *
 * It is now deliberately NOT strict, and that is a forward-compatibility
 * choice rather than laziness. An unknown key is IGNORED, so a newer client
 * that starts sending `{ optIn, source }` keeps working against an older
 * server — the same posture `bottom-tabs` takes toward tab ids it has never
 * heard of, for the same reason: the web and native release cycles are not
 * coupled, and a 400 on a field the server merely does not know about turns
 * an additive client change into an outage.
 */
export const ChannelDigestOptInSchema = z.object({
    optIn: z.boolean(),
});

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
