/**
 * The delivery decision for a person with NO FARM in scope — #2987.
 *
 * ## Why this is a sibling module and not two more lines in `resolve-delivery`
 *
 * That file is PURE on purpose, and says so: "It takes the preference, the
 * instant, and what the recipient holds, and returns channels. No database, no
 * clock, no Redis — so the test enumerates the grid instead of driving a queue
 * and hoping." Adding a read to it would cost exactly that property.
 *
 * So the DECISION stays there and this module only answers the two questions a
 * tenantless caller cannot: which preference applies to a person who has one
 * per farm, and what devices they hold across all of them.
 *
 * ## THE MOST RESTRICTIVE PREFERENCE WINS
 *
 * `UserNotificationPreference` is keyed `@@unique([userId, tenantId])`, so a
 * person in three farms has up to three rows and they may disagree. A
 * tenantless event belongs to none of those farms, so there is no "right" row
 * — the choice is a policy, and it is the strict one:
 *
 *     DISABLED  >  DAILY_DIGEST  >  IMMEDIATE
 *
 * Being wrong in the quiet direction costs a notification the person can still
 * find by opening the app. Being wrong the other way wakes somebody who
 * switched push off — in a farm, admittedly, but a person who has told this
 * product "do not push me" anywhere has said something it would be rude to
 * read narrowly.
 *
 * NO ROWS resolves to `null`, which `resolveDelivery` reads as IMMEDIATE, and
 * that is deliberate rather than inherited: the table has zero rows in
 * production, so "no row" is the state nearly every person is in, and treating
 * absence as DISABLED would silence the feature for everybody while looking
 * like it worked.
 *
 * ## Quiet hours are NOT per-person and are untouched here
 *
 * 22:00–06:00 `Europe/Sofia`, owner ruling 2026-10-21, deliberately not
 * configurable. `resolveDelivery` applies it, so a DM at 02:00 defers to
 * 06:00 exactly as a farm notification does — which is the half that made
 * wiring DMs to a push acceptable at all.
 *
 * ## The device count is DEDUPED, so the decision's figures match the sends
 *
 * `PushSubscription` is one row per (tenant, user, endpoint), so one physical
 * device registered in two farms is two rows. The transports dedupe before
 * sending (by `deviceToken` for APNs, by `endpoint` for Web Push), and this
 * count has to agree with them or `push.suppressed`'s reading would say two
 * devices where one was addressed. Zero-ness is unaffected either way, which
 * is why this is about the READING rather than about correctness.
 */
import { NotificationDelivery } from '@prisma/client';

import { runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { resolveDelivery, type DeliveryDecision } from './resolve-delivery';

/**
 * Strictness order, lowest first. Exported so the test asserts the ORDER
 * rather than restating it — a second copy is how the two come to disagree.
 */
export const DELIVERY_STRICTNESS: readonly NotificationDelivery[] = [
    NotificationDelivery.IMMEDIATE,
    NotificationDelivery.DAILY_DIGEST,
    NotificationDelivery.DISABLED,
];

/**
 * The strictest of the person's preferences, or null when they have none.
 *
 * PURE and exported, so the policy can be tested without a database — the one
 * part of this module that is a decision rather than a read.
 */
export function strictestPreference(
    rows: readonly { delivery: NotificationDelivery }[],
): NotificationDelivery | null {
    if (rows.length === 0) return null;
    let best = rows[0].delivery;
    for (const row of rows) {
        if (DELIVERY_STRICTNESS.indexOf(row.delivery) > DELIVERY_STRICTNESS.indexOf(best)) {
            best = row.delivery;
        }
    }
    return best;
}

/**
 * Read what a person holds, across every farm, and decide.
 *
 * Privileged under `person-push-devices` for the reason that reason records:
 * a tenantless event has no context to enter with, and `PushSubscription`'s
 * tenant-scoped registration route means a resolved-tenant read would miss a
 * device registered under a different farm. The bound is the `userId`.
 */
export async function resolvePersonDelivery(
    recipientUserId: string,
    now: Date,
): Promise<DeliveryDecision> {
    const { preference, devices, rowsRead, farmPreferences } = await runWithoutRls(
        { reason: 'person-push-devices' },
        async (db) => {
            const [prefs, subs] = await Promise.all([
                db.userNotificationPreference.findMany({
                    where: { userId: recipientUserId },
                    select: { delivery: true },
                }),
                db.pushSubscription.findMany({
                    where: { userId: recipientUserId },
                    select: { platform: true, deviceToken: true, endpoint: true },
                }),
            ]);

            // Deduped per transport's own identity — see the docblock. A row
            // with neither identifier is counted by neither: it cannot be sent
            // to, and counting it would make `no-devices` unreachable for a
            // person whose only row is malformed.
            const tokens = new Set<string>();
            const endpoints = new Set<string>();
            for (const s of subs) {
                if (s.platform === 'IOS' && s.deviceToken) tokens.add(s.deviceToken);
                if (s.platform === 'WEB' && s.endpoint) endpoints.add(s.endpoint);
            }

            return {
                preference: strictestPreference(prefs),
                devices: { web: endpoints.size, ios: tokens.size },
                // The DENOMINATOR beside the answer. Without it the dedupe is
                // unobservable — measured: a mutation that counted ROWS
                // instead of distinct identities left the whole suite green,
                // because the decision only reads zero-ness and each transport
                // is attempted once however many devices it has. So the
                // reading is the only consequence the dedupe has, and that
                // makes it worth logging rather than worth deleting: it is
                // what tells an operator "one device" when a person in three
                // farms registered the same phone twice.
                rowsRead: subs.length,
                farmPreferences: prefs.length,
            };
        },
    );

    logger.info('person-delivery.resolved', {
        component: 'person-delivery',
        // No userId: this line is about the DECISION, and a person-scoped log
        // naming the person is a log that identifies who was messaged.
        preference: preference ?? 'none',
        farmPreferences,
        devicesWeb: devices.web,
        devicesIos: devices.ios,
        rowsRead,
    });

    return resolveDelivery({ preference, now, devices });
}
