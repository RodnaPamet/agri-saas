/**
 * Lease dates refuse what cannot be parsed, instead of inventing a value
 * (#1558).
 *
 * ## Why this is not just another "rejects garbage" suite
 *
 * The two usecases behind these fields did not 500 on a malformed date. They
 * each substituted something plausible and returned 200:
 *
 *     lease-payment.ts   unparseable -> new Date()   the payment settled TODAY
 *     parcel-lease.ts    unparseable -> null         the lease has no end date
 *
 * Both substitutions are legitimate for an ABSENT value — a payment recorded
 * now, a lease with no recorded term — and the same branch served both cases,
 * so a typo was indistinguishable from an omission.
 *
 * The second one reaches money. `grain-net-worth.ts:1542` selects active
 * leases with `OR: [{ endDate: null }, { endDate: { gte: new Date() } }]`, so
 * a fixed-term lease whose `endDate` failed to parse counts as an active
 * obligation indefinitely.
 *
 * So the assertions below come in pairs: the schema refuses the input, AND the
 * substitution it would have produced is shown to be a real, reachable value
 * rather than an obviously-wrong sentinel. Without the second half, "rejects
 * 'abcd'" reads as ordinary input hygiene and the reason for the change is
 * lost.
 */
import { ParcelLeaseSchema, LeasePaymentSchema } from '@/app-layer/schemas/lease.schemas';

const lease = (over: Record<string, unknown> = {}) => ({
    lessorName: 'Иван Петров',
    kind: 'ARENDA' as const,
    ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
    seasonYear: 2026,
    amountPaid: 1200,
    ...over,
});

describe('lease dates reject unparseable input (#1558)', () => {
    it('the valid shapes still parse — the positive control', () => {
        // Without this, every rejection below could be a schema broken outright.
        expect(ParcelLeaseSchema.safeParse(lease()).success).toBe(true);
        expect(
            ParcelLeaseSchema.safeParse(lease({ startDate: '2026-10-08', endDate: '2027-09-30' }))
                .success,
        ).toBe(true);
        expect(LeasePaymentSchema.safeParse(payment()).success).toBe(true);
        expect(LeasePaymentSchema.safeParse(payment({ paidAt: '2026-10-08' })).success).toBe(true);
    });

    describe('a day AND an instant are both accepted — these are day-typed fields', () => {
        // The schema's own docblock says a lease term is days in a contract.
        // `instantTimestamp()` would be the wrong validator here, and these
        // assertions are what stop someone "tightening" this into it.
        it.each([
            ['a bare day', '2026-10-08'],
            ['a UTC instant', '2026-10-08T00:00:00.000Z'],
            ['an explicit offset', '2026-10-08T03:00:00+03:00'],
        ])('%s', (_label, value) => {
            expect(ParcelLeaseSchema.safeParse(lease({ endDate: value })).success).toBe(true);
            expect(LeasePaymentSchema.safeParse(payment({ paidAt: value })).success).toBe(true);
        });
    });

    describe('null and absent stay available — they MEAN something here', () => {
        // The whole defect was that the fallback made malformed input look
        // like these. They have to keep working, or the fix traded one wrong
        // behaviour for another.
        it('an omitted bound is fine', () => {
            expect(ParcelLeaseSchema.safeParse(lease()).success).toBe(true);
        });

        it('an explicit null end date is fine — an open-ended lease', () => {
            expect(ParcelLeaseSchema.safeParse(lease({ endDate: null })).success).toBe(true);
        });

        it('an omitted paidAt is fine — it defaults to now in the usecase', () => {
            expect(LeasePaymentSchema.safeParse(payment()).success).toBe(true);
        });
    });

    describe('unparseable input is REFUSED, and what it used to become', () => {
        it.each(['abcd', 'not-a-date', '2026-13-45', 'yesterday', '   ', '30/09/2027'])(
            '%p is refused on endDate and paidAt',
            (bad) => {
                expect(ParcelLeaseSchema.safeParse(lease({ endDate: bad })).success).toBe(false);
                expect(LeasePaymentSchema.safeParse(payment({ paidAt: bad })).success).toBe(false);
            },
        );

        it('it really was an Invalid Date, so the old branches really did fire', () => {
            // The premise of the whole change, asserted rather than described.
            for (const bad of ['abcd', '2026-13-45', '30/09/2027']) {
                expect(new Date(bad).getTime()).toBeNaN();
            }
        });

        it('and null endDate is treated as ACTIVE, which is why null was the wrong answer', () => {
            // Mirrors `grain-net-worth.ts:1542`'s predicate. A lease whose end
            // date silently became null satisfies the first arm forever.
            const activeNow = (endDate: Date | null) =>
                endDate === null || endDate >= new Date();
            expect(activeNow(null)).toBe(true);
            expect(activeNow(new Date('2020-01-01'))).toBe(false);
        });
    });

    describe('the length bound survives the refinement chain', () => {
        // `.max(40)` after `.refine()` works in zod 4 — verified, because in
        // zod 3 it would not have been chainable. It is also NOT redundant: a
        // long string is not automatically unparseable, and the published
        // request body declares `maxLength: 40`, so dropping it would accept
        // what the contract forbids.
        const LONG = 'Wednesday, October 08, 2026 14:00:00 GMT+0300 (Eastern European Summer Time)';

        it('a long-but-parseable date is refused by the bound', () => {
            expect(LONG.length).toBeGreaterThan(40);
            expect(Number.isNaN(new Date(LONG).getTime())).toBe(false);
            expect(ParcelLeaseSchema.safeParse(lease({ endDate: LONG })).success).toBe(false);
            expect(LeasePaymentSchema.safeParse(payment({ paidAt: LONG })).success).toBe(false);
        });
    });
});
