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
import { projectionPayload } from '../projections/public-farm-profile.allowlist';

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
            // `indexable` is omitted on BOTH branches, so the column keeps its
            // `false` default on create and is left alone on update — a
            // projection refresh must never silently change whether a farm is
            // indexed. See the docblock: the control is P6.6's.
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
