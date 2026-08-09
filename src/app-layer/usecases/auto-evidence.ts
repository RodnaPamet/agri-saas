import type { LogEntryType } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { AUTO_FARM_RECORD_CATEGORY } from '@/lib/evidence/auto-evidence-constants';

/**
 * Auto-evidence — turning farm records into certification-scheme evidence.
 *
 * Certain durable farm records (a completed spray = an INPUT_APPLICATION
 * `LogEntry`) are themselves the proof that a scheme practice point is
 * being met (GlobalG.A.P. CB.7 "application records", EU-Organic input
 * records). Rather than make the operator re-key that record as evidence,
 * `attachAutoEvidenceFromLogEntry` walks from the LogEntry → the scheme
 * requirement(s) it satisfies → the tenant's Practice(s) mapped to those
 * requirements (via `PracticeRequirementLink`) and mints one Evidence row
 * per practice, back-referenced to the LogEntry via `Evidence.sourceLogEntryId`.
 *
 * The natural gate is installation: a tenant that hasn't installed the
 * scheme pack has no Practice mapped to the requirement, so there are no
 * links, so this is a silent no-op. No extra module check is needed.
 *
 * Runs INSIDE the caller's existing tenant transaction (`db`) — the spray
 * journal write and its auto-evidence are atomic. We write Evidence (and
 * its `PracticeEvidenceLink`) directly on `db` rather than calling the
 * `createEvidence` usecase: that usecase opens its OWN
 * `runInTenantContext`, and Prisma interactive transactions cannot nest.
 *
 * STATUS = SUBMITTED, deliberately. Auto-evidence is auto-COLLECTED but
 * NOT auto-approved: it enters the existing `reviewEvidence` state machine
 * at SUBMITTED, pending a human APPROVED decision. Readiness scoring only
 * counts APPROVED evidence, so nothing unreviewed silently inflates a
 * scheme's readiness — a person still signs off.
 */

/** One auto-evidence rule: a farm-record type → the scheme requirement(s)
 *  that record satisfies. `requirementCodes` are the EXACT codes from the
 *  scheme catalog YAMLs under prisma/catalogs/. */
interface AutoEvidenceRule {
    frameworkKey: string;
    requirementCodes: readonly string[];
}

/**
 * Maps a `LogEntryType` to the scheme requirement(s) it auto-satisfies.
 * INPUT_APPLICATION (a completed spray/fertiliser record) is the proof for
 * the plant-protection / input-record practice points of both demo schemes:
 *   - GlobalG.A.P. IFA CB.7.1/CB.7.6/CB.7.9 (product choice, application
 *     records, pre-harvest interval) — codes from globalgap-ifa-demo.yaml.
 *   - EU-Organic EUO.2/EUO.3 (permitted inputs + input/parcel records) —
 *     codes from eu-organic-2018-848-demo.yaml.
 */
export const AUTO_EVIDENCE_RULES: Partial<Record<LogEntryType, readonly AutoEvidenceRule[]>> = {
    INPUT_APPLICATION: [
        {
            frameworkKey: 'GLOBALGAP-IFA-DEMO',
            requirementCodes: ['CB.7.1', 'CB.7.6', 'CB.7.9'],
        },
        {
            frameworkKey: 'EU-ORGANIC-2018-848-DEMO',
            requirementCodes: ['EUO.2', 'EUO.3'],
        },
        {
            // The Bulgarian regime a local farm actually faces. A spray record
            // in this product IS the ДНЕВНИК entry — it carries the date, the
            // parcel, the product and the dose — so the record-keeping and
            // pre-harvest-interval practice points are satisfied by the same
            // farm data GlobalG.A.P. and EU Organic already draw on. The
            // product implemented the ДНЕВНИК and the БАБХ identity block long
            // before this, and none of it reached /schemes.
            frameworkKey: 'BG-BABH-PPP',
            requirementCodes: ['BG.PPP.1', 'BG.PPP.3'],
        },
    ],
};

export interface AttachAutoEvidenceResult {
    created: number;
}

/**
 * Attach a farm `LogEntry` as scheme evidence to every tenant Practice
 * mapped to the requirement(s) that record-type satisfies.
 *
 * @param db          The caller's tenant-bound Prisma handle (RLS already set).
 * @param ctx         RequestContext (tenantId / tenantSlug / userId).
 * @param logEntryId  The LogEntry just created.
 * @returns           How many Evidence rows were created (0 on no-op).
 */
export async function attachAutoEvidenceFromLogEntry(
    db: PrismaTx,
    ctx: RequestContext,
    logEntryId: string,
): Promise<AttachAutoEvidenceResult> {
    // 1 — Load the source record. Tenant-filtered (defence in depth on top
    //     of RLS). Soft-deleted entries don't back evidence.
    const logEntry = await db.logEntry.findFirst({
        where: { id: logEntryId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, type: true, title: true, occurredAt: true },
    });
    if (!logEntry) return { created: 0 };

    const rules = AUTO_EVIDENCE_RULES[logEntry.type as LogEntryType];
    if (!rules || rules.length === 0) return { created: 0 };

    // 2 — Resolve every rule's requirement IDs in ONE query (framework key
    //     + code pair list). No per-requirement loop → no N+1.
    const orClauses = rules.map((rule) => ({
        framework: { key: rule.frameworkKey },
        code: { in: [...rule.requirementCodes] },
    }));
    const requirements = await db.frameworkRequirement.findMany({
        where: { OR: orClauses },
        select: { id: true },
    });
    if (requirements.length === 0) return { created: 0 };
    const requirementIds = requirements.map((r) => r.id);

    // 3 — Find the tenant's Practices linked to those requirements. A tenant
    //     that hasn't installed the scheme has zero links here → no-op.
    //     One findMany, distinct practiceIds collected in memory.
    const links = await db.practiceRequirementLink.findMany({
        where: { tenantId: ctx.tenantId, requirementId: { in: requirementIds } },
        select: { practiceId: true },
    });
    const practiceIds = [...new Set(links.map((l) => l.practiceId))];
    if (practiceIds.length === 0) return { created: 0 };

    // 4 — Idempotency: skip practices that already carry auto-evidence for
    //     THIS LogEntry. One query over (sourceLogEntryId, practiceId∈…).
    const existing = await db.evidence.findMany({
        where: {
            tenantId: ctx.tenantId,
            sourceLogEntryId: logEntryId,
            practiceId: { in: practiceIds },
        },
        select: { practiceId: true },
    });
    const alreadyAttached = new Set(existing.map((e) => e.practiceId));

    // The title is the journal entry's own. It used to be persisted as
    // `Farm record — {title}`, which baked an English string into the database
    // where next-intl can never reach it: a Bulgarian operator's evidence list
    // read "Farm record — " on every auto-collected row. The marker is now
    // rendered from `category` in the reader's locale.
    const title = sanitizePlainText(logEntry.title);
    const content = `/t/${ctx.tenantSlug ?? ''}/journal/${logEntryId}`;

    const toCreate = practiceIds.filter((id) => !alreadyAttached.has(id));
    if (toCreate.length === 0) return { created: 0 };

    // 5 — Insert every row in ONE statement, and let the database be the
    //     authority on idempotency.
    //
    //     The step-4 read is a fast path, not a guarantee: read-then-write is
    //     TOCTOU, and this runs inside a transaction opened by a journal write
    //     that a retry or a concurrent field-operation save can repeat. Two
    //     callers could each read "not attached" and each insert, leaving the
    //     same farm record attached to the same practice twice — one practice
    //     point apparently backed by two records, and a duplicate row a
    //     reviewer has to approve twice. The
    //     `(tenantId, sourceLogEntryId, practiceId)` unique index closes that,
    //     and `skipDuplicates` means a loser resolves its conflict inside the
    //     statement rather than raising a 23505 that would abort the caller's
    //     transaction.
    const inserted = await db.evidence.createMany({
        data: toCreate.map((practiceId) => ({
            tenantId: ctx.tenantId,
            practiceId,
            sourceLogEntryId: logEntryId,
            type: 'LINK' as const,
            title,
            // Deep-link back to the journal entry that is the evidence.
            content,
            category: AUTO_FARM_RECORD_CATEGORY,
            dateCollected: logEntry.occurredAt,
            // Auto-collected, pending human approval (see header note).
            status: 'SUBMITTED' as const,
        })),
        skipDuplicates: true,
    });

    // Resolve the ids for the bridge links + audit rows. One query for the
    // batch — `createMany` cannot return them.
    const rows = await db.evidence.findMany({
        where: {
            tenantId: ctx.tenantId,
            sourceLogEntryId: logEntryId,
            practiceId: { in: toCreate },
        },
        select: { id: true, practiceId: true },
    });

    // Mirror createEvidence's practice↔evidence bridge so the rows show in the
    // practice's Evidence tab. Duplicate-link is tolerated — but by ON CONFLICT
    // DO NOTHING, not by a try/catch. A caught 23505 leaves the enclosing
    // Postgres transaction aborted, so the very next statement (the audit
    // write below) fails with 25P02 and takes the attach down. See the longer
    // note in `evidence.ts`.
    await db.practiceEvidenceLink.createMany({
        data: rows.map((row) => ({
            tenantId: ctx.tenantId,
            practiceId: row.practiceId as string,
            kind: 'LINK' as const,
            url: content,
            note: title,
            createdByUserId: ctx.userId,
        })),
        skipDuplicates: true,
    });

    // Audit stays one row per evidence row — the chain is hash-linked and
    // sequential by construction.
    for (const row of rows) {
        await logEvent(db, ctx, {
            action: 'AUTO_EVIDENCE_ATTACHED',
            entityType: 'Evidence',
            entityId: row.id,
            details: `Farm record auto-attached as scheme evidence (practice ${row.practiceId})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: { sourceLogEntryId: logEntryId, practiceId: row.practiceId, status: 'SUBMITTED' },
                summary: 'Farm record auto-attached as scheme evidence',
            },
        });
    }

    return { created: inserted.count };
}

// ─── Keeping derived evidence truthful ─────────────────────────────
//
// Auto-evidence is a CLAIM about a farm record: "practice point CB.7.6 is met,
// and here is the spray record that proves it". A claim derived from a row
// that has since changed, or has since been deleted, is not evidence — it is
// a stale assertion sitting in an auditor's pack. Neither of the two ways the
// source can move used to reach the derived rows.

/**
 * Re-title the evidence derived from a journal entry.
 *
 * The evidence's title is a copy of the entry's, taken at attach time. Editing
 * the entry left the copy behind, so the evidence library showed the old
 * wording for a record whose page showed the new one — the same record under
 * two names, with no indication which was current.
 */
export async function syncDerivedEvidenceTitle(
    db: PrismaTx,
    ctx: RequestContext,
    logEntryId: string,
    newTitle: string,
): Promise<{ updated: number }> {
    const result = await db.evidence.updateMany({
        where: {
            tenantId: ctx.tenantId,
            sourceLogEntryId: logEntryId,
            category: AUTO_FARM_RECORD_CATEGORY,
        },
        data: { title: sanitizePlainText(newTitle) },
    });
    return { updated: result.count };
}

/**
 * Withdraw (or reinstate) the evidence derived from a journal entry.
 *
 * Soft-deleting the entry left its derived evidence in place, still counted by
 * the practice's evidence tab and still deep-linking to a page that now 404s.
 * The scheme kept reporting itself backed by a record the operator had
 * removed. Withdrawal is a soft delete for the same reason the entry's is:
 * restoring the entry has to restore the claim with it, and a hard delete
 * cannot be undone.
 */
export async function setDerivedEvidenceWithdrawn(
    db: PrismaTx,
    ctx: RequestContext,
    logEntryId: string,
    withdrawn: boolean,
): Promise<{ affected: number }> {
    const result = await db.evidence.updateMany({
        where: {
            tenantId: ctx.tenantId,
            sourceLogEntryId: logEntryId,
            category: AUTO_FARM_RECORD_CATEGORY,
            // Only flip rows that are on the wrong side of the switch, so the
            // count reports work actually done and a restore never resurrects
            // evidence a person deleted on its own merits.
            ...(withdrawn ? { deletedAt: null } : { deletedAt: { not: null } }),
        },
        data: { deletedAt: withdrawn ? new Date() : null },
    });
    return { affected: result.count };
}
