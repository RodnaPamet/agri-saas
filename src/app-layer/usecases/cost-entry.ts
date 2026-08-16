import { Prisma, type CostAllocationBasis, type CostCategory } from '@prisma/client';
import { withDeleted } from '@/lib/soft-delete';
import { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { CostEntryRepository, type CostEntryFilters } from '../repositories/CostEntryRepository';
import { FileRepository } from '../repositories/FileRepository';
import { ingestUploadedFile } from '@/lib/upload/ingest';
import { COST_DOMAIN_LINKS, COST_SPATIAL_LINKS } from '../schemas/grain.schemas';
import type { CreateCostEntryInput, UpdateCostEntryInput } from '../schemas/grain.schemas';

/**
 * Cost entries — the register behind `/grain/costs` (enterprise-grain,
 * GRAIN module).
 *
 * `/grain/costs` used to be a read-only rollup of
 * `COST_METRICS.ATTRIBUTED_CROP_COST`. The grain net-worth calculator now
 * reports that figure as part of a larger answer, so this became the place
 * a cost is ENTERED — one form for every kind of spend rather than a
 * farmer hunting for which of five surfaces owns it.
 *
 * ── What this module does NOT do ────────────────────────────────────
 *
 * It never mints a `StockTransaction`. That ledger is hash-chained and
 * append-only (an `IMMUTABLE_STOCK_LEDGER` trigger blocks UPDATE and
 * DELETE), it requires `lotId`/`unitId`/`quantityDelta` — a product and a
 * quantity this form does not collect — and its `costAmount` is a MOVEMENT
 * TOTAL rather than a rate. A mistyped cost minted into it could never be
 * corrected, only reversed, and would relink every subsequent hash in the
 * tenant. Domain pages READ the entries that link to them instead.
 *
 * It also never decides what a cost MEANS to a total. Which categories
 * reach crop cost and which reach cash-out is `cost-metrics.ts`'s
 * business, applied by the calculator — see `CostCategory`'s enum
 * docblock. This module stores what the farmer typed.
 *
 * Shape mirrors `payroll-expense.ts`: authorize before data access,
 * sanitize free text before persisting, `amount` stays a PLAINTEXT Decimal
 * so it can be SUMmed in-DB, a hash-chained audit event on EVERY mutation,
 * and all DB access through `runInTenantContext` with bounded `take:`.
 */

const LIST_TAKE = 500;

/** Prisma Decimal | null → plain number | null. */
function dec(v: Prisma.Decimal | number | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

function parseRequiredDate(value: string, label: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label} must be a valid date`);
    return d;
}

/**
 * At most ONE domain link, and `leaseId` only on a RENT entry.
 *
 * Both halves matter for the same reason: a cost that claims two homes is
 * shown on two pages and summed twice by anything that groups per domain.
 * The lease rule is narrower — a lease link on a FUEL entry would put a
 * diesel invoice on the rent surface, where it would read as rent.
 *
 * Prisma cannot express either constraint, so this is the only thing
 * standing between a caller and a row that breaks both pages. It is
 * asserted by an executing test, not merely by this comment.
 */
export function assertSingleDomainLink(input: {
    category?: CostCategory | string;
    plantingId?: string | null;
    seasonId?: string | null;
    locationId?: string | null;
    parcelId?: string | null;
    leaseId?: string | null;
    itemId?: string | null;
}): void {
    const set = COST_DOMAIN_LINKS.filter((k) => input[k] != null);
    if (set.length > 1) {
        throw badRequest(
            `A cost entry may link to at most one of ${COST_DOMAIN_LINKS.join(', ')} — got ${set.join(', ')}`,
        );
    }
    if (input.leaseId != null && input.category !== 'RENT') {
        throw badRequest('leaseId may only be set on a RENT cost entry');
    }
}

/**
 * The allocation basis and its chosen parcels have to agree with each
 * other, and with the entry's spatial links.
 *
 * Three rules, each closing a way for the stored row to say one thing and
 * the calculator to do another:
 *
 *   • A non-TARGET basis cannot also carry a spatial link. The basis has
 *     already answered "where does this sit"; the allocator reads it and
 *     ignores the link, so accepting both stores an instruction that never
 *     runs. The farmer would see a parcel on the costs page and a
 *     holding-wide spread on the calculator with nothing saying which won.
 *   • PARCEL_SUBSET needs at least TWO distinct parcels. A subset of one
 *     is a `parcelId` link with extra steps, and a subset of none is not a
 *     denominator at all — the calculator would have nothing to spread
 *     over and would report the cost unattributed.
 *   • Any other basis must carry NO chosen parcels. Rows left behind by a
 *     basis change are the classic stale-denominator bug: invisible on
 *     every screen, and instantly load-bearing again the moment someone
 *     switches back to PARCEL_SUBSET.
 *
 * Prisma can express none of them, so — like `assertSingleDomainLink` —
 * this is the only thing standing between a caller and a contradictory
 * row, and it is asserted by an executing test rather than by this
 * comment.
 */
export function assertAllocationBasis(input: {
    allocationBasis?: CostAllocationBasis | string | null;
    allocationParcelIds?: readonly string[] | null;
    plantingId?: string | null;
    parcelId?: string | null;
    locationId?: string | null;
    /** Accepted and IGNORED — see `COST_SPATIAL_LINKS`. Neither names a place. */
    seasonId?: string | null;
    itemId?: string | null;
    leaseId?: string | null;
}): void {
    const basis = input.allocationBasis ?? 'TARGET';
    const chosen = input.allocationParcelIds ?? [];

    if (basis !== 'TARGET') {
        const spatial = COST_SPATIAL_LINKS.filter((k) => input[k] != null);
        if (spatial.length > 0) {
            throw badRequest(
                `A ${basis} cost entry spreads across land of its own, so it cannot also link to ${spatial.join(', ')}`,
            );
        }
    }

    if (basis === 'PARCEL_SUBSET') {
        const distinct = new Set(chosen);
        if (distinct.size < 2) {
            throw badRequest(
                'A PARCEL_SUBSET cost entry must choose at least two distinct parcels — one parcel is a parcelId link',
            );
        }
    } else if (chosen.length > 0) {
        throw badRequest(`allocationParcelIds may only be set on a PARCEL_SUBSET cost entry`);
    }
}

/**
 * An invoice must be a file that actually finished uploading and still
 * exists, in THIS tenant.
 *
 * All three checks are load-bearing, and the obvious precedent to copy —
 * `attachLogEntryFile` in journal.ts — has only the first. A `FileRecord`
 * is created `PENDING` before the bytes are confirmed, so a row pointing
 * at a PENDING record claims an invoice that may never have landed;
 * `deletedAt` is set by the evidence-maintenance sweep, so a cost entry
 * can outlive its own document. The complete gate is the one
 * `audit-pack-sharepoint-export.ts` uses.
 */
export async function assertUsableInvoice(
    db: PrismaTx,
    ctx: RequestContext,
    invoiceFileId: string,
): Promise<void> {
    // `withDeleted` for the same reason as the evidence download gate:
    // FileRecord is soft-deletable, so without it the extension injects
    // `deletedAt: null`, the row returns NULL, and the caller gets the
    // generic "not found" instead of the specific "has been deleted" —
    // making the `file.deletedAt != null` branch below unreachable.
    const file = await db.fileRecord.findFirst(withDeleted({
        where: { id: invoiceFileId, tenantId: ctx.tenantId },
        select: { id: true, status: true, deletedAt: true },
    }));
    if (!file) throw badRequest('Invoice file not found or belongs to a different tenant');
    if (file.status !== 'STORED') {
        throw badRequest('Invoice file upload has not completed');
    }
    if (file.deletedAt != null) throw badRequest('Invoice file has been deleted');
}

function toDto(row: {
    id: string;
    category: CostCategory;
    amount: Prisma.Decimal | number;
    currency: string;
    incurredOn: Date;
    supplier: string | null;
    invoiceFileId: string | null;
    plantingId: string | null;
    seasonId: string | null;
    locationId: string | null;
    parcelId: string | null;
    leaseId: string | null;
    itemId: string | null;
    allocationBasis?: CostAllocationBasis;
    allocationParcels?: { parcelId: string }[];
    createdByUserId: string | null;
    description?: string | null;
    createdAt: Date;
    updatedAt: Date;
    planting?: { id: string; successionNumber: number; cropPlan?: { name: string | null } | null } | null;
    season?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    parcel?: { id: string; name: string } | null;
    item?: { id: string; name: string; category: string } | null;
    invoiceFile?: {
        id: string;
        originalName: string;
        mimeType: string;
        sizeBytes: number;
    } | null;
}) {
    return {
        id: row.id,
        category: row.category,
        amount: dec(row.amount) ?? 0,
        currency: row.currency,
        incurredOn: row.incurredOn,
        supplier: row.supplier,
        invoiceFileId: row.invoiceFileId,
        plantingId: row.plantingId,
        seasonId: row.seasonId,
        locationId: row.locationId,
        parcelId: row.parcelId,
        leaseId: row.leaseId,
        itemId: row.itemId,
        allocationBasis: row.allocationBasis ?? 'TARGET',
        // Flattened to ids: the join row's own id is bookkeeping, and the
        // form that prefills from this only ever means "which parcels".
        // Sorted so a payload cannot change because a query planner did.
        allocationParcelIds: (row.allocationParcels ?? []).map((p) => p.parcelId).sort(),
        createdByUserId: row.createdByUserId,
        // Present only on a single-record read — the list projection omits
        // it entirely, so `undefined` means "not sent here" rather than
        // `null`'s "this row has no description".
        ...(row.description !== undefined ? { description: row.description } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        planting: row.planting ?? null,
        season: row.season ?? null,
        location: row.location ?? null,
        parcel: row.parcel ?? null,
        item: row.item ?? null,
        invoiceFile: row.invoiceFile ?? null,
    };
}

export async function listCostEntries(
    ctx: RequestContext,
    filters: CostEntryFilters = {},
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    const take = opts.take ?? LIST_TAKE;

    return runInTenantContext(ctx, async (db) => {
        const rows = await CostEntryRepository.list(db, ctx, filters, take);

        // Only count when the page came back FULL — in the ordinary case
        // the page length IS the total and the count query is skipped. A
        // silent cap is how a truncated page comes to read as a total.
        const truncated = rows.length === take;
        const totalCount = truncated
            ? await CostEntryRepository.count(db, ctx, filters)
            : rows.length;

        return { rows: rows.map(toDto), totalCount, truncated };
    });
}

export async function getCostEntry(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, async (db) => {
        const record = await CostEntryRepository.getById(db, ctx, id);
        if (!record) throw notFound('Cost entry not found');
        return record;
    });
    return toDto(row);
}

/** Validate the optional domain FKs belong to THIS tenant before writing. */
async function assertFksBelongToTenant(
    db: PrismaTx,
    ctx: RequestContext,
    input: {
        plantingId?: string | null;
        seasonId?: string | null;
        locationId?: string | null;
        parcelId?: string | null;
        leaseId?: string | null;
        itemId?: string | null;
        allocationParcelIds?: readonly string[] | null;
    },
): Promise<void> {
    if (input.allocationParcelIds?.length) {
        // ONE batched read for the whole subset. A `findFirst` per chosen
        // parcel is what D1 bans, and 200 of them would be 200 round trips
        // before a single row is written. Counting DISTINCT ids rather
        // than the array length so a duplicated id cannot mask a missing
        // one by making the counts agree.
        const wanted = [...new Set(input.allocationParcelIds)];
        const found = await db.parcel.findMany({
            where: { id: { in: wanted }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
            take: wanted.length,
        });
        if (found.length !== wanted.length) {
            throw badRequest(
                'One or more chosen parcels were not found or belong to a different tenant',
            );
        }
    }
    if (input.plantingId) {
        const row = await db.planting.findFirst({
            where: { id: input.plantingId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Planting not found or belongs to a different tenant');
    }
    if (input.seasonId) {
        const row = await db.season.findFirst({
            where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Season not found or belongs to a different tenant');
    }
    if (input.locationId) {
        const row = await db.location.findFirst({
            where: { id: input.locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Location not found or belongs to a different tenant');
    }
    if (input.parcelId) {
        const row = await db.parcel.findFirst({
            where: { id: input.parcelId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Parcel not found or belongs to a different tenant');
    }
    if (input.leaseId) {
        const row = await db.parcelLease.findFirst({
            where: { id: input.leaseId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Lease not found or belongs to a different tenant');
    }
    if (input.itemId) {
        const row = await db.item.findFirst({
            where: { id: input.itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!row) throw badRequest('Item not found or belongs to a different tenant');
    }
}

export async function createCostEntry(ctx: RequestContext, input: CreateCostEntryInput) {
    assertCanWrite(ctx);

    assertSingleDomainLink(input);
    assertAllocationBasis(input);
    const supplier = input.supplier != null ? sanitizePlainText(input.supplier) : null;
    const description = input.description != null ? sanitizePlainText(input.description) : null;
    const incurredOn = parseRequiredDate(input.incurredOn, 'Incurred-on date');
    const currency = input.currency.trim().toUpperCase();

    const row = await runInTenantContext(ctx, async (db) => {
        await assertFksBelongToTenant(db, ctx, input);
        if (input.invoiceFileId) await assertUsableInvoice(db, ctx, input.invoiceFileId);

        const record = await CostEntryRepository.create(db, ctx, {
            category: input.category,
            amount: input.amount,
            currency,
            incurredOn,
            supplier,
            description,
            invoiceFileId: input.invoiceFileId ?? null,
            plantingId: input.plantingId ?? null,
            seasonId: input.seasonId ?? null,
            locationId: input.locationId ?? null,
            parcelId: input.parcelId ?? null,
            leaseId: input.leaseId ?? null,
            itemId: input.itemId ?? null,
            allocationBasis: input.allocationBasis ?? 'TARGET',
            createdByUserId: ctx.userId ?? null,
        });

        // Inside the same transaction as the entry: a subset written after
        // a committed row could fail and leave a PARCEL_SUBSET entry with
        // no denominator, which the calculator would report unattributed.
        if (input.allocationParcelIds?.length) {
            await CostEntryRepository.replaceAllocationParcels(
                db,
                ctx,
                record.id,
                [...new Set(input.allocationParcelIds)],
            );
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'CostEntry',
            entityId: record.id,
            details: `Recorded ${input.category} cost: ${input.amount} ${currency}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'created',
                after: {
                    costCategory: input.category,
                    amount: input.amount,
                    currency,
                    hasInvoice: input.invoiceFileId != null,
                    // WHERE a cost spreads decides which crop carries it,
                    // so a change of basis is a change of money and
                    // belongs in the trail beside the amount.
                    allocationBasis: input.allocationBasis ?? 'TARGET',
                    allocationParcelCount: input.allocationParcelIds?.length ?? 0,
                },
                summary: `Recorded a ${input.category} cost of ${input.amount} ${currency}`,
            },
        });

        // The create's own `include` ran before the subset rows existed,
        // so the response would claim an empty denominator. One extra
        // read, on the subset path only.
        if (input.allocationParcelIds?.length) {
            return (await CostEntryRepository.getById(db, ctx, record.id)) ?? record;
        }
        return record;
    });

    return toDto(row);
}

export async function updateCostEntry(
    ctx: RequestContext,
    id: string,
    input: UpdateCostEntryInput,
) {
    assertCanWrite(ctx);

    const data: Prisma.CostEntryUncheckedUpdateInput = {};
    if (input.category !== undefined) data.category = input.category;
    if (input.amount !== undefined) data.amount = input.amount;
    if (input.currency !== undefined) data.currency = input.currency.trim().toUpperCase();
    if (input.incurredOn !== undefined) {
        data.incurredOn = parseRequiredDate(input.incurredOn, 'Incurred-on date');
    }
    if (input.supplier !== undefined) {
        data.supplier = input.supplier != null ? sanitizePlainText(input.supplier) : null;
    }
    if (input.description !== undefined) {
        data.description = input.description != null ? sanitizePlainText(input.description) : null;
    }
    for (const key of ['invoiceFileId', ...COST_DOMAIN_LINKS] as const) {
        if (input[key] !== undefined) data[key] = input[key] ?? null;
    }
    if (input.allocationBasis !== undefined) data.allocationBasis = input.allocationBasis;

    const row = await runInTenantContext(ctx, async (db) => {
        const existing = await CostEntryRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Cost entry not found');

        // Validate the RESULTING row, not the patch: clearing one link
        // while setting another is legal, and checking the patch alone
        // would let a second link survive from the existing row.
        assertSingleDomainLink({
            category: input.category ?? existing.category,
            plantingId: input.plantingId !== undefined ? input.plantingId : existing.plantingId,
            seasonId: input.seasonId !== undefined ? input.seasonId : existing.seasonId,
            locationId: input.locationId !== undefined ? input.locationId : existing.locationId,
            parcelId: input.parcelId !== undefined ? input.parcelId : existing.parcelId,
            leaseId: input.leaseId !== undefined ? input.leaseId : existing.leaseId,
            itemId: input.itemId !== undefined ? input.itemId : existing.itemId,
        });

        // Same "validate the RESULTING row" rule, and it matters more
        // here: switching an entry to HOLDING while it still carries a
        // parcelId from before, or away from PARCEL_SUBSET while its
        // chosen parcels stay behind, are both states the patch alone
        // cannot see.
        const resultingBasis = input.allocationBasis ?? existing.allocationBasis;
        const resultingParcelIds =
            input.allocationParcelIds !== undefined
                ? input.allocationParcelIds
                : existing.allocationParcels.map((p) => p.parcelId);
        assertAllocationBasis({
            allocationBasis: resultingBasis,
            allocationParcelIds: resultingParcelIds,
            plantingId: input.plantingId !== undefined ? input.plantingId : existing.plantingId,
            parcelId: input.parcelId !== undefined ? input.parcelId : existing.parcelId,
            locationId: input.locationId !== undefined ? input.locationId : existing.locationId,
        });

        await assertFksBelongToTenant(db, ctx, input);
        if (input.invoiceFileId) await assertUsableInvoice(db, ctx, input.invoiceFileId);

        const record = await CostEntryRepository.update(db, ctx, id, data);

        // Rewritten whenever the resulting subset differs from what is
        // stored — including the clear-on-basis-change case, where the
        // caller sends no ids at all and the rows left behind would be an
        // invisible denominator waiting to come back to life.
        const storedParcelIds = existing.allocationParcels.map((p) => p.parcelId).sort();
        const nextParcelIds = [...new Set(resultingParcelIds)].sort();
        const subsetChanged =
            storedParcelIds.length !== nextParcelIds.length ||
            storedParcelIds.some((v, i) => v !== nextParcelIds[i]);
        if (subsetChanged) {
            await CostEntryRepository.replaceAllocationParcels(db, ctx, id, nextParcelIds);
        }

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'CostEntry',
            entityId: id,
            details: `Updated cost entry ${id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'updated',
                changedFields: [...Object.keys(data), ...(subsetChanged ? ['allocationParcels'] : [])],
                summary: `Updated a cost entry`,
            },
        });

        // As on create: `update`'s own `include` ran before the subset was
        // rewritten, so the response would echo the OLD denominator.
        if (subsetChanged) {
            return (await CostEntryRepository.getById(db, ctx, id)) ?? record;
        }
        return record;
    });

    return toDto(row);
}

export async function deleteCostEntry(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await CostEntryRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Cost entry not found');

        await CostEntryRepository.softDelete(db, ctx, id);

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'CostEntry',
            entityId: id,
            details: `Deleted cost entry ${id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'deleted',
                summary: `Deleted a cost entry`,
            },
        });

        return { id };
    });
}

/**
 * The cost entries attached to a SET of domain records, as a map keyed by
 * that domain's id.
 *
 * This is the seam every domain surface uses — rent on the lease page,
 * input costs on the product page, per-planting costs on the planting.
 * They REFLECT the register; none of them writes into it, and none writes
 * into its own ledger on a cost entry's behalf.
 *
 * ── Why a map, and why one query ────────────────────────────────────
 *
 * The caller has N domain rows on screen and wants each row's costs. The
 * obvious shape — ask per row — is exactly what the D1 guardrail bans: a
 * lease list of 200 would issue 200 queries. One batched `IN` read plus an
 * in-memory group is the same answer at one round trip, and `take` keeps
 * it bounded (D2 has zero headroom).
 *
 * Ids with no entries are ABSENT from the map rather than present with an
 * empty array — a caller writing `map.get(id) ?? []` gets the right
 * answer either way, and the absence keeps the payload proportional to
 * what actually exists.
 */
export async function listCostEntriesForDomain(
    ctx: RequestContext,
    link: 'plantingId' | 'seasonId' | 'locationId' | 'parcelId' | 'leaseId' | 'itemId',
    ids: readonly string[],
    opts: { take?: number } = {},
): Promise<Map<string, ReturnType<typeof toDomainDto>[]>> {
    assertCanRead(ctx);
    if (ids.length === 0) return new Map();

    const rows = await runInTenantContext(ctx, (db) =>
        CostEntryRepository.listByDomainIds(db, ctx, link, ids, opts.take ?? LIST_TAKE),
    );

    const out = new Map<string, ReturnType<typeof toDomainDto>[]>();
    for (const row of rows) {
        const key = row[link];
        if (key == null) continue; // the IN filter guarantees this, defensively.
        const bucket = out.get(key);
        if (bucket) bucket.push(toDomainDto(row));
        else out.set(key, [toDomainDto(row)]);
    }
    return out;
}

/**
 * The projection a domain page needs: enough to render a line and open
 * the entry, and nothing more. `description` is absent — it is encrypted
 * at rest and its only renderer is the write-gated edit form, so
 * broadcasting it onto every domain page would decrypt it into readers'
 * payloads for no one's benefit.
 */
function toDomainDto(row: {
    id: string;
    category: CostCategory;
    amount: Prisma.Decimal | number;
    currency: string;
    incurredOn: Date;
    supplier: string | null;
    invoiceFileId: string | null;
}) {
    return {
        id: row.id,
        category: row.category,
        amount: dec(row.amount) ?? 0,
        currency: row.currency,
        incurredOn: row.incurredOn,
        supplier: row.supplier,
        hasInvoice: row.invoiceFileId != null,
    };
}

/** The storage `domain` invoices are filed under. */
const INVOICE_DOMAIN = 'cost-invoice';

/**
 * Upload an invoice and attach it to a cost entry.
 *
 * ── Why this reproduces the pipeline instead of calling an endpoint ──
 *
 * There is no generic "upload bytes, get a FileRecord id" route in this
 * repo — every multipart route mints its `FileRecord` inline as part of
 * an entity-specific write. So "reuse the existing path" means reusing
 * the SHAPE: allowlist the client's claim cheaply, write the bytes,
 * reconcile the MIME against the actual signature, scan, then
 * `createPending` + `markStored` inside one transaction. `markStored` is
 * the only writer of `STORED` in the codebase, and leaving a record
 * PENDING is a trap — nothing else advances that state.
 *
 * ── No SHA-256 dedup here, deliberately ─────────────────────────────
 *
 * The evidence path dedups identical uploads onto one `FileRecord`. That
 * is right for evidence and wrong for invoices: the surviving record
 * keeps the FIRST uploader's `originalName`, so a second cost entry
 * uploading the same PDF would display someone else's filename against
 * its own invoice. An invoice's filename is part of how a farmer
 * recognises it. Two entries with the same document get two records.
 */
export async function uploadCostInvoice(
    ctx: RequestContext,
    costEntryId: string,
    file: File,
) {
    assertCanWrite(ctx);

    // Validate → key → buffer → sniff → write → scan, once, in
    // `@/lib/upload/ingest`. What stays here is the part that is genuinely
    // per-entity: minting the FileRecord inside the same transaction as the
    // CostEntry update, so a dropped connection cannot leave an invoice
    // stored and attached to nothing.
    const ingested = await ingestUploadedFile(ctx.tenantId, file, {
        domain: INVOICE_DOMAIN,
        fallbackName: 'invoice',
        component: 'cost-entry',
    });

    return runInTenantContext(ctx, async (db) => {
        const entry = await CostEntryRepository.getById(db, ctx, costEntryId);
        if (!entry) throw notFound('Cost entry not found');

        const fileRecord = await FileRepository.createPending(db, ctx, {
            pathKey: ingested.pathKey,
            originalName: ingested.originalName,
            mimeType: ingested.mimeType,
            sizeBytes: ingested.sizeBytes,
            sha256: ingested.sha256,
            storageProvider: ingested.storageProvider,
            bucket: ingested.bucket,
            domain: ingested.domain,
        });
        await FileRepository.markStored(db, ctx, fileRecord.id, ingested.scanStatus);

        const updated = await CostEntryRepository.update(db, ctx, costEntryId, {
            invoiceFileId: fileRecord.id,
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'CostEntry',
            entityId: costEntryId,
            details: `Attached invoice to cost entry ${costEntryId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'updated',
                changedFields: ['invoiceFileId'],
                summary: 'Attached an invoice to a cost entry',
            },
        });

        return toDto(updated);
    });
}

/**
 * Detach the invoice from a cost entry.
 *
 * The `FileRecord` SURVIVES — only the pointer is cleared. A cost entry
 * is a money record and its document may be referenced by an export or an
 * audit pack; deleting the bytes because someone corrected an attachment
 * would destroy evidence to fix a typo.
 */
export async function detachCostInvoice(ctx: RequestContext, costEntryId: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const entry = await CostEntryRepository.getById(db, ctx, costEntryId);
        if (!entry) throw notFound('Cost entry not found');

        const updated = await CostEntryRepository.update(db, ctx, costEntryId, {
            invoiceFileId: null,
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'CostEntry',
            entityId: costEntryId,
            details: `Detached invoice from cost entry ${costEntryId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'updated',
                changedFields: ['invoiceFileId'],
                summary: 'Detached an invoice from a cost entry',
            },
        });

        return toDto(updated);
    });
}
