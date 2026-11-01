/**
 * Classify-photo job (feat/ai-vision) — async leaf/crop photo → likely
 * pest/disease + a grounded recommendation, enqueued when a photo is
 * attached to a LogEntry.
 *
 * Flow:
 *   1. Load the stored image bytes (FileRecord → storage provider).
 *   2. Run the vision orchestrator (`identifyPhoto`): on-device ONNX
 *      first, Claude fallback (see `ai/vision`).
 *   3. GATE low confidence — below the threshold the result is still
 *      stored but flagged `lowConfidence:true` with an "inconclusive,
 *      verify with an agronomist" recommendation.
 *   4. Pair the (sufficiently confident) identification with the
 *      AgroSignal/RAG copilot (`askKnowledgeBase`) for a grounded,
 *      cite-aware recommendation/explanation.
 *   5. Write the result under `LogEntry.attributesJson.pestId` and audit
 *      it. Tenant-scoped via `runInTenantContext`.
 *
 * INVARIANTS:
 *   - NEVER auto-applies: the result is an advisory suggestion stored in
 *     attributesJson; it never changes the LogEntry's type or fields.
 *   - Fail-safe: a missing key, failed inference, or oversized image →
 *     no-op success (the photo + log entry stand untouched).
 *   - Every persisted result carries a hard "not a diagnosis" disclaimer.
 *
 * @module app-layer/jobs/classify-photo
 */
import { Readable } from 'stream';
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { getProviderByName } from '@/lib/storage';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { publishFreshNotifications } from '@/app-layer/notifications/publish-fresh';
import { getPermissionsForRole } from '@/lib/permissions';
import { identifyPhoto } from '@/app-layer/ai/vision';
import { assertAiBudget } from '@/app-layer/ai/budget';
import { recordAiUsage } from '@/app-layer/ai/usage';
import { estimateCostMicros } from '@/app-layer/ai/cost';
import { AppError } from '@/lib/errors/types';
import { askKnowledgeBase } from '@/app-layer/usecases/rag';
import type { StorageProviderType } from '@/lib/storage/types';
import type { RequestContext } from '../types';
import type { JobRunResult, ClassifyPhotoPayload } from './types';

export interface ClassifyPhotoResult {
    result: JobRunResult;
    classified: boolean;
}

/** Vision-safe image cap — refuse anything larger than 8 MB. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Below this confidence the result is gated: stored but flagged
 * lowConfidence with an inconclusive recommendation. Field photos are
 * noisier than lab images, so treat the edge band with extra caution.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** The mandatory advisory disclaimer stamped on every persisted result. */
/**
 * May this tenant pay for the CLOUD vision fallback right now? (#2596)
 *
 * ## Why this asks the throwing gate instead of a predicate of its own
 *
 * `assertAiBudget` is the authority — it reads `PLAN_LIMITS` through
 * `getLimit` + `getAiTokensUsedThisMonth` and is what every text path is
 * gated on. A second, non-throwing predicate beside it would be two spellings
 * of one policy, and the pair would eventually disagree about the limit. So
 * this calls the authority and interprets its refusal.
 *
 * ## It catches ONLY the budget refusal
 *
 * Anything else — an unreachable database, a missing billing row, a bug —
 * RETHROWS. Absorbing those as "no budget" would make two very different
 * causes produce one answer: a farm would silently lose its cloud
 * classification because Postgres blinked, and the log would say it was out of
 * tokens. The job's own error handling is the right home for a real failure.
 */
async function cloudVisionAllowed(ctx: RequestContext): Promise<boolean> {
    try {
        await assertAiBudget(ctx);
        return true;
    } catch (err) {
        if (err instanceof AppError && err.code === 'AI_BUDGET_EXCEEDED') {
            logger.info('vision cloud fallback refused — AI budget exhausted', {
                component: 'classify-photo',
                tenantId: ctx.tenantId,
            });
            return false;
        }
        throw err;
    }
}

export const PEST_ID_DISCLAIMER = 'AI suggestion — verify with an agronomist, not a diagnosis';

/**
 * Persisted shape at `LogEntry.attributesJson.pestId`. The UI imports
 * THIS type only (never a vision provider).
 */
export interface StoredPestId {
    identifiedPest: string;
    confidence: number;
    recommendation: string;
    modelVersion: string;
    backend: 'onnx' | 'claude';
    lowConfidence: boolean;
    disclaimer: string;
    /** ISO timestamp the classification was produced. */
    at: string;
    /** The file this identification was produced from. */
    fileRecordId: string;
}

/** A system RequestContext scoped to a tenant, for the RAG read path. */
function makeSystemCtx(tenantId: string): RequestContext {
    return {
        requestId: `classify-photo-${tenantId}-${Date.now()}`,
        userId: 'system',
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            stream.destroy();
            return null;
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

/**
 * Ground the identification in the knowledge base — a cite-aware
 * recommendation that augments the model's terse one. Fail-safe: returns
 * the raw recommendation when RAG produces nothing.
 */
async function groundRecommendation(
    ctx: RequestContext,
    identifiedPest: string,
    rawRecommendation: string,
    contextNote: string | null,
): Promise<string> {
    try {
        const query = [
            `What is the recommended management for "${identifiedPest}" in a field crop?`,
            contextNote ? `Field context: ${contextNote}.` : null,
        ]
            .filter(Boolean)
            .join(' ');
        const { answer, sources } = await askKnowledgeBase(ctx, query);
        // Only prefer the grounded answer when it was actually grounded
        // in sources (otherwise it's the fixed "not in my sources" text).
        if (sources.length > 0 && answer.trim().length > 0) {
            return answer.trim();
        }
    } catch (err) {
        logger.warn('classify-photo: RAG grounding failed', {
            component: 'job',
            jobName: 'classify-photo',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return rawRecommendation;
}

export async function runClassifyPhoto(payload: ClassifyPhotoPayload): Promise<ClassifyPhotoResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'classify-photo',
        async () => {
            const { tenantId, logEntryId, fileId } = payload;
            let classified = false;

            const file = await prisma.fileRecord.findFirst({
                where: { id: fileId, tenantId },
                select: { pathKey: true, mimeType: true, storageProvider: true },
            });
            const logEntry = await prisma.logEntry.findFirst({
                where: { id: logEntryId, tenantId },
                select: {
                    title: true,
                    notes: true,
                    attributesJson: true,
                    // Ported from the deleted photo-pest-id twin: notify the
                    // uploader when their photo has been analysed.
                    createdByUserId: true,
                    tenant: { select: { slug: true } },
                },
            });

            const isImage = file?.mimeType?.startsWith('image/');
            if (file && logEntry && isImage) {
                let bytes: Buffer | null = null;
                try {
                    const provider = getProviderByName(file.storageProvider as StorageProviderType);
                    bytes = await streamToBuffer(provider.readStream(file.pathKey), MAX_IMAGE_BYTES);
                } catch (err) {
                    logger.warn('classify-photo: image read failed', {
                        component: 'job',
                        jobName: 'classify-photo',
                        tenantId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                if (bytes) {
                    /**
                     * #2596 — the budget is ASSERTED here and the spend
                     * RECORDED below, and neither happened before.
                     *
                     * This surface reaches Anthropic through
                     * `ai/vision/claude-vision-provider`, which constructs the
                     * SDK directly rather than going through
                     * `completeWithRouting` — the one place that gates and
                     * records for every text path. So an unmetered paid call
                     * was reachable from any photo upload, while the sibling
                     * `askKnowledgeBase` call forty lines up was gated the
                     * whole time.
                     */
                    const budgetCtx = makeSystemCtx(tenantId);
                    const identification = await identifyPhoto(
                        { bytes, mimeType: file.mimeType },
                        { allowCloud: await cloudVisionAllowed(budgetCtx) },
                    );

                    /**
                     * Recorded whenever a PAID backend produced the result.
                     * `usage` is absent for the on-device backend by
                     * construction, so this writes a row only for a real
                     * spend — and the assertion above would otherwise cap
                     * against a total nothing contributes to, which is a cap
                     * that never binds.
                     */
                    if (identification?.usage) {
                        const u = identification.usage;
                        await recordAiUsage(budgetCtx, {
                            task: 'classify-photo',
                            model: u.model,
                            backend: identification.backend,
                            promptTokens: u.promptTokens,
                            completionTokens: u.completionTokens,
                            totalTokens: u.totalTokens,
                            costMicros: estimateCostMicros(u.model, {
                                promptTokens: u.promptTokens,
                                completionTokens: u.completionTokens,
                                totalTokens: u.totalTokens,
                            }),
                            cacheHit: false,
                            // The FILE, not the prompt: the prompt is a
                            // constant here, so hashing it would correlate
                            // nothing. Never the bytes.
                            promptHash: fileId,
                        });
                    }

                    if (identification) {
                        const lowConfidence = identification.confidence < LOW_CONFIDENCE_THRESHOLD;
                        const contextNote =
                            [logEntry.title, logEntry.notes].filter(Boolean).join(' — ') || null;

                        let recommendation: string;
                        if (lowConfidence) {
                            recommendation =
                                'Inconclusive — verify with an agronomist. The photo did not yield a confident identification.';
                        } else {
                            const ctx = makeSystemCtx(tenantId);
                            recommendation = await groundRecommendation(
                                ctx,
                                identification.identifiedPest,
                                identification.recommendation,
                                contextNote,
                            );
                        }

                        const stored: StoredPestId = {
                            identifiedPest: identification.identifiedPest,
                            confidence: identification.confidence,
                            recommendation,
                            modelVersion: identification.modelVersion,
                            backend: identification.backend,
                            lowConfidence,
                            disclaimer: PEST_ID_DISCLAIMER,
                            at: new Date().toISOString(),
                            fileRecordId: fileId,
                        };

                        // Persist + audit, tenant-scoped. NEVER mutates the
                        // entry's type/fields — only merges under the
                        // advisory `attributesJson.pestId` key.
                        await runInTenantContext(makeSystemCtx(tenantId), async (db) => {
                            const existing =
                                (logEntry.attributesJson as Record<string, unknown> | null) ?? {};
                            await db.logEntry.update({
                                where: { id: logEntryId },
                                data: {
                                    attributesJson: JSON.parse(
                                        JSON.stringify({ ...existing, pestId: stored }),
                                    ),
                                },
                            });
                            await logEvent(db, makeSystemCtx(tenantId), {
                                action: 'LOG_ENTRY_PHOTO_CLASSIFIED',
                                entityType: 'LogEntry',
                                entityId: logEntryId,
                                details: `Photo classified: ${stored.identifiedPest} (${(stored.confidence * 100).toFixed(0)}%, ${stored.backend})`,
                                detailsJson: {
                                    category: 'custom',
                                    event: 'photo_pest_id',
                                    detail: stored.identifiedPest,
                                    backend: stored.backend,
                                    modelVersion: stored.modelVersion,
                                    confidence: stored.confidence,
                                    lowConfidence: stored.lowConfidence,
                                    fileRecordId: fileId,
                                },
                            });


                            // ── Uploader notification (ported) ──
                            // The only capability the dead photo-pest-id twin
                            // had that this job lacked. Gated on the same
                            // confidence threshold the storage path uses: a
                            // low-confidence result is still stored, but it
                            // announces "inconclusive" rather than naming a
                            // pest the model isn't sure about.
                            if (logEntry.createdByUserId) {
                                // Captured, because the publish below now runs
                                // inside an `afterCommit` closure (#1990) and
                                // TypeScript discards the narrowing from the
                                // guard above at a function boundary — it
                                // cannot prove the field is still non-null when
                                // the effect drains. The const carries the
                                // narrowed value rather than re-asserting it
                                // with `!`, which would be a claim about the
                                // future rather than a fact about now.
                                const notifyUserId = logEntry.createdByUserId;
                                const dedupeKey = `classify-photo:${tenantId}:${logEntryId}:${fileId}`;
                                const linkUrl = `/t/${logEntry.tenant?.slug ?? ''}/journal/${logEntryId}`;
                                const title = stored.lowConfidence
                                    ? 'Снимката е анализирана — няма ясен резултат'
                                    : `Възможен проблем: ${stored.identifiedPest}`;
                                const message = `${stored.recommendation} ${stored.disclaimer}`.trim();
                                const created = await db.notification.createMany({
                                    data: [{
                                        tenantId,
                                        userId: logEntry.createdByUserId,
                                        type: 'GENERAL' as const,
                                        title,
                                        message,
                                        linkUrl,
                                        dedupeKey,
                                    }],
                                    skipDuplicates: true,
                                });
                                // Publish ONLY on a real insert — the twin
                                // published unconditionally, so a retry
                                // re-notified even when the row deduped.
                                if (created.count > 0) {
                                    await publishFreshNotifications(
                                        db,
                                        'notify.classify-photo',
                                        [{ tenantId, userId: notifyUserId, dedupeKey }],
                                    );
                                }
                            }
                        });
                        classified = true;
                    }
                }
            }

            logger.info('classify-photo completed', {
                component: 'job',
                jobName: 'classify-photo',
                tenantId,
                logEntryId,
                classified,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'classify-photo',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: 1,
                itemsActioned: classified ? 1 : 0,
                itemsSkipped: classified ? 0 : 1,
                details: { classified },
            };
            return { result, classified };
        },
        { tenantId: payload.tenantId },
    );
}
