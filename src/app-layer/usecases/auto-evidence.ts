import type { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { AUTO_FARM_RECORD_CATEGORY } from '@/lib/evidence/auto-evidence-constants';

/**
 * Derived farm-record evidence — keeping it truthful.
 *
 * An `Evidence` row carrying `category = AUTO_FARM_RECORD` was derived from a
 * journal entry: the farm record IS the proof, so the row holds no bytes of
 * its own, just `sourceLogEntryId` pointing back at the entry.
 *
 * The GRC teardown removed the path that MINTED those rows —
 * `attachAutoEvidenceFromLogEntry` walked LogEntry → FrameworkRequirement →
 * PracticeRequirementLink → Practice, and all three of those models are gone.
 * The rows it already wrote are not: `Evidence` survives, and so does
 * `sourceLogEntryId`. They are still listed on `/evidence` (rendered as a farm
 * record, deep-linked through that column by `EvidenceClient`), and they still
 * carry the provenance the strict download gate in `evidence.ts` reads when it
 * decides whether a READER/AUDITOR may fetch the file.
 *
 * So the two helpers below still have a subject. A derived row is a CLAIM
 * about a journal entry — "here is the spray record" — and a claim about an
 * entry that has since been retitled, or has since been deleted, is not
 * evidence. Both run INSIDE the caller's existing tenant transaction (`db`),
 * so the journal write and the correction to its derived rows are atomic.
 */

/**
 * Re-title the evidence derived from a journal entry.
 *
 * The evidence's title is a copy of the entry's, taken when the row was
 * derived. Editing the entry left the copy behind, so the evidence library
 * showed the old wording for a record whose page showed the new one — the same
 * record under two names, with no indication which was current.
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
 * Soft-deleting the entry left its derived evidence in place, still listed in
 * the evidence library and still deep-linking to a page that now 404s — and
 * still readable as provenance by the download gate, on behalf of a record the
 * operator had removed. Withdrawal is a soft delete for the same reason the
 * entry's is: restoring the entry has to restore the claim with it, and a hard
 * delete cannot be undone.
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
