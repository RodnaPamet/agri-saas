import { Prisma, WorkItemStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
// Formula-guarded CSV escaping. These two exports hand a file to a certifier
// to open in Excel, and a tenant-authored control name or applicability
// justification beginning `=`, `+`, `-` or `@` executes on open. The
// hand-rolled `"${c.replace(/"/g,'""')}"` here quoted correctly and guarded
// nothing — quoting is about parsing, formula injection is about evaluation.
import { escapeCSV } from '@/lib/reports/soa-csv';

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
                control: {
                    select: {
                        id: true, code: true, name: true, status: true,
                        // Approved, live evidence only — the same filter
                        // scheme-pack.ts uses. This is what separates "a
                        // control is MAPPED to this requirement" from "this
                        // requirement is SATISFIED", and the page's 100%
                        // milestone depends on the difference.
                        evidence: {
                            where: { status: 'APPROVED', deletedAt: null, isArchived: false },
                            select: { id: true },
                        },
                    },
                },
                requirement: { select: { id: true, code: true, title: true } },
            },
        })
    );

    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // ── Satisfaction, as distinct from mapping ──────────────────────
    //
    // `coveragePercent` counts requirements a control row LINKS to. Installing
    // a starter pack links every one of them, so a farm with zero records read
    // 100% the instant the install finished — and the framework page fires its
    // confetti milestone on exactly this number.
    //
    // A requirement is satisfied when a control mapped to it holds approved
    // evidence. Requirements whose every mapped control is NOT_APPLICABLE are
    // excluded from the denominator: a farm with no livestock cannot satisfy a
    // livestock control point, and counting it against them would put 100% out
    // of reach for a real holding.
    const satisfiedReqIds = new Set(
        links.filter((l) => l.control.status !== 'NOT_APPLICABLE' && l.control.evidence.length > 0)
            .map((l) => l.requirementId),
    );
    const applicableReqIds = new Set(
        requirements
            .filter((r) => {
                const forReq = links.filter((l) => l.requirementId === r.id);
                // Unmapped requirements are applicable (nothing has claimed
                // them N/A); mapped-but-all-N/A ones are not.
                return forReq.length === 0 || forReq.some((l) => l.control.status !== 'NOT_APPLICABLE');
            })
            .map((r) => r.id),
    );
    const satisfiedPercent = applicableReqIds.size > 0
        ? Math.round((satisfiedReqIds.size / applicableReqIds.size) * 100)
        : 0;

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
        // What a farmer is actually asking when they look at this page.
        // The CODES travel too, so a caller can render the catalogue list and
        // the farm's own progress as one table instead of two the reader has
        // to join by eye.
        satisfiedRequirementCodes: requirements
            .filter((r) => satisfiedReqIds.has(r.id))
            .map((r) => r.code),
        satisfiedRequirements: satisfiedReqIds.size,
        applicableRequirements: applicableReqIds.size,
        satisfiedPercent,
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

    const csv = rows.map((r) => r.map((c) => escapeCSV(c)).join(',')).join('\n');
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
                        //
                        // The `where` is load-bearing too, and was absent: an
                        // APPROVED row that had been soft-deleted or archived
                        // still satisfied its control, so evidence a farm had
                        // explicitly removed went on propping up its
                        // certification score. `scheme-pack.ts` filters all
                        // three conditions; this filtered none of them.
                        //
                        // Status is NOT filtered here on purpose — the
                        // `awaitingReview` breakdown below needs to see
                        // SUBMITTED rows to tell "nobody filed anything" apart
                        // from "waiting on a reviewer".
                        evidence: {
                            where: { deletedAt: null, isArchived: false },
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

    // ── Per-requirement satisfaction ────────────────────────────────
    //
    // The concept did not exist. `coveragePercent` asks only "does a control
    // row LINK to this requirement", which is why installing a starter pack
    // produced 100% instantly — and fired the confetti milestone — on a farm
    // with zero records. A link is a promise to do the work, not the work.
    //
    // A requirement is SATISFIED when at least one control mapped to it holds
    // approved evidence. It is NOT APPLICABLE when every control mapped to it
    // is NOT_APPLICABLE — a farm with no livestock genuinely cannot satisfy a
    // livestock control point, and counting it against them would make full
    // readiness unreachable. UNMAPPED requirements are neither: nothing has
    // been claimed for them at all.
    const controlsByRequirement = new Map<string, LinkControl[]>();
    for (const l of links) {
        const list = controlsByRequirement.get(l.requirementId);
        if (list) list.push(l.control);
        else controlsByRequirement.set(l.requirementId, [l.control]);
    }

    const approvedEvidenceFor = (c: LinkControl) =>
        (c.evidence || []).filter((e) => e.status === 'APPROVED');

    const requirementStatus = requirements.map((r) => {
        const mappedControls = controlsByRequirement.get(r.id) ?? [];
        const applicableControls = mappedControls.filter((c) => c.status !== 'NOT_APPLICABLE');
        const approvedCount = applicableControls.reduce(
            (n, c) => n + approvedEvidenceFor(c).length,
            0,
        );
        const awaitingReview = applicableControls.reduce(
            (n, c) => n + (c.evidence || []).filter((e) => e.status === 'SUBMITTED').length,
            0,
        );
        const notApplicable = mappedControls.length > 0 && applicableControls.length === 0;

        return {
            code: r.code,
            title: r.title,
            section: r.section || r.category,
            mapped: mappedControls.length > 0,
            notApplicable,
            satisfied: approvedCount > 0,
            approvedEvidenceCount: approvedCount,
            awaitingReviewCount: awaitingReview,
            controls: mappedControls.map((c) => ({
                id: c.id,
                code: c.code,
                name: c.name,
                status: c.status,
                approvedEvidenceCount: approvedEvidenceFor(c).length,
            })),
        };
    });

    // Applicable = every requirement a farm could actually satisfy. Excluding
    // the not-applicable ones is what makes 100% reachable for a real holding.
    const applicableRequirements = requirementStatus.filter((r) => !r.notApplicable);
    const satisfiedRequirements = applicableRequirements.filter((r) => r.satisfied);
    const satisfiedPercent = applicableRequirements.length > 0
        ? Math.round((satisfiedRequirements.length / applicableRequirements.length) * 100)
        : 0;

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
        // Per-requirement detail: what a farmer actually needs to see, which is
        // "this control point is satisfied by these approved records", not
        // "a control row exists".
        requirements: requirementStatus,
        summary: {
            totalRequirements: total,
            mappedRequirements: mapped.length,
            coveragePercent,
            notApplicableCount: notApplicable.length,
            missingEvidenceCount: missingEvidence.length,
            overdueTaskCount: overdueTasks.length,
            // ── Readiness ───────────────────────────────────────────
            //
            // A genuine ratio: control points backed by approved evidence,
            // over control points this farm can actually satisfy.
            //
            // The previous formula was
            //   coveragePercent - missingEvidence*2 - overdueTasks*3
            // which subtracts raw COUNTS from a PERCENTAGE. Three consequences,
            // all of them silent:
            //   - not comparable across schemes: the same farm scores
            //     differently on a 7-point demo and a 200-point standard purely
            //     because the subtrahend grows with the control count;
            //   - saturates at 0 for any real standard — 50 controls missing
            //     evidence is -100, so every serious scheme reads zero
            //     regardless of actual progress;
            //   - the overdue term was structurally always 0, because pack
            //     templates set no `dueAt` (catalog-applier) and the overdue
            //     test requires one.
            // It also produced 92 on a completely EMPTY farm, and that number
            // is printed on a farmer-facing PDF with a "%" suffix.
            applicableRequirements: applicableRequirements.length,
            satisfiedRequirements: satisfiedRequirements.length,
            readinessScore: satisfiedPercent,
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

    const csv = rows.map((r) => r.map((c) => escapeCSV(c)).join(',')).join('\n');
    return { csv, filename: `${frameworkKey}-readiness-report.csv`, summary: report.summary };
}
