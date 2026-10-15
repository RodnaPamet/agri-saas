/**
 * Project a farm's brand into its public profile, or withdraw it (P6.1, #1810).
 *
 * The second half of P6.1. The tables shipped in v12.26.0, a release ahead of
 * this file, as the phase requires.
 *
 * ## One transaction, and no RLS bypass
 *
 * `FarmBrand` is tenant-scoped and read here under the tenant's own RLS
 * session. `PublicFarmProfile` is global by design and carries no policies, so
 * writing it needs no bypass — which means the projection write and the
 * `projectedHandle` bookkeeping commit TOGETHER.
 *
 * That atomicity is the point rather than a convenience. P6.10 requires
 * "unpublish → 404 within 60s", and the failure mode it guards against is a
 * projection row outliving the decision to withdraw it. If the two writes
 * could commit separately, a crash between them leaves either a public page
 * nobody can find to remove (row written, bookkeeping lost) or a page that
 * silently stops being refreshed (bookkeeping written, row stale).
 *
 * `runWithoutRls({ reason: 'public-projection-read' })` is for the PUBLIC READ
 * path (P6.5), where there is no principal at all. It is deliberately not used
 * here: this runs for an authenticated owner, who has a tenant context, and
 * borrowing a read reason for a write would make an audit of that reason's
 * call sites misleading.
 *
 * ## Publishing is fail-closed on three preconditions
 *
 * A handle, a display name, and a recorded consent. The first two are
 * structural — `/f/[handle]` has no other key, and the projection's
 * `displayName` is NOT NULL, so a farm without one cannot be represented. The
 * third is a choice: P6.6 ships the consent sheet, and refusing to publish
 * without `consentedAt` now means P6.6 cannot forget to wire it. The
 * alternative — publish now, enforce consent later — would put identifiable
 * information about real farms online with no record that anyone agreed.
 *
 * ## `indexable` is always false, for now
 *
 * The projection carries it because P6.5 ships robots and a sitemap over
 * indexable profiles only. There is no source for it on `FarmBrand` — PR 1
 * missed that — and the fix belongs to P6.6 (#1815) with the rest of the
 * editor's per-field controls, because "publish my page" and "let search
 * engines index it" are different decisions and indexing is the one that is
 * hard to take back.
 *
 * Until then every projected row is `indexable: false`, so P6.5's sitemap is
 * correctly empty rather than opting farms in by default.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';

import { runWithoutRls } from '@/lib/db/rls-middleware';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { projectionPayload, HIDEABLE_FIELDS } from '../projections/public-farm-profile.allowlist';
import type {
    RecordFarmBrandConsentInput,
    UpdateFarmBrandInput,
} from '../schemas/farm-brand.schemas';
import {
    MAX_HANDLE_SUGGESTIONS,
    checkHandleShape,
    suggestHandles,
} from '@/lib/public-profile/handle';
import { publicProfileUrl } from '@/lib/public-profile/share-links';
import { getAppBaseUrl } from '@/lib/auth/app-base-url';

export interface ProjectionResult {
    /** What the farm is published as, or null when it is not published. */
    readonly handle: string | null;
    /** True when this call withdrew a previously public profile. */
    readonly withdrawn: boolean;
    /** The handle whose row was removed, when a rename or withdrawal removed one. */
    readonly removedHandle: string | null;
}

/**
 * Set whether this farm is public, and bring the projection into agreement.
 *
 * The one operation a client needs, and the reason it takes the desired state
 * rather than reading a flag somebody else set: an endpoint whose effect
 * depends on a field the same request cannot change is one a caller has to
 * make two calls to use, with no way to know what happened in between.
 *
 * Delegates to {@link projectFarmBrand} for the projection itself, so the
 * publish and withdraw paths cannot drift apart.
 */
export async function setFarmBrandPublication(
    ctx: RequestContext,
    published: boolean,
): Promise<ProjectionResult> {
    assertCanAdmin(ctx);

    await runInTenantContext(ctx, async (db) => {
        const brand = await db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!brand) {
            throw codedNotFound('FARM_BRAND_NOT_FOUND', 'This farm has no public profile yet.');
        }
        await db.farmBrand.update({ where: { id: brand.id }, data: { published } });
    });

    // A SECOND transaction, deliberately. The flag and the projection are not
    // atomic together, and making them so would mean holding a transaction
    // across the projection write for no benefit: `projectFarmBrand` is
    // idempotent and derives everything from the flag, so a crash between the
    // two leaves the flag set and the projection stale — which the next call,
    // or any later refresh, corrects. The reverse order would be worse: a
    // published row whose brand says it is private.
    return projectFarmBrand(ctx);
}

/**
 * Bring `PublicFarmProfile` into agreement with this farm's `FarmBrand`.
 *
 * Idempotent: calling it twice with no edit in between leaves the same row and
 * the same `projectedHandle`.
 */
export async function projectFarmBrand(ctx: RequestContext): Promise<ProjectionResult> {
    // Publishing a farm is an owner act, not an everyday write — `FarmBrand`
    // is described as "owner edits" and this is the operation that makes it
    // visible to strangers.
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const brand = await db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
        });
        if (!brand) {
            throw codedNotFound('FARM_BRAND_NOT_FOUND', 'This farm has no public profile yet.');
        }

        // ── withdrawal ──
        if (!brand.published) {
            const removed = brand.projectedHandle;
            if (removed) {
                await db.publicFarmProfile.deleteMany({ where: { handle: removed } });
                await db.farmBrand.update({
                    where: { id: brand.id },
                    data: { projectedHandle: null },
                });
                await logEvent(db, ctx, {
                    action: 'FARM_BRAND_UNPUBLISHED',
                    entityType: 'FarmBrand',
                    entityId: brand.id,
                    details: 'Farm profile withdrawn from public view',
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'FarmBrand',
                        fromStatus: 'PUBLISHED',
                        toStatus: 'UNPUBLISHED',
                        removedHandle: removed,
                    },
                });
            }
            return { handle: null, withdrawn: removed !== null, removedHandle: removed };
        }

        // ── publication preconditions, all fail-closed ──
        if (!brand.handle) {
            throw codedBadRequest(
                'FARM_BRAND_HANDLE_REQUIRED',
                'Choose a public address for the farm before publishing.',
            );
        }
        if (!brand.displayName) {
            throw codedBadRequest(
                'FARM_BRAND_DISPLAY_NAME_REQUIRED',
                'A public name is required before publishing.',
            );
        }
        if (!brand.consentedAt) {
            throw codedBadRequest(
                'FARM_BRAND_CONSENT_REQUIRED',
                'Publishing needs your consent first.',
            );
        }

        // ── a rename leaves a stale row behind unless it is removed here ──
        const stale =
            brand.projectedHandle && brand.projectedHandle !== brand.handle
                ? brand.projectedHandle
                : null;
        if (stale) {
            await db.publicFarmProfile.deleteMany({ where: { handle: stale } });
        }

        const payload = projectionPayload(brand);
        await db.publicFarmProfile.upsert({
            where: { handle: payload.handle },
            // `indexable` now crosses in `payload`, on both branches. It was
            // omitted for one release while `FarmBrand` had no column to read
            // it from — the brand is the source of truth now (#1850 shipped
            // the column, v12.34.0 contains it), so a refresh REPRODUCES the
            // owner's choice rather than preserving whatever the projection
            // happened to hold. Leaving it alone would mean an owner turning
            // indexing off saw it turn back on at the next content edit.
            create: { ...payload, projectedAt: new Date() },
            update: { ...payload, projectedAt: new Date() },
        });

        await db.farmBrand.update({
            where: { id: brand.id },
            data: {
                projectedHandle: payload.handle,
                publishedAt: brand.publishedAt ?? new Date(),
            },
        });

        await logEvent(db, ctx, {
            action: 'FARM_BRAND_PUBLISHED',
            entityType: 'FarmBrand',
            entityId: brand.id,
            details: `Farm profile published at /f/${payload.handle}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'FarmBrand',
                fromStatus: stale ? 'PUBLISHED' : 'UNPUBLISHED',
                toStatus: 'PUBLISHED',
                handle: payload.handle,
                ...(stale ? { replacedHandle: stale } : {}),
            },
        });

        return { handle: payload.handle, withdrawn: false, removedHandle: stale };
    });
}

/**
 * What a public page may show. Exactly the projection's columns, because the
 * projection is already the allowlisted shape — nothing is filtered again
 * here, and there is nothing left to filter.
 */
export interface PublicFarmProfileView {
    readonly handle: string;
    readonly displayName: string;
    readonly tagline: string | null;
    readonly about: string | null;
    readonly oblast: string | null;
    readonly crops: readonly string[];
    readonly indexable: boolean;
    readonly projectedAt: Date;
}

/**
 * Read one public profile by its handle, for an anonymous visitor (P6.5).
 *
 * ## There is no principal, which is why the bypass is load-bearing
 *
 * An anonymous visitor has no session, no tenant and no membership, so
 * `runInTenantContext` has nothing to enter with — the alternative to the
 * bypass is not a narrower context, it is no query. That is the argument
 * recorded on `'public-projection-read'` itself, and this is its only caller.
 *
 * ## Private and missing return the same thing, structurally
 *
 * The phase requires that a private profile and a missing one be
 * indistinguishable, so a stranger cannot enumerate which farms exist by
 * probing handles.
 *
 * This gets that for free rather than by matching two error paths: a
 * `PublicFarmProfile` row EXISTS only while the farm is published — the writer
 * deletes it on withdrawal rather than flagging it — so "not published" and
 * "never existed" are the same absence, and there is no second branch that
 * could drift. A `published` column on the projection would have required the
 * two paths to be kept in step by hand for ever.
 *
 * It returns `null` rather than throwing, so the caller decides the status. A
 * coded 404 here would put a machine-readable reason on the one response that
 * must carry none.
 *
 * ## It never reads a tenant table
 *
 * The phase's rule, and the projection makes it checkable: the row holds no
 * `tenantId`, so there is nothing to join through even by accident.
 */
export async function readPublicFarmProfile(
    handle: string,
): Promise<PublicFarmProfileView | null> {
    // Trimmed and lower-cased before the lookup, because a handle arrives from
    // a URL that a person may have typed, pasted with a trailing space, or
    // read off printed A6 paper (P6.7). An empty result for `'pobeda '` would
    // be indistinguishable from a farm that does not exist.
    const normalised = handle.trim().toLowerCase();
    if (!normalised) return null;

    const row = await runWithoutRls({ reason: 'public-projection-read' }, (db) =>
        db.publicFarmProfile.findUnique({ where: { handle: normalised } }),
    );
    if (!row) return null;

    return {
        handle: row.handle,
        displayName: row.displayName,
        tagline: row.tagline,
        about: row.about,
        oblast: row.oblast,
        crops: row.crops,
        indexable: row.indexable,
        projectedAt: row.projectedAt,
    };
}

/**
 * Every handle a search engine may index, for the sitemap (P6.5).
 *
 * ## Why this lives beside the single read rather than in the sitemap
 *
 * Both are public projection reads, and keeping them in one module keeps the
 * `'public-projection-read'` bypass to ONE file. `no-untyped-rls-bypass`
 * ratchets the number of files that call `runWithoutRls`, so a sitemap reading
 * the database directly would have raised that count for a read the existing
 * reason already covers — spending a ratchet on duplication.
 *
 * ## `indexable`, not `published`
 *
 * A row exists only while the farm is published, so every row here is public.
 * The filter is the narrower question: has this farm agreed to be FOUND? A
 * sitemap is an invitation to crawl, and publishing a page is not the same
 * decision as asking for it to be indexed — indexing is the one that outlives
 * a withdrawal, because a cached snapshot is not ours to recall.
 *
 * Nothing is indexable today (P6.6 ships the control), so this returns an
 * empty list and the sitemap is correctly empty rather than opting farms in.
 *
 * ## Bounded, because a sitemap is not a list endpoint
 *
 * 50,000 is the per-file limit in the sitemap protocol. Returning more would
 * produce a document crawlers reject wholesale rather than truncate, so the
 * cap is the protocol's and not a guess. Ordered by handle for a stable
 * document: a sitemap whose order changes every request looks like churn to a
 * crawler.
 */
export const SITEMAP_MAX_ENTRIES = 50_000;

export async function listIndexableFarmHandles(): Promise<
    Array<{ handle: string; projectedAt: Date }>
> {
    return runWithoutRls({ reason: 'public-projection-read' }, (db) =>
        db.publicFarmProfile.findMany({
            where: { indexable: true },
            select: { handle: true, projectedAt: true },
            orderBy: { handle: 'asc' },
            take: SITEMAP_MAX_ENTRIES,
        }),
    );
}

/** One directory hit. Projection fields only, plus the match score. */
export interface FarmSearchHit {
    readonly handle: string;
    readonly displayName: string;
    readonly tagline: string | null;
    readonly oblast: string | null;
    readonly crops: readonly string[];
    /** 0..1 trigram similarity. 0 when browsing with no query. */
    readonly score: number;
}

/** Bounded, because a public endpoint is not a data export. */
export const FARM_SEARCH_MAX_LIMIT = 50;
export const FARM_SEARCH_DEFAULT_LIMIT = 20;

/**
 * Search the public directory (P6.8, #1817).
 *
 * ## Why raw SQL
 *
 * `similarity()` and the `%` operator are pg_trgm's and Prisma's query builder
 * cannot express either. `%` specifically is what lets the GIN trigram index
 * serve the query — an `ILIKE '%…%'` would be a sequential scan that looks
 * identical from the outside, which is the shape the migration's own comment
 * warns about.
 *
 * Every value is parameterised through `Prisma.sql`. The filters are plain
 * equality and array containment, so there is no dynamic SQL and no place for
 * a caller-supplied fragment to land.
 *
 * ## Both columns, and never a reversed query
 *
 * `displayName` is Cyrillic as the owner typed it; `displayNameLatin` is its
 * transliteration. A Cyrillic query matches the first, a Latin query the
 * second, and nothing is ever transliterated backwards — the mapping is not
 * injective (`a` ← а and ъ), so reversing would have more than one answer and
 * would miss farms silently.
 *
 * `GREATEST` of the two scores, so a hit is ranked by its best match rather
 * than by whichever column is checked first.
 *
 * ## An empty query is BROWSE, not "match everything badly"
 *
 * With no `q` the trigram predicate is skipped entirely rather than compared
 * against `''` — `similarity(x, '')` is 0 for every row, so a threshold filter
 * would return nothing and an unfiltered one would rank randomly. Browsing is
 * ordered by handle, which is stable; searching is ordered by score.
 *
 * ## It reads only the projection
 *
 * Same bypass and the same bound as the single read: no PII columns exist on
 * this table and there is no `tenantId` to join through.
 */
export async function searchPublicFarms(opts: {
    readonly q?: string;
    readonly oblast?: string;
    readonly crop?: string;
    readonly limit?: number;
}): Promise<FarmSearchHit[]> {
    const q = (opts.q ?? '').trim();
    const oblast = (opts.oblast ?? '').trim() || null;
    const crop = (opts.crop ?? '').trim() || null;
    const limit = Math.min(
        Math.max(1, opts.limit ?? FARM_SEARCH_DEFAULT_LIMIT),
        FARM_SEARCH_MAX_LIMIT,
    );

    return runWithoutRls({ reason: 'public-projection-read' }, async (db) => {
        const rows = await db.$queryRaw<
            Array<{
                handle: string;
                displayName: string;
                tagline: string | null;
                oblast: string | null;
                crops: string[];
                score: number;
            }>
        >(
            Prisma.sql`
                SELECT
                    "handle",
                    "displayName",
                    "tagline",
                    "oblast",
                    "crops",
                    CASE WHEN ${q} = '' THEN 0::real ELSE GREATEST(
                        similarity("displayName", ${q}),
                        similarity(COALESCE("displayNameLatin", ''), ${q})
                    ) END AS "score"
                FROM "PublicFarmProfile"
                WHERE
                    (
                        ${q} = ''
                        OR "displayName" % ${q}
                        OR COALESCE("displayNameLatin", '') % ${q}
                    )
                    AND (${oblast}::text IS NULL OR "oblast" = ${oblast})
                    AND (${crop}::text IS NULL OR ${crop} = ANY("crops"))
                ORDER BY "score" DESC, "handle" ASC
                LIMIT ${limit}
            `,
        );

        return rows.map((r) => ({
            handle: r.handle,
            displayName: r.displayName,
            tagline: r.tagline,
            oblast: r.oblast,
            crops: r.crops,
            score: Number(r.score),
        }));
    });
}

/** The index whose violation means the name is taken. */
const HANDLE_INDEX = 'FarmBrand_handle_key';

/**
 * Was this error the global handle index refusing a duplicate?
 *
 * Specifically THAT index, not any unique violation. `FarmBrand` has two
 * unique constraints — `tenantId` and `handle` — and a test of mine once
 * asserted `/Unique constraint|23505/`, which a `tenantId` collision in a
 * shared fixture satisfied equally well, so it passed while proving nothing.
 * A `tenantId` violation here would mean two brand rows for one farm: a bug
 * to surface, not a name to offer alternatives for.
 *
 * ## `meta.target` is EMPTY under the driver adapter
 *
 * The obvious check is `err.meta.target`, and it silently never matches.
 * Measured against the real database on this stack (`PrismaPg`), a P2002
 * carries no `target` at all — the constraint name is nested:
 *
 *     meta.driverAdapterError.cause.constraint.index === 'FarmBrand_handle_key'
 *
 * My first version read `meta.target`, got `undefined`, and let the raw
 * P2002 escape as a 500 instead of the refusal with suggestions this whole
 * function exists to produce. The test caught it because it asserted on the
 * CODE rather than merely that a rejection happened.
 *
 * Both shapes are read, because `target` is what Prisma documents and is
 * populated without an adapter — a future driver change should not silently
 * turn the refusal back into a 500. The message is the last resort and is
 * matched on the index NAME, which is the one part of it that is not prose.
 */
function isHandleTaken(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;

    const meta = (err.meta ?? {}) as {
        target?: unknown;
        driverAdapterError?: {
            cause?: { constraint?: { index?: string }; originalMessage?: string };
        };
    };

    const target = Array.isArray(meta.target) ? meta.target.join(',') : String(meta.target ?? '');
    const cause = meta.driverAdapterError?.cause;
    const named = [target, cause?.constraint?.index ?? '', cause?.originalMessage ?? ''].join(' ');

    // `target` is a COLUMN list when present (`['handle']`), the others name
    // the index, so both spellings are accepted — and `tenantId` matches
    // neither.
    return named.includes(HANDLE_INDEX) || target.split(',').includes('handle');
}

/** Human-readable fallbacks for the shape refusals — see `checkHandleShape`. */
const HANDLE_REFUSAL_MESSAGES: Record<string, string> = {
    FARM_HANDLE_UNUSABLE: 'That address contains no letters or digits we can use.',
    FARM_HANDLE_TOO_SHORT: 'That address is too short — use at least three characters.',
    FARM_HANDLE_TOO_LONG: 'That address is too long — use at most forty characters.',
    FARM_HANDLE_RESERVED: 'That address is reserved and cannot be used by a farm.',
};

/**
 * Candidate addresses that are probably free, derived from this farm.
 *
 * ADVISORY, and the word is load-bearing: two owners can ask in the same
 * second and both be told the same name is free. The unique index is what
 * actually prevents the collision, so this exists to make a refusal useful
 * rather than to prevent one.
 */
async function suggestFreeHandles(ctx: RequestContext, raw: string): Promise<string[]> {
    const brand = await runInTenantContext(ctx, (db) =>
        db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { oblast: true, displayName: true },
        }),
    );

    const candidates = suggestHandles(raw, {
        oblast: brand?.oblast ?? null,
        displayName: brand?.displayName ?? null,
    });
    if (candidates.length === 0) return [];

    // The only cross-tenant read on this path, and it answers "is each of
    // THESE free" rather than "what exists" — see the reason's docblock.
    const taken = await runWithoutRls({ reason: 'farm-handle-availability' }, (db) =>
        db.farmBrand.findMany({
            where: { handle: { in: candidates } },
            select: { handle: true },
        }),
    );
    const takenSet = new Set(taken.map((row) => row.handle).filter((h): h is string => h !== null));

    return candidates.filter((c) => !takenSet.has(c)).slice(0, MAX_HANDLE_SUGGESTIONS);
}

/**
 * Claim the public address for this farm — P6.6 (#1815).
 *
 * The owner ruling: a second farm wanting a taken name is REFUSED with
 * suggestions, not silently given `pobeda-2`. Three consequences shape this
 * function.
 *
 * ## Suggest-then-attempt, because a pre-check cannot be authoritative
 *
 * There is no availability check before the write. Two owners can submit the
 * same name in the same second, so any pre-check is stale the moment it
 * returns and a check-then-write would report success to both. The unique
 * index is the only thing that actually prevents the collision, so a `P2002`
 * on insert is a NORMAL outcome handled here rather than an error to log.
 *
 * ## The catch is OUTSIDE the transaction, deliberately
 *
 * `runInTenantContext` opens an interactive `$transaction` (it needs one for
 * `SET LOCAL ROLE`), and a thrown `P2002` poisons the whole PostgreSQL
 * transaction — a caught JS error does not un-poison an aborted PG
 * transaction, as `task-due.ts` records. So the attempt is awaited, the
 * transaction is allowed to die, and the suggestions come from a FRESH query
 * afterwards. Catching inside and continuing would look like it worked and
 * fail on the next statement.
 *
 * ## A rename re-projects, because the old address must stop answering
 *
 * If the farm is published, the projection is brought back into agreement
 * through `projectFarmBrand`, which already removes the stale row via
 * `projectedHandle`. Without it `/f/old-name` would keep serving after a
 * rename — a page the owner believes they have moved. The re-projection is a
 * SEPARATE transaction for the reason `setFarmBrandPublication` gives: the
 * two are not atomic together, and this ordering leaves a stale projection
 * that the next refresh corrects rather than a live row for a handle nobody
 * holds.
 */
export async function claimFarmBrandHandle(
    ctx: RequestContext,
    rawHandle: string,
): Promise<{ handle: string; normalised: boolean; reprojected: boolean }> {
    assertCanAdmin(ctx);

    const verdict = checkHandleShape(rawHandle);
    if (!verdict.ok) {
        throw codedBadRequest(
            verdict.code,
            HANDLE_REFUSAL_MESSAGES[verdict.code] ?? 'That address cannot be used.',
        );
    }
    const handle = verdict.handle;

    let published: boolean;
    let changed: boolean;
    try {
        const outcome = await runInTenantContext(ctx, async (db) => {
            const brand = await db.farmBrand.findFirst({
                where: { tenantId: ctx.tenantId },
                select: { id: true, handle: true, published: true },
            });
            if (!brand) {
                throw codedNotFound(
                    'FARM_BRAND_NOT_FOUND',
                    'This farm has no brand record yet.',
                );
            }
            if (brand.handle === handle) {
                // Idempotent: re-submitting the address you already hold is a
                // success, not a collision with yourself.
                return { published: brand.published, changed: false };
            }
            await db.farmBrand.update({
                where: { tenantId: ctx.tenantId },
                data: { handle },
            });
            // On the caller's transaction, so the audit row is atomic with the
            // write it describes (#1223) — and so a rolled-back claim leaves
            // no record of an address the farm does not hold.
            await logEvent(db, ctx, {
                action: 'FARM_BRAND_HANDLE_CLAIMED',
                entityType: 'FarmBrand',
                entityId: brand.id,
                details: 'Public address claimed',
                detailsJson: {
                    category: 'status_change',
                    entityName: 'FarmBrand',
                    // The handle is public by definition — it is the URL — so
                    // recording it is not a disclosure. The PREVIOUS one is
                    // recorded too, because a rename is the thing somebody
                    // auditing a broken link needs to see.
                    fromHandle: brand.handle,
                    toHandle: handle,
                },
            });
            return { published: brand.published, changed: true };
        });
        published = outcome.published;
        changed = outcome.changed;
    } catch (err) {
        if (isHandleTaken(err)) {
            const suggestions = await suggestFreeHandles(ctx, rawHandle);
            // `details`, not `params`. `ErrorParams` values are
            // `string | number` for message interpolation; a list of
            // alternatives is structured data a client renders as buttons.
            throw codedBadRequest(
                'FARM_HANDLE_TAKEN',
                'That address is already taken by another farm.',
                undefined,
                { suggestions },
            );
        }
        throw err;
    }

    if (!changed) return { handle, normalised: verdict.normalised, reprojected: false };

    if (published) {
        await projectFarmBrand(ctx);
        return { handle, normalised: verdict.normalised, reprojected: true };
    }
    return { handle, normalised: verdict.normalised, reprojected: false };
}

/**
 * Save the farm's public content — P6.6 (#1815).
 *
 * ## This is an UPSERT, and that is the point of it
 *
 * Nothing in the product could create a `FarmBrand` before this. Measured on
 * main before this change: `farmBrand.create`, `farmBrand.upsert` and
 * `farmBrand.createMany` appeared NOWHERE in `src/`, `scripts/` or
 * `prisma/`, and `prisma/seed.ts` never mentioned the model — every row in
 * existence had been written by a test fixture.
 *
 * So `/f/{handle}` could not serve any real farm, the sitemap was correctly
 * empty, and both brand routes refused `FARM_BRAND_NOT_FOUND` every time
 * they were called. Five phases shipped behind a precondition nothing
 * satisfied (#1867). The upsert is what makes all of it reachable.
 *
 * ## `undefined` leaves a field alone; `null` clears it
 *
 * An owner fills this in over several sittings, and an editor autosaves. If
 * absent and explicitly-cleared were the same, saving a tagline would wipe
 * the `about` the owner wrote yesterday and never opened today. So the write
 * is assembled from the keys actually present.
 *
 * ## Publication preconditions are NOT enforced here
 *
 * A draft may be incomplete. `displayName` is nullable in the schema even
 * though the projection's column is NOT NULL, because refusing a nameless
 * draft would stop an owner saving a tagline before they have decided what
 * to call the farm. `setFarmBrandPublication` is where the three
 * preconditions bite, which is the right place: they are conditions for
 * being PUBLIC, not for having a draft.
 */
export async function updateFarmBrand(
    ctx: RequestContext,
    input: UpdateFarmBrandInput,
): Promise<{ created: boolean; reprojected: boolean }> {
    assertCanAdmin(ctx);

    // Only the keys the caller sent. `crops` is absent-or-replaced rather
    // than nullable: an empty array IS the cleared state for a list, so a
    // separate null would be a second spelling of the same thing.
    const data: Record<string, unknown> = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.tagline !== undefined) data.tagline = input.tagline;
    if (input.about !== undefined) data.about = input.about;
    if (input.oblast !== undefined) data.oblast = input.oblast;
    if (input.crops !== undefined) data.crops = input.crops;
    if (input.indexable !== undefined) data.indexable = input.indexable;
    // The eye toggles (P6.6, #1815). Same `!== undefined` treatment as every
    // field above: an omitted flag is untouched, so saving a tagline cannot
    // un-hide the «За стопанството» paragraph.
    for (const column of Object.values(HIDEABLE_FIELDS)) {
        const value = (input as Record<string, unknown>)[column];
        if (value !== undefined) data[column] = value;
    }

    const outcome = await runInTenantContext(ctx, async (db) => {
        const before = await db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { id: true, published: true },
        });

        if (!before) {
            const row = await db.farmBrand.create({
                data: { tenantId: ctx.tenantId, ...data },
                select: { id: true },
            });
            await logEvent(db, ctx, {
                action: 'FARM_BRAND_CREATED',
                entityType: 'FarmBrand',
                entityId: row.id,
                details: 'Public profile draft created',
                detailsJson: { category: 'status_change', entityName: 'FarmBrand' },
            });
            // A new draft cannot be published, so there is nothing to
            // reproject — `published` defaults to false.
            return { created: true, published: false };
        }

        await db.farmBrand.update({ where: { id: before.id }, data });
        await logEvent(db, ctx, {
            action: 'FARM_BRAND_UPDATED',
            entityType: 'FarmBrand',
            entityId: before.id,
            details: 'Public profile content edited',
            detailsJson: {
                category: 'status_change',
                entityName: 'FarmBrand',
                // WHICH fields changed, not their values. The content is
                // destined to be public, but an audit row naming every edit
                // of an unpublished draft would be a record of what the owner
                // tried and withdrew.
                fields: Object.keys(data).sort(),
            },
        });
        return { created: false, published: before.published };
    });

    // A published farm's page must agree with its brand, or an edit silently
    // changes nothing a visitor can see. Separate transaction, for the reason
    // `setFarmBrandPublication` gives.
    if (outcome.published) {
        await projectFarmBrand(ctx);
        return { created: outcome.created, reprojected: true };
    }
    return { created: outcome.created, reprojected: false };
}

/**
 * Record consent to publish identifiable information about this farm — P6.6.
 *
 * Its own operation rather than a field on the content save. Consent is a
 * legal artefact: it records that a person was shown a specific text and
 * agreed to it. A content `PUT` is autosaved, and an autosave that recorded
 * consent would be claiming somebody read something they never saw — the one
 * thing a consent record must not be able to say.
 *
 * `textVersion` is what makes it checkable. "They consented" is unfalsifiable
 * once the wording changes; "they consented to v2" can be held against the v2
 * text.
 *
 * Requires the draft to exist, because consent to publish a farm that has no
 * brand record is consent to nothing.
 */
export async function recordFarmBrandConsent(
    ctx: RequestContext,
    input: RecordFarmBrandConsentInput,
): Promise<{ consentedAt: Date; textVersion: string }> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const brand = await db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!brand) {
            throw codedNotFound(
                'FARM_BRAND_NOT_FOUND',
                'This farm has no public profile draft to consent to.',
            );
        }

        // Re-consenting MOVES the timestamp rather than being refused. The
        // text changes, and the record that matters is the most recent
        // agreement to the current wording — a first-consent-wins rule would
        // leave a farm published against a text nobody alive agreed to.
        const row = await db.farmBrand.update({
            where: { id: brand.id },
            data: { consentedAt: new Date(), consentTextVersion: input.textVersion },
            select: { consentedAt: true, consentTextVersion: true },
        });

        await logEvent(db, ctx, {
            action: 'FARM_BRAND_CONSENT_RECORDED',
            entityType: 'FarmBrand',
            entityId: brand.id,
            details: `Consent recorded for text ${input.textVersion}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'FarmBrand',
                consentTextVersion: input.textVersion,
            },
        });

        return {
            consentedAt: row.consentedAt as Date,
            textVersion: row.consentTextVersion as string,
        };
    });
}

/**
 * The farm's own public-profile draft, for the editor — #1884.
 *
 * The four write endpoints shipped without a read, so nothing could show an
 * owner what they already had: the editor would open blank over existing
 * content, and a farmer would have no way to see the handle they chose or
 * whether consent was on record. Measured before this change — all four
 * `farm-brand` routes exported `PUT` and nothing else.
 *
 * Returns the EDITOR's view, which is deliberately wider than the public
 * projection: it includes the fields a reader never sees — `published`,
 * `consentedAt`, `consentTextVersion`, `indexable` — because those are the
 * state the form has to render. The public read path is
 * `readPublicFarmProfile` and it stays narrow.
 *
 * `null` when there is no draft, not a 404: a farm that has never opened the
 * editor is in a normal state and the form should show itself empty rather
 * than an error. Only operations that need an existing draft refuse.
 */
export async function readFarmBrandDraft(ctx: RequestContext): Promise<{
    handle: string | null;
    displayName: string | null;
    tagline: string | null;
    about: string | null;
    oblast: string | null;
    crops: string[];
    published: boolean;
    publishedAt: Date | null;
    consentedAt: Date | null;
    consentTextVersion: string | null;
    indexable: boolean;
    hideTagline: boolean;
    hideAbout: boolean;
    hideOblast: boolean;
    hideCrops: boolean;
} | null> {
    // Same gate as every write on this model: the public face of a farm is an
    // owner concern, and a read that was looser than the write would let a
    // member see a draft they cannot edit.
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, (db) =>
        db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: {
                handle: true,
                displayName: true,
                tagline: true,
                about: true,
                oblast: true,
                crops: true,
                published: true,
                publishedAt: true,
                consentedAt: true,
                consentTextVersion: true,
                indexable: true,
                // The eye toggles, so the editor renders them in the state
                // they were left in. Private on the PUBLIC page (they reveal
                // that something is withheld) and necessarily visible to the
                // owner, who is the one who set them.
                hideTagline: true,
                hideAbout: true,
                hideOblast: true,
                hideCrops: true,
                // `projectedHandle` and `tenantId` are deliberately NOT
                // selected. The first is this writer's bookkeeping and means
                // nothing to an editor; the second is the coupling the
                // handle ruling exists to avoid putting in front of anyone.
            },
        }),
    );
}

/**
 * Everything the A6 share card needs, with the preconditions that make it
 * safe to PRINT — P6.7 (#1816).
 *
 * ## Why this refuses where the editor merely warns
 *
 * The card carries `https://app.agrent.bg/f/{handle}` onto paper, and paper
 * outlives state. #1816 raises the hazard in its own text for handle reuse;
 * the same reasoning applies one step earlier. A card printed from an
 * unpublished draft points at a 404 for as long as the sheet exists, and
 * there is no equivalent of withdrawing it.
 *
 * So all three preconditions are fail-closed, matching
 * {@link projectFarmBrand}'s publication gate rather than the editor's
 * save-anything-anytime contract. Two of the codes are deliberately the SAME
 * ones publishing raises — a client that already translates
 * `FARM_BRAND_HANDLE_REQUIRED` needs no new string for the same cause.
 *
 * `FARM_BRAND_NOT_PUBLISHED` is the one new code, because this is the first
 * operation in the product that requires an ALREADY-published farm; every
 * other write is what gets it there.
 */
export async function buildFarmShareCard(ctx: RequestContext): Promise<{
    handle: string;
    displayName: string;
    tagline: string | null;
    url: string;
    generatedAt: string;
}> {
    // Same gate as every other read and write on this model: a farm's public
    // face is an owner concern.
    assertCanAdmin(ctx);

    const brand = await runInTenantContext(ctx, (db) =>
        db.farmBrand.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { handle: true, displayName: true, tagline: true, published: true },
        }),
    );

    if (!brand) {
        throw codedNotFound('FARM_BRAND_NOT_FOUND', 'This farm has no public profile yet.');
    }
    if (!brand.handle) {
        throw codedBadRequest(
            'FARM_BRAND_HANDLE_REQUIRED',
            'Choose a public address for the farm before printing a card.',
        );
    }
    if (!brand.displayName) {
        throw codedBadRequest(
            'FARM_BRAND_DISPLAY_NAME_REQUIRED',
            'A public name is required before printing a card.',
        );
    }
    if (!brand.published) {
        throw codedBadRequest(
            'FARM_BRAND_NOT_PUBLISHED',
            'Publish the farm profile first — a printed address that is not published leads nowhere.',
        );
    }

    return {
        handle: brand.handle,
        displayName: brand.displayName,
        tagline: brand.tagline,
        // `publicProfileUrl`, never a local template. It is described as "the
        // ONE definition every share surface uses" for exactly this case: the
        // printed card and the Viber forward must resolve to the same place,
        // and the printed one is the copy nobody can correct.
        //
        // `baseUrl` is passed in rather than read inside that module, which is
        // what makes it importable from a `'use client'` component: reading it
        // there reached `getAppBaseUrl` -> `logger` -> `node:async_hooks` and
        // failed the BUILD. Here we are server-side, so resolving it is free.
        url: publicProfileUrl(brand.handle, getAppBaseUrl()),
        generatedAt: new Date().toISOString(),
    };
}
