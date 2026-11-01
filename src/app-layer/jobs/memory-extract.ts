/**
 * Extract remembered points from conversations that have ENDED (#2671).
 *
 * The queue is `extractedAt IS NULL AND lastTurnAt < cutoff`. That is also the
 * answer to the question #2671 left open — whether extraction runs per
 * conversation end or on a schedule. It is ONE mechanism, not two: "ended" can
 * only ever be an idle timeout, because nothing fires when a person puts their
 * phone down, so a per-conversation-end hook would need this sweep anyway to
 * catch the abandoned ones. `AssistantConversation.lastTurnAt`'s own docblock
 * anticipated it.
 *
 * ## Two queries, and the split is load-bearing
 *
 * `notice-score`'s shape, for its reasons:
 *
 *   · the QUEUE is raw SQL on the global client, so the database does the
 *     anti-join under a LIMIT and the scan is cross-tenant — the sweep has to
 *     find every idle conversation, not one farm's.
 *   · the TURNS go through `runInTenantContext`, because `AssistantTurn.content`
 *     is encrypted under the TENANT's DEK and the client extension is what
 *     decrypts it. Read them raw and the model extracts from ciphertext,
 *     returning a confident nothing with nothing failing.
 *
 * ## Stamping
 *
 * `extractedAt` is set in the SAME transaction as the facts, and AFTER them.
 * Stamping first loses a conversation permanently on any failure in between;
 * the queue IS the unstamped set, so leaving it unstamped is the retry. That is
 * `statement-dispatch`'s rule.
 *
 * A conversation whose extraction wrote nothing is still stamped — "looked and
 * learned nothing" has to be distinguishable from "not looked at yet", or the
 * queue never drains and every run re-spends on the same conversations.
 *
 * ## What is deliberately NOT stamped
 *
 * A conversation skipped because the flag is OFF for that person, or because
 * their farm is over its AI ceiling. Stamping either would mean that turning
 * the flag on, or paying for more budget, silently skipped every conversation
 * that happened first — `notice-triage-alert`'s rule about the unconfigured
 * branch, which is the same mistake in a different coat.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { extractMemoryPoints, type ExistingPoint, type UserTurn } from '@/app-layer/ai/memory-extractor';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { isAppError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import type { JobRunResult, MemoryExtractPayload } from './types';

const COMPONENT = 'memory-extract';
const MEMORY_FLAG = 'assistant.memory';

/** Conversations per run. */
const DEFAULT_BATCH = 20;
/** Quiet minutes after which a conversation counts as ENDED. */
export const DEFAULT_IDLE_MINUTES = 30;
/**
 * Turns read per conversation, and a character ceiling beside it.
 *
 * Two bounds because only one of them is bounded by the other: 40 turns of a
 * pasted spray label is a different prompt from 40 short questions, and the
 * count alone does not say which this is.
 */
const MAX_TURNS = 40;
const MAX_TURN_CHARS = 12_000;

function jobContext(tenantId: string): RequestContext {
    return {
        userId: 'system:memory-extract',
        tenantId,
        requestId: `memory-extract-${tenantId}`,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: false },
        appPermissions: undefined,
    } as unknown as RequestContext;
}

export async function runMemoryExtract(
    payload: MemoryExtractPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `mx-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;
    const idleMinutes = payload.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    const cutoff = new Date(Date.now() - idleMinutes * 60_000);

    let scanned = 0;
    let actioned = 0;
    let skipped = 0;
    let pointsWritten = 0;

    const queue = await prisma.$queryRaw<Array<{ id: string; tenantId: string; userId: string }>>`
        SELECT "id", "tenantId", "userId"
        FROM "AssistantConversation"
        WHERE "extractedAt" IS NULL
          AND "lastTurnAt" < ${cutoff}
        ORDER BY "lastTurnAt" ASC
        LIMIT ${take}
    `;
    scanned = queue.length;

    /*
     * Tenants whose ceiling is already known to be reached, for THIS run.
     *
     * The budget is per-tenant and the queue is cross-tenant, so one farm being
     * out of tokens must not stop another's extraction — but re-asking the same
     * exhausted tenant once per conversation is a database aggregate per row for
     * an answer that cannot change inside one run.
     */
    const exhausted = new Set<string>();

    /*
     * guardrail-allow: n+1 — the per-conversation reads cannot be hoisted, and
     * the loop is bounded.
     *
     * `AssistantTurn.content` is encrypted under the TENANT's DEK, so it is
     * only readable inside `runInTenantContext` for THAT tenant. The queue is
     * cross-tenant by design, so one `findMany({ conversationId: { in: [...] } })`
     * would have to pick a single tenant context and would silently return
     * ciphertext — or nothing — for every other farm in the batch. The read is
     * per-tenant because the KEY is per-tenant.
     *
     * The fact read is per-PERSON for the same structural reason: rules 4, 5
     * and 6 are evaluated against that person's own points, and batching them
     * would mean passing one person's profile while extracting another's.
     *
     * Bounded at `DEFAULT_BATCH` (20) conversations, so this is at most 40
     * indexed reads per run, each backed by a purpose-built composite.
     */
    for (const conv of queue) { // guardrail-allow: n+1
        try {
            // Per PERSON, because the flag resolves cohorts per user. An OFF
            // flag leaves the row UNSTAMPED on purpose — see the module note.
            if (!(await isFeatureEnabled(MEMORY_FLAG, conv.userId))) {
                skipped += 1;
                continue;
            }
            if (exhausted.has(conv.tenantId)) {
                skipped += 1;
                continue;
            }

            const ctx = jobContext(conv.tenantId);

            // Only `user` turns. An `assistant` turn may quote tool output —
            // a parcel's area, a block's reading — and rule 1 forbids a farm's
            // records entering a profile that is read across farms. Rule 3's
            // verbatim-quote check then makes that structural rather than
            // merely intended.
            const rows = await runInTenantContext(ctx, (db) =>
                db.assistantTurn.findMany({
                    where: { conversationId: conv.id, role: 'user' },
                    orderBy: { createdAt: 'asc' },
                    take: MAX_TURNS,
                    select: { content: true, createdAt: true },
                }),
            );

            let budget = MAX_TURN_CHARS;
            const turns: UserTurn[] = [];
            for (const r of rows) {
                if (budget - r.content.length < 0) break;
                budget -= r.content.length;
                turns.push({ content: r.content, createdAt: r.createdAt });
            }

            if (turns.length === 0) {
                // Nothing to learn from, and that is a FINISHED conversation
                // rather than a pending one. Stamp it or it is re-read for ever.
                await prisma.assistantConversation.update({
                    where: { id: conv.id },
                    data: { extractedAt: new Date() },
                });
                actioned += 1;
                continue;
            }

            // Every point the person has, including tombstoned and superseded
            // ones: rules 4, 5 and 6 and the idempotence check all need them.
            const facts = await prisma.assistantMemoryFact.findMany({
                where: { userId: conv.userId },
                select: {
                    id: true,
                    text: true,
                    editedByPerson: true,
                    deletedAt: true,
                    supersededAt: true,
                    sourceQuote: true,
                },
            });
            const existing: ExistingPoint[] = facts.map((f) => ({
                id: f.id,
                text: f.text,
                editedByPerson: f.editedByPerson,
                // `refused` is rule 5 — the PERSON's deletion. A supersede is
                // not a refusal, and conflating them would make the extractor
                // treat its own bookkeeping as somebody's wish.
                refused: f.deletedAt !== null,
                sourceQuote: f.sourceQuote,
            }));

            // The gate lives INSIDE `extractMemoryPoints`, beside the spend it
            // guards — see its docblock. The refusal still arrives here, which
            // is what drives the skip-without-stamping and the exhausted memo.
            const outcome = await extractMemoryPoints(ctx, turns, existing);

            const now = new Date();
            await prisma.$transaction(async (tx) => {
                for (const point of outcome.points) {
                    if (point.supersedesId) {
                        await tx.assistantMemoryFact.update({
                            where: { id: point.supersedesId },
                            data: { supersededAt: now },
                        });
                    }
                    await tx.assistantMemoryFact.create({
                        data: {
                            userId: conv.userId,
                            text: point.text,
                            sourceQuote: point.sourceQuote,
                            sourceAt: now,
                            editedByPerson: false,
                        },
                    });
                }
                // LAST, and in the same transaction. See the module note.
                await tx.assistantConversation.update({
                    where: { id: conv.id },
                    data: { extractedAt: now },
                });
            });

            pointsWritten += outcome.points.length;
            actioned += 1;

            if (outcome.discarded.length) {
                // A READING, not an error. A high discard count means the
                // prompt is drifting from the rules, which is only visible if
                // the counts are reported.
                logger.info('memory-extract.discarded', {
                    component: COMPONENT,
                    conversationId: conv.id,
                    discarded: outcome.discarded,
                });
            }
        } catch (err) {
            skipped += 1;
            if (isAppError(err) && err.code === 'AI_BUDGET_EXCEEDED') {
                // Not an error in this job: the farm is over its ceiling. The
                // row stays unstamped so it is picked up when budget frees, and
                // the tenant is not re-asked for the rest of this run.
                exhausted.add(conv.tenantId);
                logger.info('memory-extract.budget_exhausted', {
                    component: COMPONENT,
                    tenantId: conv.tenantId,
                });
                continue;
            }
            logger.warn('memory-extract.failed', {
                component: COMPONENT,
                conversationId: conv.id,
                tenantId: conv.tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'memory-extract',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: scanned,
            itemsActioned: actioned,
            itemsSkipped: skipped,
            /*
             * `success: true` WITH skips is the honest shape — the RUN worked,
             * and the skips are the finding. `notice-score`'s reasoning, with
             * one difference worth naming: a skip here can mean the flag is off
             * for that person, or their farm is over its ceiling, and both
             * leave the row queued. So a persistently non-zero
             * `conversationsLeftQueued` is a real signal rather than noise.
             */
            details: { pointsWritten, conversationsLeftQueued: skipped },
        },
    };
}
