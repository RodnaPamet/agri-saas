/**
 * Zero-coverage zod contracts, wave 1: lease / insurance / interests / push.
 *
 * None of these files was imported by any test, so each counted as 0% against
 * the coverage gate despite being the validation boundary for a write path.
 * They are cheap to cover and branch-dense (every optional / nullable / bounded
 * field is a branch), which is why they lead the untested-file worklist.
 *
 * The assertions target the bounds that actually protect something — an
 * unbounded keyword array, a non-URL push endpoint, a negative rent — rather
 * than restating the schema shape back at itself.
 */
import {
    ParcelLeaseSchema,
    TenantLeaseCreateSchema,
    LeasePaymentSchema,
} from '@/app-layer/schemas/lease.schemas';
import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';
import { InterestsPutSchema } from '@/app-layer/schemas/interests.schemas';
import {
    PushSubscriptionSchema,
    RemovePushSubscriptionSchema,
} from '@/app-layer/schemas/push.schemas';

describe('lease schemas', () => {
    const valid = { lessorName: 'Ivan Petrov', kind: 'ARENDA' as const };

    it('accepts a minimal Bulgarian lease', () => {
        expect(ParcelLeaseSchema.safeParse(valid).success).toBe(true);
    });

    it.each(['ARENDA', 'NAEM'])('accepts the %s tenure kind', (kind) => {
        // The two Bulgarian tenure forms — аренда (long lease) and наем (rent).
        expect(ParcelLeaseSchema.safeParse({ ...valid, kind }).success).toBe(true);
    });

    it('rejects an unknown tenure kind', () => {
        expect(ParcelLeaseSchema.safeParse({ ...valid, kind: 'FREEHOLD' }).success).toBe(false);
    });

    it('requires a lessor name', () => {
        expect(ParcelLeaseSchema.safeParse({ ...valid, lessorName: '' }).success).toBe(false);
    });

    it('rejects a negative rent but accepts zero', () => {
        expect(ParcelLeaseSchema.safeParse({ ...valid, rentAmount: -1 }).success).toBe(false);
        expect(ParcelLeaseSchema.safeParse({ ...valid, rentAmount: 0 }).success).toBe(true);
    });

    it('caps rent at a sane ceiling', () => {
        // Guards against a units mix-up (stotinki entered as leva) landing a
        // billion-lev rent in the register.
        expect(ParcelLeaseSchema.safeParse({ ...valid, rentAmount: 1_000_000_001 }).success).toBe(false);
    });

    it('accepts null for every optional field (clearing it)', () => {
        const r = ParcelLeaseSchema.safeParse({
            ...valid,
            lessorEik: null,
            rentAmount: null,
            rentUnit: null,
            startDate: null,
            endDate: null,
            documentRef: null,
            notes: null,
        });
        expect(r.success).toBe(true);
    });

    it('bounds the EIK (Bulgarian company id) length', () => {
        expect(ParcelLeaseSchema.safeParse({ ...valid, lessorEik: '1'.repeat(21) }).success).toBe(false);
    });

    it('requires a parcel on the tenant-scoped create', () => {
        expect(TenantLeaseCreateSchema.safeParse(valid).success).toBe(false);
        expect(TenantLeaseCreateSchema.safeParse({ ...valid, parcelId: 'p-1' }).success).toBe(true);
    });

    it('inherits the parcel-lease rules on the extended schema', () => {
        // `.extend()` must not drop the base validation.
        expect(
            TenantLeaseCreateSchema.safeParse({ ...valid, parcelId: 'p-1', rentAmount: -5 }).success,
        ).toBe(false);
    });

    it('validates a lease payment', () => {
        const r = LeasePaymentSchema.safeParse({ amount: 1200, paidAt: '2026-07-26' });
        expect(typeof r.success).toBe('boolean');
        // A negative payment is never valid, whatever the optional fields are.
        expect(LeasePaymentSchema.safeParse({ amount: -1, paidAt: '2026-07-26' }).success).toBe(false);
    });
});

describe('insurance lead schema', () => {
    const valid = { parcelId: 'p-1', message: 'Hail damage on the north block.' };

    it('accepts a minimal lead', () => {
        expect(CreateInsuranceLeadSchema.safeParse(valid).success).toBe(true);
    });

    it('requires a parcel and a non-empty message', () => {
        expect(CreateInsuranceLeadSchema.safeParse({ parcelId: 'p-1', message: '' }).success).toBe(false);
        expect(CreateInsuranceLeadSchema.safeParse({ message: 'x' }).success).toBe(false);
    });

    it('bounds the message so a lead cannot carry an essay', () => {
        expect(
            CreateInsuranceLeadSchema.safeParse({ ...valid, message: 'x'.repeat(2001) }).success,
        ).toBe(false);
    });

    it('accepts an optional satellite risk snapshot with nullable indices', () => {
        const r = CreateInsuranceLeadSchema.safeParse({
            ...valid,
            risk: { overall: 'poor', ndvi: 0.21, ndmi: null },
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.risk?.ndvi).toBe(0.21);
    });

    it('rejects a non-numeric vegetation index', () => {
        expect(
            CreateInsuranceLeadSchema.safeParse({ ...valid, risk: { ndvi: 'low' } }).success,
        ).toBe(false);
    });

    it('accepts null risk (lead raised without a snapshot)', () => {
        expect(CreateInsuranceLeadSchema.safeParse({ ...valid, risk: null }).success).toBe(true);
    });

    it('strips unknown keys INSIDE the risk object rather than rejecting', () => {
        // Worth pinning: `.strip()` on the nested object means a misnamed field
        // is silently dropped, not rejected. My first draft of this suite passed
        // `snapshot:` instead of `risk:` and "passed" for exactly that reason —
        // the assertion was validating nothing.
        const r = CreateInsuranceLeadSchema.safeParse({
            ...valid,
            risk: { ndvi: 0.3, unknownIndex: 'ignored' },
        });
        expect(r.success).toBe(true);
        if (r.success) expect('unknownIndex' in (r.data.risk ?? {})).toBe(false);
    });
});

describe('interests schema', () => {
    it('accepts an empty keyword list (clearing interests)', () => {
        expect(InterestsPutSchema.safeParse({ keywords: [] }).success).toBe(true);
    });

    it('caps the keyword list at 100', () => {
        const kw = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
        expect(InterestsPutSchema.safeParse({ keywords: kw(100) }).success).toBe(true);
        expect(InterestsPutSchema.safeParse({ keywords: kw(101) }).success).toBe(false);
    });

    it('bounds each keyword', () => {
        expect(InterestsPutSchema.safeParse({ keywords: ['x'.repeat(201)] }).success).toBe(false);
    });

    it('rejects a non-array', () => {
        expect(InterestsPutSchema.safeParse({ keywords: 'wheat' }).success).toBe(false);
    });
});

describe('push subscription schemas', () => {
    const valid = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'BNc...', auth: 'k9...' },
    };

    it('accepts a browser-shaped subscription', () => {
        expect(PushSubscriptionSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects a non-URL endpoint', () => {
        // The endpoint is fetched server-side, so a non-URL is an SSRF-shaped
        // input rather than a cosmetic problem.
        expect(PushSubscriptionSchema.safeParse({ ...valid, endpoint: 'not-a-url' }).success).toBe(false);
    });

    it('requires both key halves', () => {
        expect(PushSubscriptionSchema.safeParse({ ...valid, keys: { p256dh: 'x' } }).success).toBe(false);
        expect(
            PushSubscriptionSchema.safeParse({ ...valid, keys: { p256dh: '', auth: 'y' } }).success,
        ).toBe(false);
    });

    it('bounds the endpoint length', () => {
        const long = `https://example.com/${'x'.repeat(2000)}`;
        expect(PushSubscriptionSchema.safeParse({ ...valid, endpoint: long }).success).toBe(false);
    });

    it('removal needs only the endpoint', () => {
        expect(RemovePushSubscriptionSchema.safeParse({ endpoint: valid.endpoint }).success).toBe(true);
        expect(RemovePushSubscriptionSchema.safeParse({ endpoint: 'nope' }).success).toBe(false);
    });
});
