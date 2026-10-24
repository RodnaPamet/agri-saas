import { Prisma, LogEntryType, LogEntryStatus } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { buildCursorWhere, computePageInfo, clampLimit } from '@/lib/pagination';
import { dayKeyInTz, FARM_TIME_ZONE } from '@/lib/calendar-day-key';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { AssetRepository } from './AssetRepository';
import { canDeleteTreatment, canEditTreatment } from '@/app-layer/policies/task.policies';

export interface LogQuantityInput {
    measure:
        | 'COUNT'
        | 'WEIGHT'
        | 'VOLUME'
        | 'AREA'
        | 'LENGTH'
        | 'RATE'
        | 'OTHER';
    value: number;
    unitId: string;
    label?: string | null;
}

export interface CreateLogEntryInput {
    /**
     * This entry was recorded by a person in the diary, even though it may
     * carry an `operationParcelId` (#1740). Default-false.
     *
     * Only the two-step treatment record sets it. Everything else — including
     * `recordInputApplication` writing an entry for a line an operator
     * completed in Задачи — leaves it false and stays hidden from the journal
     * list, which is the 2026-10-10 manual-only ruling.
     */
    recordedInDiary?: boolean;
    /**
     * The ДНЕВНИК fold key (#1740) — the treatment's handle, or omitted so the
     * column's own unique default applies and the entry folds to itself.
     *
     * Declared here because the repository maps `data` field by field. A
     * caller passing it through a SPREAD gets no help from `tsc`: excess
     * property checking does not apply to spreads, so an undeclared field is
     * accepted at every call site and silently dropped at the write. That is
     * what happened — four links of the chain were wired, the fifth discarded
     * it, and the first sign was three entries with three different group ids
     * in a DB-backed test.
     */
    treatmentGroupId?: string;
    type:
        | 'ACTIVITY'
        | 'OBSERVATION'
        | 'INPUT_APPLICATION'
        | 'SEEDING'
        | 'TRANSPLANTING'
        | 'HARVEST'
        | 'IRRIGATION'
        | 'MAINTENANCE'
        | 'LAB_TEST'
        | 'GRAZING';
    title: string;
    /**
     * Descriptor for a SERVER-COMPOSED title (#1073). `title` above is then
     * its rendering rather than the source of truth. Absent for anything a
     * person typed — see `@/lib/journal/auto-title`.
     */
    titleKey?: string | null;
    titleParams?: Prisma.InputJsonValue | null;
    occurredAt?: Date;
    status?: 'PLANNED' | 'DONE';
    notes?: string | null;
    conditionsJson?: Prisma.InputJsonValue;
    operationParcelId?: string | null;
    costAmount?: number | null;
    costCurrency?: string | null;
    quantities?: LogQuantityInput[];
    /** Feature-1 Location ids the entry happened at. */
    locationIds?: string[];
    /** Equipment ids used in the entry. */
    equipmentIds?: string[];
    /**
     * Crop-planning plan-vs-actual links — the planting + lifecycle
     * stage this entry realises. Mirrors `locationIds` → LogLocation:
     * each becomes a LogPlanting row, so a sow/transplant/harvest
     * journal entry records the ACTUAL date against the planned
     * Planting.
     */
    plantingLinks?: { plantingId: string; stage: 'SOW' | 'TRANSPLANT' | 'HARVEST' }[];
    /** Offline exactly-once handle (outbox-item id). See LogEntry.clientMutationId. */
    clientMutationId?: string | null;
}

export interface UpdateLogEntryInput {
    type?: CreateLogEntryInput['type'];
    /**
     * Clearing the server's title descriptor when a person takes the title
     * over. `null` clears, `undefined` leaves it alone — the same
     * three-state contract the other optional fields here use.
     */
    titleKey?: string | null;
    titleParams?: Prisma.InputJsonValue | null;
    title?: string;
    occurredAt?: Date;
    status?: 'PLANNED' | 'DONE';
    notes?: string | null;
    operationParcelId?: string | null;
    costAmount?: number | null;
    costCurrency?: string | null;
    /** When provided, fully REPLACES the existing quantity set. */
    quantities?: LogQuantityInput[];
    /** When provided, fully REPLACES the existing location links. */
    locationIds?: string[];
    /** When provided, fully REPLACES the existing equipment links. */
    equipmentIds?: string[];
}

/**
 * Append an AND clause instead of assigning one.
 *
 * TWO filters write `where.AND` now — `crop` and `locationId` — and
 * `listPaginated` adds its cursor predicate on top of whatever they left. An
 * assignment silently drops whichever ran first, and the symptom is a filter
 * that WIDENS when you combine it with another: exactly the shape that made
 * `where.OR` unusable for the location clause.
 *
 * The cursor code already appends defensively for this reason. This keeps the
 * builder honest at its own level rather than relying on which filters a
 * caller happens to send together.
 */
function andClause(
    where: Prisma.LogEntryWhereInput,
    clause: Prisma.LogEntryWhereInput,
): void {
    const existing = where.AND;
    if (Array.isArray(existing)) existing.push(clause);
    else if (existing) where.AND = [existing, clause];
    else where.AND = [clause];
}

export interface LogEntryFilters {
    /**
     * Include entries the TASK flow wrote, not just what a person typed.
     *
     * Owner ruling 2026-10-10: «journal should be entered manually only and
     * tasks list should appear only in tasks». The journal, its API and the
     * dashboard strip therefore show MANUAL entries only, and this flag
     * defaults to the journal's own semantics rather than to the old
     * behaviour — a new caller inherits "what a person typed", which is what
     * the journal now means.
     *
     * The ONE caller that opts in is `satellite-briefing`: its job is to
     * summarise what happened on the farm, and a briefing blind to spraying is
     * less useful rather than tidier (owner, same ruling — "keep the briefing
     * fed"). The dashboard strip does NOT opt in, so it cannot disagree with
     * the journal page beside it about what the journal contains.
     *
     * It is a READ rule and nothing is deleted. `recordInputApplication` keeps
     * writing the row, so the ДНЕВНИК PDF, the task lines and `cost-rollup`'s
     * join through `CONSUMPTION.logEntryId` are all untouched — and flipping
     * this flag restores every hidden entry. The PDF is unaffected for a
     * second reason worth knowing: `reports/pdf/farm-record-diary.ts` queries
     * `logEntry.findMany` DIRECTLY and never reaches this builder.
     */
    includeTaskWritten?: boolean;
    // ARRAYS — multiple:true facets, parsed at the route.
    type?: LogEntryType[];
    status?: LogEntryStatus[];
    q?: string;
    /** ISO date — entries with occurredAt >= this. */
    occurredFrom?: string;
    /** ISO date — entries with occurredAt <= this. */
    occurredTo?: string;
    /** Filter to entries whose operation line is on a parcel of this crop (#10). */
    crop?: string[];
    /** Filter to entries logged against this location (#10). */
    locationId?: string;
    /**
     * Filter to entries linked (via LogPlanting) to a planting of this crop
     * plan — scopes the plan-detail Journal tab to just this plan's actuals.
     */
    cropPlanId?: string;
}

/**
 * The ДНЕВНИК list's own cursor: `(occurredAt, treatmentGroupId)`.
 *
 * ## Why not the shared `{ createdAt, id }` one
 *
 * The list folds a treatment's N entries into ONE row with
 * `distinct: ['treatmentGroupId']`, and `DISTINCT ON` picks the FIRST member
 * of each group in the ORDER BY. A cursor naming a ROW excludes only that
 * row, so the group's remaining members are still eligible and represent it
 * AGAIN on the next page.
 *
 * Measured, 3 treatments of 3 entries paged 2 at a time with a
 * `(createdAt, id)` cursor: six rows came back, one treatment three times.
 * For a compliance register a farmer would reasonably read a repeated
 * treatment as a repeated application.
 *
 * `treatmentGroupId` is one-per-group by construction, so ordering on it
 * makes each treatment appear exactly once and a cursor can skip the whole
 * group. `occurredAt` leads because that is the day the work happened, which
 * is how a register is read (owner ruling 2026-10-14, and #1771's question
 * answered in the same move) — not the day the row was typed.
 *
 * Deliberately LOCAL rather than an extension of `src/lib/pagination.ts`:
 * that helper is shared by every other cursor-paginated list here, and none
 * of them folds. Widening it would put a field on the shared payload that
 * only this list can populate.
 */
interface DiaryCursor {
    occurredAt: string;
    treatmentGroupId: string;
}

/**
 * Exported so a test can build a VALID cursor from the implementation rather
 * than hand-rolling the base64, which would drift the moment the payload
 * changed and would leave the cursor tests passing over a shape the code no
 * longer reads.
 */
export function encodeDiaryCursor(c: DiaryCursor): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
}

function decodeDiaryCursor(raw: string | null | undefined): DiaryCursor | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof (parsed as DiaryCursor).occurredAt === 'string' &&
            typeof (parsed as DiaryCursor).treatmentGroupId === 'string' &&
            !Number.isNaN(Date.parse((parsed as DiaryCursor).occurredAt))
        ) {
            return parsed as DiaryCursor;
        }
    } catch {
        // A malformed cursor is treated as no cursor — the first page — rather
        // than as an error. A client that lost its place gets the top of the
        // list, which is recoverable; a 400 on a stale bookmark is not.
    }
    return null;
}

/** `(occurredAt, treatmentGroupId)` strictly after the cursor, descending. */
function diaryCursorWhere(c: DiaryCursor): Prisma.LogEntryWhereInput {
    const at = new Date(c.occurredAt);
    return {
        OR: [
            { occurredAt: { lt: at } },
            { occurredAt: at, treatmentGroupId: { lt: c.treatmentGroupId } },
        ],
    };
}

/**
 * The `treatment` object on a folded ДНЕВНИК row.
 *
 * Scalars come from the REPRESENTATIVE entry the page already fetched — the
 * product, dose, technique, pest and quarantine period are properties of the
 * treatment, so any one of its lines carries them and none costs a query.
 * Only the aggregates need the group.
 *
 * Always an object, never null: a free-hand entry folds to itself and reports
 * `parcelCount: 0`, which is a documented answer. Returning null for it would
 * make "no treatment" and "could not summarise" the same value.
 */
function buildTreatmentSummary(
    entry: {
        occurredAt: Date;
        treatmentGroupId: string;
        recordedInDiary: boolean;
        operationParcel: {
            doseValue: Prisma.Decimal | null;
            targetNote: string | null;
            quarantinePeriodDays: number | null;
            phenophase: string | null;
            product: { name: string; quarantinePeriodDays: number | null } | null;
            doseUnit: { symbol: string } | null;
            task: { operationType: string | null; applicationTechnique: string | null } | null;
        } | null;
    },
    agg: { parcelCount: number; totalAreaHa: number; blockNames: string[] } | undefined,
    permits: { mayDelete: boolean; mayCorrect: boolean },
): Record<string, unknown> {
    const line = entry.operationParcel;
    // The DAY as the FARM sees it, for every row.
    //
    // This was `occurredAt.toISOString().slice(0, 10)`, justified as "reading
    // back the stored UTC midnight" — true of a TREATMENT entry, whose day is
    // written as `Date.UTC(y, mo, d)`, and false of a free-hand entry, whose
    // `occurredAt` is a real instant. For one typed between 00:00 and 03:00
    // in Sofia that slice returns the PREVIOUS day. Found in review by
    // agrent-ios; the same UTC-slice-of-an-instant mistake as the date guard
    // they caught earlier on this issue.
    //
    // `dayKeyInTz` is correct for BOTH: a stored UTC midnight renders as the
    // same calendar day in Sofia (02:00 or 03:00), including across both DST
    // transitions, so one rule covers the two kinds rather than branching on
    // whether a row happens to have lines.
    const occurredOn = dayKeyInTz(entry.occurredAt, FARM_TIME_ZONE);
    const quarantinePeriodDays =
        line?.quarantinePeriodDays ?? line?.product?.quarantinePeriodDays ?? null;

    return {
        treatmentGroupId: entry.treatmentGroupId,
        occurredOn,
        // Whether THIS caller may withdraw it, and whether they may correct it
        // — both computed here rather than left to the client, because the rule
        // has an arm no row can express (see `_treatmentAuthorship`) and an
        // offered «Изтрий» or «Коригирай» that 403s is worse than an absent one.
        //
        // Read these as `=== false`, never `!flag`: an ABSENT field is a row
        // cached before it existed, and the journal list reads through a
        // persistent SWR cache. A stale permit costs one refusal; a stale
        // denial costs a farmer their own record.
        mayDelete: permits.mayDelete,
        mayCorrect: permits.mayCorrect,
        kind: line?.task?.operationType ?? null,
        productName: line?.product?.name ?? null,
        parcelCount: agg?.parcelCount ?? 0,
        totalAreaHa: agg?.totalAreaHa ?? 0,
        blockNames: agg?.blockNames ?? [],
        doseValue: line?.doseValue != null ? Number(line.doseValue) : null,
        doseUnit: line?.doseUnit?.symbol ?? null,
        targetNote: line?.targetNote ?? null,
        applicationTechnique: line?.task?.applicationTechnique ?? null,
        quarantinePeriodDays,
        // Фенофаза/BBCH as captured on the line (#2072), so an entry reopened
        // for editing shows what was saved. Deliberately no `?? product`
        // fallback — see the select.
        phenophase: line?.phenophase ?? null,
        // Computed server-side from the period that applied ON THE DAY, so
        // every client shows the same date and it matches the PDF. Null when
        // no period was captured — never the treatment day itself, which
        // would read as "harvest today".
        earliestHarvestOn:
            quarantinePeriodDays != null
                ? new Date(
                      Date.parse(`${occurredOn}T00:00:00.000Z`) +
                          quarantinePeriodDays * 86_400_000,
                  )
                      .toISOString()
                      .slice(0, 10)
                : null,
        recordedInDiary: entry.recordedInDiary,
    };
}

export interface LogEntryListParams {
    limit?: number;
    cursor?: string;
    filters?: LogEntryFilters;
}

/**
 * Shared include shape for a fully-hydrated journal entry (sans
 * `files` — that link is added per-query in `getById` with an explicit
 * tenant filter, since FileRecord has no [id, tenantId] barrier).
 */
const ENTRY_DETAIL_INCLUDE = {
    quantities: { include: { unit: { select: { id: true, symbol: true, name: true } } } },
    locations: { include: { location: { select: { id: true, name: true } } } },
    // `LogEquipment.asset` since the Equipment merge. Projected as the
    // old equipment shape (`category`) so the detail page renders unchanged.
    equipment: { include: { asset: { select: { id: true, name: true, type: true } } } },
} satisfies Prisma.LogEntryInclude;

/**
 * List include shape (dnevnik #10). Beyond the first-location label + counts,
 * it hydrates the linked `OperationParcel` prescription line so the on-screen
 * journal can render the regulated Bulgarian field-logbook columns — parcel +
 * culture, product + active ingredient, dose, treated area, PHI (карантинен
 * срок), and the БАБХ operation type — sourced from the SAME data the ДНЕВНИК
 * PDF (`farm-record-diary.ts`) prints. Free-hand entries with no operation
 * line simply leave those columns blank. `notes` + `conditionsJson` come back
 * as plain LogEntry scalars (this is an `include`, not a `select`).
 */
const ENTRY_LIST_INCLUDE = {
    locations: { include: { location: { select: { id: true, name: true } } } },
    operationParcel: {
        select: {
            doseValue: true,
            targetNote: true,
            parcel: { select: { name: true, cropType: true, areaHa: true } },
            // The LINE's own period first (#1775); the product is the
            // fallback for lines written before that column existed. Selected
            // here so the list's earliest-harvest day is computed from the
            // same source as the PDF's — two readers of one number must not
            // disagree about which number it is.
            quarantinePeriodDays: true,
            // Фенофаза/BBCH (#2072). NO product fallback, unlike the period
            // above: a growth stage is an observation of the CROP on a day
            // and has no product-level analogue to fall back to, so a null
            // here means "not captured" and nothing else can supply it.
            phenophase: true,
            product: { select: { name: true, activeIngredient: true, quarantinePeriodDays: true } },
            doseUnit: { select: { symbol: true } },
            task: { select: { operationType: true, applicationTechnique: true } },
        },
    },
    _count: { select: { quantities: true, files: true } },
} satisfies Prisma.LogEntryInclude;

/**
 * Journal repository — LogEntry + its LogQuantity / LogLocation /
 * LogEquipment / LogEntryFile rows, tenant-scoped.
 *
 * LogEntry is NOT registered with the Prisma soft-delete middleware
 * (`SOFT_DELETE_MODELS` in `src/lib/soft-delete.ts`), so this
 * repository handles the soft-delete trio EXPLICITLY: reads filter
 * `deletedAt: null`, `delete` stamps `deletedAt` instead of removing
 * the row, and `purge` is the only hard-delete path.
 */
export class JournalRepository {
    // ─── Reads ───────────────────────────────────────────────────────

    /**
     * The FLAT read: every matching entry, newest work first, capped at 200.
     *
     * `occurredAt` and then `id`, and the tiebreak is contractual rather than
     * tidy (#1771, the same class as #1742 for parcels).
     *
     * `occurredAt` on a diary entry is a DAY — a treatment stores
     * `Date.UTC(y, mo, d)` — so every entry recorded for the same day ties,
     * and a farm records several. With `take: 200` and no tiebreak, Postgres
     * may return a different subset of a tied group between two identical
     * requests: an entry near the cap can be present in one read and absent
     * from the next with nothing changed. The offline outbox replay reads this
     * branch, so "the same request answered differently" is not academic
     * there.
     *
     * Ordering here matches `listPaginated`, which pairs `occurredAt` with
     * `treatmentGroupId` because it folds treatments. This one returns rows,
     * so `id` is its total key. The two branches agreed on the COLUMN as of
     * the owner's ruling of 2026-10-14; this makes them agree on being
     * deterministic.
     */
    static async list(db: PrismaTx, ctx: RequestContext, filters?: LogEntryFilters) {
        const where = JournalRepository._buildWhere(ctx, filters);
        return db.logEntry.findMany({
            where,
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            include: ENTRY_LIST_INCLUDE,
            take: 200,
        });
    }

    /**
     * The ДНЕВНИК list: ONE row per treatment, folded server-side (#1740).
     *
     * A treatment writes one `INPUT_APPLICATION` entry per line — twelve
     * parcels in three blocks is twelve entries — and the register shows one
     * row. Client folding is impossible because a page boundary can split a
     * treatment, so the fold is `distinct: ['treatmentGroupId']` and happens
     * IN the query: collapsing rows after `take: limit + 1` would shrink the
     * page and make `hasNextPage` wrong, turning the fold into a pagination
     * bug. Same note P5.2b's thread list and #1655's browse filter carry.
     *
     * The row stays ENTRY-SHAPED — `id`, `type`, `status` at the top level,
     * detail in `treatment` (owner ruling). Every phone build in use decodes
     * each row as an entry needing those three, and one row without them
     * fails the whole list while the Дневник is the launch screen. The `id` is
     * a real `LogEntry` id, so an old build's tap opens the existing
     * entry-detail read rather than 404ing.
     *
     * Ordering and the cursor are `(occurredAt, treatmentGroupId)` — see
     * `DiaryCursor`. Not `(createdAt, id)`: a cursor naming a ROW cannot skip
     * a folded group, and 3 treatments paged 2 at a time came back as 6 rows.
     *
     * Two queries, both bounded by the page: the folded page, then one read
     * for its groups' aggregates. Never per row.
     */
    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: LogEntryListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = JournalRepository._buildWhere(ctx, params.filters);

        // `andClause`, never assignment: the `q` search already owns
        // `where.OR`, and an assignment here would be silently discarded and
        // WIDEN the result — the collision that made `where.OR` unusable for
        // the manual-only rule.
        const cursor = decodeDiaryCursor(params.cursor);
        if (cursor) andClause(where, diaryCursorWhere(cursor));

        const items = await db.logEntry.findMany({
            where,
            distinct: ['treatmentGroupId'],
            orderBy: [{ occurredAt: 'desc' }, { treatmentGroupId: 'desc' }],
            take: limit + 1,
            include: ENTRY_LIST_INCLUDE,
        });

        const hasNextPage = items.length > limit;
        const page = hasNextPage ? items.slice(0, limit) : items;
        const last = page[page.length - 1];
        const nextCursor =
            hasNextPage && last
                ? encodeDiaryCursor({
                      occurredAt: last.occurredAt.toISOString(),
                      treatmentGroupId: last.treatmentGroupId,
                  })
                : undefined;

        const handles = page.map((e) => e.treatmentGroupId);
        const aggregates = await JournalRepository._treatmentAggregates(db, ctx, handles);
        const authorship = await JournalRepository._treatmentAuthorship(db, ctx, handles);

        return {
            items: page.map((e) => ({
                ...e,
                treatment: buildTreatmentSummary(
                    e,
                    aggregates.get(e.treatmentGroupId),
                    // The 403 arm AND the 409 arm, because the control has to
                    // be absent for both. A treatment with no tasks under its
                    // handle — a free-hand entry folding to itself — has no
                    // author to compare against, so it is neither deletable nor
                    // correctable through the treatment route at all.
                    //
                    // TWO flags from one authorship lookup, and they are
                    // separate fields even though the two rules agree TODAY.
                    // #2280 asks the owner whether to narrow deletion now that
                    // a withdrawal is irreversible; if it narrows, a client
                    // reusing `mayDelete` for «Коригирай» would silently hide
                    // the correction from the creators who may still correct.
                    // Asked for by the agrent-ios session before it built the
                    // control on the wrong flag.
                    (() => {
                        const a = authorship.get(e.treatmentGroupId);
                        if (!a || a.mixedAuthorship) return { mayDelete: false, mayCorrect: false };
                        return {
                            mayDelete: canDeleteTreatment(ctx, a),
                            mayCorrect: canEditTreatment(ctx, a),
                        };
                    })(),
                ),
            })),
            pageInfo: { nextCursor, hasNextPage },
        };
    }

    /**
     * Per-treatment aggregates for ONE page of folded rows.
     *
     * ## Why this is raw SQL, having rejected raw SQL for the fold
     *
     * The fold itself stays in Prisma because its `where` is the journal's
     * manual-only rule, and a second hand-written copy of that rule is how
     * the journal's semantics drift — it took a DB-backed test to pin down
     * because Prisma's `NOT: { a, b }` is not obvious.
     *
     * This query has no such clause. The page has already decided WHICH
     * treatments to summarise, so the predicate is `tenantId` + `handle IN
     * (…)` and nothing else. There is nothing here to drift from.
     *
     * ## It replaced a bounded `findMany`, which was silently wrong
     *
     * The first version read the page's lines with `take: 2000` and
     * aggregated in memory. The bound applied to the page's ENTRIES across
     * all its groups, with no ordering — so once a page held more than 2000
     * lines (50 rows of 40 parcels is enough), arbitrary groups came back
     * PARTIAL: `parcelCount`, `totalAreaHa` and `blockNames` all too small,
     * with nothing saying so, and a group cut out entirely got
     * `treatment: null` — contradicting this list's own documented promise
     * that an entry with no treatment reports `parcelCount: 0`.
     *
     * "12 parcels" on a treatment that covered 30 is the wrong number to be
     * quiet about in a compliance register. Found in review by agrent-ios
     * before it merged.
     *
     * `GROUP BY` has no such bound: it returns one row per handle, so the
     * result is bounded by the PAGE SIZE rather than by the parcels behind
     * it, and every figure is exact. The scalars a treatment shows — product,
     * dose, technique, pest, quarantine period — are taken from the
     * REPRESENTATIVE row the page already fetched, so they cost no query at
     * all.
     */
    /**
     * Who recorded each treatment on ONE page, and whether that answer is
     * SINGLE — the two facts `mayDelete` needs.
     *
     * Authorship lives on `Task.createdByUserId`, and a treatment is N tasks
     * (one per block), so the question cannot be answered from the `LogEntry`
     * row the fold already holds. Every task of one treatment is written by one
     * person in one request, so the normal answer is one creator — but a reused
     * handle would make it several, and then "who may delete this" has no
     * single answer and the usecase refuses with `TREATMENT_MIXED_AUTHORSHIP`
     * (409) for ADMINS TOO. That is the arm no client can see, which is why
     * `mayDelete` is computed on the server rather than left to a
     * `createdByUserId` field on the row.
     *
     * A `groupBy` rather than raw SQL: the predicate is `tenantId` + `handle IN
     * (…)` over `@@index([tenantId, treatmentGroupId])` and the shape is one
     * row per (handle, author), so it is bounded by the PAGE like its sibling
     * above and never by the tasks behind it.
     *
     * `deletedAt: null` matches what this list shows. There is no withdrawn
     * listing to keep in step with any more: «Кошче» went on 2026-10-24 and a
     * withdrawn treatment's rows are deleted outright.
     */
    private static async _treatmentAuthorship(
        db: PrismaTx,
        ctx: RequestContext,
        handles: string[],
    ): Promise<Map<string, { createdByUserId: string | null; mixedAuthorship: boolean }>> {
        const out = new Map<string, { createdByUserId: string | null; mixedAuthorship: boolean }>();
        if (handles.length === 0) return out;

        const rows = await db.task.groupBy({
            by: ['treatmentGroupId', 'createdByUserId'],
            where: {
                tenantId: ctx.tenantId,
                treatmentGroupId: { in: handles },
                deletedAt: null,
            },
        });

        for (const row of rows) {
            const handle = row.treatmentGroupId;
            if (!handle) continue;
            const seen = out.get(handle);
            if (seen) {
                // A SECOND author for this handle. Keep the first id rather
                // than nulling it: the flag is what decides, and the id stays
                // useful to a reader diagnosing the reuse.
                seen.mixedAuthorship = true;
                continue;
            }
            out.set(handle, { createdByUserId: row.createdByUserId, mixedAuthorship: false });
        }

        return out;
    }

    private static async _treatmentAggregates(
        db: PrismaTx,
        ctx: RequestContext,
        handles: string[],
    ): Promise<Map<string, { parcelCount: number; totalAreaHa: number; blockNames: string[] }>> {
        const out = new Map<string, { parcelCount: number; totalAreaHa: number; blockNames: string[] }>();
        if (handles.length === 0) return out;

        const rows = await db.$queryRaw<
            Array<{
                handle: string;
                parcelCount: number;
                totalAreaHa: number | null;
                blockNames: string[] | null;
            }>
        >(Prisma.sql`
            SELECT le."treatmentGroupId"                        AS "handle",
                   COUNT(op."id")::int                          AS "parcelCount",
                   -- The TREATED area per line, falling back to the parcel's
                   -- (#2072 part B). The register prints the same expression
                   -- per row, and this file already records why that matters:
                   -- two readers of one number must not disagree about which
                   -- number it is. Summing the parcel area here while the PDF
                   -- prints the treated area would make the list report more
                   -- hectares than the document a farmer submits.
                   COALESCE(SUM(COALESCE(op."treatedAreaHa", p."areaHa")), 0)::float8
                                                                AS "totalAreaHa",
                   COALESCE(
                       ARRAY_AGG(DISTINCT loc."name")
                           FILTER (WHERE loc."name" IS NOT NULL),
                       ARRAY[]::text[]
                   )                                            AS "blockNames"
              FROM "LogEntry" le
              LEFT JOIN "OperationParcel" op ON op."id" = le."operationParcelId"
              LEFT JOIN "Parcel"          p  ON p."id"  = op."parcelId"
              LEFT JOIN "Location"        loc ON loc."id" = p."locationId"
             WHERE le."tenantId" = ${ctx.tenantId}
               AND le."deletedAt" IS NULL
               AND le."treatmentGroupId" IN (${Prisma.join(handles)})
             GROUP BY le."treatmentGroupId"
        `);

        for (const r of rows) {
            out.set(r.handle, {
                // LEFT JOIN + COUNT of the JOINED column, so an entry with no
                // operation line counts 0 rather than 1 — which is what makes
                // a free-hand entry report `parcelCount: 0` as documented.
                parcelCount: r.parcelCount,
                totalAreaHa: Math.round((r.totalAreaHa ?? 0) * 1e4) / 1e4,
                blockNames: [...(r.blockNames ?? [])].sort(),
            });
        }
        return out;
    }

    private static _buildWhere(ctx: RequestContext, filters?: LogEntryFilters): Prisma.LogEntryWhereInput {
        const where: Prisma.LogEntryWhereInput = { tenantId: ctx.tenantId, deletedAt: null };

        // MANUAL ENTRIES ONLY, unless a caller explicitly asks otherwise.
        // Owner ruling 2026-10-10, unchanged in intent.
        //
        // What changed (#1740) is the TEST. This used to read
        // `operationParcelId IS NULL`, and the comment here said that column
        // was "the only thing distinguishing a task-written entry from one a
        // person typed". That was true when it was written and is not any
        // more, so it is replaced rather than left to mislead.
        //
        // `recordInputApplication` still sets `operationParcelId` on the
        // INPUT_APPLICATION entry it writes for a completed spray line, and
        // such a row must still be hidden. But the two-step treatment record
        // is typed by a person IN the diary and ALSO writes operation lines,
        // because those lines are what the BABH diary PDF reads. So the FK
        // answers "is this linked to an operation line" and `recordedInDiary`
        // answers "did a person record it here" — one question until it
        // became two.
        //
        // The disjunction, not a replacement: an entry with no operation line
        // is still manual, which is the overwhelming majority of rows and
        // needs no flag. `recordedInDiary` only rescues the rows the FK test
        // would wrongly hide.
        //
        // Default-false on the column is what makes this safe to deploy: every
        // existing row keeps the visibility the 2026-10-10 ruling gave it.
        //
        // Stated as a NEGATION of the thing being hidden, which is both the
        // clearest reading and the least invasive shape.
        //
        // The rule is "hide what a task wrote", and a task-written row is
        // exactly `operationParcelId IS NOT NULL AND NOT recordedInDiary`. So
        // negating that pair says it directly, rather than enumerating the
        // two ways a row qualifies as manual.
        //
        // `NOT`, not `OR` and not `AND`. Both of those are contested here:
        // `where.OR` belongs to the `q` free-text search a few lines down and
        // is ASSIGNED, so writing it here would be silently discarded the
        // moment anyone typed a search term — and the failure would WIDEN the
        // result, un-hiding every task-written entry in the farm. `where.AND`
        // is shared by the crop, location and cursor clauses, so adding to it
        // works but makes this rule a term in a list three other filters read
        // and the pagination code appends to. `where.NOT` is used by nothing
        // else in this builder, so the rule owns its own key and cannot be
        // clobbered or clobber anything.
        //
        // Default-false on the column is what makes this safe to deploy: for
        // every existing row `recordedInDiary` is false, so the negated pair
        // reduces to `operationParcelId IS NOT NULL` — the exact 2026-10-10
        // behaviour, unchanged until something sets the flag.
        if (filters?.includeTaskWritten !== true) {
            where.NOT = { operationParcelId: { not: null }, recordedInDiary: false };
        }

        // Guarded on `.length`: a CLEARED facet must OMIT the filter —
        // `{ in: [] }` matches nothing and would blank the table.
        if (filters?.type?.length) where.type = { in: filters.type };
        if (filters?.status?.length) where.status = { in: filters.status };
        if (filters?.occurredFrom || filters?.occurredTo) {
            where.occurredAt = {
                ...(filters.occurredFrom ? { gte: new Date(filters.occurredFrom) } : {}),
                ...(filters.occurredTo ? { lte: new Date(filters.occurredTo) } : {}),
            };
        }
        if (filters?.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { notes: { contains: filters.q, mode: 'insensitive' } },
            ];
        }
        // Culture (crop) — matches entries whose operation line sits on a
        // parcel of that crop. Free-hand entries (no operation line) don't
        // match, which is the intended agronomic-only scope. Accepts a
        // comma-separated multi-select.
        // crop used to split the comma-joined param HERE; parsing now
        // happens at the route like every other facet, so the repository
        // only ever sees a validated array.
        if (filters?.crop?.length) {
            andClause(where, {
                OR: [
                    // Path 1 — the entry's own operation line. Only the
                    // `includeTaskWritten` opt-in reaches these now, which is
                    // why this arm is NOT dead: `satellite-briefing` filters
                    // by crop over task-written entries.
                    {
                        operationParcel: {
                            is: { parcel: { is: { cropType: { in: filters.crop } } } },
                        },
                    },
                    // Path 2 — the crops of the blocks the entry is linked to.
                    //
                    // Owner ruling 2026-10-10: a manual entry linked to block X
                    // matches crop Y when a LIVE parcel of X grows Y. Without
                    // this, `?crop=` returns NOTHING on a manual-only journal,
                    // because every entry path 1 can match is hidden — so the
                    // filter would look functional and answer empty.
                    //
                    // `deletedAt: null` is the owner's word "live" doing work:
                    // a soft-deleted parcel keeps its last `cropType`, so
                    // omitting it would match a block on a crop it stopped
                    // growing.
                    //
                    // Compared RAW, not normalised. `Parcel.cropType` holds the
                    // picker's capitalised values (`'Wheat'`, `'Canola'`) while
                    // the market vocabulary is lowercase slugs, and the phone
                    // already sends every stored spelling under one label
                    // («Пшеница» -> `Wheat,wheat`) built from the farm's own
                    // parcels. Raw keeps that contract working with no client
                    // release; normalising is a later pure widening.
                    {
                        locations: {
                            some: {
                                location: {
                                    is: {
                                        parcels: {
                                            some: {
                                                cropType: { in: filters.crop },
                                                deletedAt: null,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                ],
            });
        }
        // Location — a «блок» in the owner's words: "a collection of parcels,
        // the one uploaded in the shape files". TWO paths reach one, and only
        // the first was matched.
        //
        //   1. LogLocation — an entry a person explicitly linked to the block.
        //   2. operationParcel → parcel → locationId — an entry attached to an
        //      operation LINE, which names a parcel, which belongs to a block.
        //
        // Path 2 is where the bulk of a ДНЕВНИК lives. The INPUT_APPLICATION
        // entry the spray flow writes (`inventory.ts`, the
        // `createLogEntryWithAudit` call) passes `operationParcelId: line.id`
        // and NO `locationIds`, so every automatic spray record was invisible
        // to `?locationId=`. A farmer filtering their journal by block saw only
        // the hand-linked entries and no indication the rest existed — the
        // worst shape for a regulatory record, since an incomplete ДНЕВНИК
        // reads exactly like a complete one.
        //
        // The tell was that `crop` and `locationId` disagreed about which
        // entries belong to a block: `crop` already matches through
        // `operationParcel` (just above), so the same spray record was
        // reachable by crop and unreachable by block.
        //
        // `AND`, not `OR`, and that is load-bearing: `where.OR` is already
        // taken by the `q` free-text search a dozen lines up, so assigning
        // `where.OR` here would silently discard the search and return the
        // whole block — a filter that WIDENS when you add a term to it.
        //
        // Assigning `AND` is safe because the one other writer accumulates:
        // `listPaginated` appends its cursor predicate with
        // `if (where.AND) { push } else { assign }`, so a paginated read keeps
        // this clause on page two. That ordering is the whole reason the
        // cursor code is written defensively; do not "simplify" it to an
        // assignment, or the second page of a block-filtered journal becomes
        // the second page of the WHOLE journal.
        if (filters?.locationId) {
            andClause(where, {
                OR: [
                    { locations: { some: { locationId: filters.locationId } } },
                    {
                        operationParcel: {
                            is: { parcel: { is: { locationId: filters.locationId } } },
                        },
                    },
                ],
            });
        }
        // Crop plan — entries linked (LogPlanting) to a planting of this plan.
        // LogEntry → plantings (LogPlanting[]) → planting (Planting).cropPlanId.
        if (filters?.cropPlanId) {
            where.plantings = { some: { planting: { is: { cropPlanId: filters.cropPlanId } } } };
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                ...ENTRY_DETAIL_INCLUDE,
                files: {
                    where: { tenantId: ctx.tenantId },
                    include: { fileRecord: true },
                    orderBy: { createdAt: 'asc' },
                },
            },
        });
    }

    /** Find including soft-deleted rows — for restore / purge. */
    static async getByIdWithDeleted(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.logEntry.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true, tenantId: true, deletedAt: true, title: true },
        });
    }

    // ─── Validation helpers ──────────────────────────────────────────

    /** Returns the subset of the given location ids that belong to the tenant. */
    static async validLocationIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        if (!ids.length) return new Set();
        // Bounded by the caller's id set (Create/UpdateLogEntry Zod caps
        // locationIds at 100) — `take` makes the bound explicit so the
        // unbounded-findMany guardrail stays satisfied.
        const rows = await db.location.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            select: { id: true },
            take: ids.length,
        });
        return new Set(rows.map((r) => r.id));
    }

    /**
     * Returns the subset of the given equipment ids that belong to the
     * tenant. Since the `Equipment` merge these are `Asset` ids, and the
     * check also enforces machine-SHAPED — a caller cannot attach a barn
     * or a retired tractor to a journal entry.
     */
    static async validEquipmentIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        return AssetRepository.validMachineIds(db, ctx, ids);
    }

    /** Returns the subset of the given parcel ids that belong to the tenant. */
    static async validParcelIds(db: PrismaTx, ctx: RequestContext, ids: string[]): Promise<Set<string>> {
        if (!ids.length) return new Set();
        // Bounded by the caller's id set (farm-task Zod caps parcelIds at 100).
        const rows = await db.parcel.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
            take: ids.length,
        });
        return new Set(rows.map((r) => r.id));
    }

    /**
     * List the tenant's active machines (newest first) for pickers.
     * Delegates to the asset register since the `Equipment` merge — kept
     * here so existing journal call sites don't all have to move.
     */
    static async listEquipment(db: PrismaTx, ctx: RequestContext, take = 200) {
        return AssetRepository.listMachines(db, ctx, take);
    }

    // ─── Mutations ───────────────────────────────────────────────────

    static async createLogEntry(db: PrismaTx, ctx: RequestContext, input: CreateLogEntryInput) {
        return db.logEntry.create({
            data: {
                tenantId: ctx.tenantId,
                type: input.type,
                status: input.status ?? 'DONE',
                occurredAt: input.occurredAt ?? new Date(),
                title: input.title,
                // Written together with the rendering above, never apart:
                // a descriptor whose params disagree with the stored string
                // is worse than no descriptor at all.
                titleKey: input.titleKey ?? null,
                titleParams:
                    input.titleParams === undefined || input.titleParams === null
                        ? Prisma.DbNull
                        : input.titleParams,
                notes: input.notes ?? null,
                ...(input.conditionsJson !== undefined ? { conditionsJson: input.conditionsJson } : {}),
                operationParcelId: input.operationParcelId ?? null,
                recordedInDiary: input.recordedInDiary ?? false,
            // Omitted rather than defaulted: the column is NOT NULL with its
            // own unique default, so writing `undefined` would be wrong and
            // writing a chosen fallback would put every un-grouped entry in
            // ONE group — the ghost-row collapse the NOT NULL exists to stop.
            ...(input.treatmentGroupId ? { treatmentGroupId: input.treatmentGroupId } : {}),
                ...(input.costAmount != null ? { costAmount: input.costAmount } : {}),
                costCurrency: input.costCurrency ?? null,
                clientMutationId: input.clientMutationId ?? null,
                createdByUserId: ctx.userId ?? null,
                ...(input.quantities && input.quantities.length
                    ? {
                          quantities: {
                              // tenantId is populated by Prisma from the parent
                              // via the composite [logEntryId, tenantId] relation
                              // FK — passing it explicitly is rejected.
                              create: input.quantities.map((q) => ({
                                  measure: q.measure,
                                  value: q.value,
                                  unitId: q.unitId,
                                  label: q.label ?? null,
                              })),
                          },
                      }
                    : {}),
                ...(input.locationIds && input.locationIds.length
                    ? {
                          locations: {
                              create: input.locationIds.map((locationId) => ({
                                  tenantId: ctx.tenantId,
                                  locationId,
                              })),
                          },
                      }
                    : {}),
                ...(input.equipmentIds && input.equipmentIds.length
                    ? {
                          equipment: {
                              create: input.equipmentIds.map((assetId) => ({
                                  tenantId: ctx.tenantId,
                                  assetId,
                              })),
                          },
                      }
                    : {}),
                ...(input.plantingLinks && input.plantingLinks.length
                    ? {
                          plantings: {
                              // tenantId is populated by Prisma from the parent
                              // LogEntry via the composite [logEntryId, tenantId]
                              // relation FK — and because LogPlanting.planting
                              // ALSO keys on tenantId, passing it explicitly is
                              // rejected ("Unknown argument tenantId"). Provide
                              // only plantingId + stage; tenantId flows from the
                              // parent (mirrors the `quantities` nested create).
                              create: input.plantingLinks.map((p) => ({
                                  plantingId: p.plantingId,
                                  stage: p.stage,
                              })),
                          },
                      }
                    : {}),
            },
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    /**
     * Offline exactly-once — fetch the entry a replayed request already minted
     * (same outbox id → same idempotency key), in the SAME shape `createLogEntry`
     * returns, so a re-send yields the original 201 body and no duplicate row.
     */
    static async findByClientMutationId(db: PrismaTx, ctx: RequestContext, clientMutationId: string) {
        return db.logEntry.findFirst({
            where: { tenantId: ctx.tenantId, clientMutationId },
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    static async updateLogEntry(db: PrismaTx, ctx: RequestContext, id: string, input: UpdateLogEntryInput) {
        // Scalar fields. `undefined` leaves a field untouched; explicit
        // null clears the nullable columns.
        const data: Prisma.LogEntryUncheckedUpdateInput = {};
        if (input.type !== undefined) data.type = input.type;
        if (input.title !== undefined) data.title = input.title;
        if (input.occurredAt !== undefined) data.occurredAt = input.occurredAt;
        if (input.status !== undefined) data.status = input.status;
        if (input.notes !== undefined) data.notes = input.notes;
        if (input.operationParcelId !== undefined) data.operationParcelId = input.operationParcelId;
        if (input.costAmount !== undefined) data.costAmount = input.costAmount;
        if (input.costCurrency !== undefined) data.costCurrency = input.costCurrency;

        // Child-collection replaces — only when the caller supplied the
        // array. `deleteMany` then `create` gives full-replace semantics
        // in one transaction (the wrapping usecase runs inside one tx).
        if (input.quantities !== undefined) {
            data.quantities = {
                deleteMany: {},
                create: input.quantities.map((q) => ({
                    measure: q.measure,
                    value: q.value,
                    unitId: q.unitId,
                    label: q.label ?? null,
                })),
            };
        }
        if (input.locationIds !== undefined) {
            data.locations = {
                deleteMany: {},
                create: input.locationIds.map((locationId) => ({
                    tenantId: ctx.tenantId,
                    locationId,
                })),
            };
        }
        if (input.equipmentIds !== undefined) {
            data.equipment = {
                deleteMany: {},
                create: input.equipmentIds.map((assetId) => ({
                    tenantId: ctx.tenantId,
                    assetId,
                })),
            };
        }

        return db.logEntry.update({
            where: { id },
            data,
            include: {
                quantities: true,
                locations: true,
                equipment: true,
            },
        });
    }

    /**
     * Delete an entry outright — cascades to LogQuantity / LogLocation /
     * LogEquipment / LogEntryFile.
     *
     * This was three methods until 2026-10-24: `softDelete` stamped
     * `deletedAt`, `restore` cleared it, and `purge` did what this one does
     * now. The owner removed «Кошче» — "what's deleted is deleted" — so the
     * flag has no reader and the other two have no purpose.
     *
     * `LogEntry` is NOT in `SOFT_DELETE_MODELS`, so this really is a delete.
     * That matters: on a model that IS in the allowlist, the extension would
     * rewrite it into a `deletedAt` update and nothing would cascade. See
     * #2242 — a `Task` delete reads exactly like this one and behaves
     * differently.
     */
    static async hardDelete(db: PrismaTx, ctx: RequestContext, id: string) {
        await db.logEntry.delete({ where: { id } });
        return true;
    }

    // ─── File links (photo logging) ──────────────────────────────────

    static async attachFile(
        db: PrismaTx,
        ctx: RequestContext,
        logEntryId: string,
        fileRecordId: string,
        caption?: string | null,
    ) {
        return db.logEntryFile.create({
            data: {
                tenantId: ctx.tenantId,
                logEntryId,
                fileRecordId,
                caption: caption ?? null,
            },
            include: { fileRecord: true },
        });
    }

    static async getFileLink(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        return db.logEntryFile.findFirst({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
            select: { id: true },
        });
    }

    /**
     * Full link row (with its FileRecord) for a (logEntry, fileRecord) pair —
     * used by the idempotent-upload path to return the ORIGINAL link when a
     * replayed photo re-attaches identical bytes, instead of a duplicate.
     */
    static async findFileLink(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        return db.logEntryFile.findFirst({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
            include: { fileRecord: true },
        });
    }

    static async detachFile(db: PrismaTx, ctx: RequestContext, logEntryId: string, fileRecordId: string) {
        await db.logEntryFile.deleteMany({
            where: { logEntryId, fileRecordId, tenantId: ctx.tenantId },
        });
        return true;
    }
}
