import { Prisma, WorkItemStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';

// в”Ђв”Ђв”Ђ Coverage Computation в”Ђв”Ђв”Ђ

export async function computeCoverage(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fw = version
        ? await db.framework.findUnique({ where: { key_version: { key: frameworkKey, version } } })
        : await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    const requirements = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id },
        orderBy: { sortOrder: 'asc' },
    });

    // Get all tenant control requirement links for this framework
    const links = await runInTenantContext(ctx, (tdb) =>
        tdb.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirementId: { in: requirements.map((r) => r.id) } },
            include: {
                control: { select: { id: true, code: true, name: true, status: true } },
                requirement: { select: { id: true, code: true, title: true } },
            },
        })
    );

    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // Group by section
    const sections = [...new Set(requirements.map((r) => r.section || r.category || 'Other'))];
    const bySection = sections.map((s) => {
        const sectionReqs = requirements.filter((r) => (r.section || r.category || 'Other') === s);
        const sectionMapped = sectionReqs.filter((r) => mappedReqIds.has(r.id));
        return {
            section: s,
            total: sectionReqs.length,
            mapped: sectionMapped.length,
            coveragePercent: sectionReqs.length > 0 ? Math.round((sectionMapped.length / sectionReqs.length) * 100) : 0,
        };
    });

    return {
        framework: { key: fw.key, name: fw.name, version: fw.version },
        total,
        mapped: mapped.length,
        unmapped: unmapped.length,
        coveragePercent,
        bySection,
        unmappedRequirements: unmapped.map((r) => ({ code: r.code, title: r.title, section: r.section || r.category })),
        controlMappings: links.map((l) => ({
            requirementCode: l.requirement.code,
            requirementTitle: l.requirement.title,
            controlCode: l.control.code,
            controlName: l.control.name,
            controlStatus: l.control.status,
        })),
    };
}

// в”Ђв”Ђв”Ђ Template Library (global catalog with tenant install status) в”Ђв”Ђв”Ђ

export async function listTemplates(
    ctx: RequestContext,
    filters: { frameworkKey?: string; section?: string; category?: string; search?: string }
) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const where: Prisma.ControlTemplateWhereInput = {};
    if (filters.frameworkKey) {
        const fw = await db.framework.findFirst({ where: { key: filters.frameworkKey } });
        if (!fw) throw notFound('Framework not found');
        where.requirementLinks = { some: { requirement: { frameworkId: fw.id } } };
    }
    if (filters.category) {
        where.category = filters.category;
    }
    if (filters.search) {
        where.OR = [
            { code: { contains: filters.search } },
            { title: { contains: filters.search } },
        ];
    }

    const templates = await db.controlTemplate.findMany({
        where,
        include: {
            tasks: true,
            requirementLinks: { include: { requirement: { include: { framework: true } } } },
            packLinks: { include: { pack: true } },
        },
        orderBy: { code: 'asc' },
    });

    // Check install status per template for this tenant
    const existingControls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, code: { in: templates.map((t) => t.code) } },
            select: { code: true },
        })
    );
    const installedCodes = new Set(existingControls.map((c) => c.code));

    // Filter by section if specified (section comes from linked requirement)
    let result = templates;
    if (filters.section) {
        result = templates.filter((t) =>
            t.requirementLinks.some((rl) => (rl.requirement.section || rl.requirement.category) === filters.section)
        );
    }

    return result.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        description: t.description,
        category: t.category,
        defaultFrequency: t.defaultFrequency,
        isGlobal: t.isGlobal,
        installed: installedCodes.has(t.code),
        tasks: t.tasks.map((tt) => ({ id: tt.id, title: tt.title, description: tt.description })),
        requirements: t.requirementLinks.map((rl) => ({
            code: rl.requirement.code,
            title: rl.requirement.title,
            section: rl.requirement.section || rl.requirement.category,
            framework: { key: rl.requirement.framework.key, name: rl.requirement.framework.name },
        })),
        packs: t.packLinks.map((pl) => ({ key: pl.pack.key, name: pl.pack.name })),
    }));
}

// в”Ђв”Ђв”Ђ Export Coverage Data в”Ђв”Ђв”Ђ

export async function exportCoverageData(
    ctx: RequestContext,
    frameworkKey: string,
    format: 'json' | 'csv' = 'json'
) {
    assertCanViewFrameworks(ctx);
    const coverage = await computeCoverage(ctx, frameworkKey);

    if (format === 'json') {
        return coverage;
    }

    // CSV export
    const rows: string[][] = [
        ['Status', 'Requirement Code', 'Requirement Title', 'Section', 'Control Code', 'Control Name', 'Control Status'],
    ];

    for (const m of coverage.controlMappings) {
        rows.push(['Mapped', m.requirementCode, m.requirementTitle, '', m.controlCode || '', m.controlName, m.controlStatus]);
    }
    for (const r of coverage.unmappedRequirements) {
        rows.push(['Unmapped', r.code, r.title, r.section || '', '', '', '']);
    }

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return { csv, filename: `${frameworkKey}-coverage.csv` };
}

// в”Ђв”Ђв”Ђ Readiness Report в”Ђв”Ђв”Ђ

export async function generateReadinessReport(ctx: RequestContext, frameworkKey: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fw = await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    // Get all active requirements
    const requirements = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });

    // Get tenant control-requirement mappings
    const links = await runInTenantContext(ctx, (tdb) =>
        tdb.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirementId: { in: requirements.map((r) => r.id) } },
            include: {
                control: {
                    include: {
                        tasks: { select: { id: true, status: true, dueAt: true, title: true } },
                        // `status` is load-bearing, not decorative — see the
                        // APPROVED filter below.
                        evidence: {
                            select: {
                                id: true, status: true, title: true,
                                category: true, sourceLogEntryId: true,
                            },
                        },
                    },
                },
            },
        })
    );

    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // Unique controls involved
    type LinkControl = (typeof links)[0]['control'];
    const controlsMap = new Map<string, LinkControl>();
    for (const l of links) {
        if (!controlsMap.has(l.control.id)) {
            controlsMap.set(l.control.id, l.control);
        }
    }
    const controls = Array.from(controlsMap.values());

    // NOT_APPLICABLE controls
    const notApplicable = controls.filter((c) => c.status === 'NOT_APPLICABLE').map((c) => ({
        code: c.code,
        name: c.name,
        justification: c.description || 'No justification provided',
    }));

    // Controls missing evidence.
    //
    // "Has evidence" means has evidence a person APPROVED. This used to count
    // any row at all, which made the auto-evidence header's central promise
    // false: it says readiness "only counts APPROVED evidence, so nothing
    // unreviewed silently inflates a scheme's readiness — a person still signs
    // off", and auto-evidence is minted SUBMITTED precisely so a human gates
    // it. Counting it on creation meant filing a spray record moved the
    // certification score on the farm dashboard before anyone had looked at
    // it — the score reported a sign-off that had not happened.
    //
    // REJECTED is the sharper case: a reviewer explicitly refused the evidence
    // and the control still read as covered.
    const hasApprovedEvidence = (c: LinkControl) =>
        (c.evidence || []).some((e) => e.status === 'APPROVED');
    const missingEvidence = controls.filter((c) =>
        c.status !== 'NOT_APPLICABLE' && !hasApprovedEvidence(c)
    ).map((c) => ({
        code: c.code,
        name: c.name,
        status: c.status,
        // Distinguishes "nobody has filed anything" from "something is filed
        // and waiting on a reviewer" — the same number, two different jobs.
        awaitingReview: (c.evidence || []).filter((e) => e.status === 'SUBMITTED').length,
    }));

    // Overdue tasks
    const now = new Date();
    const overdueTasks: Array<{ taskTitle: string; taskStatus: string; dueDate: Date; controlCode: string | null; controlName: string }> = [];
    for (const ctrl of controls) {
        for (const task of (ctrl.tasks || [])) {
            if (task.dueAt && new Date(task.dueAt) < now && task.status !== WorkItemStatus.RESOLVED && task.status !== WorkItemStatus.CLOSED && task.status !== WorkItemStatus.CANCELED) {
                overdueTasks.push({
                    taskTitle: task.title,
                    taskStatus: task.status,
                    dueDate: task.dueAt,
                    controlCode: ctrl.code,
                    controlName: ctrl.name,
                });
            }
        }
    }

    // By section
    const sections = [...new Set(requirements.map((r) => r.section || r.category || 'Other'))];
    const bySection = sections.map((s) => {
        const sectionReqs = requirements.filter((r) => (r.section || r.category || 'Other') === s);
        const sectionMapped = sectionReqs.filter((r) => mappedReqIds.has(r.id));
        return {
            section: s,
            total: sectionReqs.length,
            mapped: sectionMapped.length,
            coveragePercent: sectionReqs.length > 0 ? Math.round((sectionMapped.length / sectionReqs.length) * 100) : 0,
        };
    });

    return {
        framework: { key: fw.key, name: fw.name, version: fw.version },
        generatedAt: now.toISOString(),
        coverage: { total, mapped: mapped.length, unmapped: unmapped.length, coveragePercent },
        bySection,
        unmappedRequirements: unmapped.map((r) => ({
            code: r.code, title: r.title, section: r.section || r.category,
        })),
        notApplicableControls: notApplicable,
        controlsMissingEvidence: missingEvidence,
        overdueTasks,
        summary: {
            totalRequirements: total,
            mappedRequirements: mapped.length,
            coveragePercent,
            notApplicableCount: notApplicable.length,
            missingEvidenceCount: missingEvidence.length,
            overdueTaskCount: overdueTasks.length,
            readinessScore: Math.max(0, coveragePercent - (missingEvidence.length * 2) - (overdueTasks.length * 3)),
        },
    };
}

export async function exportReadinessReport(
    ctx: RequestContext,
    frameworkKey: string,
    format: 'json' | 'csv' = 'json'
) {
    const report = await generateReadinessReport(ctx, frameworkKey);

    if (format === 'json') return report;

    const rows: string[][] = [
        ['Section', 'Type', 'Code', 'Title/Description', 'Status', 'Due Date'],
    ];

    for (const r of report.unmappedRequirements) {
        rows.push([r.section || '', 'Unmapped Requirement', r.code, r.title, '', '']);
    }
    for (const c of report.notApplicableControls) {
        rows.push(['', 'Not Applicable Control', c.code || '', `${c.name} — ${c.justification}`, 'NOT_APPLICABLE', '']);
    }
    for (const c of report.controlsMissingEvidence) {
        rows.push(['', 'Missing Evidence', c.code || '', c.name, c.status, '']);
    }
    for (const t of report.overdueTasks) {
        rows.push(['', 'Overdue Task', t.controlCode || '', `${t.taskTitle} (${t.controlName})`, t.taskStatus, t.dueDate?.toString() || '']);
    }

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return { csv, filename: `${frameworkKey}-readiness-report.csv`, summary: report.summary };
}
