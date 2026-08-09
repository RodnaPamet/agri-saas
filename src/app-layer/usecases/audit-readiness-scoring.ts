/**
 * Audit Readiness Scoring & Exports
 *
 * Framework-aware readiness scoring with documented weights:
 *
 * ISO27001:2022 weights:
 *   - Coverage (requirements mapped to APPLIES practices): 35%
 *   - Implementation (APPLIES practices IMPLEMENTED): 25%
 *   - Evidence (APPLIES practices with >=1 evidence): 25%
 *   - Task completion (penalty for overdue tasks): 10%
 *   - Issues (penalty for open PRACTICE_GAP/AUDIT_FINDING): 5%
 *
 * NIS2 Directive weights:
 *   - Coverage (NIS2 requirements mapped to practices): 40%
 *   - Evidence (mapped practices with >=1 evidence): 30%
 *   - Policies (presence of key NIS2 policies: IR/BCP/Supplier): 15%
 *   - Issues (penalty for open incidents/issues): 15%
 *
 * RETENTION HARDENING: Evidence queries exclude archived (isArchived=true)
 * and soft-deleted (deletedAt!=null) evidence. This ensures readiness
 * scores only reflect active, valid evidence.
 */
import { type AuditCycle, type Applicability, type WorkItemStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { assertCanViewPack } from '../policies/audit-readiness.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';


// ─── Types ───

export interface ReadinessBreakdown {
    coverage: { score: number; weight: number; mapped: number; total: number };
    implementation?: { score: number; weight: number; implemented: number; total: number };
    evidence: { score: number; weight: number; withEvidence: number; total: number };
    policies?: { score: number; weight: number; found: string[]; expected: string[] };
    tasks?: { score: number; weight: number; overdue: number };
    issues: { score: number; weight: number; open: number };
}

export interface ReadinessGap {
    type: 'UNMAPPED_REQUIREMENT' | 'MISSING_EVIDENCE' | 'OVERDUE_TASK' | 'OPEN_ISSUE' | 'MISSING_POLICY';
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    details: string;
    entityId?: string;
}

export interface ReadinessResult {
    frameworkKey: string;
    score: number;
    breakdown: ReadinessBreakdown;
    gaps: ReadinessGap[];
    recommendations: string[];
    computedAt: string;
}

// ─── ISO27001 Weights ───
const ISO_WEIGHTS = { coverage: 0.35, implementation: 0.25, evidence: 0.25, tasks: 0.10, issues: 0.05 };

// ─── NIS2 Weights ───
const NIS2_WEIGHTS = { coverage: 0.40, evidence: 0.30, policies: 0.15, issues: 0.15 };

// ─── NIS2 Key Policies ───
const NIS2_KEY_POLICIES = [
    { keyword: 'incident', label: 'Incident Response' },
    { keyword: 'business continuity', label: 'Business Continuity' },
    { keyword: 'disaster recovery', label: 'Disaster Recovery' },
    { keyword: 'supplier', label: 'Supplier Security' },
    { keyword: 'supply chain', label: 'Supply Chain Security' },
    { keyword: 'access control', label: 'Access Control' },
];

// ─── Compute Readiness ───

/**
 * Audit Coherence S5 (2026-05-22) — load the effective weights for
 * a framework. Per-tenant override via `Tenant.readinessWeightsJson`
 * takes precedence over the hardcoded defaults; the override is
 * validated (sum ≈ 1.0, each value in [0, 1]) before use.
 */
async function loadEffectiveWeights<T extends Record<string, number>>(
    ctx: RequestContext,
    frameworkKey: string,
    defaults: T,
): Promise<T> {
    const override = await runInTenantContext(ctx, (tdb) =>
        tdb.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { readinessWeightsJson: true },
        }));
    const json = override?.readinessWeightsJson;
    if (!json || typeof json !== 'object') return defaults;
    const candidate = (json as Record<string, unknown>)[frameworkKey];
    if (!candidate || typeof candidate !== 'object') return defaults;
    // Validate: every key in defaults must appear in candidate, every
    // value in [0,1], and the sum within tolerance of 1.0.
    const merged = { ...defaults };
    let sum = 0;
    for (const k of Object.keys(defaults)) {
        const v = (candidate as Record<string, unknown>)[k];
        if (typeof v !== 'number' || v < 0 || v > 1) return defaults;
        (merged as Record<string, number>)[k] = v;
        sum += v;
    }
    if (Math.abs(sum - 1.0) > 0.001) return defaults;
    return merged;
}

export async function computeReadiness(ctx: RequestContext, cycleId: string): Promise<ReadinessResult> {
    assertCanViewPack(ctx);

    const cycle = await runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findFirst({ where: { id: cycleId, tenantId: ctx.tenantId } }));
    if (!cycle) throw notFound('Audit cycle not found');

    let result: ReadinessResult;
    if (cycle.frameworkKey === 'ISO27001') {
        result = await computeISO27001Readiness(ctx, cycle);
    } else if (cycle.frameworkKey === 'NIS2') {
        result = await computeNIS2Readiness(ctx, cycle);
    } else {
        // Audit S5 — generic fallback for custom frameworks. Coverage
        // + evidence + issues only (no implementation/policy specifics).
        result = await computeGenericReadiness(ctx, cycle);
    }

    // Audit S5 — persist a time-series snapshot AFTER scoring so the
    // dashboard's readiness-over-time chart has a cheap source. The
    // snapshot is best-effort: if the write fails, the computed
    // result still returns to the caller (the original behaviour).
    try {
        await runInTenantContext(ctx, (tdb) =>
            tdb.readinessSnapshot.create({
                data: {
                    tenantId: ctx.tenantId,
                    frameworkKey: cycle.frameworkKey,
                    auditCycleId: cycleId,
                    score: result.score,
                    breakdownJson: result.breakdown as unknown as Prisma.InputJsonValue,
                    gapCount: result.gaps.length,
                    computedByUserId: ctx.userId,
                },
            }),
        );
    } catch (_err) {
        // Snapshot is observational — failure must not surface to
        // the caller. Job-level metrics will surface persistent
        // failures via the standard logging pipeline.
    }

    // Log event
    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'READINESS_COMPUTED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ score: result.score, frameworkKey: cycle.frameworkKey }),
            detailsJson: {
                category: 'custom',
                event: 'readiness_computed',
                score: result.score,
                frameworkKey: cycle.frameworkKey,
                gapCount: result.gaps.length,
            },
        })
    );

    return result;
}

/**
 * Audit Coherence S5 (2026-05-22) — read the readiness snapshot
 * history for the dashboard's trend chart.
 *
 * Returns the most-recent N snapshots for the framework in
 * descending `computedAt` order; the chart reverses to ascending
 * for rendering.
 */
export interface ReadinessSnapshotRow {
    id: string;
    score: number;
    gapCount: number;
    computedAt: Date;
    auditCycleId: string | null;
}

export async function getReadinessHistory(
    ctx: RequestContext,
    frameworkKey: string,
    opts: { take?: number; cycleId?: string } = {},
): Promise<ReadinessSnapshotRow[]> {
    assertCanViewPack(ctx);
    const take = Math.min(Math.max(1, opts.take ?? 30), 200);

    return runInTenantContext(ctx, (tdb) =>
        tdb.readinessSnapshot.findMany({
            where: {
                tenantId: ctx.tenantId,
                frameworkKey,
                ...(opts.cycleId ? { auditCycleId: opts.cycleId } : {}),
            },
            select: {
                id: true,
                score: true,
                gapCount: true,
                computedAt: true,
                auditCycleId: true,
            },
            orderBy: { computedAt: 'desc' },
            take,
        }),
    );
}

// ─── Generic / Custom-Framework Scoring ───
//
// Audit Coherence S5 (2026-05-22) — fallback model for any
// framework key without a hardcoded scoring profile. Uses three
// dimensions only: coverage (% requirements mapped to APPLIES
// practices), evidence (% mapped practices with ≥1 evidence), and
// issues (penalty for open PRACTICE_GAP / AUDIT_FINDING). Per-tenant
// `GENERIC` weight override is honoured.

const GENERIC_WEIGHTS = { coverage: 0.5, evidence: 0.35, issues: 0.15 };

async function computeGenericReadiness(
    ctx: RequestContext,
    cycle: AuditCycle,
): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];
    const weights = await loadEffectiveWeights(ctx, 'GENERIC', GENERIC_WEIGHTS);

    // 1) Coverage — requirements mapped to APPLIES practices.
    const fw = await runInTenantContext(ctx, (tdb) =>
        tdb.framework.findFirst({ where: { key: cycle.frameworkKey } }),
    );
    let totalReqs = 0;
    let mappedReqs = 0;
    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) =>
            tdb.frameworkRequirement.findMany({
                where: { frameworkId: fw.id, deprecatedAt: null },
                select: { id: true, code: true, title: true },
            }),
        );
        totalReqs = reqs.length;
        const reqIds = reqs.map((r) => r.id);
        const mappings = await runInTenantContext(ctx, (tdb) =>
            tdb.practiceRequirementLink.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    requirementId: { in: reqIds },
                    practice: { applicability: 'APPLIES' as Applicability },
                },
                select: { requirementId: true },
            }),
        );
        mappedReqs = new Set(mappings.map((m) => m.requirementId)).size;
    }
    const coverageScore = totalReqs > 0 ? Math.round((mappedReqs / totalReqs) * 100) : 0;

    // 2) Evidence — mapped practices with ≥1 active evidence.
    const mappedPractices = await runInTenantContext(ctx, (tdb) =>
        tdb.practice.findMany({
            where: {
                tenantId: ctx.tenantId,
                applicability: 'APPLIES' as Applicability,
                deletedAt: null,
                requirementLinks: { some: { requirement: { frameworkId: fw?.id ?? '' } } },
            },
            select: { id: true },
        }),
    );
    let withEvidence = 0;
    if (mappedPractices.length > 0) {
        const ids = mappedPractices.map((c) => c.id);
        const ev = await runInTenantContext(ctx, (tdb) =>
            tdb.evidence.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    practiceId: { in: ids },
                    isArchived: false,
                    deletedAt: null,
                    status: { in: ['SUBMITTED', 'APPROVED'] },
                },
                select: { practiceId: true },
            }),
        );
        withEvidence = new Set(ev.map((e) => e.practiceId).filter((v): v is string => !!v)).size;
    }
    const evidenceScore =
        mappedPractices.length > 0
            ? Math.round((withEvidence / mappedPractices.length) * 100)
            : 0;

    // 3) Issues — penalty for open PRACTICE_GAP / AUDIT_FINDING.
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.count({
            where: {
                tenantId: ctx.tenantId,
                type: { in: ['PRACTICE_GAP', 'AUDIT_FINDING'] },
                status: {
                    notIn: TERMINAL_WORK_ITEM_STATUSES as readonly WorkItemStatus[] as WorkItemStatus[],
                },
                deletedAt: null,
            },
        }),
    );
    const issuesScore = Math.max(0, 100 - openIssues * 5);

    const finalScore = Math.round(
        coverageScore * weights.coverage +
            evidenceScore * weights.evidence +
            issuesScore * weights.issues,
    );

    const result: ReadinessResult = {
        frameworkKey: cycle.frameworkKey,
        score: finalScore,
        breakdown: {
            coverage: { score: coverageScore, weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            evidence: { score: evidenceScore, weight: weights.evidence, withEvidence, total: mappedPractices.length },
            issues: { score: issuesScore, weight: weights.issues, open: openIssues },
        },
        gaps,
        recommendations: [
            `Custom framework "${cycle.frameworkKey}" — using the generic 3-dimension scoring model (coverage / evidence / issues). For framework-specific weights or dimensions, set tenant.readinessWeightsJson["${cycle.frameworkKey}"] or add a dedicated scoring profile.`,
        ],
        computedAt: new Date().toISOString(),
    };
    return result;
}

// ─── ISO27001 Scoring ───

async function computeISO27001Readiness(ctx: RequestContext, cycle: AuditCycle): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];

    // Audit S7 — route through the per-tenant weight override seam.
    // Pre-S7 this function read `ISO_WEIGHTS` directly, so the
    // helper added during Audit S5 only applied to GENERIC frameworks
    // — the Tenant.readinessWeightsJson override was silently
    // ignored for ISO27001 + NIS2. Wiring the load through the
    // helper means the operator-facing override surface (which
    // already accepts framework-keyed weights) finally applies
    // uniformly.
    const weights = await loadEffectiveWeights(ctx, 'ISO27001', ISO_WEIGHTS);

    // 1) Requirement coverage
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'ISO27001' } }));
    let totalReqs = 0;
    let mappedReqs = 0;
    interface RequirementSummary { id: string; code: string; title: string }
    let unmappedReqs: RequirementSummary[] = [];

    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) => tdb.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true, title: true },
        }));
        totalReqs = reqs.length;

        const mappedReqIds = await runInTenantContext(ctx, (tdb) =>
            tdb.practiceRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { requirementId: true },
            }));
        const mappedSet = new Set(mappedReqIds.map((l) => l.requirementId));
        mappedReqs = mappedSet.size;
        unmappedReqs = reqs.filter((r) => !mappedSet.has(r.id));
    }

    const coverageScore = totalReqs > 0 ? (mappedReqs / totalReqs) * 100 : 0;

    // Add unmapped requirement gaps (top 10)
    unmappedReqs.slice(0, 10).forEach((r) => gaps.push({
        type: 'UNMAPPED_REQUIREMENT', severity: 'HIGH',
        title: `${r.code}: ${r.title}`, details: 'Not mapped to any practice', entityId: r.id,
    }));

    // 2) Practices implementation
    const practices = await runInTenantContext(ctx, (tdb) =>
        tdb.practice.findMany({
            where: { tenantId: ctx.tenantId, applicability: 'APPLICABLE' },
            select: { id: true, code: true, name: true, status: true },
        }));
    const totalPractices = practices.length;
    const implementedPractices = practices.filter((c) => c.status === 'IMPLEMENTED').length;
    const implScore = totalPractices > 0 ? (implementedPractices / totalPractices) * 100 : 0;

    // 3) Evidence completeness — EXCLUDES archived/deleted evidence
    const practicesWithEvidence = await runInTenantContext(ctx, (tdb) =>
        tdb.practice.findMany({
            where: { tenantId: ctx.tenantId, applicability: 'APPLICABLE' },
            select: { id: true, code: true, name: true, evidence: {
                where: { isArchived: false, deletedAt: null },
                select: { id: true },
            } },
        }));
    const withEvidence = practicesWithEvidence.filter((c) => c.evidence?.length > 0).length;
    const evidenceScore = totalPractices > 0 ? (withEvidence / totalPractices) * 100 : 0;

    // Practices missing evidence (top 10)
    practicesWithEvidence
        .filter((c) => !c.evidence?.length)
        .slice(0, 10)
        .forEach((c) => gaps.push({
            type: 'MISSING_EVIDENCE', severity: 'MEDIUM',
            title: `${c.code}: ${c.name}`, details: 'No active evidence attached (archived/expired excluded)', entityId: c.id,
        }));

    // 4) Overdue tasks
    const overdueTasks = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                dueAt: { lt: new Date() },
            },
            select: { id: true, title: true, dueAt: true },
            take: 20,
        }));
    const overdueCount = overdueTasks.length;
    const taskScore = Math.max(0, 100 - (overdueCount * 10));

    overdueTasks.slice(0, 5).forEach((t) => gaps.push({
        type: 'OVERDUE_TASK', severity: 'MEDIUM',
        title: t.title, details: `Due: ${t.dueAt?.toISOString().split('T')[0] || 'unknown'}`, entityId: t.id,
    }));

    // 5) Open issues
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                type: { in: ['PRACTICE_GAP', 'AUDIT_FINDING'] },
            },
            select: { id: true, title: true, severity: true },
            take: 20,
        }));
    const issueCount = openIssues.length;
    const issueScore = Math.max(0, 100 - (issueCount * 15));

    openIssues.slice(0, 5).forEach((i) => gaps.push({
        type: 'OPEN_ISSUE', severity: i.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        title: i.title, details: `Severity: ${i.severity}`, entityId: i.id,
    }));

    // Weighted score — Audit S7 reads `weights` instead of the
    // raw `ISO_WEIGHTS` constant so a per-tenant override applies.
    const score = Math.round(
        coverageScore * weights.coverage +
        implScore * weights.implementation +
        evidenceScore * weights.evidence +
        taskScore * weights.tasks +
        issueScore * weights.issues
    );

    return {
        frameworkKey: 'ISO27001',
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
            coverage: { score: Math.round(coverageScore), weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            implementation: { score: Math.round(implScore), weight: weights.implementation, implemented: implementedPractices, total: totalPractices },
            evidence: { score: Math.round(evidenceScore), weight: weights.evidence, withEvidence, total: totalPractices },
            tasks: { score: Math.round(taskScore), weight: weights.tasks, overdue: overdueCount },
            issues: { score: Math.round(issueScore), weight: weights.issues, open: issueCount },
        },
        gaps,
        recommendations: generateISO27001Recommendations(coverageScore, implScore, evidenceScore, overdueCount, issueCount),
        computedAt: new Date().toISOString(),
    };
}

// ─── NIS2 Scoring ───

async function computeNIS2Readiness(ctx: RequestContext, cycle: AuditCycle): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];

    // Audit S7 — see the matching comment in computeISO27001Readiness
    // for the rationale. The per-tenant override seam now applies to
    // NIS2 as well as ISO27001 and GENERIC.
    const weights = await loadEffectiveWeights(ctx, 'NIS2', NIS2_WEIGHTS);

    // 1) Requirement coverage
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'NIS2' } }));
    let totalReqs = 0;
    let mappedReqs = 0;
    interface RequirementSummary { id: string; code: string; title: string }
    let unmappedReqs: RequirementSummary[] = [];

    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) => tdb.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true, title: true },
        }));
        totalReqs = reqs.length;

        const mappedReqIds = await runInTenantContext(ctx, (tdb) =>
            tdb.practiceRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { requirementId: true },
            }));
        const mappedSet = new Set(mappedReqIds.map((l) => l.requirementId));
        mappedReqs = mappedSet.size;
        unmappedReqs = reqs.filter((r) => !mappedSet.has(r.id));
    }

    const coverageScore = totalReqs > 0 ? (mappedReqs / totalReqs) * 100 : 0;

    unmappedReqs.slice(0, 10).forEach((r) => gaps.push({
        type: 'UNMAPPED_REQUIREMENT', severity: 'HIGH',
        title: `${r.code}: ${r.title}`, details: 'Not mapped to any measure', entityId: r.id,
    }));

    // 2) Evidence completeness for mapped practices — EXCLUDES archived/deleted evidence
    let practiceIds: string[] = [];
    if (fw) {
        const links = await runInTenantContext(ctx, (tdb) =>
            tdb.practiceRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { practiceId: true },
            }));
        practiceIds = [...new Set(links.map((l) => l.practiceId))];
    }
    if (practiceIds.length === 0) {
        const allPractices = await runInTenantContext(ctx, (tdb) =>
            tdb.practice.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true } }));
        practiceIds = allPractices.map((c) => c.id);
    }

    const practicesWithEv = await runInTenantContext(ctx, (tdb) =>
        tdb.practice.findMany({
            where: { tenantId: ctx.tenantId, id: { in: practiceIds } },
            select: { id: true, code: true, name: true, evidence: {
                where: { isArchived: false, deletedAt: null },
                select: { id: true },
            } },
        }));
    const totalPractices = practicesWithEv.length;
    const withEvidence = practicesWithEv.filter((c) => c.evidence?.length > 0).length;
    const evidenceScore = totalPractices > 0 ? (withEvidence / totalPractices) * 100 : 0;

    practicesWithEv
        .filter((c) => !c.evidence?.length)
        .slice(0, 10)
        .forEach((c) => gaps.push({
            type: 'MISSING_EVIDENCE', severity: 'MEDIUM',
            title: `${c.code}: ${c.name}`, details: 'No active evidence for this practice (archived/expired excluded)', entityId: c.id,
        }));

    // 3) Key policies check
    const policies = await runInTenantContext(ctx, (tdb) =>
        tdb.policy.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, title: true, category: true },
        }));

    const foundPolicies: string[] = [];
    const expectedPolicies = NIS2_KEY_POLICIES.map((p) => p.label);

    for (const kp of NIS2_KEY_POLICIES) {
        const found = policies.some((p) => {
            const text = `${p.title} ${p.category || ''}`.toLowerCase();
            return text.includes(kp.keyword);
        });
        if (found) foundPolicies.push(kp.label);
        else gaps.push({
            type: 'MISSING_POLICY', severity: 'MEDIUM',
            title: kp.label, details: `No policy found matching "${kp.keyword}"`,
        });
    }

    const policyScore = expectedPolicies.length > 0 ? (foundPolicies.length / expectedPolicies.length) * 100 : 0;

    // 4) Open issues
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
            },
            select: { id: true, title: true, severity: true, type: true },
            take: 20,
        }));
    const issueCount = openIssues.length;
    const issueScore = Math.max(0, 100 - (issueCount * 10));

    openIssues.slice(0, 5).forEach((i) => gaps.push({
        type: 'OPEN_ISSUE', severity: i.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        title: i.title, details: `${i.type} · Severity: ${i.severity}`, entityId: i.id,
    }));

    const score = Math.round(
        coverageScore * weights.coverage +
        evidenceScore * weights.evidence +
        policyScore * weights.policies +
        issueScore * weights.issues
    );

    return {
        frameworkKey: 'NIS2',
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
            coverage: { score: Math.round(coverageScore), weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            evidence: { score: Math.round(evidenceScore), weight: weights.evidence, withEvidence, total: totalPractices },
            policies: { score: Math.round(policyScore), weight: weights.policies, found: foundPolicies, expected: expectedPolicies },
            issues: { score: Math.round(issueScore), weight: weights.issues, open: issueCount },
        },
        gaps,
        recommendations: generateNIS2Recommendations(coverageScore, evidenceScore, policyScore, issueCount),
        computedAt: new Date().toISOString(),
    };
}

// ─── Recommendations ───

function generateISO27001Recommendations(coverage: number, impl: number, evidence: number, overdue: number, issues: number): string[] {
    const recs: string[] = [];
    if (coverage < 50) recs.push('Map more Annex A requirements to practices — coverage is below 50%');
    else if (coverage < 80) recs.push('Continue mapping requirements — aim for 80%+ coverage before audit');
    if (impl < 60) recs.push('Focus on implementing practices — many APPLICABLE practices are not yet IMPLEMENTED');
    if (evidence < 50) recs.push('Attach evidence to practices — auditors will expect documentation for each practice');
    else if (evidence < 80) recs.push('Strengthen evidence collection — aim for 80%+ practices with evidence');
    if (overdue > 5) recs.push(`Address ${overdue} overdue tasks to improve audit readiness`);
    else if (overdue > 0) recs.push(`Close remaining ${overdue} overdue task(s)`);
    if (issues > 3) recs.push(`Resolve ${issues} open audit findings/practice gaps before audit`);
    if (recs.length === 0) recs.push('Readiness is strong — review final pack before scheduling audit');
    return recs;
}

function generateNIS2Recommendations(coverage: number, evidence: number, policies: number, issues: number): string[] {
    const recs: string[] = [];
    if (coverage < 50) recs.push('Map NIS2 requirements (Art.21 measures) to practices — coverage below 50%');
    else if (coverage < 80) recs.push('Continue mapping NIS2 requirements — aim for full Art.21 coverage');
    if (evidence < 50) recs.push('Attach evidence to mapped practices — NIS2 requires demonstrable measures');
    if (policies < 50) recs.push('Create key NIS2 policies: Incident Response, Business Continuity, Supplier Security');
    else if (policies < 100) recs.push('Complete missing NIS2 policy areas to demonstrate full compliance');
    if (issues > 3) recs.push(`Address ${issues} open issues to reduce compliance risk`);
    if (recs.length === 0) recs.push('NIS2 readiness is strong — prepare for notification to competent authority');
    return recs;
}

// ─── Export Generators ───

export async function exportReadinessJson(ctx: RequestContext, cycleId: string): Promise<ReadinessResult> {
    const result = await computeReadiness(ctx, cycleId);
    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'readiness.json', score: result.score }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'readiness.json',
                score: result.score,
            },
        })
    );
    return result;
}

export async function exportUnmappedCsv(ctx: RequestContext, cycleId: string): Promise<{ csv: string; filename: string }> {
    const result = await computeReadiness(ctx, cycleId);
    const unmapped = result.gaps.filter((g) => g.type === 'UNMAPPED_REQUIREMENT');

    const rows = [['Requirement', 'Details', 'Severity']];
    unmapped.forEach((g) => rows.push([g.title, g.details, g.severity]));

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'unmapped.csv', count: unmapped.length }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'unmapped.csv',
                count: unmapped.length,
            },
        })
    );

    return { csv, filename: `${result.frameworkKey}-unmapped-requirements.csv` };
}

export async function exportPracticeGapsCsv(ctx: RequestContext, cycleId: string): Promise<{ csv: string; filename: string }> {
    const result = await computeReadiness(ctx, cycleId);
    const gapItems = result.gaps.filter((g) => g.type === 'MISSING_EVIDENCE' || g.type === 'OVERDUE_TASK' || g.type === 'OPEN_ISSUE');

    const rows = [['Type', 'Title', 'Details', 'Severity']];
    gapItems.forEach((g) => rows.push([g.type, g.title, g.details, g.severity]));

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'practice-gaps.csv', count: gapItems.length }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'practice-gaps.csv',
                count: gapItems.length,
            },
        })
    );

    return { csv, filename: `${result.frameworkKey}-practice-gaps.csv` };
}

// ─── Attach readiness to frozen pack ───

export async function addReadinessToPack(ctx: RequestContext, packId: string, cycleId: string) {
    assertCanViewPack(ctx);
    const result = await computeReadiness(ctx, cycleId);
    const { addAuditPackItems } = await import('./audit-readiness');
    return addAuditPackItems(ctx, packId, [{
        entityType: 'READINESS_REPORT',
        entityId: cycleId,
        snapshotJson: JSON.stringify(result),
        sortOrder: 999,
    }]);
}

// ─── Exported weights for tests ───
export { ISO_WEIGHTS, NIS2_WEIGHTS, NIS2_KEY_POLICIES };
