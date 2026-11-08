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
import { badRequest, codedBadRequest, codedNotFound } from '@/lib/errors/types';
import {
    canonicalRentUnit,
    isMoneyRentUnit,
    isRecordedMoneyRentUnit,
    MONEY_RENT_UNIT_CURRENCY,
    RENT_MONEY_CURRENCY,
    RENT_UNIT_EUR,
} from '@/lib/agro/rent-units';

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

/**
 * Refuse a money rent unit this product cannot report (#2793).
 *
 * The payload's `rentUnit` is `z.string().max(20)` free text, so nothing in
 * the schema can carry this rule — and until #2793 nothing needed to: a
 * `лв/дка` lease was accepted and `resolveRentBasis` converted it at the
 * legally fixed 1.95583 peg. The peg is gone (owner ruling 2026-11-08), so a
 * lev-priced lease now has no honest per-hectare figure anywhere in the
 * product. Refusing it at the WRITE is what keeps that from being a surprise
 * later: the alternative is a lease that saves, lists, and is then excluded
 * from every cost figure with the operator never told why.
 *
 * The ORDER matters and is the reason this landed before the peg came out.
 * Removing the division without this refusal would report 500 лв/ha as
 * 500 €/ha — a silent 96% overstatement — which is strictly worse than either
 * converting or refusing.
 *
 * Only MONEY units are judged. `кг/дка` is a mass with no currency, and an
 * unrecognised unit is already preserved verbatim in `rentUnitRaw` and
 * reported `resolved: false` by `rent-basis.ts`; refusing either here would
 * narrow the field far beyond the currency question.
 *
 * Exported for `lease-payment.ts`, which applies the same rule to a SUPPLIED
 * payment unit. One function rather than two spellings — a payment accepted in
 * a unit the lease could not have been written in is the drift to avoid.
 *
 * `stored` is the lease's OWN unit on an update, and passing it is what keeps
 * a legacy row EDITABLE. This mirrors `COST_ENTRY_LEGACY_CURRENCY_LOCKED`
 * exactly, including the part that is easy to leave out: restating a row's own
 * value verbatim is not a change, and refusing it would block an operator
 * correcting the LESSOR'S NAME on a lease recorded before the peg came out.
 * The form posts every field, so an unrelated edit resubmits the stored unit —
 * which is why this has to be a comparison and not a flat check.
 */
export function assertRecordableRentUnit(
    canonical: string | null,
    raw: string | null,
    stored?: string | null,
): void {
    if (!isMoneyRentUnit(canonical) || isRecordedMoneyRentUnit(canonical)) return;
    if (stored != null && canonical === stored) return;
    throw codedBadRequest(
        'LEASE_RENT_UNIT_NOT_EUR',
        `Money rent is recorded in ${RENT_MONEY_CURRENCY}. Enter the rent as ${RENT_UNIT_EUR}.`,
        {
            unit: raw ?? canonical,
            currency: MONEY_RENT_UNIT_CURRENCY[canonical as string],
            expected: RENT_UNIT_EUR,
        },
    );
}

/**
 * Build the persist payload from validated input — sanitises every free text.
 *
 * `storedRentUnit` is the row's current unit on an UPDATE and absent on a
 * CREATE; see `assertRecordableRentUnit` for why that distinction exists.
 */
function mapLeaseData(input: ParcelLeaseInput, storedRentUnit?: string | null) {
    const lessorName = sanitizePlainText((input.lessorName ?? '').trim());
    if (!lessorName) throw badRequest('Lessor name is required.');
    const rawRentUnit = input.rentUnit ? sanitizePlainText(input.rentUnit.trim()) : null;
    const canonicalRent = canonicalRentUnit(rawRentUnit);
    assertRecordableRentUnit(canonicalRent, rawRentUnit, storedRentUnit);
    return {
        lessorName,
        lessorEik: input.lessorEik ? sanitizePlainText(input.lessorEik.trim()) : null,
        kind: input.kind,
        rentAmount: input.rentAmount != null ? new Prisma.Decimal(input.rentAmount) : null,
        // The roll GROUPs BY rentUnit, so it stores the CANONICAL form; the
        // operator's original text is preserved verbatim alongside it.
        rentUnit: canonicalRent,
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
            // `name, id` — total, not merely mostly-stable (#1742).
            //
            // `ParcelRepository.listSummariesByIds` documents this rule and
            // calls it contractual; this sibling read did not follow it.
            // Parcel names are NOT unique, and Postgres gives no stability
            // guarantee for rows that tie, so two reads could return
            // duplicate-named parcels in either order.
            //
            // The `take: 5000` below is what makes it more than cosmetic: with
            // a non-total order, WHICH 5000 rows come back is unstable too, so
            // a parcel near the cap can be present in one read and absent in
            // the next with nothing having changed.
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
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
        if (!parcel) throw codedNotFound('PARCEL_NOT_FOUND', 'Parcel not found');
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
            // `rentUnit` is read for the #2793 refusal, not for the update
            // itself: a row already quoted in `лв/дка` keeps editing with its
            // own unit restated, and only a CHANGE to an unrecordable unit is
            // refused.
            select: { id: true, rentUnit: true },
        });
        if (!existing) throw codedNotFound('LEASE_NOT_FOUND', 'That lease was not found.');
        const lease = await db.parcelLease.update({
            where: { id: leaseId },
            data: mapLeaseData(input, existing.rentUnit),
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
        if (!existing) throw codedNotFound('LEASE_NOT_FOUND', 'That lease was not found.');
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
