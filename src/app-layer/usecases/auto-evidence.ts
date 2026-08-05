import type { LogEntryType } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Auto-evidence — turning farm records into certification-scheme evidence.
 *
 * Certain durable farm records (a completed spray = an INPUT_APPLICATION
 * `LogEntry`) are themselves the proof that a scheme control point is
 * being met (GlobalG.A.P. CB.7 "application records", EU-Organic input
 * records). Rather than make the operator re-key that record as evidence,
 * `attachAutoEvidenceFromLogEntry` walks from the LogEntry → the scheme
 * requirement(s) it satisfies → the tenant's Control(s) mapped to those
 * requirements (via `ControlRequirementLink`) and mints one Evidence row
 * per control, back-referenced to the LogEntry via `Evidence.sourceLogEntryId`.
 *
 * The natural gate is installation: a tenant that hasn't installed the
 * scheme pack has no Control mapped to the requirement, so there are no
 * links, so this is a silent no-op. No extra module check is needed.
 *
 * Runs INSIDE the caller's existing tenant transaction (`db`) — the spray
 * journal write and its auto-evidence are atomic. We write Evidence (and
 * its `ControlEvidenceLink`) directly on `db` rather than calling the
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
 * the plant-protection / input-record control points of both demo schemes:
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
    ],
};

export interface AttachAutoEvidenceResult {
    created: number;
}

/**
 * Attach a farm `LogEntry` as scheme evidence to every tenant Control
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

    // 3 — Find the tenant's Controls linked to those requirements. A tenant
    //     that hasn't installed the scheme has zero links here → no-op.
    //     One findMany, distinct controlIds collected in memory.
    const links = await db.controlRequirementLink.findMany({
        where: { tenantId: ctx.tenantId, requirementId: { in: requirementIds } },
        select: { controlId: true },
    });
    const controlIds = [...new Set(links.map((l) => l.controlId))];
    if (controlIds.length === 0) return { created: 0 };

    // 4 — Idempotency: skip controls that already carry auto-evidence for
    //     THIS LogEntry. One query over (sourceLogEntryId, controlId∈…).
    const existing = await db.evidence.findMany({
        where: {
            tenantId: ctx.tenantId,
            sourceLogEntryId: logEntryId,
            controlId: { in: controlIds },
        },
        select: { controlId: true },
    });
    const alreadyAttached = new Set(existing.map((e) => e.controlId));

    const title = sanitizePlainText(`Farm record — ${logEntry.title}`);
    const content = `/t/${ctx.tenantSlug ?? ''}/journal/${logEntryId}`;

    let created = 0;
    for (const controlId of controlIds) {
        if (alreadyAttached.has(controlId)) continue;

        const evidence = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                controlId,
                sourceLogEntryId: logEntryId,
                type: 'LINK',
                title,
                // Deep-link back to the journal entry that is the evidence.
                content,
                category: 'AUTO_FARM_RECORD',
                dateCollected: logEntry.occurredAt,
                // Auto-collected, pending human approval (see header note).
                status: 'SUBMITTED',
            },
            select: { id: true },
        });

        // Mirror createEvidence's control↔evidence bridge so the row shows in
        // the control's Evidence tab. Duplicate-link is tolerated — but by
        // ON CONFLICT DO NOTHING, not by a try/catch. A caught 23505 leaves
        // the enclosing Postgres transaction aborted, so the very next
        // statement (the audit write below) fails with 25P02 and takes the
        // attach down. See the longer note in `evidence.ts`.
        await db.controlEvidenceLink.createMany({
            data: [{
                tenantId: ctx.tenantId,
                controlId,
                kind: 'LINK',
                url: content,
                note: title,
                createdByUserId: ctx.userId,
            }],
            skipDuplicates: true,
        });

        await logEvent(db, ctx, {
            action: 'AUTO_EVIDENCE_ATTACHED',
            entityType: 'Evidence',
            entityId: evidence.id,
            details: `Farm record auto-attached as scheme evidence (control ${controlId})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Evidence',
                operation: 'created',
                after: { sourceLogEntryId: logEntryId, controlId, status: 'SUBMITTED' },
                summary: 'Farm record auto-attached as scheme evidence',
            },
        });
        created++;
    }

    return { created };
}
