/**
 * Audit Readiness — Pack CRUD, Freeze, Snapshots, Export, Default Pack Preview
 */
import { AuditPackItemEntityType, WorkItemStatus } from '@prisma/client';
import { type PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../../types';
import {
    assertCanManageAuditPacks, assertCanFreezePack, assertCanViewPack,
} from '../../policies/audit-readiness.policies';
import { logEvent } from '../../events/audit';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Audit Packs РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function createAuditPack(ctx: RequestContext, auditCycleId: string, name: string) {
    assertCanManageAuditPacks(ctx);
    return runInTenantContext(ctx, async (tdb) => {
        const cycle = await tdb.auditCycle.findFirst({ where: { id: auditCycleId, tenantId: ctx.tenantId } });
        if (!cycle) throw notFound('Audit cycle not found');
        const pack = await tdb.auditPack.create({
            data: { tenantId: ctx.tenantId, auditCycleId, name },
        });
        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_CREATED', entityType: 'AuditPack', entityId: pack.id, details: JSON.stringify({ auditCycleId, name }), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditPack', operation: 'created', after: { auditCycleId, name }, summary: `Audit pack created: ${name}` } });
        return pack;
    });
}

export async function listAuditPacks(ctx: RequestContext, cycleId?: string) {
    assertCanViewPack(ctx);
    return runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findMany({
            where: { tenantId: ctx.tenantId, ...(cycleId ? { auditCycleId: cycleId } : {}) },
            include: { _count: { select: { items: true } }, cycle: { select: { frameworkKey: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        })
    );
}

export async function getAuditPack(ctx: RequestContext, packId: string) {
    assertCanViewPack(ctx);
    const pack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId },
            include: {
                items: { orderBy: { sortOrder: 'asc' } },
                cycle: true,
                frozenBy: { select: { id: true, name: true, email: true } },
                _count: { select: { items: true, shares: true } },
            },
        })
    );
    if (!pack) throw notFound('Audit pack not found');
    return pack;
}

export async function updateAuditPack(ctx: RequestContext, packId: string, data: { name?: string; notes?: string }) {
    assertCanManageAuditPacks(ctx);
    return runInTenantContext(ctx, async (tdb) => {
        const existing = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } });
        if (!existing) throw notFound('Audit pack not found');
        if (existing.status !== 'DRAFT') throw badRequest('Cannot update a frozen or exported pack');
        return tdb.auditPack.update({
            where: { id: packId },
            data: { ...(data.name !== undefined && { name: data.name }), ...(data.notes !== undefined && { notes: data.notes }) },
        });
    });
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Pack Items РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function addAuditPackItems(
    ctx: RequestContext,
    packId: string,
    items: Array<{ entityType: string; entityId: string; snapshotJson?: string; sortOrder?: number }>
) {
    assertCanManageAuditPacks(ctx);
    return runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Cannot add items to a frozen or exported pack');
        if (!items || items.length === 0) throw badRequest('At least one item required');

        const payload = items.map(item => ({
            tenantId: ctx.tenantId,
            auditPackId: packId,
            entityType: item.entityType as AuditPackItemEntityType,
            entityId: item.entityId,
            snapshotJson: item.snapshotJson || '{}',
            sortOrder: item.sortOrder ?? 0,
        }));

        const result = await tdb.auditPackItem.createMany({
            data: payload,
            skipDuplicates: true,
        });

        const created = result.count;
        const skipped = items.length - created;

        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_UPDATED', entityType: 'AuditPack', entityId: packId, details: JSON.stringify({ created, skipped }), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditPack', operation: 'updated', after: { itemsCreated: created, itemsSkipped: skipped }, summary: `Audit pack items added: ${created} created, ${skipped} skipped` } });
        return { created, skipped };
    });
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Snapshot Creation РІвЂќР‚РІвЂќР‚РІвЂќР‚

/**
 * Snapshot a framework's coverage for a frozen pack.
 *
 * The freeze switch had no case for FRAMEWORK_COVERAGE, so it fell through to
 * the `default` arm and froze `{ entityType, entityId, snapshotAt }` — a stub
 * naming an id. The coverage the certifier's pack exists to carry was absent,
 * while `scheme-pack.ts` documented the opposite ("the existing freeze flow
 * fills it from the live entity at freeze time").
 */
async function createFrameworkCoverageSnapshot(
    ctx: RequestContext,
    frameworkId: string,
): Promise<string> {
    const fw = await prisma.framework.findUnique({
        where: { id: frameworkId },
        select: { key: true, name: true, version: true },
    });
    if (!fw) {
        // Keep the id so the gap is traceable rather than silently empty.
        return JSON.stringify({
            type: 'FRAMEWORK_COVERAGE',
            frameworkId,
            error: 'framework not found at freeze time',
            snapshotAt: new Date().toISOString(),
        });
    }
    // The coverage engine (`framework/coverage`) was removed with the
    // compliance uproot — a requirement is no longer "covered" by a Control
    // row, so there is no percentage to freeze. The snapshot keeps the
    // framework identity so the pack item still names what it refers to.
    return JSON.stringify({
        type: 'FRAMEWORK_COVERAGE',
        framework: { key: fw.key, name: fw.name, version: fw.version },
        snapshotAt: new Date().toISOString(),
    });
}

async function createControlSnapshot(tdb: PrismaTx, controlId: string, tenantId: string): Promise<string> {
    const ctrl = await tdb.control.findFirst({
        where: { id: controlId, tenantId },
        include: {
            tasks: { select: { id: true, title: true, status: true, dueAt: true } },
            evidence: { select: { id: true, title: true, status: true, type: true } },
            requirementLinks: { include: { requirement: { select: { code: true, title: true, frameworkId: true } } } },
        },
    });
    if (!ctrl) return JSON.stringify({ error: 'Control not found', entityId: controlId });
    return JSON.stringify({
        code: ctrl.code, name: ctrl.name, status: ctrl.status,
        description: ctrl.description,
        owner: ctrl.ownerUserId,
        taskCompletion: { total: ctrl.tasks.length, done: ctrl.tasks.filter((t) => t.status === WorkItemStatus.RESOLVED || t.status === WorkItemStatus.CLOSED).length },
        evidenceCount: ctrl.evidence.length,
        mappedRequirements: (ctrl.requirementLinks || []).map((l) => ({
            code: l.requirement.code, title: l.requirement.title,
        })),
        snapshotAt: new Date().toISOString(),
    });
}

async function createPolicySnapshot(tdb: PrismaTx, policyId: string, tenantId: string): Promise<string> {
    const pol = await tdb.policy.findFirst({
        where: { id: policyId, tenantId },
        include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { versionNumber: true } } },
    });
    if (!pol) return JSON.stringify({ error: 'Policy not found', entityId: policyId });
    return JSON.stringify({
        title: pol.title, status: pol.status, category: pol.category,
        currentVersion: pol.versions[0]?.versionNumber,
        snapshotAt: new Date().toISOString(),
    });
}

async function createEvidenceSnapshot(tdb: PrismaTx, evidenceId: string, tenantId: string): Promise<string> {
    const ev = await tdb.evidence.findFirst({ where: { id: evidenceId, tenantId } });
    if (!ev) return JSON.stringify({ error: 'Evidence not found', entityId: evidenceId });
    return JSON.stringify({
        title: ev.title, type: ev.type, status: ev.status,
        snapshotAt: new Date().toISOString(),
    });
}

async function createIssueSnapshot(tdb: PrismaTx, issueId: string, tenantId: string): Promise<string> {
    const issue = await tdb.task.findFirst({ where: { id: issueId, tenantId } });
    if (!issue) return JSON.stringify({ error: 'Issue not found', entityId: issueId });
    return JSON.stringify({
        title: issue.title, type: issue.type, severity: issue.severity,
        status: issue.status, dueAt: issue.dueAt,
        snapshotAt: new Date().toISOString(),
    });
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Freeze Pack РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function freezeAuditPack(ctx: RequestContext, packId: string) {
    assertCanFreezePack(ctx);

    // Use an extended transaction timeout (60s) because large packs (500+ items)
    // require snapshot creation for each item, which exceeds the default 5s timeout.
    const frozenPack = await runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId },
            include: { items: true },
        });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Pack is already frozen or exported');
        if (pack.items.length === 0) throw badRequest('Cannot freeze an empty pack');

        // Create snapshots for all items in chunks
        const CHUNK_SIZE = 10;
        for (let i = 0; i < pack.items.length; i += CHUNK_SIZE) {
            const chunk = pack.items.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (item) => {
                let snapshot = item.snapshotJson;
                try {
                    if (!snapshot || snapshot === '{}') {
                        switch (item.entityType) {
                            case 'CONTROL': snapshot = await createControlSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'POLICY': snapshot = await createPolicySnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'EVIDENCE': snapshot = await createEvidenceSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'ISSUE': snapshot = await createIssueSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            // `scheme-pack.ts` adds exactly one of these per
                            // pack and leaves snapshotJson '{}' because its
                            // comment says "the existing freeze flow fills it
                            // from the live entity at freeze time". There was
                            // no case for it, so it fell to `default` and froze
                            // a stub naming an entity id and nothing else — the
                            // coverage the certifier's pack exists to carry was
                            // simply absent.
                            case 'FRAMEWORK_COVERAGE':
                                snapshot = await createFrameworkCoverageSnapshot(ctx, item.entityId);
                                break;
                            default: snapshot = JSON.stringify({ entityType: item.entityType, entityId: item.entityId, snapshotAt: new Date().toISOString() });
                        }
                        await tdb.auditPackItem.update({ where: { id: item.id }, data: { snapshotJson: snapshot } });
                    }
                } catch { /* keep existing snapshot */ }
            }));
        }

        const result = await tdb.auditPack.update({
            where: { id: packId },
            data: { status: 'FROZEN', frozenAt: new Date(), frozenByUserId: ctx.userId },
        });

        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_FROZEN', entityType: 'AuditPack', entityId: packId, details: JSON.stringify({ itemCount: pack.items.length }), detailsJson: { category: 'status_change', entityName: 'AuditPack', fromStatus: 'DRAFT', toStatus: 'FROZEN', reason: `Pack frozen with ${pack.items.length} items` } });

        return { frozenPack: result, itemCount: pack.items.length };
    }, { timeout: 60000, maxWait: 10000 });

    // Phase 2: Attach the SoA snapshot as an EXPORT_ARTIFACT item.
    //
    // A Statement of Applicability used to be appended here as an
    // EXPORT_ARTIFACT pack item. `getSoA` derived it from Control rows and
    // their applicability decisions; both went with the compliance uproot,
    // so a frozen pack now carries its item snapshots and nothing further.

    return frozenPack.frozenPack;
}


// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Default Pack Templates (selection logic) РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function previewDefaultPack(ctx: RequestContext, cycleId: string) {
    assertCanViewPack(ctx);

    const cycle = await runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findFirst({ where: { id: cycleId, tenantId: ctx.tenantId } })
    );
    if (!cycle) throw notFound('Audit cycle not found');

    if (cycle.frameworkKey === 'ISO27001') {
        return previewISO27001DefaultPack(ctx);
    } else if (cycle.frameworkKey === 'NIS2') {
        return previewNIS2DefaultPack(ctx);
    }
    throw badRequest(`No default pack template for framework: ${cycle.frameworkKey}`);
}

async function previewISO27001DefaultPack(ctx: RequestContext) {
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'ISO27001' } }));

    // Controls mapped to ISO27001 requirements
    let controlIds: string[] = [];
    if (fw) {
        const links = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { controlId: true },
            })
        );
        controlIds = [...new Set(links.map((l) => l.controlId))];
    }

    // Fallback: all controls if no framework mapping
    if (controlIds.length === 0) {
        const controls = await runInTenantContext(ctx, (tdb) =>
            tdb.control.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true } })
        );
        controlIds = controls.map((c) => c.id);
    }

    // Policies with category "Security" or any policies
    const policies = await runInTenantContext(ctx, (tdb) =>
        tdb.policy.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, category: true },
        })
    );
    const securityPolicies = policies.filter((p) => p.category === 'Security' || p.category === 'INFORMATION_SECURITY');
    const policyIds = (securityPolicies.length > 0 ? securityPolicies : policies).map((p) => p.id);

    // Evidence linked to those controls (via direct Control.evidence relation)
    const controlsWithEvidence = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, id: { in: controlIds } },
            select: { evidence: { select: { id: true } } },
        })
    );
    const evidenceIds = [...new Set(controlsWithEvidence.flatMap((c) => c.evidence.map((e) => e.id)))];

    // Open issues
    const issues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: { tenantId: ctx.tenantId, status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] } },
            select: { id: true },
        })
    );
    const issueIds = issues.map((i) => i.id);

    return {
        frameworkKey: 'ISO27001',
        selection: {
            controls: { count: controlIds.length, ids: controlIds },
            policies: { count: policyIds.length, ids: policyIds },
            evidence: { count: evidenceIds.length, ids: evidenceIds },
            issues: { count: issueIds.length, ids: issueIds },
        },
        totalItems: controlIds.length + policyIds.length + evidenceIds.length + issueIds.length,
    };
}

async function previewNIS2DefaultPack(ctx: RequestContext) {
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'NIS2' } }));

    // Controls mapped to NIS2 requirements (Art.21 measures)
    let controlIds: string[] = [];
    if (fw) {
        const links = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { controlId: true },
            })
        );
        controlIds = [...new Set(links.map((l) => l.controlId))];
    }

    if (controlIds.length === 0) {
        const controls = await runInTenantContext(ctx, (tdb) =>
            tdb.control.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true } })
        );
        controlIds = controls.map((c) => c.id);
    }

    // NIS2-relevant policies: incident response, BC/DR, access control, supplier security
    const policies = await runInTenantContext(ctx, (tdb) =>
        tdb.policy.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, title: true, category: true },
        })
    );
    const nis2Keywords = ['incident', 'business continuity', 'disaster recovery', 'access control', 'supplier', 'supply chain'];
    const nis2Policies = policies.filter((p) => {
        const text = `${p.title} ${p.category || ''}`.toLowerCase();
        return nis2Keywords.some(kw => text.includes(kw));
    });
    const policyIds = (nis2Policies.length > 0 ? nis2Policies : policies).map((p) => p.id);

    // Evidence tied to controls (via direct Control.evidence relation)
    const controlsWithEvidence = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, id: { in: controlIds } },
            select: { evidence: { select: { id: true } } },
        })
    );
    const evidenceIds = [...new Set(controlsWithEvidence.flatMap((c) => c.evidence.map((e) => e.id)))];

    // Issues
    const issues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: { tenantId: ctx.tenantId, status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] } },
            select: { id: true },
        })
    );
    const issueIds = issues.map((i) => i.id);

    return {
        frameworkKey: 'NIS2',
        selection: {
            controls: { count: controlIds.length, ids: controlIds },
            policies: { count: policyIds.length, ids: policyIds },
            evidence: { count: evidenceIds.length, ids: evidenceIds },
            issues: { count: issueIds.length, ids: issueIds },
        },
        totalItems: controlIds.length + policyIds.length + evidenceIds.length + issueIds.length,
    };
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Export Primitives РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function exportAuditPack(ctx: RequestContext, packId: string, format: 'json' | 'csv' = 'json') {
    assertCanViewPack(ctx);
    const pack = await getAuditPack(ctx, packId);
    if (pack.status === 'DRAFT') throw badRequest('Cannot export a draft pack');

    const items = pack.items.map((item) => ({
        entityType: item.entityType,
        entityId: item.entityId,
        sortOrder: item.sortOrder,
        snapshot: JSON.parse(item.snapshotJson || '{}'),
    }));

    if (format === 'json') {
        return {
            pack: { id: pack.id, name: pack.name, status: pack.status, frozenAt: pack.frozenAt },
            cycle: pack.cycle,
            items,
        };
    }

    // CSV
    const rows: string[][] = [
        ['Type', 'Entity ID', 'Name/Title', 'Status', 'Details'],
    ];
    for (const item of items) {
        const s = item.snapshot;
        rows.push([
            item.entityType,
            item.entityId,
            s.code || s.title || s.name || '',
            s.status || '',
            JSON.stringify(s),
        ]);
    }

    const csv = rows.map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return { csv, filename: `${pack.name.replace(/\s+/g, '-')}-audit-pack.csv` };
}
