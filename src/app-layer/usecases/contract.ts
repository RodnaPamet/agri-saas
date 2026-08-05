import { Prisma, type ContractStatus, type ContractType } from '@prisma/client';
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';
import { benchmarkContract } from '@/lib/market/contract-benchmark';
import { getMarketReferences } from '@/app-layer/usecases/trends';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    checkContractTransition,
    formatContractTransitionError,
} from '../domain/contract-status';
import { aggregateDeliveredTonnes, deriveFulfilment } from './grain-delivery';
import { computeContractValue } from '@/lib/grain/contract-value';
import type {
    CreateContractInput,
    UpdateContractInput,
} from '../schemas/grain.schemas';

/**
 * Contracts — grain marketing / supply contracts (ENTERPRISE-grain, GRAIN
 * module). A forward SALE of produce or PURCHASE of inputs against a
 * counterparty.
 *
 * Shape mirrors `crop-planning.ts` exactly:
 *   - authorize via assertCanRead/Write BEFORE data access,
 *   - sanitize user free text at the boundary (counterparty / commodity /
 *     key / terms / pricingNotes → sanitizePlainText) — the last two are
 *     ALSO encrypted at rest by the Epic B manifest; sanitisation protects
 *     every downstream renderer that decrypts them,
 *   - the NUMERIC magnitudes (volumeTonnes / pricePerTonne) stay PLAINTEXT
 *     Decimals so the portfolio rollups can SUM them,
 *   - emit a hash-chained audit event on EVERY mutation,
 *   - all DB access through runInTenantContext (RLS-bound), every read
 *     tenant-scoped + bounded with `take:`.
 *
 * Contract-specific: `updateContract` enforces the documented
 * ContractStatus lifecycle via `../domain/contract-status.ts`
 * (DRAFT → ACTIVE → DELIVERED → SETTLED, CANCELLED terminal from any
 * pre-SETTLED state). `createContract` does NOT — a contract may be
 * recorded at whatever stage it already is; only subsequent moves are
 * constrained. Moving to DELIVERED additionally requires real movement
 * in the `GrainDelivery` ledger (see `./grain-delivery.ts`).
 *
 * `listContracts` decorates each row with two DERIVED figures, neither
 * of them stored: `fulfilment` (delivered / remaining / progress, from
 * ONE groupBy over the page) and `valueAmount` (volume × price,
 * Decimal-exact). Per-currency book totals are built from the same page
 * by `summariseContractBook` — see `@/lib/grain/contract-value`.
 */

// Single cap for the contracts list read. Mirrors crop-planning's LIST_TAKE;
// the composite indexes ([tenantId,status] / [tenantId,type] /
// [tenantId,seasonId]) back the filtered reads.
const LIST_TAKE = 500;

/**
 * Columns the LIST read returns.
 *
 * `terms` (≤20 000 chars) and `pricingNotes` are deliberately absent.
 * They are the two Epic-B encrypted columns on this model, and a
 * `findMany` with no `select` returned them DECRYPTED for up to 500 rows
 * — into the SSR payload, into the client query cache, and into the
 * browser memory of every READER and AUDITOR, none of whom have any
 * surface that renders them (the only renderer is the edit modal, gated
 * on `canWrite`). Encrypting a column at rest and then broadcasting it
 * to everyone who can open a list is not confidentiality.
 *
 * The full row — including both narrative fields — is fetched on demand
 * by `getContract` when someone actually opens one.
 */
const LIST_SELECT = {
    id: true,
    tenantId: true,
    seasonId: true,
    key: true,
    counterparty: true,
    commodity: true,
    commodityCanonical: true,
    type: true,
    status: true,
    volumeTonnes: true,
    pricePerTonne: true,
    priceCurrency: true,
    deliveryStart: true,
    deliveryEnd: true,
    createdAt: true,
    updatedAt: true,
    season: { select: { id: true, name: true, status: true } },
} as const;

/**
 * Server-side free-text search across the plaintext identifying columns.
 *
 * Restricted to `counterparty` / `commodity` / `key` on purpose: those
 * are plaintext and indexed-adjacent. `terms` and `pricingNotes` are
 * ENCRYPTED at rest, so a `contains` against them would match ciphertext
 * — silently returning nothing rather than erroring, the worst failure
 * shape for a search box.
 */
function buildSearchWhere(q: string): Prisma.ContractWhereInput {
    const term = q.trim();
    if (!term) return {};
    return {
        OR: [
            { counterparty: { contains: term, mode: 'insensitive' } },
            { commodity: { contains: term, mode: 'insensitive' } },
            { key: { contains: term, mode: 'insensitive' } },
        ],
    };
}

/** Parse a wire date string → Date, or throw a 400. Null/undefined → null. */
function parseDate(value: string | null | undefined, label: string): Date | null {
    if (value == null) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label} must be a valid date`);
    return d;
}

/**
 * Sanitise an optional short free-text field and normalise the empty
 * result to `null`.
 *
 * `sanitizePlainText` strips markup but does NOT trim, so a value of
 * `"   "` survives as `"   "` — which for `key` meant a second
 * blank-keyed contract collided on the `[tenantId, key]` unique index
 * (a 409 the operator could not diagnose), and for `counterparty`
 * meant whitespace passed the required-field check.
 */
function cleanOptionalText(value: string | null | undefined): string | null {
    if (value == null) return null;
    const cleaned = sanitizePlainText(value).trim();
    return cleaned === '' ? null : cleaned;
}

/**
 * List filters. Both enum facets are MULTI-select in the UI
 * (`filter-defs.ts` sets `multiple: true`), so they arrive as arrays and
 * query with `{ in: [...] }`. The route validates every member against
 * the Prisma enum before calling in — this signature is typed to the
 * enum precisely so an unvalidated string can no longer reach Prisma
 * (which is what turned a two-status filter into a 500).
 */
export interface ContractListFilters {
    status?: ContractStatus[];
    type?: ContractType[];
    /** Multi-select, like `status`/`type`: the season facet declares
     *  `multiple: true`, so it arrives comma-joined. Read as a scalar it
     *  became `seasonId = "a,b"`, which a String column accepts and no row
     *  matches — a silent empty table rather than the 500 the enum facets
     *  produced. */
    seasonIds?: string[];
    /** Free-text search over counterparty / commodity / contract number.
     *  Server-side: the in-memory client filter only ever saw the
     *  500-row page, so a match on row 501 was invisible. */
    q?: string;
}

export async function listContracts(
    ctx: RequestContext,
    filters: ContractListFilters = {},
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.contract.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(filters.status?.length ? { status: { in: filters.status } } : {}),
                ...(filters.type?.length ? { type: { in: filters.type } } : {}),
                ...(filters.seasonIds?.length ? { seasonId: { in: filters.seasonIds } } : {}),
                ...(filters.q ? buildSearchWhere(filters.q) : {}),
            },
            // Explicit projection — `terms` and `pricingNotes` are
            // DELIBERATELY absent. See LIST_SELECT.
            select: LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }],
            take: opts.take ?? LIST_TAKE,
        });

        // ONE groupBy for the whole page's delivered tonnes — never a
        // query per row.
        const delivered = await aggregateDeliveredTonnes(
            db,
            ctx.tenantId,
            rows.map((r) => r.id),
        );

        // Decorate each row with its fulfilment position and its
        // Decimal-exact value. Both are derived, not stored: value is
        // volume × price (the schema has claimed this since the module
        // landed), and fulfilment comes from the delivery ledger.
        // Market references for the commodities ON THIS PAGE only — one
        // extra query for the whole page, never one per row (query-shape
        // guardrail D1). Global data, so it sits outside the tenant context.
        const references = await getMarketReferences(
            rows.map((r) => r.commodityCanonical).filter((c): c is string => c !== null),
        );
        const asOf = new Date().toISOString();

        const decorated = rows.map((row) => {
            const agg = delivered.get(row.id);
            return {
                ...row,
                fulfilment: deriveFulfilment(
                    row.id,
                    agg?.tonnes ?? new Prisma.Decimal(0),
                    agg?.count ?? 0,
                    row.volumeTonnes,
                ),
                valueAmount: computeContractValue(row.volumeTonnes, row.pricePerTonne),
                // "Am I selling above or below market?" — the question the
                // product could not answer until these two vocabularies met.
                benchmark: benchmarkContract(
                    {
                        commodityCanonical: row.commodityCanonical,
                        pricePerTonne: row.pricePerTonne == null ? null : Number(row.pricePerTonne),
                        priceCurrency: row.priceCurrency,
                    },
                    references,
                    asOf,
                ),
            };
        });

        // The 500-row cap used to be silent: a tenant with 600 contracts
        // saw 500 and was told nothing. Count only when the page came
        // back FULL — in the ordinary case (fewer rows than the cap) the
        // page length IS the total and the extra query is skipped.
        const take = opts.take ?? LIST_TAKE;
        const truncated = rows.length === take;
        const totalCount = truncated
            ? await db.contract.count({
                  where: {
                      tenantId: ctx.tenantId,
                      deletedAt: null,
                      ...(filters.status?.length ? { status: { in: filters.status } } : {}),
                      ...(filters.type?.length ? { type: { in: filters.type } } : {}),
                      ...(filters.seasonIds?.length ? { seasonId: { in: filters.seasonIds } } : {}),
                      ...(filters.q ? buildSearchWhere(filters.q) : {}),
                  },
              })
            : rows.length;

        return { rows: decorated, totalCount, truncated };
    });
}

export async function getContract(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const contract = await db.contract.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: { season: { select: { id: true, name: true, status: true } } },
        });
        if (!contract) throw notFound('Contract not found');
        return contract;
    });
}

export async function createContract(ctx: RequestContext, input: CreateContractInput) {
    assertCanWrite(ctx);

    // Trim AFTER sanitising: the sanitiser does not trim, so an
    // all-whitespace counterparty would otherwise pass the required check
    // and persist as a blank row title.
    const counterparty = sanitizePlainText(input.counterparty ?? '').trim();
    if (!counterparty) throw badRequest('Contract counterparty is required');

    // `key` is on a [tenantId, key] unique index — an empty string is not
    // a key, so normalise it to null (multiple key-less contracts are
    // legal; two `key: ""` rows would 409).
    const key = cleanOptionalText(input.key);
    const commodity = cleanOptionalText(input.commodity);
    // Derived, never user-supplied. The free text is what the farmer read off
    // the paper; this is the key that lets it meet a market price.
    const commodityCanonical = normalizeCommodity(commodity);
    const terms = input.terms != null ? sanitizePlainText(input.terms) : null;
    const pricingNotes = input.pricingNotes != null ? sanitizePlainText(input.pricingNotes) : null;

    if (input.volumeTonnes != null && input.volumeTonnes < 0) {
        throw badRequest('Contract volume must be zero or positive');
    }
    if (input.pricePerTonne != null && input.pricePerTonne < 0) {
        throw badRequest('Contract price per tonne must be zero or positive');
    }
    const deliveryStart = parseDate(input.deliveryStart, 'Delivery start');
    const deliveryEnd = parseDate(input.deliveryEnd, 'Delivery end');
    if (deliveryStart && deliveryEnd && deliveryEnd < deliveryStart) {
        throw badRequest('Delivery end must be on or after the delivery start');
    }

    return runInTenantContext(ctx, async (db) => {
        if (input.seasonId) {
            const season = await db.season.findFirst({
                where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!season) throw badRequest('Season not found or belongs to a different tenant');
        }

        const contract = await db.contract.create({
            data: {
                tenantId: ctx.tenantId,
                seasonId: input.seasonId ?? null,
                key,
                counterparty,
                commodity,
                commodityCanonical,
                type: input.type ?? 'SALE',
                status: input.status ?? 'DRAFT',
                volumeTonnes: input.volumeTonnes ?? null,
                pricePerTonne: input.pricePerTonne ?? null,
                priceCurrency: input.priceCurrency ?? null,
                deliveryStart,
                deliveryEnd,
                terms,
                pricingNotes,
            },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Contract',
            entityId: contract.id,
            details: `Created ${contract.type.toLowerCase()} contract: ${counterparty}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Contract',
                operation: 'created',
                after: {
                    counterparty,
                    type: contract.type,
                    status: contract.status,
                    volumeTonnes: input.volumeTonnes ?? null,
                },
                summary: `Created ${contract.type.toLowerCase()} contract with ${counterparty}`,
            },
        });
        return contract;
    });
}

export async function updateContract(ctx: RequestContext, id: string, input: UpdateContractInput) {
    assertCanWrite(ctx);

    const data: Prisma.ContractUncheckedUpdateInput = {};
    if (input.counterparty !== undefined) {
        const counterparty = sanitizePlainText(input.counterparty).trim();
        if (!counterparty) throw badRequest('Contract counterparty is required');
        data.counterparty = counterparty;
    }
    if (input.key !== undefined) data.key = cleanOptionalText(input.key);
    if (input.commodity !== undefined) {
        const nextCommodity = cleanOptionalText(input.commodity);
        data.commodity = nextCommodity;
        // Recomputed on EVERY commodity edit, including clearing it. Leaving a
        // stale canonical behind would silently keep comparing a contract
        // against the wrong market.
        data.commodityCanonical = normalizeCommodity(nextCommodity);
    }
    if (input.terms !== undefined) data.terms = input.terms != null ? sanitizePlainText(input.terms) : null;
    if (input.pricingNotes !== undefined) {
        data.pricingNotes = input.pricingNotes != null ? sanitizePlainText(input.pricingNotes) : null;
    }
    if (input.seasonId !== undefined) data.seasonId = input.seasonId;
    if (input.type !== undefined) data.type = input.type;
    // `status` is deliberately NOT folded in here — the lifecycle guard
    // below needs the CURRENT status, so it is applied inside the
    // transaction once the existing row has been read.
    if (input.volumeTonnes !== undefined) {
        if (input.volumeTonnes != null && input.volumeTonnes < 0) {
            throw badRequest('Contract volume must be zero or positive');
        }
        data.volumeTonnes = input.volumeTonnes;
    }
    if (input.pricePerTonne !== undefined) {
        if (input.pricePerTonne != null && input.pricePerTonne < 0) {
            throw badRequest('Contract price per tonne must be zero or positive');
        }
        data.pricePerTonne = input.pricePerTonne;
    }
    if (input.priceCurrency !== undefined) data.priceCurrency = input.priceCurrency;

    // Parse the window edges up front (a malformed date is a 400 either
    // way); the ORDERING check needs the existing row, so it runs inside
    // the transaction below against the EFFECTIVE post-update values.
    const nextDeliveryStart =
        input.deliveryStart !== undefined ? parseDate(input.deliveryStart, 'Delivery start') : undefined;
    const nextDeliveryEnd =
        input.deliveryEnd !== undefined ? parseDate(input.deliveryEnd, 'Delivery end') : undefined;
    if (nextDeliveryStart !== undefined) data.deliveryStart = nextDeliveryStart;
    if (nextDeliveryEnd !== undefined) data.deliveryEnd = nextDeliveryEnd;

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.contract.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true, deliveryStart: true, deliveryEnd: true },
        });
        if (!existing) throw notFound('Contract not found');

        // ── Lifecycle guard ──
        //
        // `createContract` may open a contract at any status (recording
        // one that is already mid-lifecycle), but every SUBSEQUENT move
        // must follow the documented graph. A no-op (same status
        // re-sent, which ContractFormModal does on every edit) passes
        // and simply writes nothing.
        if (input.status !== undefined && input.status !== existing.status) {
            const transitionErr = checkContractTransition(existing.status, input.status);
            if (transitionErr) throw badRequest(formatContractTransitionError(transitionErr));

            // ── Movement gate (the fulfilment half of the lifecycle) ──
            //
            // DELIVERED must mean grain actually moved, not that
            // somebody picked it from a dropdown. Requires at least one
            // recorded GrainDelivery against this contract.
            //
            // The bar is "> 0 delivered", NOT "fully delivered":
            // partial and tolerance-adjusted deliveries are ordinary in
            // grain marketing (moisture shrink, a short final load), and
            // refusing to let an operator close a 499.2 t delivery on a
            // 500 t contract would push them straight back to lying to
            // the system. `fulfilment.complete` on the read side is what
            // distinguishes fully- from partially-delivered.
            if (input.status === 'DELIVERED') {
                const agg = await aggregateDeliveredTonnes(db, ctx.tenantId, [id]);
                const deliveredTonnes = agg.get(id)?.tonnes;
                if (!deliveredTonnes || deliveredTonnes.lessThanOrEqualTo(0)) {
                    throw badRequest(
                        'Cannot mark a contract DELIVERED with no recorded deliveries — ' +
                            'record the delivered tonnage first.',
                    );
                }
            }

            data.status = input.status;
        }

        // ── Delivery-window ordering ──
        //
        // Checked against the EFFECTIVE values, not just the submitted
        // ones: a PATCH that sends only `deliveryEnd` must still be
        // compared against the STORED `deliveryStart`, or an edit could
        // leave the row with end < start (which `createContract` has
        // always rejected).
        const effectiveStart =
            nextDeliveryStart !== undefined ? nextDeliveryStart : existing.deliveryStart;
        const effectiveEnd =
            nextDeliveryEnd !== undefined ? nextDeliveryEnd : existing.deliveryEnd;
        if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
            throw badRequest('Delivery end must be on or after the delivery start');
        }

        if (input.seasonId) {
            const season = await db.season.findFirst({
                where: { id: input.seasonId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!season) throw badRequest('Season not found or belongs to a different tenant');
        }

        const contract = await db.contract.update({ where: { id }, data });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Contract',
            entityId: id,
            details: 'Contract updated',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Contract',
                operation: 'updated',
                changedFields: Object.keys(input).filter(
                    (k) => (input as Record<string, unknown>)[k] !== undefined,
                ),
                after: { counterparty: contract.counterparty, status: contract.status },
                summary: 'Contract updated',
            },
        });
        return contract;
    });
}

export async function deleteContract(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.contract.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, counterparty: true },
        });
        if (!existing) throw notFound('Contract not found');

        const contract = await db.contract.update({
            where: { id },
            data: { deletedAt: new Date(), deletedByUserId: ctx.userId ?? null },
            select: { id: true },
        });
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'Contract',
            entityId: id,
            details: `Deleted contract: ${existing.counterparty}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Contract',
                operation: 'deleted',
                before: { counterparty: existing.counterparty },
                summary: `Deleted contract with ${existing.counterparty}`,
            },
        });
        return { id: contract.id, deleted: true };
    });
}
