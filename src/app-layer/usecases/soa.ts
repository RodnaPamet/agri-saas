/**
 * Statement of Applicability — Computation Use Case
 *
 * Produces a deterministic SoA "view" for a tenant against a framework
 * (ISO 27001:2022 Annex A by default).
 *
 * Rules:
 *   Applicability (per requirement):
 *     - Any mapped control APPLICABLE       → true
 *     - All mapped controls NOT_APPLICABLE   → false
 *     - No mapped controls                   → null (unmapped)
 *
 *   Implementation status (worst-status rollup):
 *     NOT_STARTED < IN_PROGRESS < NEEDS_REVIEW < IMPLEMENTED
 *     Reports the lowest status among mapped applicable controls.
 *
 *   Justification (when applicable === false):
 *     Concatenates applicabilityJustification from NOT_APPLICABLE controls.
 *     If any justification is missing → missingJustification++.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import type {
    SoAReportDTO,
    SoAEntryDTO,
    SoAMappedControlDTO,
    SoASummaryDTO,
} from '@/lib/dto/soa';

// ─── Status ordering (lower index = worse) ───

const STATUS_ORDER: Record<string, number> = {
    NOT_STARTED: 0,
    IN_PROGRESS: 1,
    NEEDS_REVIEW: 2,
    IMPLEMENTED: 3,
    NOT_APPLICABLE: -1, // excluded from rollup
};

function worstStatus(statuses: string[]): string | null {
    const applicable = statuses.filter(s => STATUS_ORDER[s] !== undefined && STATUS_ORDER[s] >= 0);
    if (applicable.length === 0) return null;
    applicable.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
    return applicable[0];
}

// ─── Options ───

export interface SoAOptions {
    framework?: string;       // default ISO27001_2022
    /** Explicit framework/scheme key. Alias for `framework`, added so the
     *  per-scheme applicability export can pin the AG_SCHEME key without
     *  going through the installed-framework auto-detection. Takes
     *  precedence over `framework` when both are set. */
    frameworkKey?: string;
    includeEvidence?: boolean;
    includeTasks?: boolean;
    includeTests?: boolean;
}

// ─── Installed-framework resolution ───

/**
 * Resolve which framework the SoA should report on when the caller
 * doesn't pin one explicitly. A framework counts as "installed" for a
 * tenant when at least one of the tenant's controls links to one of
 * that framework's requirements (`ControlRequirementLink`) — that's
 * exactly what `installPack` writes. ISO 27001 is preferred when it's
 * installed (the SoA is an ISO-native artifact); otherwise the first
 * installed framework is used. Falls back to ISO 27001 only when the
 * tenant has nothing installed yet, so a fresh tenant still renders a
 * meaningful (unmapped) baseline instead of erroring.
 *
 * Fixes the report defaulting to ISO 27001's 93 requirements even when
 * the tenant installed a different pack (e.g. NIS2, SOC 2).
 */
export async function resolveInstalledFrameworkKey(
    ctx: RequestContext,
): Promise<string> {
    const installed = await runInTenantContext(ctx, (db) =>
        db.framework.findMany({
            where: {
                requirements: {
                    some: { controlLinks: { some: { tenantId: ctx.tenantId } } },
                },
            },
            select: { key: true },
            orderBy: { key: 'asc' },
        }),
    );
    if (installed.length === 0) return 'ISO27001';
    const keys = installed.map((f) => f.key);
    return keys.includes('ISO27001') ? 'ISO27001' : keys[0];
}

// ─── Main Use Case ───

export async function getSoA(ctx: RequestContext, options: SoAOptions = {}): Promise<SoAReportDTO> {
    assertCanRead(ctx);
    const frameworkKey =
        options.frameworkKey || options.framework || (await resolveInstalledFrameworkKey(ctx));

    // 1. Load framework + requirements
    const fw = await runInTenantContext(ctx, (db) =>
        db.framework.findFirst({ where: { key: frameworkKey } })
    );
    if (!fw) throw notFound(`Framework "${frameworkKey}" not found`);

    const requirements = await runInTenantContext(ctx, (db) =>
        db.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            orderBy: { sortOrder: 'asc' },
        })
    );

    if (requirements.length === 0) throw notFound('No requirements found for this framework');

    const reqIds = requirements.map((r) => r.id);

    // 2. Load all ControlRequirementLinks for this tenant + framework
    interface ControlLinkRow {
        requirementId: string;
        control: {
            id: string;
            code: string | null;
            name: string;
            status: string;
            applicability: string;
            applicabilityJustification: string | null;
            ownerUserId: string | null;
            frequency: string | null;
            deletedAt: Date | null;
        };
    }
    const links: ControlLinkRow[] = await runInTenantContext(ctx, (db) =>
        db.controlRequirementLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                requirementId: { in: reqIds },
            },
            include: {
                control: {
                    select: {
                        id: true,
                        code: true,
                        name: true,
                        status: true,
                        applicability: true,
                        applicabilityJustification: true,
                        ownerUserId: true,
                        frequency: true,
                        deletedAt: true,
                    },
                },
            },
        })
    ) as ControlLinkRow[];

    // Filter out deleted controls
    const activeLinks = links.filter((l) => !l.control.deletedAt);

    // Group links by requirement ID
    const linksByReq = new Map<string, ControlLinkRow[]>();
    for (const link of activeLinks) {
        const arr = linksByReq.get(link.requirementId) || [];
        arr.push(link);
        linksByReq.set(link.requirementId, arr);
    }

    // 3. Optionally load rollup data
    const controlIds = [...new Set(activeLinks.map((l: { control: { id: string } }) => l.control.id))];

    let evidenceCounts = new Map<string, number>();
    let taskCounts = new Map<string, number>();
    let latestTestResults = new Map<string, string>();

    if (options.includeEvidence && controlIds.length > 0) {
        evidenceCounts = await loadEvidenceCounts(ctx, controlIds);
    }
    if (options.includeTasks && controlIds.length > 0) {
        taskCounts = await loadOpenTaskCounts(ctx, controlIds);
    }
    if (options.includeTests && controlIds.length > 0) {
        latestTestResults = await loadLatestTestResults(ctx, controlIds);
    }

    // 4. Build entries
    const entries: SoAEntryDTO[] = [];
    const summary: SoASummaryDTO = {
        total: requirements.length,
        applicable: 0,
        notApplicable: 0,
        unmapped: 0,
        implemented: 0,
        missingJustification: 0,
    };

    for (const req of requirements) {
        const reqLinks = linksByReq.get(req.id) || [];

        // Build mapped controls list
        const mappedControls: SoAMappedControlDTO[] = reqLinks.map((l) => ({
            controlId: l.control.id,
            code: l.control.code,
            title: l.control.name,
            status: l.control.status,
            applicability: l.control.applicability,
            justification: l.control.applicabilityJustification,
            owner: l.control.ownerUserId,
            frequency: l.control.frequency,
        }));

        // Derive applicability
        let applicable: boolean | null = null;
        let justification: string | null = null;

        if (mappedControls.length === 0) {
            // Unmapped
            applicable = null;
            summary.unmapped++;
        } else {
            const hasApplicable = mappedControls.some(c => c.applicability === 'APPLICABLE');
            if (hasApplicable) {
                applicable = true;
                summary.applicable++;
            } else {
                // All NOT_APPLICABLE
                applicable = false;
                summary.notApplicable++;

                // Collect justifications
                const justifications = mappedControls
                    .map(c => c.justification)
                    .filter(Boolean) as string[];

                if (justifications.length > 0) {
                    justification = justifications.join('; ');
                }

                // Check for missing justifications
                const missingCount = mappedControls.filter(c => !c.justification).length;
                if (missingCount > 0) {
                    summary.missingJustification++;
                }
            }
        }

        // Derive implementation status (worst among applicable controls)
        let implementationStatus: string | null = null;
        if (applicable === true) {
            const applicableStatuses = mappedControls
                .filter(c => c.applicability === 'APPLICABLE')
                .map(c => c.status);
            implementationStatus = worstStatus(applicableStatuses);
            if (implementationStatus === 'IMPLEMENTED') {
                summary.implemented++;
            }
        }

        // Rollup counts for this entry
        let evidenceCount = 0;
        let openTaskCount = 0;
        let lastTestResult: string | null = null;

        for (const mc of mappedControls) {
            evidenceCount += evidenceCounts.get(mc.controlId) || 0;
            openTaskCount += taskCounts.get(mc.controlId) || 0;
            const tr = latestTestResults.get(mc.controlId);
            if (tr && !lastTestResult) lastTestResult = tr;
        }

        entries.push({
            requirementId: req.id,
            requirementCode: req.code,
            requirementTitle: req.title || '',
            section: req.section || req.category || null,
            applicable,
            justification,
            implementationStatus,
            mappedControls,
            evidenceCount,
            openTaskCount,
            lastTestResult,
        });
    }

    // 5. Tenant info for slug
    const tenant = await runInTenantContext(ctx, (db) =>
        db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { slug: true },
        })
    );

    return {
        tenantId: ctx.tenantId,
        tenantSlug: tenant?.slug || '',
        framework: frameworkKey,
        // Display name for the report header — resolved from the
        // installed framework so it isn't hard-coded to ISO 27001.
        frameworkName: fw.version ? `${fw.name}:${fw.version}` : fw.name,
        generatedAt: new Date().toISOString(),
        entries,
        summary,
    };
}

// ─── Rollup Helpers ───

async function loadEvidenceCounts(ctx: RequestContext, controlIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const counts = await runInTenantContext(ctx, (db) =>
        db.evidence.groupBy({
            by: ['controlId'],
            // The Statement of Applicability goes to a certifier, so this
            // count is a CLAIM about how well a control point is evidenced.
            // It filtered `deletedAt` only, so archived rows and unreviewed
            // DRAFT / SUBMITTED / REJECTED ones all inflated it — the same
            // overstatement the readiness score used to make, in the document
            // an auditor actually reads.
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                status: 'APPROVED',
                deletedAt: null,
                isArchived: false,
            },
            _count: { id: true },
        })
    );
    for (const row of counts) {
        if (row.controlId) result.set(row.controlId, row._count.id);
    }
    return result;
}

async function loadOpenTaskCounts(ctx: RequestContext, controlIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const counts = await runInTenantContext(ctx, (db) =>
        db.controlTask.groupBy({
            by: ['controlId'],
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                status: { in: ['OPEN', 'IN_PROGRESS'] },
            },
            _count: { id: true },
        })
    );
    for (const row of counts) {
        result.set(row.controlId, row._count.id);
    }
    return result;
}

async function loadLatestTestResults(ctx: RequestContext, controlIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    // Get the latest completed test run per control
    const runs = await runInTenantContext(ctx, (db) =>
        db.controlTestRun.findMany({
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                status: 'COMPLETED',
                result: { not: null },
            },
            orderBy: { executedAt: 'desc' },
            select: { controlId: true, result: true },
        })
    );
    // Take first (latest) per control
    for (const run of runs) {
        if (!result.has(run.controlId) && run.result) {
            result.set(run.controlId, run.result);
        }
    }
    return result;
}
