/**
 * Resolving and grouping the parcels of a RECORDED day's work — #2316.
 *
 * Shared by the treatment write and the activity write. Both take a flat
 * `parcelIds` list with an optional per-parcel area, and both must do the same
 * four things before writing anything:
 *
 *   1. refuse a future day;
 *   2. refuse an empty parcel list;
 *   3. fetch the parcels and refuse any the tenant does not own;
 *   4. bound each stated area by the parcel's own, at the resolution the
 *      register prints.
 *
 * ## It is NOT yet shared, and that is stated rather than implied
 *
 * `recordDiaryTreatment` still has its own copy of all four steps. This module
 * is used by the ACTIVITY write only, so right now it is a second copy rather
 * than an extraction — which is the thing it exists to prevent, and worth
 * saying plainly instead of letting the docblock imply otherwise.
 *
 * The reason it was not rewired in the same change: in the treatment path those
 * four steps are NOT contiguous. The replay lookup for a resumed write sits
 * between the date check and the parcel fetch, so routing it through one call
 * would move the parcel fetch ahead of the replay lookup and change WHICH
 * refusal a bad request receives first. That is a behaviour change in a
 * regulated write, and it belongs in its own change with its own measurement
 * rather than riding along with a new feature.
 *
 * Converging them is tracked; until then the rules are duplicated, and anyone
 * changing one must change both. The pinned messages are the tripwire that
 * will catch the easy half of a divergence.
 *
 * ## The refusal codes AND their exact English keep the `TREATMENT_` prefix
 *
 * `tests/unit/refusal-codes-read-in-bulgarian.test.ts` pins these message
 * strings, because the English is the fallback a reader with no Bulgarian entry
 * sees. Rewording them to be activity-neutral would have reddened that guard
 * for no gain: the Bulgarian a farmer actually reads is ALREADY neutral —
 * «Мероприятие не може да се записва с бъдеща дата».
 *
 * ## And the prefix itself
 *
 * Consistent with `parseRecordedDay`, and for the same reason: the phone
 * already handles these, the prefix is historical, and renaming them would make
 * a client handle two codes for one condition or lose the old one. They
 * describe the DATE, the PARCEL LIST and the AREA — none of which is specific
 * to a treatment.
 */

import { farmToday } from '@/lib/calendar-day-key';
import { codedBadRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { exceedsParcel } from '@/lib/operations/printed-area';
import { parseRecordedDay } from '@/lib/operations/recorded-day';
import { RequestContext } from '../types';

export interface RecordedParcelsInput {
    occurredOn: string;
    parcelIds: string[];
    parcels?: { parcelId: string; treatedAreaHa: number }[];
}

export interface RecordedParcels {
    /** Midnight UTC on the recorded day. */
    day: Date;
    /** The day as the register writes it, `YYYY-MM-DD`. */
    dayKey: string;
    parcels: { id: string; locationId: string; areaHa: unknown }[];
    /** Stated area per parcel. An ABSENT entry means the whole parcel. */
    treatedByParcel: Map<string, number>;
    /** Parcel ids grouped by the block (`Location`) they sit in. */
    byBlock: Map<string, string[]>;
}

/**
 * ── The four steps, each callable on its own (#2351) ──
 *
 * `resolveRecordedParcels` below composes them in order, which is what the
 * ACTIVITY path wants. The TREATMENT path cannot use the composition, and the
 * reason is specific rather than stylistic: its four steps are not contiguous.
 * A resumed write's replay lookup sits between the empty-list refusal and the
 * parcel fetch, and it can RETURN SUCCESSFULLY —
 *
 *     parse day → future refusal → empty-list refusal
 *       → replay lookup, which returns `replayed: true` for a complete treatment
 *       → parcel fetch + tenant refusal → area bound → block grouping
 *
 * so routing it through one call would move the parcel fetch ahead of the
 * replay. A client retrying a treatment it had already recorded, with one parcel
 * since archived or mistyped, would stop getting its idempotent success and
 * start getting `REFERENCE_NOT_IN_TENANT` — a behaviour change on a resumable
 * write to a regulated document, not a refactor.
 *
 * Owner decision: split to preserve the order exactly. So the treatment path
 * calls these four at its OWN points and the rule lives in one place, which is
 * what the duplicate was costing.
 */

/**
 * Parse the day and refuse a future one.
 *
 * Compared against today AS THE FARM SEES IT, not as the server's UTC clock
 * sees it — and this history is carried here from `recordDiaryTreatment`, whose
 * copy it was, because it is the reason the comparison has the shape it does.
 *
 * That comment once claimed the UTC comparison meant "today" is never refused
 * for a farm whose clock runs ahead of the server's, and it was exactly
 * backwards. `new Date()` with `setUTCHours(23,59,59,999)` is the end of the
 * SERVER's day: at 00:30 on 14 October in Sofia it is 21:30 UTC on the 13th, so
 * `2026-10-14` parsed as UTC midnight sat PAST the end of UTC the 13th and a
 * farmer recording what they had just sprayed got `TREATMENT_DATE_IN_FUTURE`.
 * Every night from local midnight to 03:00 (02:00 in winter), while the screen
 * beside them — rendered through `format-date.ts`, in the same zone — showed
 * that day as today. The guard refused the one day it most needed to allow.
 */
export function assertRecordedDay(occurredOn: string): { day: Date; dayKey: string } {
    const { day, key: dayKey } = parseRecordedDay(occurredOn);
    // String comparison on `YYYY-MM-DD`: fixed-width and zero-padded, so
    // lexicographic order is calendar order, and there is no Date arithmetic to
    // get wrong at a DST boundary.
    if (dayKey > farmToday()) {
        throw codedBadRequest(
            'TREATMENT_DATE_IN_FUTURE',
            'A treatment cannot be recorded for a future date.',
            { field: 'occurredOn' },
        );
    }
    return { day, dayKey };
}

/** Refuse a record with no parcels at all. */
export function assertParcelsChosen(parcelIds: readonly string[]): void {
    if (parcelIds.length === 0) {
        throw codedBadRequest('TREATMENT_NO_PARCELS', 'Select at least one parcel that was treated.', {
            field: 'parcelIds',
        });
    }
}

export interface OwnedParcel {
    id: string;
    locationId: string;
    areaHa: unknown;
}

/**
 * Fetch the parcels and refuse any the tenant does not own.
 *
 * Which block a parcel sits in is the server's to know. A parcel the tenant does
 * not own simply is not returned, so the difference in counts IS the refusal.
 */
export async function resolveOwnedParcels(
    ctx: RequestContext,
    parcelIds: readonly string[],
): Promise<OwnedParcel[]> {
    const parcels = await runInTenantContext(ctx, (db) =>
        db.parcel.findMany({
            where: { id: { in: [...parcelIds] }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, locationId: true, areaHa: true },
        }),
    );
    if (parcels.length !== parcelIds.length) {
        // One code for the whole cross-tenant class (owner ruling), with the
        // entity in `params.reference`. 400 and not 404 deliberately: a 404
        // would confirm the parcel exists in SOME tenant, which is what a
        // cross-tenant probe is for.
        throw codedBadRequest(
            'REFERENCE_NOT_IN_TENANT',
            'One or more chosen parcels were not found or belong to a different tenant',
            { reference: 'parcels' },
        );
    }
    return parcels as OwnedParcel[];
}

/**
 * Bound each stated area by the parcel's own.
 *
 * Bounded at this point because only this point holds the parcel row. The
 * structural half — every `parcels[].parcelId` appearing in `parcelIds`, and no
 * parcel twice — is already refused by `refineParcelAreaList` in the schema.
 *
 * A parcel whose own `areaHa` is NULL has nothing to bound against. Such a line
 * accepts any positive value rather than being refused for a fact nobody
 * recorded: `Parcel.areaHa` is nullable, a farm can hold parcels with no
 * measured area, and refusing would block a legitimate register entry over
 * missing cadastral data.
 */
export function boundTreatedAreas(
    parcels: readonly OwnedParcel[],
    stated: readonly { parcelId: string; treatedAreaHa: number }[] | undefined,
): Map<string, number> {
    const treatedByParcel = new Map<string, number>();
    if (!stated?.length) return treatedByParcel;
    const areaOf = new Map(parcels.map((p) => [p.id, p.areaHa]));
    for (const entry of stated) {
        const area = areaOf.get(entry.parcelId);
        if (area != null && exceedsParcel(entry.treatedAreaHa, Number(area))) {
            throw codedBadRequest(
                'TREATMENT_AREA_EXCEEDS_PARCEL',
                'The treated area cannot exceed the parcel’s own area',
                { reference: 'parcels' },
            );
        }
        treatedByParcel.set(entry.parcelId, entry.treatedAreaHa);
    }
    return treatedByParcel;
}

/**
 * One field operation per block, because the ДНЕВНИК resolves a block through
 * the task's location link: a single task spanning blocks would print a parcel
 * under a block it was never on.
 */
export function groupParcelsByBlock(parcels: readonly OwnedParcel[]): Map<string, string[]> {
    const byBlock = new Map<string, string[]>();
    for (const p of parcels) {
        const list = byBlock.get(p.locationId);
        if (list) list.push(p.id);
        else byBlock.set(p.locationId, [p.id]);
    }
    return byBlock;
}

/**
 * The four steps in order — what the ACTIVITY path wants, where they ARE
 * contiguous.
 *
 * A composition and not a second implementation: every rule lives in the step
 * above, so the treatment path calling the steps individually and this calling
 * them together cannot drift. That drift is what #2351 was about — the module
 * existed to prevent a duplicate and was one.
 */
export async function resolveRecordedParcels(
    ctx: RequestContext,
    input: RecordedParcelsInput,
): Promise<RecordedParcels> {
    const { day, dayKey } = assertRecordedDay(input.occurredOn);
    assertParcelsChosen(input.parcelIds);
    const parcels = await resolveOwnedParcels(ctx, input.parcelIds);
    const treatedByParcel = boundTreatedAreas(parcels, input.parcels);
    const byBlock = groupParcelsByBlock(parcels);
    return { day, dayKey, parcels, treatedByParcel, byBlock };
}
