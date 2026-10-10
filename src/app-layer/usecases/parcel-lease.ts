/**
 * Parcel lease register (roadmap 2/3) — the land-use agreements (аренда/наем)
 * under which the tenant farms parcels it does not own. Tenant-scoped (RLS);
 * free-text fields are sanitised before persist. The lessor pre-fills from the
 * parcel's КАИС legal-entity owner in the UI, but is stored as free text here so
 * a non-cadastre lessor is equally recordable.
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, notFound } from '@/lib/errors/types';
import { canonicalRentUnit } from '@/lib/agro/rent-units';

export type LeaseKindInput = 'ARENDA' | 'NAEM';

export interface ParcelLeaseInput {
    lessorName: string;
    lessorEik?: string | null;
    kind: LeaseKindInput;
    rentAmount?: number | null;
    rentUnit?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    documentRef?: string | null;
    notes?: string | null;
}

const LEASE_SELECT = {
    id: true,
    parcelId: true,
    lessorName: true,
    lessorEik: true,
    kind: true,
    rentAmount: true,
    rentUnit: true,
    rentUnitRaw: true,
    startDate: true,
    endDate: true,
    documentRef: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.ParcelLeaseSelect;

/**
 * A recorded lease bound, or `null` when there genuinely is not one.
 *
 * The NaN fallback this used to carry is gone. It mapped an unparseable
 * string to `null` — and `null` is a legitimate value here, meaning "no end
 * date recorded" (`calendar.ts` says so). So a typo and an omission produced
 * the same row, with a 200, and `grain-net-worth.ts:1542`
 * (`OR: [{ endDate: null }, { endDate: { gte: new Date() } }]`) then counted
 * the lease as an active obligation indefinitely.
 *
 * `ParcelLeaseSchema` now refuses an unparseable bound at the boundary
 * (`requestTimestamp()`), so this function only ever sees an absent value or
 * a parseable one. `null` here now means exactly one thing (#1558).
 */
function toDate(v?: string | null): Date | null {
    return v ? new Date(v) : null;
}

/** Build the persist payload from validated input — sanitises every free text. */
function mapLeaseData(input: ParcelLeaseInput) {
    const lessorName = sanitizePlainText((input.lessorName ?? '').trim());
    if (!lessorName) throw badRequest('Lessor name is required.');
    const rawRentUnit = input.rentUnit ? sanitizePlainText(input.rentUnit.trim()) : null;
    return {
        lessorName,
        lessorEik: input.lessorEik ? sanitizePlainText(input.lessorEik.trim()) : null,
        kind: input.kind,
        rentAmount: input.rentAmount != null ? new Prisma.Decimal(input.rentAmount) : null,
        // The roll GROUPs BY rentUnit, so it stores the CANONICAL form; the
        // operator's original text is preserved verbatim alongside it.
        rentUnit: canonicalRentUnit(rawRentUnit),
        rentUnitRaw: rawRentUnit,
        startDate: toDate(input.startDate),
        endDate: toDate(input.endDate),
        documentRef: input.documentRef ? sanitizePlainText(input.documentRef.trim()) : null,
        notes: input.notes ? sanitizePlainText(input.notes.trim()) : null,
    };
}

/** Every (non-deleted) lease for a parcel, newest term first. */
export async function listParcelLeases(ctx: RequestContext, parcelId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.parcelLease.findMany({
            where: { parcelId, tenantId: ctx.tenantId, deletedAt: null },
            select: LEASE_SELECT,
            orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
            take: 100, // a parcel realistically carries a handful of leases
        }),
    );
}

/**
 * Every (non-deleted) lease across the tenant, with its parcel + location for
 * display on the Rent page. Optionally scoped to one location (the deep-link
 * from a location's overview). Newest term first.
 */
export async function listTenantLeases(
    ctx: RequestContext,
    opts: { locationId?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.parcelLease.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(opts.locationId ? { parcel: { locationId: opts.locationId } } : {}),
            },
            select: {
                ...LEASE_SELECT,
                parcel: {
                    select: {
                        id: true,
                        name: true,
                        areaHa: true,
                        location: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
            // A tenant's whole lease register — realistically hundreds, not
            // thousands; the [tenantId, endDate] index serves the orderBy.
            take: 500,
        }),
    );
}

/**
 * Lightweight parcel picker options for the Rent-page create modal — a lease is
 * parcel-bound, so the modal needs to choose one. Grouped by location name in
 * the Combobox via the returned locationName.
 */
export async function listTenantParcelOptions(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.parcel.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, location: { select: { id: true, name: true } } },
            orderBy: [{ name: 'asc' }],
            take: 5000,
        });
        return rows.map((p) => ({
            id: p.id,
            name: p.name,
            locationId: p.location.id,
            locationName: p.location.name,
        }));
    });
}

export async function createParcelLease(ctx: RequestContext, parcelId: string, input: ParcelLeaseInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const parcel = await db.parcel.findFirst({
            where: { id: parcelId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true },
        });
        if (!parcel) throw notFound('Parcel not found');
        const lease = await db.parcelLease.create({
            data: { tenantId: ctx.tenantId, parcelId, ...mapLeaseData(input) },
            select: LEASE_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PARCEL_LEASE_CREATED',
            entityType: 'ParcelLease',
            entityId: lease.id,
            details: `Recorded ${input.kind} lease for parcel ${parcel.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelLease',
                operation: 'created',
                summary: `Recorded a lease for ${parcel.name}`,
            },
        });
        return lease;
    });
}

export async function updateParcelLease(ctx: RequestContext, leaseId: string, input: ParcelLeaseInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelLease.findFirst({
            where: { id: leaseId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!existing) throw notFound('Lease not found');
        const lease = await db.parcelLease.update({
            where: { id: leaseId },
            data: mapLeaseData(input),
            select: LEASE_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PARCEL_LEASE_UPDATED',
            entityType: 'ParcelLease',
            entityId: leaseId,
            details: 'Updated a parcel lease',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelLease',
                operation: 'updated',
                summary: 'Updated a parcel lease',
            },
        });
        return lease;
    });
}

export async function deleteParcelLease(ctx: RequestContext, leaseId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.parcelLease.findFirst({
            where: { id: leaseId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!existing) throw notFound('Lease not found');
        await db.parcelLease.update({ where: { id: leaseId }, data: { deletedAt: new Date() } });
        await logEvent(db, ctx, {
            action: 'PARCEL_LEASE_DELETED',
            entityType: 'ParcelLease',
            entityId: leaseId,
            details: 'Removed a parcel lease',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ParcelLease',
                operation: 'deleted',
                summary: 'Removed a parcel lease',
            },
        });
        return { id: leaseId };
    });
}
