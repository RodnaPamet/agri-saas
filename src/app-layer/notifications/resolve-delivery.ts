/**
 * The ONE place that decides which channels a notification uses — P7.5 (#1994).
 *
 * ## Why one function
 *
 * The word is the requirement. A delivery decision made wherever a
 * notification is created means three channels decided independently by three
 * producers, and that is how somebody gets woken at 03:00 on one device having
 * muted another. Everything that delivers calls this; nothing else decides.
 *
 * ## Pure, and that is what makes it testable
 *
 * It takes the preference, the instant, and what the recipient holds, and
 * returns channels. No database, no clock, no Redis — so the test enumerates
 * the grid (muted/unmuted x inside/outside the window x devices/none) instead
 * of driving a queue and hoping. The issue's own argument for extracting it
 * rather than threading the logic through the push worker.
 *
 * ## The three inputs, and what each resolves to
 *
 * **Preferences** — `UserNotificationPreference.delivery`, which already
 * existed with exactly this shape (`IMMEDIATE` / `DAILY_DIGEST` / `DISABLED`
 * per user and tenant), carried an RLS policy, and had never been read: zero
 * references in `src/` and zero rows in production. So this adopts it rather
 * than adding a parallel table.
 *
 * **Quiet hours** — 22:00–06:00 `Europe/Sofia`, from ADR 0002 OD18. That row
 * is headed "Push for DMs", which left its scope open; the owner ruled on
 * 2026-10-21 that it covers ALL push and is not per-user configurable. See
 * `quiet-hours.ts` for why the window is a union rather than a range and why
 * 06:00 is resolved in the zone rather than by adding eight hours.
 *
 * **Cross-device dedup** — one DELIVERY per event per person, not one per
 * device. The fan-out across a person's devices is each transport's own
 * business (both filter by `platform` and iterate rows); what this prevents is
 * the in-app row, a web push and an APNs push being counted as three
 * deliveries and so three chances to decide differently.
 *
 * ## Quiet means "do not push", never "do not record"
 *
 * `inApp` is unconditional. The row is written by the producer before this is
 * consulted, and the bell is how a person finds out about anything they were
 * not interrupted for — so a function that could suppress it would be able to
 * lose a notification entirely. The only thing quiet hours moves is the
 * interruption.
 */
import { NotificationDelivery } from '@prisma/client';

import { isQuietHours, quietNightKey, quietWindowEnd } from '@/lib/notifications/quiet-hours';

/** What the recipient can be reached on, as counted by the caller. */
export interface RecipientDevices {
    /** `PushSubscription` rows with `platform = 'WEB'`. */
    web: number;
    /** `PushSubscription` rows with `platform = 'IOS'` and a device token. */
    ios: number;
}

export interface DeliveryDecision {
    /** Always true. See the docblock — the row is not a channel this may refuse. */
    inApp: true;
    /** Send Web Push now. */
    webPush: boolean;
    /** Send APNs now. */
    apns: boolean;
    /**
     * Set when push was withheld by quiet hours and should be summarised when
     * the window ends. Null whenever push went out, or when there was no push
     * to withhold.
     */
    deferral: {
        /** The instant the window ends — when the summary is due. */
        at: Date;
        /**
         * `YYYY-MM-DD` of the EVENING the window opened, so one night is one
         * summary. 23:00 on the 5th and 01:00 on the 6th share this.
         */
        nightKey: string;
    } | null;
    /** Why push was not sent, for the caller to log. Null when it was. */
    suppressedBecause: 'preference-disabled' | 'digest-only' | 'quiet-hours' | 'no-devices' | null;
}

export interface ResolveDeliveryInput {
    /**
     * The recipient's preference, or null when they have never set one.
     *
     * Null means IMMEDIATE, deliberately: `UserNotificationPreference` has
     * zero rows in production, so "no row" is the state almost every user is
     * in, and treating absence as DISABLED would silence the product for
     * everybody while looking like a working feature.
     */
    preference: NotificationDelivery | null;
    /** When the decision is being made. Passed in so the function stays pure. */
    now: Date;
    devices: RecipientDevices;
}

/**
 * Decide the channels for one notification to one person.
 *
 * Order matters and is not arbitrary: the cheapest and most absolute refusals
 * come first, so a DISABLED preference is never reported as "quiet hours" —
 * which would tell an operator the push is coming at 06:00 when it is never
 * coming at all.
 */
export function resolveDelivery(input: ResolveDeliveryInput): DeliveryDecision {
    const { preference, now, devices } = input;
    const none = { inApp: true, webPush: false, apns: false, deferral: null } as const;

    // 1. The person turned push off. Nothing to defer and nothing to summarise.
    if (preference === NotificationDelivery.DISABLED) {
        return { ...none, suppressedBecause: 'preference-disabled' };
    }

    // 2. They asked for a daily digest, which `notification-dispatch` sends at
    //    07:00. A push would be the interruption the digest exists to replace,
    //    so it is not deferred to 06:00 either — the digest IS the delivery.
    if (preference === NotificationDelivery.DAILY_DIGEST) {
        return { ...none, suppressedBecause: 'digest-only' };
    }

    // 3. Nothing to push to. Checked BEFORE quiet hours so a person with no
    //    devices does not accumulate summary jobs for pushes that could never
    //    have been sent — the 06:00 job would find nothing to tell them about
    //    and would have cost a Redis entry per night to discover that.
    if (devices.web === 0 && devices.ios === 0) {
        return { ...none, suppressedBecause: 'no-devices' };
    }

    // 4. Inside the window: withhold the interruption, record which night.
    if (isQuietHours(now)) {
        const nightKey = quietNightKey(now);
        // `quietNightKey` returns null only outside the window, which
        // `isQuietHours` has just excluded. The check is here because a
        // non-null assertion would be the one line that silently becomes a
        // crash if either predicate's definition drifts from the other's.
        if (nightKey !== null) {
            return {
                ...none,
                deferral: { at: quietWindowEnd(now), nightKey },
                suppressedBecause: 'quiet-hours',
            };
        }
    }

    // 5. Awake, opted in, reachable. Each transport still filters its own rows,
    //    so asking for a channel with no devices is harmless — but it is asked
    //    for only when a device of that kind exists, so a log line saying
    //    "attempted 2" means two were genuinely possible.
    return {
        inApp: true,
        webPush: devices.web > 0,
        apns: devices.ios > 0,
        deferral: null,
        suppressedBecause: null,
    };
}
