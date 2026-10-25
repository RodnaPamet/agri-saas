/**
 * Read a campaign's activities for «ДНЕВНИК НА СТОПАНСТВОТО» — #2316.
 *
 * The query half. All the row-shaping decisions live in `./rows.ts` and are
 * tested without a database; this module's job is to fetch exactly what that
 * needs and nothing else.
 *
 * ## «Продукция» needs a TWO-PART filter, and either half alone is wrong
 *
 * The harvest quantity reaches a line through
 * `OperationParcel` → `LogEntry.operationParcelId` → `LogQuantity`. That path
 * works, and what it returns is not produce. Measured on production:
 *
 *     entry type          measure   count
 *     INPUT_APPLICATION   VOLUME      6
 *     INPUT_APPLICATION   WEIGHT      6
 *
 * **Zero harvest entries carry a quantity.** All twelve belong to sprays or
 * fertilisings. An unfiltered join would print six product weights as produce
 * — one of them `811,95`, the kg of preparation applied — and six water
 * VOLUMES in a kilograms column. Both are misstatements rather than gaps, and
 * neither looks wrong: the numbers are plausible and the column is right.
 *
 * So BOTH conditions, because each covers a different leak:
 *
 *   - `measure: 'WEIGHT'` alone still admits the six product weights; they
 *     genuinely are weights.
 *   - `type: 'HARVEST'` alone still admits a harvest counted in crates or
 *     litres, printing a count as кг. `recordYieldFromHarvest` refuses
 *     non-mass units dimensionally rather than reinterpreting them, which is
 *     the same judgement.
 *
 * ## Quantities are AGGREGATED, not assumed unique
 *
 * 19 join rows for 19 distinct lines means at most one quantity per linked
 * entry today, but `LogQuantity` is one-to-many per `LogEntry` by schema — a
 * spray legitimately carries both a product weight and a water volume. Summing
 * rather than taking the first keeps the first two-quantity entry from
 * duplicating its diary row.
 *
 * ## Completion is per LINE, not per task
 *
 * `OperationParcel` carries its own `completedAt`, and the window filters on
 * that. A task can have lines finished on different days, which is exactly
 * what the template's date RANGE (`01-05.02.2025`) is for; filtering on
 * `Task.completedAt` would collapse that to one day or drop the task entirely.
 */
import type { RequestContext } from '@/app-layer/types';
import { assertCanRead } from '@/app-layer/policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import { ACTIVITY_LABELS_BG } from '@/lib/operations/activity-labels';
import { campaignWindow } from '@/lib/reports/campaign-window';
import { buildCampaignRows, type DiaryLineInput } from './rows';
import type { CampaignDiaryData } from '@/app-layer/reports/pdf/campaign-diary';

/**
 * `REGISTER_EMPTY_FOR_PERIOD` is passed as a LITERAL below, not through a
 * constant, and that is the convention rather than an oversight.
 *
 * `a-new-code-ships-with-its-entry` (#1677) reads refusal codes OUT of their
 * call sites so it can check each has a Bulgarian entry. A constant makes the
 * call opaque to it — the guard then demands the site be declared as
 * unreadable, which buys an exemption instead of a check. It caught this file
 * on arrival, when it had its own `export const` duplicating the one in
 * `farm-record-diary.ts`.
 *
 * The canonical constant lives there (`farm-record-diary.ts`), for callers
 * that need to COMPARE against a thrown code; this module only throws, so it
 * needs no constant of its own and a second definition of the same string
 * would be a second source of truth for it.
 *
 * The code already carries both locales — bg «Няма записи за този период.» —
 * so this adds no catalogue entry.
 */

const dec = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v as { toString(): string });

export async function gatherCampaignDiary(
    ctx: RequestContext,
    campaignLabel: string,
): Promise<CampaignDiaryData> {
    // Same privilege model as the per-location and season routes: authorised
    // inside the gatherer, no `requirePermission`.
    assertCanRead(ctx);

    // Throws InvalidCampaignError on a malformed label, before any query.
    const window = campaignWindow(campaignLabel);

    return runInTenantContext(ctx, async (db) => {
        const lines = await db.operationParcel.findMany({
            // The LINE's own completedAt — see the module docblock.
            where: {
                completedAt: { gte: window.startsAt, lt: window.endsAtExclusive },
            },
            select: {
                id: true,
                taskId: true,
                parcelId: true,
                completedAt: true,
                treatedAreaHa: true,
                doseValue: true,
                task: { select: { operationType: true, treatmentGroupId: true } },
                parcel: { select: { name: true, cropType: true, areaHa: true } },
                product: { select: { name: true } },
                doseUnit: { select: { symbol: true } },
            },
        });

        if (lines.length === 0) {
            throw codedNotFound(
                'REGISTER_EMPTY_FOR_PERIOD',
                `Няма записи за кампания ${campaignLabel}.`,
            );
        }

        // Produce, under BOTH filters. Fetched separately rather than as a
        // nested include so the two conditions are visible at the call site
        // instead of buried in a relation filter.
        const produce = await db.logEntry.findMany({
            where: {
                operationParcelId: { in: lines.map((l) => l.id) },
                type: 'HARVEST',
                deletedAt: null,
                quantities: { some: { measure: 'WEIGHT' } },
            },
            select: {
                operationParcelId: true,
                quantities: {
                    where: { measure: 'WEIGHT' },
                    // The VALUE only. `label` is «Общо за мероприятието» — a
                    // note that the figure is the activity's total, not this
                    // parcel's yield — and reading it as the produce kind
                    // printed that note in the «Продукция / Вид» column.
                    select: { value: true },
                },
            },
        });

        // Summed per line, because LogQuantity is one-to-many by schema.
        const kgByLine = new Map<string, number>();
        for (const e of produce) {
            if (!e.operationParcelId) continue;
            const total = e.quantities.reduce((s, q) => s + (dec(q.value) ?? 0), 0);
            kgByLine.set(e.operationParcelId, (kgByLine.get(e.operationParcelId) ?? 0) + total);
        }

        const profile = await db.farmProfile.findFirst({
            select: {
                producerName: true,
                settlement: true,
                municipality: true,
                oblast: true,
            },
        });

        const input: DiaryLineInput[] = lines.map((l) => ({
            treatmentGroupId: l.task?.treatmentGroupId ?? null,
            // The TASK's id, not the line's. `l.id` was here first and would
            // have made every line its own group — the fallback key is
            // `task:<id>`, so a task's several lines would each become a
            // separate row and «Пръскане – 17,05 ха» would print as three
            // rows of one parcel each. Exactly the aggregation this document
            // exists to do, undone by one wrong field.
            taskId: l.taskId,
            operationType: l.task?.operationType ?? null,
            completedAt: l.completedAt,
            parcelId: l.parcelId,
            parcelName: l.parcel?.name ?? '',
            cropName: l.parcel?.cropType ?? null,
            parcelAreaHa: dec(l.parcel?.areaHa),
            treatedAreaHa: dec(l.treatedAreaHa),
            productName: l.product?.name ?? null,
            doseValue: dec(l.doseValue),
            doseUnitSymbol: l.doseUnit?.symbol ?? null,
            produceKg: kgByLine.get(l.id) ?? null,
        }));

        const { rows, skippedIncomplete, rowsWithUnknownArea } = buildCampaignRows(
            input,
            ACTIVITY_LABELS_BG,
        );

        // Reachable even though `lines` was non-empty: every line could be
        // incomplete. The register would then be a header over nothing, which
        // is the state the coded 404 exists to express.
        if (rows.length === 0) {
            throw codedNotFound(
                'REGISTER_EMPTY_FOR_PERIOD',
                `Няма завършени записи за кампания ${campaignLabel}.`,
            );
        }

        return {
            header: {
                producerName: profile?.producerName ?? null,
                settlement: profile?.settlement ?? null,
                municipality: profile?.municipality ?? null,
                oblast: profile?.oblast ?? null,
            },
            campaignLabel: window.label,
            rows,
            skippedIncomplete,
            rowsWithUnknownArea,
        };
    });
}
