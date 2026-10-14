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
