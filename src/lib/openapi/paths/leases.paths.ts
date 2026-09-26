/**
 * Аренда / наем — the land-tenancy register and what has been paid against it.
 *
 * A lease is PARCEL-BOUND, and that shapes the whole surface: the tenant-wide
 * create carries `parcelId` in the BODY (the Rent page picks it in a combobox),
 * while the parcel-scoped route carries it in the path. Same lease, two entry
 * points, different placement — documented because guessing wrong is a 400.
 *
 * ── the unit is the correctness problem here, not a detail ──
 *
 * Rent in Bulgaria is settled EITHER in money OR in grain („кг/дка"), and
 * `rentUnit` says which. A payment's `unit` defaults to the lease's own
 * canonical unit precisely so that grain rent is never booked against a money
 * obligation — the two are not convertible and summing them produces a number
 * that means nothing.
 *
 * `rentUnit` is the CANONICAL form and `rentUnitRaw` is what was actually typed
 * or imported. Both travel: the canonical one is what arithmetic may use, the
 * raw one is what a person recognises and what an audit trail needs.
 *
 * ── the money fields are decimal strings ──
 *
 * `rentAmount` and `amountPaid` are Prisma Decimals, so they arrive as STRINGS
 * while the write side takes numbers. Same asymmetry as grain and planning.
 */
import { z } from '@/lib/openapi/zod';
import {
    ParcelLeaseSchema,
    TenantLeaseCreateSchema,
    LeasePaymentSchema,
} from '@/app-layer/schemas/lease.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const LeaseParams = TenantParams.extend({
    leaseId: z.string().openapi({ param: { name: 'leaseId', in: 'path' } }),
});
const PaymentParams = LeaseParams.extend({
    paymentId: z.string().openapi({ param: { name: 'paymentId', in: 'path' } }),
});

const LeaseSchema = z
    .object({
        id: z.string(),
        parcelId: z.string(),
        lessorName: z.string(),
        /** Bulgarian legal-entity id. Null for an individual lessor. */
        lessorEik: z.string().nullable(),
        /** ARENDA (a lease) or NAEM (a rental) — different legal instruments. */
        kind: z.enum(['ARENDA', 'NAEM']),
        /** Decimal -> STRING on the wire; the write side takes a number. */
        rentAmount: z.string().nullable(),
        /**
         * CANONICAL unit. This is what decides whether the obligation is money
         * or grain, and therefore what a payment may be booked against.
         */
        rentUnit: z.string().nullable(),
        /** What was actually typed or imported, before canonicalisation. */
        rentUnitRaw: z.string().nullable(),
        startDate: z.string().nullable(),
        endDate: z.string().nullable(),
        documentRef: z.string().nullable(),
        notes: z.string().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
    })
    .openapi('ParcelLease', {
        description:
            'One tenancy over one parcel. rentUnit is canonical and decides whether the obligation is settled in MONEY or in GRAIN — the two are not convertible, so a client must never sum across them. rentUnitRaw preserves what a person actually wrote.',
    });

const LeasePaymentRowSchema = z
    .object({
        id: z.string(),
        leaseId: z.string(),
        /** The season the payment settles, not the date it was made. */
        seasonYear: z.number(),
        amountPaid: z.string(),
        /** Defaults to the LEASE's canonical unit when omitted on write. */
        unit: z.string().nullable(),
        paidAt: z.string().nullable(),
        note: z.string().nullable(),
        createdAt: z.string().datetime(),
    })
    .openapi('LeasePayment', {
        description:
            'Rent PAID against a lease for one season. `unit` defaults to the lease’s canonical rent unit, which is what stops grain rent being booked against a money obligation. seasonYear is the season settled, which is not necessarily the year in paidAt.',
    });

export function registerLeasePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/leases',
        operationId: 'listTenantLeases',
        summary: 'The tenant’s leases',
        description: 'Every tenancy the tenant holds, each carrying its parcel and that parcel’s location.',
        tags: ['Leases'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The leases.',
            schema: z.array(
                LeaseSchema.extend({
                    parcel: z
                        .object({
                            id: z.string(),
                            name: z.string(),
                            location: z.object({ id: z.string(), name: z.string() }).nullable(),
                        })
                        .optional(),
                }),
            ),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/leases',
        operationId: 'createTenantLease',
        summary: 'Register a lease',
        description:
            'The tenant-wide entry point: `parcelId` travels in the BODY here, because the Rent page picks the parcel in a combobox. The parcel-scoped route takes it as a path parameter instead.',
        tags: ['Leases'],
        params: TenantParams,
        body: TenantLeaseCreateSchema,
        success: { status: 200, description: 'The created lease.', schema: LeaseSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/leases/parcel-options',
        operationId: 'listLeaseParcelOptions',
        summary: 'Parcels a lease can be registered against',
        description:
            'The combobox source for the create form — id, name and the parcel’s location, nothing more. Not a parcel read: it exists so the picker does not have to load the full parcel surface.',
        tags: ['Leases'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The options.',
            schema: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    location: z.object({ id: z.string(), name: z.string() }).nullable(),
                }),
            ),
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/leases/{leaseId}',
        operationId: 'updateParcelLease',
        summary: 'Update a lease',
        description:
            'The body is the same shape as a create MINUS the parcel: a lease cannot be moved to another parcel by editing it.',
        tags: ['Leases'],
        params: LeaseParams,
        body: ParcelLeaseSchema,
        success: { status: 200, description: 'The updated lease.', schema: LeaseSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/leases/{leaseId}',
        operationId: 'deleteParcelLease',
        summary: 'Delete a lease',
        description: 'Answers with the id only.',
        tags: ['Leases'],
        params: LeaseParams,
        success: {
            status: 200,
            description: 'Deleted.',
            schema: z.object({ id: z.string() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/leases/{leaseId}/payments',
        operationId: 'listLeasePayments',
        summary: 'Payments against a lease',
        tags: ['Leases'],
        params: LeaseParams,
        success: {
            status: 200,
            description: 'The payments.',
            schema: z.array(LeasePaymentRowSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/leases/{leaseId}/payments',
        operationId: 'recordLeasePayment',
        summary: 'Record a rent payment',
        description:
            'OMIT `unit` to book against the lease’s own canonical rent unit, which is the safe default: rent settled in grain must never be recorded against a money obligation, and the two cannot be summed.',
        tags: ['Leases'],
        params: LeaseParams,
        body: LeasePaymentSchema,
        success: { status: 200, description: 'The recorded payment.', schema: LeasePaymentRowSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/leases/{leaseId}/payments/{paymentId}',
        operationId: 'deleteLeasePayment',
        summary: 'Delete a rent payment',
        tags: ['Leases'],
        params: PaymentParams,
        success: {
            status: 200,
            description: 'Acknowledged.',
            schema: z.object({ success: z.boolean() }),
        },
    });
}
