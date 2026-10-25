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

export async function resolveRecordedParcels(
    ctx: RequestContext,
    input: RecordedParcelsInput,
): Promise<RecordedParcels> {
    const { day, key: dayKey } = parseRecordedDay(input.occurredOn);

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

    if (input.parcelIds.length === 0) {
        throw codedBadRequest('TREATMENT_NO_PARCELS', 'Select at least one parcel that was treated.', {
            field: 'parcelIds',
        });
    }

    // Which block a parcel sits in is the server's to know. A parcel the tenant
    // does not own simply is not returned, so the difference in counts is the
    // refusal.
    const parcels = await runInTenantContext(ctx, (db) =>
        db.parcel.findMany({
            where: { id: { in: input.parcelIds }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, locationId: true, areaHa: true },
        }),
    );
    if (parcels.length !== input.parcelIds.length) {
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

    // Bounded here because only this point holds the parcel row. The structural
    // half — every `parcels[].parcelId` appearing in `parcelIds`, and no parcel
    // twice — is already refused by `refineParcelAreaList` in the schema.
    //
    // A parcel whose own `areaHa` is NULL has nothing to bound against. Such a
    // line accepts any positive value rather than being refused for a fact
    // nobody recorded: `Parcel.areaHa` is nullable, a farm can hold parcels with
    // no measured area, and refusing would block a legitimate register entry
    // over missing cadastral data.
    const treatedByParcel = new Map<string, number>();
    if (input.parcels?.length) {
        const areaOf = new Map(parcels.map((p) => [p.id, p.areaHa]));
        for (const entry of input.parcels) {
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
    }

    // One field operation per block, because the ДНЕВНИК resolves a block
    // through the task's location link: a single task spanning blocks would
    // print a parcel under a block it was never on.
    const byBlock = new Map<string, string[]>();
    for (const p of parcels) {
        const list = byBlock.get(p.locationId);
        if (list) list.push(p.id);
        else byBlock.set(p.locationId, [p.id]);
    }

    return { day, dayKey, parcels, treatedByParcel, byBlock };
}
