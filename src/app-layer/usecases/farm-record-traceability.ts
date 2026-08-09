/**
 * "Which farm records back this scheme?" — the reverse of auto-evidence.
 *
 * `Evidence.sourceLogEntryId` carries a schema comment naming this exact
 * query, and `@@index([tenantId, sourceLogEntryId])` was added to serve it.
 * Neither had a caller: the index was maintained on every evidence write and
 * read by nothing, and the traceability the comment promised did not exist in
 * any surface a user could reach.
 *
 * The forward direction (`attachAutoEvidenceFromLogEntry`) answers "this spray
 * record proves these practice points". This answers the question an auditor
 * actually asks, which is the other one: *show me the field records behind
 * this certification*. Same rows, opposite direction, and only one of the two
 * is a question a person asks out loud.
 *
 * ## Shape
 *
 * ```
 * Framework (scheme)
 *   └─ FrameworkRequirement[]        the practice points
 *        └─ PracticeRequirementLink[] the tenant's mapping
 *             └─ Practice
 *                  └─ Evidence WHERE sourceLogEntryId IS NOT NULL
 *                       └─ LogEntry               ← what we return
 * ```
 *
 * Walked in four bulk queries, never per-row. The evidence status travels with
 * each record because "backed by a record nobody has reviewed" and "backed by
 * an approved record" are different answers to an auditor, and collapsing them
 * is how a readiness number starts lying.
 *
 * @module app-layer/usecases/farm-record-traceability
 */
import type { LogEntryType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { assertCanViewFrameworks } from '@/app-layer/policies/framework.policies';
import { traceUsecase } from '@/lib/observability';
import type { RequestContext } from '../types';

/** Cap — a traceability panel, not an export. The CSV path is the export. */
const MAX_RECORDS = 200;

export interface BackingFarmRecordPractice {
    practiceId: string;
    practiceCode: string | null;
    practiceName: string;
    /** Requirement codes this practice is mapped to WITHIN this framework. */
    requirementCodes: string[];
    /** Status of the evidence row linking this record to this practice. */
    evidenceStatus: string;
    evidenceId: string;
}

export interface BackingFarmRecord {
    logEntryId: string;
    title: string;
    type: LogEntryType;
    occurredAt: string;
    /** Every practice point this one record backs. */
    practices: BackingFarmRecordPractice[];
    /** True when at least one of its evidence rows is still unreviewed. */
    awaitingReview: boolean;
}

export interface BackingFarmRecordsResult {
    framework: { key: string; name: string };
    records: BackingFarmRecord[];
    /** Total matched before the cap — so the UI can say what it is not showing. */
    totalRecords: number;
    truncated: boolean;
}

/**
 * List the farm journal entries whose auto-collected evidence backs a
 * framework's practice points, newest first.
 */
export async function listFarmRecordsBackingFramework(
    ctx: RequestContext,
    frameworkKey: string,
): Promise<BackingFarmRecordsResult> {
    assertCanViewFrameworks(ctx);

    return traceUsecase('farmRecordTraceability.listBackingFramework', ctx, async () => {
        // 1 — The framework and its requirements. Global catalog, not tenant
        //     data, so it reads off the base client.
        const fw = await prisma.framework.findFirst({
            where: { key: frameworkKey },
            select: { id: true, key: true, name: true },
        });
        if (!fw) throw notFound('Framework not found');

        const requirements = await prisma.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true },
        });
        if (requirements.length === 0) {
            return { framework: { key: fw.key, name: fw.name }, records: [], totalRecords: 0, truncated: false };
        }
        const requirementCodeById = new Map(requirements.map((r) => [r.id, r.code]));

        return runInTenantContext(ctx, async (db) => {
            // 2 — The tenant's mapping. A tenant that has not installed the
            //     scheme has no links, so the whole thing is an empty answer
            //     rather than an error.
            const links = await db.practiceRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirementId: { in: [...requirementCodeById.keys()] } },
                select: { practiceId: true, requirementId: true },
            });
            if (links.length === 0) {
                return { framework: { key: fw.key, name: fw.name }, records: [], totalRecords: 0, truncated: false };
            }

            // practiceId → the requirement codes it covers in THIS framework.
            const codesByPractice = new Map<string, string[]>();
            for (const l of links) {
                const code = requirementCodeById.get(l.requirementId);
                if (!code) continue;
                const list = codesByPractice.get(l.practiceId);
                if (list) list.push(code);
                else codesByPractice.set(l.practiceId, [code]);
            }
            const practiceIds = [...codesByPractice.keys()];

            // 3 — The evidence rows derived from a farm record. This is the
            //     query the (tenantId, sourceLogEntryId) index exists for.
            const evidence = await db.evidence.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    practiceId: { in: practiceIds },
                    sourceLogEntryId: { not: null },
                    deletedAt: null,
                },
                select: {
                    id: true,
                    status: true,
                    practiceId: true,
                    sourceLogEntryId: true,
                    practice: { select: { id: true, code: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: MAX_RECORDS * 4, // several practices per record
            });
            if (evidence.length === 0) {
                return { framework: { key: fw.key, name: fw.name }, records: [], totalRecords: 0, truncated: false };
            }

            // 4 — The journal entries themselves, in one query. Ordering comes
            //     from here (occurredAt), not from the evidence rows.
            const logEntryIds = [...new Set(
                evidence.map((e) => e.sourceLogEntryId).filter((v): v is string => !!v),
            )];
            const entries = await db.logEntry.findMany({
                where: { tenantId: ctx.tenantId, id: { in: logEntryIds }, deletedAt: null },
                select: { id: true, title: true, type: true, occurredAt: true },
                orderBy: { occurredAt: 'desc' },
                take: MAX_RECORDS,
            });

            const byEntry = new Map<string, BackingFarmRecordPractice[]>();
            for (const e of evidence) {
                if (!e.sourceLogEntryId || !e.practice) continue;
                const row: BackingFarmRecordPractice = {
                    practiceId: e.practice.id,
                    practiceCode: e.practice.code,
                    practiceName: e.practice.name,
                    requirementCodes: codesByPractice.get(e.practice.id) ?? [],
                    evidenceStatus: e.status,
                    evidenceId: e.id,
                };
                const list = byEntry.get(e.sourceLogEntryId);
                if (list) list.push(row);
                else byEntry.set(e.sourceLogEntryId, [row]);
            }

            const records: BackingFarmRecord[] = entries.map((entry) => {
                const practices = byEntry.get(entry.id) ?? [];
                return {
                    logEntryId: entry.id,
                    title: entry.title,
                    type: entry.type,
                    occurredAt: entry.occurredAt.toISOString(),
                    practices,
                    awaitingReview: practices.some((c) => c.evidenceStatus !== 'APPROVED'),
                };
            });

            return {
                framework: { key: fw.key, name: fw.name },
                records,
                totalRecords: logEntryIds.length,
                truncated: logEntryIds.length > records.length,
            };
        });
    });
}
