/**
 * Epic 46 — `getFrameworkTree` usecase.
 *
 * Returns the framework descriptor PLUS its requirements pre-built
 * into a hierarchical tree, so the UI gets the entire shape it
 * needs in one round-trip. The hierarchy is derived per
 * `buildFrameworkTree` (see `src/lib/framework-tree/build.ts`) —
 * the schema has no parent FK on `FrameworkRequirement`, so the
 * tree shape comes from `section` / `theme` / dotted code prefixes.
 *
 * Frameworks are GLOBAL (no `tenantId`), but the route is mounted
 * under `/api/t/[tenantSlug]/...` so we still call the tenant-scoped
 * policy assertion (`assertCanViewFrameworks`) — it gates on the
 * caller having ANY authenticated role on the tenant. This matches
 * `getFramework` / `getFrameworkRequirements`.
 */

import { RequestContext } from '../../types';
import {
    assertCanViewFrameworks,
    assertCanInstallFrameworkPack,
} from '../../policies/framework.policies';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { buildFrameworkTree } from '@/lib/framework-tree/build';
import {
    decorateTreeWithCompliance,
    type PracticeForCompliance,
} from '@/lib/framework-tree/compliance';
import {
    applySortOrderOverlay,
    findUnknownRequirementIds,
    flattenOrderedSectionsToOverlay,
    type OrderedSection,
} from '@/lib/framework-tree/reorder';
import type { FrameworkTreePayload } from '@/lib/framework-tree/types';
import { logEvent } from '../../events/audit';

export async function getFrameworkTree(
    ctx: RequestContext,
    frameworkKey: string,
    version?: string,
): Promise<FrameworkTreePayload> {
    assertCanViewFrameworks(ctx);
    const fw = version
        ? await prisma.framework.findUnique({
              where: { key_version: { key: frameworkKey, version } },
          })
        : await prisma.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    const requirementsRaw = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: {
            id: true,
            code: true,
            title: true,
            description: true,
            section: true,
            category: true,
            theme: true,
            themeNumber: true,
            sortOrder: true,
        },
    });

    // Epic 46.4 — apply per-tenant reorder overlay BEFORE grouping.
    // RLS-scoped read: a tenant only sees their own override rows.
    const overlayRows = requirementsRaw.length
        ? await runInTenantContext(ctx, (tdb) =>
              tdb.frameworkRequirementOrder.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      requirementId: { in: requirementsRaw.map((r) => r.id) },
                  },
                  select: { requirementId: true, sortOrder: true },
              }),
          )
        : [];
    const overlay = new Map(
        overlayRows.map((r) => [r.requirementId, r.sortOrder] as const),
    );
    const requirements = applySortOrderOverlay(requirementsRaw, overlay);

    // Epic 46.3 — pull every tenant practice linked to one of these
    // requirements + its status & applicability. Run inside the
    // tenant RLS context so the join is provably scoped to the
    // calling tenant. Frameworks themselves are global, but
    // PracticeRequirementLink.tenantId is the load-bearing scope.
    const reqIds = requirements.map((r) => r.id);
    const links = reqIds.length
        ? await runInTenantContext(ctx, (tdb) =>
              tdb.practiceRequirementLink.findMany({
                  where: { tenantId: ctx.tenantId, requirementId: { in: reqIds } },
                  select: {
                      requirementId: true,
                      practice: { select: { status: true, applicability: true } },
                  },
              }),
          )
        : [];

    // Group by requirementId for the compliance decorator.
    const practicesByReqId = new Map<string, PracticeForCompliance[]>();
    for (const l of links) {
        const list = practicesByReqId.get(l.requirementId) ?? [];
        list.push({
            status: l.practice.status,
            applicability: l.practice.applicability,
        });
        practicesByReqId.set(l.requirementId, list);
    }

    const baseTree = buildFrameworkTree(
        {
            id: fw.id,
            key: fw.key,
            name: fw.name,
            version: fw.version,
            kind: fw.kind,
            description: fw.description,
        },
        requirements,
    );
    const decoratedNodes = decorateTreeWithCompliance(
        baseTree.nodes,
        practicesByReqId,
    );
    return { ...baseTree, nodes: decoratedNodes };
}

// ─── Reorder (Epic 46.4 — Builder MVP persistence) ─────────────────────

/**
 * Persist a per-tenant requirement ordering overlay for a single
 * framework. Admin-gated (re-uses
 * `assertCanInstallFrameworkPack` — the same OWNER/ADMIN gate
 * used for every other framework-write surface today).
 *
 * The endpoint accepts the user's desired ordering as a list of
 * SECTION blocks, each with its requirements in the new order.
 * This shape comes straight out of the builder's drag-and-drop
 * state, so no client-side serialization is needed.
 *
 * Defensive checks:
 *   - Every requirement id in the payload must belong to the
 *     framework being reordered. Mismatch → 400.
 *   - The payload must reference EVERY non-deprecated requirement
 *     of the framework (no partial overlays — keeps the section
 *     ordering invariant intact).
 *
 * Persistence: a single `runInTenantContext` transaction with
 * upserts keyed on `(tenantId, requirementId)`. Order matters
 * less than atomicity — if any row fails, the whole reorder is
 * rolled back.
 */
export async function reorderFrameworkRequirements(
    ctx: RequestContext,
    frameworkKey: string,
    sections: ReadonlyArray<OrderedSection>,
): Promise<{ updated: number }> {
    assertCanInstallFrameworkPack(ctx);

    const fw = await prisma.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    const live = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        select: { id: true },
    });
    const liveIds = new Set(live.map((r) => r.id));

    const unknown = findUnknownRequirementIds(sections, liveIds);
    if (unknown.length > 0) {
        throw badRequest(
            `Reorder payload references ${unknown.length} unknown requirement id(s)`,
        );
    }

    const seen = new Set<string>();
    let total = 0;
    for (const s of sections) {
        for (const id of s.requirementIds) {
            if (seen.has(id)) {
                throw badRequest(`Duplicate requirement id in reorder payload: ${id}`);
            }
            seen.add(id);
            total += 1;
        }
    }
    if (total !== liveIds.size) {
        throw badRequest(
            `Reorder payload covers ${total} of ${liveIds.size} requirements — partial reorders are not supported`,
        );
    }

    const overlay = flattenOrderedSectionsToOverlay(sections);

    // `runInTenantContext` already binds `app.tenant_id` inside a
    // transaction, so the upserts here are guaranteed all-or-nothing
    // even though we don't open a nested `$transaction`. The
    // sequential await keeps the DB roundtrips bounded by the
    // overlay size — typical frameworks have <100 requirements; the
    // largest seeded today (ISO 27001) has 93.
    const result: Array<{ id: string }> = [];
    await runInTenantContext(ctx, async (tdb) => {
        for (const entry of overlay) {
            const row = await tdb.frameworkRequirementOrder.upsert({
                where: {
                    tenantId_requirementId: {
                        tenantId: ctx.tenantId,
                        requirementId: entry.requirementId,
                    },
                },
                create: {
                    tenantId: ctx.tenantId,
                    requirementId: entry.requirementId,
                    sortOrder: entry.sortOrder,
                },
                update: { sortOrder: entry.sortOrder },
                select: { id: true },
            });
            result.push(row);
        }
    });

    await logEvent(prisma, ctx, {
        action: 'FRAMEWORK_REORDERED',
        entityType: 'Framework',
        entityId: fw.id,
        details: `Reordered ${result.length} requirements across ${sections.length} sections`,
        detailsJson: {
            category: 'custom',
            frameworkKey: fw.key,
            requirementCount: result.length,
            sectionCount: sections.length,
        },
    });

    return { updated: result.length };
}
