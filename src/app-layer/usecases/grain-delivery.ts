import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { PrismaTx } from '@/lib/db-context';
import type {
    CreateGrainDeliveryInput,
} from '../schemas/grain.schemas';

/**
 * Grain deliveries — the fulfilment side of a marketing contract.
 *
 * A `GrainDelivery` is one physical movement of tonnage against one
 * contract (a weighbridge ticket, in effect). Summing them per contract
 * is what turns `Contract.status = DELIVERED` from a dropdown choice
 * into a fact, and what lets a farmer answer "how much do I still owe
 * this buyer?".
 *
 * Shape mirrors `contract.ts`:
 *   - authorize via assertCanRead/Write BEFORE data access,
 *   - sanitize the one free-text field (`reference`) at the boundary,
 *   - emit a hash-chained audit event on EVERY mutation,
 *   - all DB access through runInTenantContext (RLS-bound), every read
 *     tenant-scoped + bounded with `take:`.
 *
 * Every column here is plaintext — `tonnes` is a magnitude the rollups
 * SUM in-DB, `reference` is a short external identifier. The
 * commercially-sensitive narrative stays on the parent Contract
 * (`terms` / `pricingNotes`, encrypted), so the Epic-B split holds
 * without this model joining the manifest.
 */

/** Cap for a per-contract delivery list. A contract filled in more than
 *  this many movements is pathological; the aggregate below is what the
 *  rollups use, so this bound never truncates a total. */
const LIST_TAKE = 500;

/** Cap for the per-page fulfilment aggregate (contract ids per query). */
const AGGREGATE_TAKE = 1000;

/** Fulfilment position of one contract. All magnitudes are exact
 *  decimal STRINGS — they cross the wire as JSON and must not meet a
 *  float parse. */
export interface ContractFulfilment {
    contractId: string;
    /** Σ delivered tonnes (non-deleted deliveries). */
    deliveredTonnes: string;
    /** Number of delivery movements recorded. */
    deliveryCount: number;
    /** `volumeTonnes − delivered`, floored at 0; `null` when the
     *  contract carries no contracted volume (nothing to remain). */
    remainingTonnes: string | null;
    /** delivered / contracted × 100, clamped to [0, 100]; `null` when
     *  there is no contracted volume to be a percentage OF. */
    progressPct: number | null;
    /** True when delivered ≥ contracted (over-delivery counts). */
    complete: boolean;
}

/**
 * Compute a fulfilment row from the two magnitudes. Pure — exported so
 * the rollup, the route and the tests all agree on the arithmetic.
 *
 * Over-delivery is preserved in `deliveredTonnes` (the tickets say what
 * they say) but `remainingTonnes` floors at zero: "you still owe −3 t"
 * is not a sentence anyone wants on a dashboard.
 */
export function deriveFulfilment(
    contractId: string,
    deliveredTonnes: Prisma.Decimal,
    deliveryCount: number,
    contractedVolume: Prisma.Decimal | null,
): ContractFulfilment {
    const hasVolume = contractedVolume != null && contractedVolume.greaterThan(0);
    const remaining = hasVolume
        ? Prisma.Decimal.max(contractedVolume.minus(deliveredTonnes), new Prisma.Decimal(0))
        : null;

    let progressPct: number | null = null;
    if (hasVolume) {
        const raw = deliveredTonnes.div(contractedVolume).mul(100).toNumber();
        progressPct = Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
    }

    return {
        contractId,
        deliveredTonnes: deliveredTonnes.toFixed(),
        deliveryCount,
        remainingTonnes: remaining ? remaining.toFixed() : null,
        progressPct,
        complete: hasVolume
            ? deliveredTonnes.greaterThanOrEqualTo(contractedVolume)
            : deliveredTonnes.greaterThan(0),
    };
}

/**
 * Delivered-tonnes aggregate for a set of contracts, in ONE groupBy —
 * never a query per row.
 *
 * Exported for reuse by the contract list read and the delivery-window
 * sweep. Takes an open `db` so a caller already inside a tenant
 * transaction does not open a second one.
 */
export async function aggregateDeliveredTonnes(
    db: PrismaTx,
    tenantId: string,
    contractIds: readonly string[],
): Promise<Map<string, { tonnes: Prisma.Decimal; count: number }>> {
    const out = new Map<string, { tonnes: Prisma.Decimal; count: number }>();
    if (contractIds.length === 0) return out;

    const groups = await db.grainDelivery.groupBy({
        by: ['contractId'],
        where: {
            tenantId,
            deletedAt: null,
            contractId: { in: [...contractIds].slice(0, AGGREGATE_TAKE) },
        },
        _sum: { tonnes: true },
        _count: { _all: true },
    });

    for (const g of groups) {
        out.set(g.contractId, {
            tonnes: g._sum.tonnes ?? new Prisma.Decimal(0),
            count: g._count._all,
        });
    }
    return out;
}

/** Assert the contract exists in this tenant, returning what the
 *  fulfilment math needs. */
async function requireContract(db: PrismaTx, tenantId: string, contractId: string) {
    const contract = await db.contract.findFirst({
        where: { id: contractId, tenantId, deletedAt: null },
        select: { id: true, status: true, volumeTonnes: true, counterparty: true },
    });
    if (!contract) throw notFound('Contract not found');
    return contract;
}

export async function listContractDeliveries(
    ctx: RequestContext,
    contractId: string,
): Promise<{ rows: Array<Record<string, unknown>>; fulfilment: ContractFulfilment }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const contract = await requireContract(db, ctx.tenantId, contractId);

        const rows = await db.grainDelivery.findMany({
            where: { tenantId: ctx.tenantId, contractId, deletedAt: null },
            orderBy: [{ deliveredAt: 'desc' }],
            take: LIST_TAKE,
        });

        // Sum the page in memory rather than a second groupBy: the list
        // is already bounded and Decimal addition is exact.
        let tonnes = new Prisma.Decimal(0);
        for (const r of rows) tonnes = tonnes.add(r.tonnes);

        return {
            rows,
            fulfilment: deriveFulfilment(
                contractId,
                tonnes,
                rows.length,
                contract.volumeTonnes,
            ),
        };
    });
}

export async function createGrainDelivery(
    ctx: RequestContext,
    input: CreateGrainDeliveryInput,
) {
    assertCanWrite(ctx);

    if (input.tonnes <= 0) {
        throw badRequest('Delivery tonnes must be greater than zero');
    }
    const deliveredAt = new Date(input.deliveredAt);
    if (Number.isNaN(deliveredAt.getTime())) {
        throw badRequest('Delivered at must be a valid date');
    }
    const reference =
        input.reference != null ? sanitizePlainText(input.reference).trim() || null : null;

    return runInTenantContext(ctx, async (db) => {
        const contract = await requireContract(db, ctx.tenantId, input.contractId);

        // A cancelled deal cannot receive grain. DRAFT can't either —
        // nothing is signed, so there is no obligation to deliver
        // against. Everything else (ACTIVE / DELIVERED / SETTLED) can
        // take a late or corrective ticket.
        if (contract.status === 'CANCELLED' || contract.status === 'DRAFT') {
            throw badRequest(
                `Cannot record a delivery against a ${contract.status.toLowerCase()} contract`,
            );
        }

        const delivery = await db.grainDelivery.create({
            data: {
                tenantId: ctx.tenantId,
                contractId: input.contractId,
                deliveredAt,
                tonnes: new Prisma.Decimal(input.tonnes),
                reference,
            },
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'GrainDelivery',
            entityId: delivery.id,
            details: `Recorded ${input.tonnes} t delivered against contract ${contract.counterparty}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'GrainDelivery',
                operation: 'created',
                after: {
                    contractId: input.contractId,
                    tonnes: input.tonnes,
                    deliveredAt: deliveredAt.toISOString(),
                    reference,
                },
                summary: `Delivered ${input.tonnes} t to ${contract.counterparty}`,
            },
        });

        return delivery;
    });
}

export async function deleteGrainDelivery(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.grainDelivery.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, contractId: true, tonnes: true },
        });
        if (!existing) throw notFound('Delivery not found');

        const delivery = await db.grainDelivery.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
            select: { id: true },
        });

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'GrainDelivery',
            entityId: id,
            details: `Removed a ${existing.tonnes.toFixed()} t delivery`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'GrainDelivery',
                operation: 'deleted',
                before: {
                    contractId: existing.contractId,
                    tonnes: existing.tonnes.toFixed(),
                },
                summary: `Removed a ${existing.tonnes.toFixed()} t delivery`,
            },
        });

        return { id: delivery.id, deleted: true };
    });
}
