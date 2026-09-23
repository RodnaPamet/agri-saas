import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { badRequest, notFound, codedConflict } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { cachedListRead } from '@/lib/cache/list-cache';
import { Prisma, ItemCategory, QuantityMeasure } from '@prisma/client';

/**
 * Per-hectare RATE unit keys — hidden from the dose-unit picker (Bulgaria
 * works in decares). They remain in the catalog so legacy operations that
 * referenced them still resolve; new doses are per-decare only.
 */
const PER_HA_RATE_KEYS = ['l-per-ha', 'ml-per-ha', 'kg-per-ha', 'g-per-ha'];

/**
 * Read-only catalog endpoints backing the prescription form:
 *   • Items — the tenant's input-product catalog (spray products),
 *   • Units — the global unit-of-measure catalog (dose RATE units).
 */
export async function listItems(ctx: RequestContext, filters?: { category?: string; q?: string }) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => {
        const where: Prisma.ItemWhereInput = { tenantId: ctx.tenantId, deletedAt: null };
        if (filters?.category) where.category = filters.category as ItemCategory;
        if (filters?.q) where.name = { contains: filters.q, mode: 'insensitive' };
        return db.item.findMany({
            where,
            include: { defaultUnit: { select: { id: true, key: true, symbol: true, measure: true } } },
            orderBy: { name: 'asc' },
        });
    });
}

export interface CreateItemInput {
    name: string;
    category:
        | 'SEED'
        | 'PESTICIDE'
        | 'FERTILIZER'
        | 'AMENDMENT'
        | 'FUEL'
        | 'HARVESTED_PRODUCE'
        | 'OTHER';
    defaultUnitId: string;
    sku?: string | null;
    reorderLevel?: number | null;
    /** БАБХ farm-record regulatory fields (structured). */
    quarantinePeriodDays?: number | null;
    activeIngredient?: string | null;
    pppRegistrationNo?: string | null;
}

/**
 * Turn the unique-index violation into something a person can act on.
 *
 * The raw P2002 already becomes a 409, but with the generic body "A resource
 * with that unique constraint already exists" and `details` carrying an index
 * name — true, and useless to an operator who has just typed a product name.
 *
 * Narrow on purpose: only a violation naming the NAME index is translated,
 * and any other constraint rethrows untouched. A catch-all here would relabel
 * a future constraint as a name clash and send someone hunting the wrong
 * field.
 */
function asDuplicateNameConflict(err: unknown): never {
    const code = (err as { code?: unknown })?.code;
    const target = (err as { meta?: { target?: unknown } })?.meta?.target;
    const hitNameIndex =
        code === 'P2002' &&
        (typeof target === 'string'
            ? target.includes('name')
            : Array.isArray(target) && target.some((t) => String(t).includes('name')));
    if (!hitNameIndex) throw err;
    // No `params`, and no interpolation either.
    //
    // `error-params-carry-no-pii` forbids a `name` key outright — params
    // leave the server in the clear and reach every client — and there is no
    // id to send instead, because P2002 reports the INDEX that was violated,
    // not the row already holding the value.
    //
    // The message does not name the product either, and that was the guard's
    // doing rather than mine: its param scan matches the first `{…}` among a
    // call's arguments, so `${name}` inside a template literal reads as a
    // params object. Strictly that is imprecise — but it errs toward the safe
    // side and it is arguably right on the merits, since an interpolated
    // sentence leaves the server just as clear as a param does. The operator
    // has just typed the name, so nothing is lost by not echoing it.
    throw codedConflict(
        'ITEM_NAME_ALREADY_EXISTS',
        'A product with that name already exists. Open it instead of creating ' +
            "a second one — two rows with one name split a product's history " +
            'between them.',
    );
}

/**
 * Create an input-product catalog entry (the thing lots are batches of).
 * Part of the inventory module — the POST /items route gates on
 * INVENTORY; the read path stays open (the spray form needs it).
 */
export async function createItem(ctx: RequestContext, input: CreateItemInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const name = sanitizePlainText(input.name.trim());
        if (!name) throw badRequest('Product name is required.');
        const unit = await db.unit.findUnique({ where: { id: input.defaultUnitId }, select: { id: true } });
        if (!unit) throw badRequest('Default unit not found.');

        let item;
        try {
            item = await db.item.create({
                data: {
                    tenantId: ctx.tenantId,
                    name,
                    category: input.category as ItemCategory,
                    defaultUnitId: input.defaultUnitId,
                    sku: input.sku ? sanitizePlainText(input.sku.trim()) : null,
                    reorderLevel: input.reorderLevel ?? null,
                    quarantinePeriodDays: input.quarantinePeriodDays ?? null,
                    activeIngredient: input.activeIngredient
                        ? sanitizePlainText(input.activeIngredient.trim())
                        : null,
                    pppRegistrationNo: input.pppRegistrationNo
                        ? sanitizePlainText(input.pppRegistrationNo.trim())
                        : null,
                    createdByUserId: ctx.userId ?? null,
                },
                select: { id: true, name: true, category: true },
            });
        } catch (err) {
            // The partial unique index on (tenantId, lower(name)).
            asDuplicateNameConflict(err);
        }

        await logEvent(db, ctx, {
            action: 'INVENTORY_ITEM_CREATED',
            entityType: 'Item',
            entityId: item.id,
            details: `Created product ${item.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Item',
                operation: 'created',
                after: { name: item.name, category: item.category },
                summary: `Created product ${item.name}`,
            },
        });

        return item;
    });
}

/**
 * Single-item read for the inventory edit form — returns every editable
 * field (name, category, default unit, reorder level, and the БАБХ
 * regulatory fields) so the product modal can pre-fill on "Edit product".
 * Tenant-scoped; the `Decimal` reorderLevel is normalised to a plain
 * number for the wire.
 */
export async function getItemDetail(ctx: RequestContext, itemId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const item = await db.item.findFirst({
            where: { id: itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                category: true,
                defaultUnitId: true,
                sku: true,
                reorderLevel: true,
                quarantinePeriodDays: true,
                activeIngredient: true,
                pppRegistrationNo: true,
            },
        });
        if (!item) throw notFound('Item not found.');
        return {
            id: item.id,
            name: item.name,
            category: item.category,
            defaultUnitId: item.defaultUnitId,
            sku: item.sku,
            reorderLevel: item.reorderLevel !== null ? Number(item.reorderLevel) : null,
            quarantinePeriodDays: item.quarantinePeriodDays,
            activeIngredient: item.activeIngredient,
            pppRegistrationNo: item.pppRegistrationNo,
        };
    });
}

export interface UpdateItemInput {
    name?: string;
    category?: CreateItemInput['category'];
    defaultUnitId?: string;
    sku?: string | null;
    reorderLevel?: number | null;
    quarantinePeriodDays?: number | null;
    activeIngredient?: string | null;
    pppRegistrationNo?: string | null;
}

/**
 * Partial update of an input-product catalog entry. Mirrors `createItem`
 * (assertCanWrite, sanitise free-text, tenant-scoped write, audit event)
 * but writes ONLY the provided fields — an undefined key is left
 * untouched, a null clears the column. Emits the `updated` variant of the
 * item lifecycle audit event.
 */
export async function updateItem(ctx: RequestContext, itemId: string, input: UpdateItemInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.item.findFirst({
            where: { id: itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!existing) throw notFound('Item not found.');

        const data: Prisma.ItemUpdateInput = {};
        if (input.name !== undefined) {
            const name = sanitizePlainText(input.name.trim());
            if (!name) throw badRequest('Product name is required.');
            data.name = name;
        }
        if (input.category !== undefined) data.category = input.category as ItemCategory;
        if (input.defaultUnitId !== undefined) {
            const unit = await db.unit.findUnique({ where: { id: input.defaultUnitId }, select: { id: true } });
            if (!unit) throw badRequest('Default unit not found.');
            data.defaultUnit = { connect: { id: input.defaultUnitId } };
        }
        if (input.sku !== undefined) data.sku = input.sku ? sanitizePlainText(input.sku.trim()) : null;
        if (input.reorderLevel !== undefined) data.reorderLevel = input.reorderLevel ?? null;
        if (input.quarantinePeriodDays !== undefined) data.quarantinePeriodDays = input.quarantinePeriodDays ?? null;
        if (input.activeIngredient !== undefined)
            data.activeIngredient = input.activeIngredient ? sanitizePlainText(input.activeIngredient.trim()) : null;
        if (input.pppRegistrationNo !== undefined)
            data.pppRegistrationNo = input.pppRegistrationNo ? sanitizePlainText(input.pppRegistrationNo.trim()) : null;

        let item;
        try {
            item = await db.item.update({
                where: { id: existing.id },
                data,
                select: { id: true, name: true, category: true },
            });
        } catch (err) {
            // Renaming ONTO a taken name is the same collision as creating a
            // second one, and reaches the same index.
            asDuplicateNameConflict(err);
        }

        await logEvent(db, ctx, {
            action: 'INVENTORY_ITEM_UPDATED',
            entityType: 'Item',
            entityId: item.id,
            details: `Updated product ${item.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Item',
                operation: 'updated',
                after: { name: item.name, category: item.category },
                summary: `Updated product ${item.name}`,
            },
        });

        return item;
    });
}

export async function listUnits(ctx: RequestContext, measure?: string) {
    assertCanRead(ctx);
    // Units are a static, seeded catalog — cache for a day. NOTE: there
    // is NO Unit write path (the catalog is seeded), so there is nothing
    // to `bumpEntityCacheVersion` — the entry is TTL-only.
    //
    // NOTE: Unit is a GLOBAL catalog (no tenantId / no RLS), but
    // `cachedListRead` keys by `ctx.tenantId`. That means every tenant
    // gets its OWN cached copy of the same global list — a harmless
    // per-tenant duplication (correct, just slightly redundant). We
    // accept it rather than add a separate global-key cache path.
    return cachedListRead({
        ctx,
        entity: 'unit',
        operation: 'list',
        params: { measure: measure ?? null },
        ttlSeconds: 86400,
        loader: () =>
            // Read inside the tenant context for a single, consistent
            // connection path.
            runInTenantContext(ctx, (db) =>
                db.unit.findMany({
                    where: measure
                        ? {
                              measure: measure as QuantityMeasure,
                              // Bulgaria works in DECARES: the RATE dose picker
                              // offers only per-decare units (кг/дка …). The
                              // per-hectare rows stay in the catalog for legacy
                              // operations that reference them, but are hidden
                              // from selection so new doses can't be per-ha.
                              ...(measure === 'RATE'
                                  ? { key: { notIn: PER_HA_RATE_KEYS } }
                                  : {}),
                          }
                        : {},
                    orderBy: [{ measure: 'asc' }, { name: 'asc' }],
                }),
            ),
    });
}
