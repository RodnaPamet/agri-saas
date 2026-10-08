/**
 * The 14-day PAST_DUE grace, and what it withholds (#1325).
 *
 * ## The one defect this file exists to catch
 *
 * Stripe fires `invoice.payment_failed` on EVERY smart retry, not once. A
 * webhook site writing `pastDueSince: new Date()` on each failure pushes the
 * deadline out roughly four times across the retry window, and the
 * restriction NEVER FIRES — a fourteen-day grace that silently lasts for
 * ever. Every "entering PAST_DUE sets the clock" test still passes, because
 * the defect is in the arm where the account is ALREADY past due. §2 is that
 * arm.
 *
 * ## And the one that would be worse on deploy day
 *
 * Every row that is already PAST_DUE gets `pastDueSince = NULL`, because the
 * column is new. Reading NULL as "the grace expired long ago" would restrict
 * every already-failing tenant on the first request after this ships, with
 * no warning and none of the fourteen days the owner ruled for. §1 pins NULL
 * as in-grace.
 */
import {
    PAST_DUE_GRACE_DAYS,
    PAST_DUE_GRACE_MS,
    RESTRICTED_CAPABILITIES,
    isCapabilityRestricted,
    pastDueStatusPatch,
    resolvePastDueState,
} from '@/lib/billing/past-due';

const T0 = new Date('2026-10-08T12:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

describe('§1 resolving the state', () => {
    it('an ACTIVE account is never restricted', () => {
        expect(resolvePastDueState({ status: 'ACTIVE', pastDueSince: null }, T0)).toMatchObject({
            restricted: false,
            inGrace: false,
        });
    });

    it('no billing row at all is never restricted', () => {
        // A SaaS tenant with no BillingAccount resolves to FREE elsewhere; it
        // has no failed payment, so it must not be swept up here.
        expect(resolvePastDueState(null, T0).restricted).toBe(false);
    });

    it('PAST_DUE inside the grace warns but does NOT restrict', () => {
        const s = resolvePastDueState({ status: 'PAST_DUE', pastDueSince: day(-6) }, T0);
        expect(s).toMatchObject({ restricted: false, inGrace: true });
        expect(s.daysRemaining).toBe(PAST_DUE_GRACE_DAYS - 6);
    });

    it('PAST_DUE past the grace restricts', () => {
        const s = resolvePastDueState({ status: 'PAST_DUE', pastDueSince: day(-15) }, T0);
        expect(s).toMatchObject({ restricted: true, inGrace: false, daysRemaining: 0 });
    });

    it('the boundary: exactly 14 days is restricted, a second under is not', () => {
        const since = new Date(T0.getTime() - PAST_DUE_GRACE_MS);
        expect(resolvePastDueState({ status: 'PAST_DUE', pastDueSince: since }, T0).restricted)
            .toBe(true);
        const oneSecondShort = new Date(since.getTime() + 1000);
        expect(resolvePastDueState({ status: 'PAST_DUE', pastDueSince: oneSecondShort }, T0)
            .restricted).toBe(false);
    });

    it('PAST_DUE with a NULL clock is IN-GRACE, never restricted', () => {
        // Deploy day. Every existing PAST_DUE row has NULL here. Reading it as
        // expired would restrict those tenants immediately and silently — the
        // exact opposite of a fourteen-day grace.
        const s = resolvePastDueState({ status: 'PAST_DUE', pastDueSince: null }, T0);
        expect(s.restricted).toBe(false);
        expect(s.inGrace).toBe(true);
    });

    it('CANCELED is not this mechanism', () => {
        // A cancelled subscription is downgraded to FREE by the webhook
        // (#1324). Treating it as past-due-restricted as well would apply two
        // different penalties for one state.
        expect(resolvePastDueState({ status: 'CANCELED', pastDueSince: day(-30) }, T0).restricted)
            .toBe(false);
    });
});

describe('§2 the clock survives a retry — the defect that would make this inert', () => {
    it('entering PAST_DUE stamps the clock', () => {
        expect(pastDueStatusPatch('ACTIVE', 'PAST_DUE', null, T0)).toEqual({
            status: 'PAST_DUE',
            pastDueSince: T0,
        });
    });

    it('a SECOND failure while already PAST_DUE keeps the ORIGINAL stamp', () => {
        // The assertion that matters. Stripe retries ~4 times over two weeks,
        // each firing `invoice.payment_failed`. Re-stamping here would move
        // the deadline every time and the grace would never expire.
        const original = day(-6);
        expect(pastDueStatusPatch('PAST_DUE', 'PAST_DUE', original, day(0))).toEqual({
            status: 'PAST_DUE',
            pastDueSince: original,
        });
    });

    it('…and four retries across the window still expire on schedule', () => {
        // The same property stated as the outcome, because the unit assertion
        // above can be satisfied while the composed behaviour is still wrong.
        let since: Date | null = null;
        let status: 'ACTIVE' | 'PAST_DUE' = 'ACTIVE';
        for (const d of [-14, -11, -8, -4]) {
            const patch = pastDueStatusPatch(status, 'PAST_DUE', since, day(d));
            status = 'PAST_DUE';
            since = patch.pastDueSince;
        }
        expect(resolvePastDueState({ status: 'PAST_DUE', pastDueSince: since }, T0).restricted)
            .toBe(true);
    });

    it('paying clears the clock, which is why no sweep is needed', () => {
        expect(pastDueStatusPatch('PAST_DUE', 'ACTIVE', day(-20), T0)).toEqual({
            status: 'ACTIVE',
            pastDueSince: null,
        });
        // And the predicate agrees on the very next request — no job, nothing
        // to race a `payment_succeeded` against.
        expect(resolvePastDueState({ status: 'ACTIVE', pastDueSince: null }, T0).restricted)
            .toBe(false);
    });

    it('a PAST_DUE row with a NULL clock stays NULL across a retry', () => {
        // It must not be handed a fresh fourteen days either — that would
        // reward a tenant for having failed before the column existed.
        expect(pastDueStatusPatch('PAST_DUE', 'PAST_DUE', null, T0).pastDueSince).toBeNull();
    });

    it('every non-PAST_DUE destination clears it', () => {
        for (const next of ['ACTIVE', 'CANCELED', 'INCOMPLETE', 'TRIALING'] as const) {
            expect(pastDueStatusPatch('PAST_DUE', next, day(-20), T0).pastDueSince).toBeNull();
        }
    });
});

describe('§3 the capability list is the owner’s ruling, not a downgrade', () => {
    it('all five fall together once the grace expires', () => {
        const expired = { status: 'PAST_DUE' as const, pastDueSince: day(-20) };
        for (const cap of RESTRICTED_CAPABILITIES) {
            expect(isCapabilityRestricted(expired, cap, T0)).toBe(true);
        }
        expect(RESTRICTED_CAPABILITIES).toHaveLength(5);
    });

    it('and none of them while in grace — the control', () => {
        // Without this, a predicate that returned true unconditionally would
        // satisfy every assertion above and restrict every paying tenant.
        const inGrace = { status: 'PAST_DUE' as const, pastDueSince: day(-3) };
        for (const cap of RESTRICTED_CAPABILITIES) {
            expect(isCapabilityRestricted(inGrace, cap, T0)).toBe(false);
        }
    });

    it('the list holds exactly what the owner named, and nothing else', () => {
        // Spelled out so widening it is a visible diff against a ruling
        // rather than an edit to an array. The owner's words were: hide the
        // exchange and trends, stop task creation, stop uploads (the map
        // stays), stop new journal entries (the journal stays readable).
        expect([...RESTRICTED_CAPABILITIES].sort()).toEqual([
            'exchange',
            'journal.create',
            'task.create',
            'trends',
            'upload',
        ]);
    });
});
