import { z } from 'zod';

import { requestTimestamp } from '@/lib/schemas/timestamp';

/**
 * Parcel-lease (аренда/наем) create/update payload. Dates stay DELIBERATELY
 * loose — a day (`2026-10-08`) or a full instant, because a lease term is
 * recorded as days in a contract, not as a timestamp. `requestTimestamp()` is
 * the validator for exactly that: it accepts either and refuses only what
 * cannot be parsed at all.
 *
 * It is there because the usecase could not tell a typo from an omission.
 * `parcel-lease.ts`'s `toDate` mapped an unparseable string to `null`, and
 * `null` is a LEGITIMATE value here — `calendar.ts` records that "a lease can
 * be recorded without one". So a malformed `endDate` became
 * indistinguishable from an open-ended lease, with a 200 and no warning.
 *
 * That is not cosmetic: `grain-net-worth.ts:1542` selects active leases with
 *
 *     OR: [{ endDate: null }, { endDate: { gte: new Date() } }]
 *
 * so a fixed-term lease whose end date failed to parse is counted as an
 * active obligation forever, in a money figure. #1558.
 *
 * The `.max(40)` bound is kept and is NOT redundant: a long string is not
 * automatically unparseable (`'Wednesday, October 08, 2026 14:00:00 GMT+0300
 * (Eastern European Summer Time)'` is 76 characters and parses fine), and the
 * published request body declares `maxLength: 40`. Dropping it would make the
 * server accept what the contract forbids.
 */
export const ParcelLeaseSchema = z.object({
    lessorName: z.string().min(1).max(200),
    lessorEik: z.string().max(20).nullable().optional(),
    kind: z.enum(['ARENDA', 'NAEM']),
    rentAmount: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
    rentUnit: z.string().max(20).nullable().optional(),
    startDate: requestTimestamp().max(40).nullable().optional(),
    endDate: requestTimestamp().max(40).nullable().optional(),
    documentRef: z.string().max(120).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
});

export type ParcelLeaseBody = z.infer<typeof ParcelLeaseSchema>;

/**
 * Tenant-wide create payload for the Rent page — a lease is parcel-bound, so the
 * parcel is chosen in the modal (a Combobox) and travels in the body rather than
 * the URL path (the parcel-scoped route carries it as a path param instead).
 */
export const TenantLeaseCreateSchema = ParcelLeaseSchema.extend({
    parcelId: z.string().min(1).max(60),
});

export type TenantLeaseCreateBody = z.infer<typeof TenantLeaseCreateSchema>;

/**
 * Rent PAID against a lease for one season. The unit is optional and defaults
 * to the lease's own canonical rent unit — rent settled in grain („кг/дка")
 * must never be booked against a money obligation.
 */
export const LeasePaymentSchema = z.object({
    seasonYear: z.number().int().min(1900).max(2200),
    amountPaid: z.number().nonnegative().max(1_000_000_000),
    unit: z.string().max(20).nullable().optional(),
    paidAt: requestTimestamp().max(40).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
});

export type LeasePaymentBody = z.infer<typeof LeasePaymentSchema>;
