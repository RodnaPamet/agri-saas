import { Prisma, type CostCategory } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { CostEntryRepository, type CostEntryFilters } from '../repositories/CostEntryRepository';
import { COST_DOMAIN_LINKS } from '../schemas/grain.schemas';
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
    const file = await db.fileRecord.findFirst({
        where: { id: invoiceFileId, tenantId: ctx.tenantId },
        select: { id: true, status: true, deletedAt: true },
    });
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
    createdByUserId: string | null;
    description?: string | null;
    createdAt: Date;
    updatedAt: Date;
    planting?: { id: string; successionNumber: number; cropPlan?: { name: string | null } | null } | null;
    season?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    parcel?: { id: string; name: string } | null;
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
    },
): Promise<void> {
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
}

export async function createCostEntry(ctx: RequestContext, input: CreateCostEntryInput) {
    assertCanWrite(ctx);

    assertSingleDomainLink(input);
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
            createdByUserId: ctx.userId ?? null,
        });

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
                },
                summary: `Recorded a ${input.category} cost of ${input.amount} ${currency}`,
            },
        });

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
        });

        await assertFksBelongToTenant(db, ctx, input);
        if (input.invoiceFileId) await assertUsableInvoice(db, ctx, input.invoiceFileId);

        const record = await CostEntryRepository.update(db, ctx, id, data);

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'CostEntry',
            entityId: id,
            details: `Updated cost entry ${id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'CostEntry',
                operation: 'updated',
                changedFields: Object.keys(data),
                summary: `Updated a cost entry`,
            },
        });

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
    link: 'plantingId' | 'seasonId' | 'locationId' | 'parcelId' | 'leaseId',
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
