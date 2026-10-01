import { RequestContext } from '../types';
import { assertCanViewAdminSettings } from '../policies/admin.policies';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { staleData } from '@/lib/errors/types';
import { isUniqueViolation } from '@/lib/errors/prisma';

/**
 * БАБХ farm-record — the one-per-tenant FarmProfile identity block printed on
 * the "ДНЕВНИК за проведените растителнозащитни мероприятия и торене"
 * (Прил. 1 към заповед РД 11-3194/31.12.2021). Every field is optional (the
 * paper form tolerates blanks). egn/eik/urn are encrypted at rest via the Epic B
 * manifest — this usecase reads/writes plaintext; the Prisma extension does
 * the crypto transparently.
 *
 * ── two fields are NOT strings, and that is deliberate ──
 *
 * Every field here used to be `string | null`, which let one list drive read,
 * write and normalisation. `sizeHa` and `grainProduced` break that on purpose:
 * a size that can hold "abc" is bad data on a page whose numbers reach a state
 * form, and a single grain string cannot express the ordinary case of a farm
 * growing three. So they are handled explicitly beside the uniform block
 * rather than squeezed into it.
 *
 * `sizeHa` crosses the wire as a NUMBER, not the decimal string a Prisma
 * `Decimal` serialises to by default. That is a departure from the money and
 * tonnage fields elsewhere in this API, and the reason is that those are money:
 * a float cannot be trusted with them. An area in hectares to three decimals is
 * exactly representable, nobody sums thousands of them, and a numeric field
 * that arrives as `"12.5"` is the asymmetry this codebase has been removing.
 */

export interface FarmProfileFields {
    producerName?: string | null;
    egn?: string | null;
    eik?: string | null;
    /** УРН — the holding's registration number. Encrypted at rest. */
    urn?: string | null;
    address?: string | null;
    municipality?: string | null;
    settlement?: string | null;
    agricultureDirectorateCity?: string | null;
    registrationPlace?: string | null;
    registrationEkatte?: string | null;
    odbhCity?: string | null;
    /** Declared hectares. A NUMBER on the wire — see the module note. */
    sizeHa?: number | null;
    /** Declared grains. Free values; a farm may grow something unquoted. */
    grainProduced?: string[] | null;
}

/** Ordered list of the editable string fields (single source of truth). */
const PROFILE_FIELDS = [
    'producerName',
    'egn',
    'eik',
    'urn',
    'address',
    'municipality',
    'settlement',
    'agricultureDirectorateCity',
    'registrationPlace',
    'registrationEkatte',
    'odbhCity',
] as const;

type StringShape = Record<(typeof PROFILE_FIELDS)[number], string | null>;

/** The whole profile: the uniform string block plus the two typed fields. */
export type ProfileShape = StringShape & {
    sizeHa: number | null;
    grainProduced: string[];
    /**
     * Optimistic-lock version. Send it back as `If-Match` on PUT.
     *
     * 0 means NO ROW EXISTS YET — a sentinel, not a stored value. The column
     * defaults to 1, so a real row always reports >= 1 and `If-Match: 0` can
     * only ever mean "create". See the schema comment for the create race this
     * closes.
     */
    version: number;
};

const EMPTY_PROFILE: ProfileShape = {
    ...PROFILE_FIELDS.reduce((acc, k) => ({ ...acc, [k]: null }), {} as StringShape),
    sizeHa: null,
    // An EMPTY ARRAY rather than null: "this farm declares no grain" and
    // "nobody has filled this in" are the same fact here, and an array a
    // client can map over without a null check is the kinder shape.
    grainProduced: [],
    // The sentinel. No stored row holds 0, so a client that reads an unset
    // profile and sends this back is unambiguously saying "create".
    version: 0,
};

/** Decimal → number. See the module note on why this is not a string. */
function toNum(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(String(v));
    return Number.isFinite(n) ? n : null;
}

/** Project a row (or the empty default) onto the wire shape. */
function project(row: Record<string, unknown> | null): ProfileShape {
    if (!row) return { ...EMPTY_PROFILE };
    return {
        ...PROFILE_FIELDS.reduce(
            (acc, k) => ({ ...acc, [k]: (row[k] as string | null) ?? null }),
            {} as StringShape,
        ),
        sizeHa: toNum(row.sizeHa),
        grainProduced: Array.isArray(row.grainProduced) ? (row.grainProduced as string[]) : [],
        // A stored row always has one. The `?? 0` is not a default for real
        // rows — it is unreachable for them — it keeps the type honest for a
        // caller that hands this a partial record.
        version: typeof row.version === 'number' ? row.version : 0,
    };
}

/** Admin read — the tenant's farm profile (an all-null shape when unset). */
export async function getFarmProfile(ctx: RequestContext): Promise<ProfileShape> {
    assertCanViewAdminSettings(ctx);
    return runInTenantContext(ctx, async (db) => {
        const row = await db.farmProfile.findUnique({
            where: { tenantId: ctx.tenantId },
        });
        return project(row as Record<string, unknown> | null);
    });
}

/**
 * Admin write — upsert the tenant's farm profile, with MERGE semantics.
 *
 * Three instructions share each field, and they are all distinct (#1176):
 *
 *     absent from the body   say nothing   -> the stored value stands
 *     explicit null          say empty     -> cleared
 *     blank string           say empty     -> cleared
 *
 * It used to clear on absence, so a partial body wiped the record. See `said`
 * below for the discriminator and why it is `Object.hasOwn`.
 */
export async function upsertFarmProfile(
    ctx: RequestContext,
    input: FarmProfileFields,
    expectedVersion?: number,
): Promise<ProfileShape> {
    assertCanAdmin(ctx);

    /**
     * Did the caller SAY anything about this field?
     *
     * `Object.hasOwn`, not `!= null` — and that distinction is the whole of
     * #1176. Every field is `.optional()`, and this function used to map all
     * thirteen through a normaliser returning null for `undefined`, so an
     * ABSENT field was CLEARED: `{"urn":"123"}` nulled the other twelve and
     * emptied `grainProduced`. Nothing had hit it because the only caller is
     * the admin page, which GETs the whole profile and PUTs it entire — but
     * the native client was about to send partial bodies against a schema
     * whose every field is optional.
     *
     * Zod's `.optional()` OMITS an absent key rather than materialising it as
     * undefined (verified on the installed zod 4.6.5), so `hasOwn` separates
     * "said nothing" from "said null". The `!== undefined` half is
     * belt-and-braces: JSON cannot carry undefined, so a present-but-undefined
     * key cannot arrive over HTTP — and if one ever does, "leave alone" is the
     * conservative reading.
     */
    const said = (k: keyof FarmProfileFields): boolean =>
        Object.hasOwn(input, k) && input[k] !== undefined;

    // Free text — trim + sanitise. A BLANK STRING still clears, as it always
    // did; that is a caller saying "this field is empty", not saying nothing.
    const norm = (v: string | null | undefined): string | null => {
        if (v == null) return null;
        return sanitizePlainText(v.trim()) || null;
    };

    // A negative area is not a smaller farm, it is a typo. Refuse rather than
    // store it: this number can reach a state form.
    const normSize = (n: number | null | undefined): number | null =>
        n == null || !Number.isFinite(n) || n < 0 ? null : n;

    // Sanitise each grain, drop blanks, de-duplicate case-insensitively while
    // keeping what the farmer typed. Order is preserved — it is a declaration,
    // not a set, and re-ordering someone's list on save is an unasked-for edit.
    const normGrain = (list: string[] | null | undefined): string[] => {
        const seen = new Set<string>();
        return (list ?? [])
            .map((g) => norm(g))
            .filter((g): g is string => g !== null)
            .filter((g) => {
                const key = g.toLocaleLowerCase('bg');
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };

    // UPDATE carries ONLY what the caller mentioned. A field absent from the
    // body is absent from the statement, so the stored value stands.
    const update: Record<string, unknown> = {};
    for (const k of PROFILE_FIELDS) {
        if (said(k)) update[k] = norm(input[k]);
    }
    if (said('sizeHa')) update.sizeHa = normSize(input.sizeHa);
    if (said('grainProduced')) update.grainProduced = normGrain(input.grainProduced);

    // CREATE is the full shape, and that is not an inconsistency: with no
    // prior row there is nothing to leave alone, so a field the caller did
    // not mention is genuinely undeclared.
    const create = {
        tenantId: ctx.tenantId,
        ...PROFILE_FIELDS.reduce(
            (acc, k) => ({ ...acc, [k]: said(k) ? norm(input[k]) : null }),
            {} as StringShape,
        ),
        sizeHa: said('sizeHa') ? normSize(input.sizeHa) : null,
        grainProduced: said('grainProduced') ? normGrain(input.grainProduced) : [],
    };

    /**
     * ONE attempt at the write, entirely inside one transaction.
     *
     * Returns the stored profile, or throws. Called at most twice: a concurrent
     * CREATE makes the loser raise P2002, and that must be retried as a WHOLE
     * transaction rather than caught and continued — see the loop below.
     */
    const attempt = async (): Promise<ProfileShape> =>
        runInTenantContext(ctx, async (db) => {
            let row: Record<string, unknown>;

            if (expectedVersion === undefined) {
                // UNGUARDED — no precondition was sent. Behaves exactly as it
                // did before this lock existed: last-write-wins. Still bumps
                // `version`, which is the half that matters: an unguarded write
                // that left the version behind would silently corrupt the lock
                // for every client that DOES send one. journal.paths.ts
                // documents that exact defect on its own route; this does not
                // inherit it.
                row = (await db.farmProfile.upsert({
                    where: { tenantId: ctx.tenantId },
                    create,
                    update: { ...update, version: { increment: 1 } },
                })) as unknown as Record<string, unknown>;
            } else {
                // GUARDED. `upsert` cannot carry a precondition — its `where` is
                // the unique selector, not a predicate — so the compare-and-swap
                // is an `updateMany` and the create is a separate branch.
                //
                // `version: 0` never matches a stored row (the column defaults
                // to 1), so an If-Match of 0 always falls through to the
                // existence check below and is answered there.
                const swapped = await db.farmProfile.updateMany({
                    where: { tenantId: ctx.tenantId, version: expectedVersion },
                    data: { ...update, version: { increment: 1 } },
                });

                if (swapped.count === 1) {
                    row = (await db.farmProfile.findUniqueOrThrow({
                        where: { tenantId: ctx.tenantId },
                    })) as unknown as Record<string, unknown>;
                } else {
                    // count === 0 is AMBIGUOUS: the version moved, or there is
                    // no row at all. Those want different answers, so read
                    // rather than infer from the count.
                    const existing = await db.farmProfile.findUnique({
                        where: { tenantId: ctx.tenantId },
                        select: { version: true },
                    });

                    if (existing) {
                        throw staleData('The farm profile changed while you were editing it.', {
                            currentVersion: existing.version,
                            expectedVersion,
                        });
                    }
                    if (expectedVersion !== 0) {
                        // They held a version for a row that does not exist.
                        // `currentVersion: 0` is the sentinel saying so — the
                        // client should re-read and retry as a create.
                        throw staleData('The farm profile no longer exists.', {
                            currentVersion: 0,
                            expectedVersion,
                        });
                    }
                    // If-Match: 0 and genuinely no row -> this is a create.
                    // A concurrent create raises P2002 here and the whole
                    // transaction is retried.
                    row = (await db.farmProfile.create({
                        data: create,
                    })) as unknown as Record<string, unknown>;
                }
            }

            await logEvent(db, ctx, {
                action: 'FARM_PROFILE_UPDATED',
                entityType: 'FarmProfile',
                entityId: row.id as string,
                details: 'Farm profile updated',
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'FarmProfile',
                    operation: 'updated',
                    summary: 'Farm profile updated',
                },
            });

            return project(row);
        });

    /**
     * P2002 is retried as a WHOLE transaction, never caught and continued.
     *
     * Two callers can both pass the existence check with no row and both reach
     * `create`; the loser violates the unique `tenantId`. That error has already
     * ABORTED the transaction by the time it surfaces, and there are no
     * SAVEPOINTs in this codebase (the one textual mention, at
     * exchange-messaging.ts:473, is a comment explaining their absence), so
     * nothing further can run inside it — a catch-and-continue here reads
     * correctly and silently commits nothing, which is exactly how #1168's
     * swallowed notification looked.
     *
     * Re-running the whole thing is safe because the second pass is not a
     * repeat: a row now exists, so it takes the 409 branch (or the update
     * branch, if this caller genuinely holds the current version). ONE retry is
     * enough — the row cannot go back to not existing, since nothing deletes a
     * farm profile.
     */
    for (let i = 0; ; i++) {
        try {
            return await attempt();
        } catch (err) {
            if (i === 0 && isUniqueViolation(err)) continue;
            throw err;
        }
    }
}
