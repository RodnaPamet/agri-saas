/**
 * Epic G-3 — Vendor Assessment review + close usecases.
 *
 *   • reviewAssessment   — run the scoring engine, apply per-answer
 *                          overrides, set the final rating, transition
 *                          SUBMITTED → REVIEWED.
 *   • closeAssessment    — terminal lifecycle flip REVIEWED → CLOSED.
 *
 * Traceability invariants:
 *
 *   computedPoints (from submit)   — never overwritten
 *   reviewerOverridePoints         — set/cleared by review
 *   reviewerNotes (per-answer)     — set/cleared by review
 *   assessment.score               — final post-override score
 *   assessment.riskRating          — reviewer override OR engine
 *                                    suggestion (manual wins)
 *   assessment.reviewerNotes       — assessment-level commentary
 *
 * The engine runs entirely on the post-override view of answers, so
 * a reviewer who returns to a REVIEWED assessment to tweak one
 * override sees the new total recomputed identically.
 *
 * @module usecases/vendor-assessment-review
 */
import type { RequestContext } from '../types';
import type { VendorCriticality } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertCanApproveAssessment } from '../policies/vendor.policies';
import {
    scoreAssessment,
    parseScoringConfig,
    type ScoringResult,
} from '../services/vendor-assessment-scoring-engine';
import { enqueueEmail } from '../notifications/enqueue';
import { logger } from '@/lib/observability/logger';
// Audit S6 (2026-05-22) — `notifyAssessmentReviewed` runs
// post-commit, after `runInTenantContext` has returned, so it needs
// a non-tenant-bound prisma client to look up the recipient's email
// and tenant slug. Pre-this-PR the file used a dynamic require()
// inline; that bypassed the `no-direct-prisma`
// structural ratchet but also undermined it (operators reading the
// file couldn't tell whether the global prisma was intentional or
// drift). The static import is paired with an allowlist entry in
// `tests/unit/no-direct-prisma.test.ts`.
import { prisma } from '@/lib/prisma';
import { env } from '@/env';

// ─── Types ─────────────────────────────────────────────────────────

export interface ReviewOverrideInput {
    questionId: string;
    /** undefined = leave untouched; null = clear; number = set. */
    overridePoints?: number | null;
    /** undefined = leave untouched; null = clear; string = set. */
    reviewerNotes?: string | null;
}

export interface ReviewAssessmentInput {
    overrides?: ReviewOverrideInput[];
    /** Manual rating override. undefined = use engine suggestion. */
    finalRiskRating?: VendorCriticality | null;
    /** Assessment-level reviewer commentary. */
    reviewerNotes?: string | null;
}

export interface ReviewAssessmentResult {
    status: 'REVIEWED';
    score: number;
    riskRating: VendorCriticality | null;
    /** True when finalRiskRating came from the input (manual override),
     *  false when it was derived from the engine's suggestion. */
    ratingOverridden: boolean;
    /** Full scoring breakdown — drives the review-detail UI. */
    scoring: ScoringResult;
    reviewedAt: Date;
}

export interface CloseAssessmentResult {
    status: 'CLOSED';
    closedAt: Date;
}

// ─── 1. reviewAssessment ───────────────────────────────────────────

export async function reviewAssessment(
    ctx: RequestContext,
    assessmentId: string,
    input: ReviewAssessmentInput,
): Promise<ReviewAssessmentResult> {
    assertCanApproveAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        // ── Load assessment + status guard ──
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                tenantId: true,
                status: true,
                templateVersionId: true,
                templateId: true,
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.status !== 'SUBMITTED') {
            throw badRequest(
                `Cannot review an assessment in status ${assessment.status}. ` +
                    `Only SUBMITTED assessments can be reviewed.`,
            );
        }
        if (!assessment.templateVersionId) {
            // The G-3 review path requires the new normalized
            // template; legacy approval-flow assessments use the
            // existing decideAssessment usecase.
            throw badRequest(
                'This assessment was created via the legacy approval flow. ' +
                    'Use decideAssessment instead.',
            );
        }

        // ── Apply per-answer overrides ──
        const overrides = input.overrides ?? [];
        for (const o of overrides) {
            const data: Record<string, unknown> = {};
            if (o.overridePoints !== undefined) {
                data.reviewerOverridePoints = o.overridePoints;
            }
            if (o.reviewerNotes !== undefined) {
                data.reviewerNotes = o.reviewerNotes
                    ? sanitizePlainText(o.reviewerNotes)
                    : null;
            }
            if (Object.keys(data).length === 0) continue;
            // Use updateMany so a non-existent answer (override on a
            // never-answered question) is a no-op rather than a
            // throw — the reviewer might be ahead of the response.
            await db.vendorAssessmentAnswer.updateMany({
                where: {
                    assessmentId: assessment.id,
                    tenantId: ctx.tenantId,
                    questionId: o.questionId,
                },
                data,
            });
        }

        // ── Reload questions + (post-override) answers for engine ──
        const questions = await db.vendorAssessmentTemplateQuestion.findMany({
            where: {
                templateId: assessment.templateVersionId,
                tenantId: ctx.tenantId,
            },
            select: { id: true, weight: true, required: true },
        });
        const answers = await db.vendorAssessmentAnswer.findMany({
            where: {
                assessmentId: assessment.id,
                tenantId: ctx.tenantId,
            },
            select: {
                questionId: true,
                computedPoints: true,
                reviewerOverridePoints: true,
            },
        });

        const template = await db.vendorAssessmentTemplate.findUnique({
            where: { id: assessment.templateVersionId },
            select: { scoringConfigJson: true },
        });
        const config = parseScoringConfig(template?.scoringConfigJson ?? null);

        // ── Score ──
        const scoring = scoreAssessment({
            questions: questions.map((q) => ({
                id: q.id,
                weight: q.weight,
                required: q.required,
            })),
            answers,
            config,
        });

        // ── Resolve final rating ──
        const ratingOverridden = input.finalRiskRating !== undefined;
        const riskRating: VendorCriticality | null = ratingOverridden
            ? (input.finalRiskRating ?? null)
            : (scoring.suggestedRating ?? null);

        // ── Persist + transition ──
        const reviewedAt = new Date();
        await db.vendorAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'REVIEWED',
                reviewedAt,
                reviewedByUserId: ctx.userId,
                reviewerNotes: input.reviewerNotes
                    ? sanitizePlainText(input.reviewerNotes)
                    : input.reviewerNotes === null
                        ? null
                        : undefined,
                score: scoring.score,
                riskRating,
                decidedAt: reviewedAt,
                decidedByUserId: ctx.userId,
            },
        });

        // ── Audit ──
        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_REVIEWED',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details:
                `Reviewed assessment with ${scoring.mode}: ` +
                `score=${formatScore(scoring.score)}, rating=${riskRating ?? 'none'}, ` +
                `overrides=${overrides.length}` +
                (scoring.verdict ? `, verdict=${scoring.verdict}` : ''),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'reviewed',
                after: {
                    status: 'REVIEWED',
                    mode: scoring.mode,
                    autoSum: scoring.autoSum,
                    effectiveSum: scoring.effectiveSum,
                    score: scoring.score,
                    riskRating,
                    ratingOverridden,
                    overrideCount: overrides.length,
                    answeredCount: scoring.breakdown.length,
                    verdict: scoring.verdict ?? null,
                    reviewedAt: reviewedAt.toISOString(),
                },
                summary: `Vendor assessment reviewed`,
            },
        });

        // ── Evidence attachment + REVIEWED notification (post-commit) ──
        await attachReviewedAssessmentEvidence(
            ctx,
            db,
            assessment.id,
            scoring.score,
            riskRating,
        );
        await notifyAssessmentReviewed(
            assessment.id,
            scoring.score,
            riskRating,
        );

        return {
            status: 'REVIEWED' as const,
            score: scoring.score,
            riskRating,
            ratingOverridden,
            scoring,
            reviewedAt,
        };
    });
}

/**
 * Best-effort REVIEWED notification. Audited as part of the same
 * txn in `notifyAssessmentReviewed`-internal logEvent shim is
 * skipped — the reviewerNotes audit row already covers the human
 * action; the email is operational only.
 */
async function notifyAssessmentReviewed(
    assessmentId: string,
    finalScore: number,
    finalRating: string | null,
): Promise<void> {
    try {
        const a = await prisma.vendorAssessment.findUnique({
            where: { id: assessmentId },
            select: {
                tenantId: true,
                vendor: { select: { name: true, ownerUserId: true } },
                templateVersion: { select: { name: true } },
                tenant: { select: { slug: true } },
                requestedByUserId: true,
                vendorId: true,
            },
        });
        if (!a?.vendor || !a.templateVersion || !a.tenant) return;
        // Recipient: vendor owner if set, else the assessment requester.
        const recipientId =
            a.vendor.ownerUserId ?? a.requestedByUserId;
        const recipient = await prisma.user.findUnique({
            where: { id: recipientId },
            select: { email: true, name: true },
        });
        if (!recipient?.email) return;
        // env.APP_URL is the validated source of truth (src/env.ts).
        const origin = (env.APP_URL ?? '').replace(/\/$/, '');
        const reviewUrl = `${origin}/t/${a.tenant.slug}/admin/vendor-assessment-reviews/${assessmentId}`;

        await prisma.$transaction(async (tx) => {
            await enqueueEmail(tx, {
                tenantId: a.tenantId,
                type: 'VENDOR_ASSESSMENT_REVIEWED',
                toEmail: recipient.email!,
                entityId: assessmentId,
                payload: {
                    recipientName: recipient.name ?? 'there',
                    vendorName: a.vendor!.name,
                    templateName: a.templateVersion!.name,
                    reviewedAtIso: new Date().toISOString(),
                    finalScore,
                    finalRating,
                    reviewUrl,
                },
            });
        });
    } catch (err) {
        logger.warn('vendor-assessment-review: reviewed-notify failed', {
            component: 'vendor-assessment-review',
            assessmentId,
            err: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

/**
 * Create an Evidence row + attach it to the vendor's "Vendor
 * Assessments" bundle. Runs in the same outer transaction (`db`)
 * so a failure rolls back the review itself.
 */
async function attachReviewedAssessmentEvidence(
    ctx: RequestContext,
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    assessmentId: string,
    finalScore: number,
    finalRating: string | null,
): Promise<void> {
    const a = await db.vendorAssessment.findFirst({
        where: { id: assessmentId, tenantId: ctx.tenantId },
        select: {
            vendorId: true,
            templateVersion: { select: { name: true, key: true, version: true } },
        },
    });
    if (!a?.templateVersion) return;

    const content = [
        `Vendor questionnaire reviewed.`,
        `Template: ${a.templateVersion.name} (${a.templateVersion.key} v${a.templateVersion.version})`,
        `Final score: ${finalScore}`,
        `Risk rating: ${finalRating ?? '—'}`,
        `Reviewed at: ${new Date().toISOString()}`,
    ].join('\n');

    const evidence = await db.evidence.create({
        data: {
            tenantId: ctx.tenantId,
            practiceId: null,
            type: 'TEXT',
            title: `Vendor assessment: ${a.templateVersion.name}`,
            content,
            category: 'vendor-assessment',
            status: 'APPROVED',
            ownerUserId: ctx.userId,
        },
        select: { id: true },
    });

    // Get-or-create the vendor's "Vendor Assessments" bundle.
    let bundle = await db.vendorEvidenceBundle.findFirst({
        where: {
            tenantId: ctx.tenantId,
            vendorId: a.vendorId,
            name: 'Vendor Assessments',
        },
        select: { id: true },
    });
    if (!bundle) {
        bundle = await db.vendorEvidenceBundle.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId: a.vendorId,
                name: 'Vendor Assessments',
                description:
                    'Reviewed questionnaire results — auto-attached on review completion.',
                createdByUserId: ctx.userId,
            },
            select: { id: true },
        });
    }

    await db.vendorEvidenceBundleItem.create({
        data: {
            tenantId: ctx.tenantId,
            bundleId: bundle.id,
            entityType: 'Evidence',
            entityId: evidence.id,
            snapshotJson: {
                assessmentId,
                templateName: a.templateVersion.name,
                finalScore,
                finalRating,
                reviewedAt: new Date().toISOString(),
            },
        },
    });

    await logEvent(db, ctx, {
        action: 'VENDOR_ASSESSMENT_EVIDENCE_ATTACHED',
        entityType: 'Vendor',
        entityId: a.vendorId,
        details: `Attached reviewed assessment as evidence (score=${finalScore}, rating=${finalRating ?? 'none'})`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'VendorEvidenceBundleItem',
            operation: 'created',
            after: {
                vendorId: a.vendorId,
                bundleId: bundle.id,
                evidenceId: evidence.id,
                assessmentId,
                finalScore,
                finalRating,
            },
            summary: `Reviewed assessment attached as vendor risk evidence`,
        },
    });
}

// ─── 2. getReviewView ──────────────────────────────────────────────

export interface ReviewViewQuestion {
    id: string;
    sectionId: string;
    sortOrder: number;
    prompt: string;
    answerType: string;
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}
export interface ReviewViewSection {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: ReviewViewQuestion[];
}
export interface ReviewViewAnswer {
    questionId: string;
    answerJson: unknown;
    computedPoints: number;
    reviewerOverridePoints: number | null;
    reviewerNotes: string | null;
    evidenceId: string | null;
}
export interface ReviewView {
    assessmentId: string;
    status: string;
    vendor: { id: string; name: string };
    template: {
        id: string;
        key: string;
        version: number;
        name: string;
        description: string | null;
        isPublished: boolean;
    };
    sections: ReviewViewSection[];
    answers: ReviewViewAnswer[];
    /** Live engine output computed against the current answer state. */
    scoring: ScoringResult;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewedByUserId: string | null;
    reviewerNotes: string | null;
    riskRating: string | null;
    closedAt: string | null;
}

/**
 * Read-only review view. Loads the assessment + template tree +
 * answers and runs the scoring engine fresh against the current
 * answer state (post-override) so the UI sees a live "what would
 * the score be" preview before any save.
 *
 * Permission gate: canRead — every authenticated tenant member can
 * inspect the review surface; only admins can submit it.
 */
export async function getReviewView(
    ctx: RequestContext,
    assessmentId: string,
): Promise<ReviewView> {
    if (!ctx.permissions.canRead) {
        throw badRequest('Read access required.');
    }

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                status: true,
                vendorId: true,
                templateVersionId: true,
                submittedAt: true,
                reviewedAt: true,
                reviewedByUserId: true,
                reviewerNotes: true,
                riskRating: true,
                closedAt: true,
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (!assessment.templateVersionId) {
            throw badRequest(
                'This assessment was not created from a G-3 template.',
            );
        }

        const [vendor, template, answers] = await Promise.all([
            db.vendor.findUnique({
                where: { id: assessment.vendorId },
                select: { id: true, name: true },
            }),
            db.vendorAssessmentTemplate.findUnique({
                where: { id: assessment.templateVersionId },
                select: {
                    id: true,
                    key: true,
                    version: true,
                    name: true,
                    description: true,
                    isPublished: true,
                    scoringConfigJson: true,
                    sections: {
                        orderBy: { sortOrder: 'asc' },
                        include: {
                            questions: { orderBy: { sortOrder: 'asc' } },
                        },
                    },
                    questions: { orderBy: { sortOrder: 'asc' } },
                },
            }),
            db.vendorAssessmentAnswer.findMany({
                where: {
                    assessmentId: assessment.id,
                    tenantId: ctx.tenantId,
                },
                select: {
                    questionId: true,
                    answerJson: true,
                    computedPoints: true,
                    reviewerOverridePoints: true,
                    reviewerNotes: true,
                    evidenceId: true,
                },
            }),
        ]);
        if (!vendor || !template) throw notFound('Assessment context not found');

        const config = parseScoringConfig(template.scoringConfigJson);
        const scoring = scoreAssessment({
            questions: template.questions.map((q) => ({
                id: q.id,
                weight: q.weight,
                required: q.required,
            })),
            answers,
            config,
        });

        return {
            assessmentId: assessment.id,
            status: assessment.status,
            vendor: { id: vendor.id, name: vendor.name },
            template: {
                id: template.id,
                key: template.key,
                version: template.version,
                name: template.name,
                description: template.description,
                isPublished: template.isPublished,
            },
            sections: template.sections.map((s) => ({
                id: s.id,
                sortOrder: s.sortOrder,
                title: s.title,
                description: s.description,
                questions: s.questions.map((q) => ({
                    id: q.id,
                    sectionId: q.sectionId,
                    sortOrder: q.sortOrder,
                    prompt: q.prompt,
                    answerType: q.answerType,
                    required: q.required,
                    weight: q.weight,
                    optionsJson: q.optionsJson,
                    scaleConfigJson: q.scaleConfigJson,
                })),
            })),
            answers: answers.map((a) => ({
                questionId: a.questionId,
                answerJson: a.answerJson,
                computedPoints: a.computedPoints,
                reviewerOverridePoints: a.reviewerOverridePoints,
                reviewerNotes: a.reviewerNotes,
                evidenceId: a.evidenceId,
            })),
            scoring,
            submittedAt: assessment.submittedAt?.toISOString() ?? null,
            reviewedAt: assessment.reviewedAt?.toISOString() ?? null,
            reviewedByUserId: assessment.reviewedByUserId,
            reviewerNotes: assessment.reviewerNotes,
            riskRating: assessment.riskRating,
            closedAt: assessment.closedAt?.toISOString() ?? null,
        };
    });
}

// ─── 3. closeAssessment ────────────────────────────────────────────

export async function closeAssessment(
    ctx: RequestContext,
    assessmentId: string,
    notes?: string | null,
): Promise<CloseAssessmentResult> {
    assertCanApproveAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: { id: true, status: true },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.status !== 'REVIEWED') {
            throw badRequest(
                `Cannot close an assessment in status ${assessment.status}. ` +
                    `Only REVIEWED assessments can be closed.`,
            );
        }

        const closedAt = new Date();
        await db.vendorAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'CLOSED',
                closedAt,
                closedByUserId: ctx.userId,
                ...(notes !== undefined && {
                    reviewerNotes: notes
                        ? sanitizePlainText(notes)
                        : null,
                }),
            },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_CLOSED',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details: `Closed reviewed assessment`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'closed',
                after: {
                    status: 'CLOSED',
                    closedAt: closedAt.toISOString(),
                },
                summary: `Vendor assessment closed`,
            },
        });

        return { status: 'CLOSED' as const, closedAt };
    });
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatScore(n: number): string {
    if (Number.isInteger(n)) return n.toString();
    return n.toFixed(3);
}
