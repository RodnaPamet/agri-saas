/**
 * `resolveDelivery` — P7.5 (#1994).
 *
 * The function is pure, so this enumerates the grid the issue asks for —
 * preference x inside/outside the window x devices — rather than driving a
 * queue. The mutation the issue names is a `resolveDelivery` that returns
 * every channel unconditionally; that is proved, along with five others.
 */
import { NotificationDelivery } from '@prisma/client';

import { resolveDelivery } from '@/app-layer/notifications/resolve-delivery';

/** Europe/Sofia is UTC+2 in November. */
const AWAKE = new Date(Date.UTC(2026, 10, 15, 10, 0, 0)); // 12:00 Sofia
const QUIET_EVENING = new Date(Date.UTC(2026, 10, 5, 21, 0, 0)); // 23:00 Sofia, the 5th
const QUIET_SMALL_HOURS = new Date(Date.UTC(2026, 10, 5, 23, 0, 0)); // 01:00 Sofia, the 6th

const BOTH = { web: 1, ios: 2 };
const NONE = { web: 0, ios: 0 };

describe('the in-app row is never refused', () => {
    it.each([
        ['disabled', NotificationDelivery.DISABLED, BOTH, AWAKE],
        ['digest', NotificationDelivery.DAILY_DIGEST, BOTH, AWAKE],
        ['quiet hours', NotificationDelivery.IMMEDIATE, BOTH, QUIET_EVENING],
        ['no devices', NotificationDelivery.IMMEDIATE, NONE, AWAKE],
        ['every refusal at once', NotificationDelivery.DISABLED, NONE, QUIET_EVENING],
    ])('inApp stays true — %s', (_n, preference, devices, now) => {
        // Quiet means "do not push", not "do not record". A function able to
        // refuse this could lose a notification entirely, since the bell is
        // how somebody finds out about anything they were not interrupted for.
        expect(resolveDelivery({ preference, now, devices }).inApp).toBe(true);
    });
});

describe('preferences', () => {
    it('a null preference means IMMEDIATE, not DISABLED', () => {
        // `UserNotificationPreference` has zero rows in production, so "no
        // row" is the state nearly every user is in. Treating absence as
        // DISABLED would silence the product for everybody while looking like
        // a working feature.
        const d = resolveDelivery({ preference: null, now: AWAKE, devices: BOTH });

        expect(d.webPush).toBe(true);
        expect(d.apns).toBe(true);
        expect(d.suppressedBecause).toBeNull();
    });

    it('DISABLED sends nothing and defers nothing', () => {
        const d = resolveDelivery({
            preference: NotificationDelivery.DISABLED,
            now: QUIET_EVENING,
            devices: BOTH,
        });

        expect(d.webPush).toBe(false);
        expect(d.apns).toBe(false);
        // Not deferred: a 06:00 summary for somebody who turned push off would
        // be the push they turned off, delivered late.
        expect(d.deferral).toBeNull();
        expect(d.suppressedBecause).toBe('preference-disabled');
    });

    it('DAILY_DIGEST sends nothing and defers nothing — the digest IS the delivery', () => {
        const d = resolveDelivery({
            preference: NotificationDelivery.DAILY_DIGEST,
            now: QUIET_EVENING,
            devices: BOTH,
        });

        expect(d.webPush).toBe(false);
        expect(d.apns).toBe(false);
        expect(d.deferral).toBeNull();
        expect(d.suppressedBecause).toBe('digest-only');
    });

    it('reports DISABLED rather than quiet-hours when both apply', () => {
        // Order matters: reporting "quiet-hours" here would tell an operator
        // the push is coming at 06:00 when it is never coming at all.
        const d = resolveDelivery({
            preference: NotificationDelivery.DISABLED,
            now: QUIET_SMALL_HOURS,
            devices: BOTH,
        });

        expect(d.suppressedBecause).toBe('preference-disabled');
    });
});

describe('devices', () => {
    it('asks only for channels the person can actually receive', () => {
        const webOnly = resolveDelivery({ preference: null, now: AWAKE, devices: { web: 1, ios: 0 } });
        const iosOnly = resolveDelivery({ preference: null, now: AWAKE, devices: { web: 0, ios: 3 } });

        expect(webOnly).toMatchObject({ webPush: true, apns: false });
        expect(iosOnly).toMatchObject({ webPush: false, apns: true });
    });

    it('no devices is reported as such, and NOT deferred', () => {
        // Checked before quiet hours on purpose: a person with no devices
        // would otherwise accumulate a summary job every night for pushes
        // that could never have been sent.
        const d = resolveDelivery({ preference: null, now: QUIET_EVENING, devices: NONE });

        expect(d.deferral).toBeNull();
        expect(d.suppressedBecause).toBe('no-devices');
    });
});

describe('quiet hours', () => {
    it('withholds push and schedules the window end', () => {
        const d = resolveDelivery({ preference: null, now: QUIET_EVENING, devices: BOTH });

        expect(d.webPush).toBe(false);
        expect(d.apns).toBe(false);
        expect(d.suppressedBecause).toBe('quiet-hours');
        expect(d.deferral).not.toBeNull();
        expect(d.deferral!.at.getTime()).toBeGreaterThan(QUIET_EVENING.getTime());
    });

    it('gives one night ONE key, from either side of midnight', () => {
        // The property that keeps a night to a single summary job. Without it
        // the job id differs across midnight and the person gets two 06:00
        // summaries for one night.
        const evening = resolveDelivery({ preference: null, now: QUIET_EVENING, devices: BOTH });
        const smallHours = resolveDelivery({ preference: null, now: QUIET_SMALL_HOURS, devices: BOTH });

        expect(evening.deferral!.nightKey).toBe('2026-11-05');
        expect(smallHours.deferral!.nightKey).toBe('2026-11-05');
        // And the same deadline, so the second notification of the night does
        // not move the first one's delivery.
        expect(evening.deferral!.at.getTime()).toBe(smallHours.deferral!.at.getTime());
    });

    it('does not defer outside the window — the control', () => {
        // Without this, an implementation that always deferred would satisfy
        // every assertion above.
        const d = resolveDelivery({ preference: null, now: AWAKE, devices: BOTH });

        expect(d.deferral).toBeNull();
        expect(d.webPush).toBe(true);
        expect(d.apns).toBe(true);
    });
});

describe('the grid', () => {
    it('every combination resolves, and push is refused more often than granted', () => {
        const prefs = [null, NotificationDelivery.IMMEDIATE, NotificationDelivery.DAILY_DIGEST, NotificationDelivery.DISABLED];
        const times = [AWAKE, QUIET_EVENING, QUIET_SMALL_HOURS];
        const deviceSets = [BOTH, { web: 1, ios: 0 }, { web: 0, ios: 1 }, NONE];

        let pushed = 0;
        let total = 0;
        for (const preference of prefs) {
            for (const now of times) {
                for (const devices of deviceSets) {
                    const d = resolveDelivery({ preference, now, devices });
                    total += 1;
                    if (d.webPush || d.apns) pushed += 1;
                    // Invariants that must hold for EVERY cell, which is the
                    // point of walking the grid rather than sampling it.
                    expect(d.inApp).toBe(true);
                    // A deferral and a push are mutually exclusive: both would
                    // mean the person is interrupted now AND summarised later.
                    if (d.deferral !== null) expect(d.webPush || d.apns).toBe(false);
                    // Anything that pushed has no reason recorded, and
                    // anything that did not has one. Neither direction may be
                    // silent.
                    if (d.webPush || d.apns) expect(d.suppressedBecause).toBeNull();
                    else expect(d.suppressedBecause).not.toBeNull();
                }
            }
        }

        console.log(`[resolve-delivery] ${total} cells, push granted in ${pushed}`);
        expect(total).toBe(48);
        // 2 permissive prefs x 1 awake hour x 3 device sets with a device = 6.
        expect(pushed).toBe(6);
    });
});
