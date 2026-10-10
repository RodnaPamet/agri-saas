/**
 * Lease payments — rent actually SETTLED against a parcel lease, per season.
 *
 * The lease carries the obligation (rentAmount × decares); this carries what
 * was paid, so the rent roll answers "who hasn't been paid" rather than only
 * "what is owed". Tenant-scoped (RLS + an explicit tenantId on every query);
 * free text is sanitised before persist.
 *
 * The payment's `unit` defaults to the lease's canonical `rentUnit` — rent paid
 * in grain settles a grain obligation, never a money one, so the roll can keep
 * its per-unit books straight.
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { notFound } from '@/lib/errors/types';
import { canonicalRentUnit } from '@/lib/agro/rent-units';

export interface LeasePaymentInput {
    seasonYear: number;
    amountPaid: number;
    unit?: string | null;
    paidAt?: string | null;
    note?: string | null;
}

const PAYMENT_SELECT = {
    id: true,
    leaseId: true,
    seasonYear: true,
    amountPaid: true,
    unit: true,
    paidAt: true,
    note: true,
    createdAt: true,
} satisfies Prisma.LeasePaymentSelect;

/**
 * When a payment settled — now, if the caller did not say.
 *
 * Defaulting an ABSENT `paidAt` to now is intended: the panel records a
 * payment as it happens. Defaulting an UNPARSEABLE one to now was not, and
 * that is what this used to do — the same branch served both, so a typo
 * booked the payment as settled TODAY, returned 200, and nobody found out.
 * In a rent ledger the settlement date is the point of the row.
 *
 * `LeasePaymentSchema` now refuses an unparseable value at the boundary
 * (`requestTimestamp()`), so the only remaining case is the deliberate one
 * (#1558).
 */
function toDate(v?: string | null): Date {
    return v ? new Date(v) : new Date();
}

/** Every (non-deleted) payment on a lease, newest settlement first. */
export async function listLeasePayments(ctx: RequestContext, leaseId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.leasePayment.findMany({
            where: { leaseId, tenantId: ctx.tenantId, deletedAt: null },
            select: PAYMENT_SELECT,
            orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
            take: 200, // a lease settles a handful of times per season
        }),
    );
}

export async function recordLeasePayment(
    ctx: RequestContext,
    leaseId: string,
    input: LeasePaymentInput,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const lease = await db.parcelLease.findFirst({
            where: { id: leaseId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, lessorName: true, rentUnit: true },
        });
        if (!lease) throw notFound('Lease not found');

        // Default to the lease's own unit so a payment can't drift dimensionally.
        const unit = input.unit
            ? canonicalRentUnit(sanitizePlainText(input.unit.trim()))
            : lease.rentUnit;

        const payment = await db.leasePayment.create({
            data: {
                tenantId: ctx.tenantId,
                leaseId,
                seasonYear: input.seasonYear,
                amountPaid: new Prisma.Decimal(input.amountPaid),
                unit,
                paidAt: toDate(input.paidAt),
                note: input.note ? sanitizePlainText(input.note.trim()) : null,
            },
            select: PAYMENT_SELECT,
        });

        await logEvent(db, ctx, {
            action: 'LEASE_PAYMENT_RECORDED',
            entityType: 'LeasePayment',
            entityId: payment.id,
            details: `Recorded rent payment to ${lease.lessorName} for season ${input.seasonYear}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'LeasePayment',
                operation: 'created',
                summary: `Recorded a rent payment for season ${input.seasonYear}`,
            },
        });
        return payment;
    });
}

/** Soft-delete a payment (a mis-keyed settlement shouldn't skew the roll). */
export async function deleteLeasePayment(ctx: RequestContext, paymentId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.leasePayment.findFirst({
            where: { id: paymentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, seasonYear: true },
        });
        if (!existing) throw notFound('Payment not found');
        await db.leasePayment.update({
            where: { id: paymentId },
            data: { deletedAt: new Date() },
        });
        await logEvent(db, ctx, {
            action: 'LEASE_PAYMENT_DELETED',
            entityType: 'LeasePayment',
            entityId: paymentId,
            details: `Removed a rent payment for season ${existing.seasonYear}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'LeasePayment',
                operation: 'deleted',
                summary: 'Removed a rent payment',
            },
        });
        return { success: true };
    });
}
