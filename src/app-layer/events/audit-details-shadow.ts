/**
 * Shadow-parse `detailsJson` against the CANONICAL schema, and change nothing
 * — #2109.
 *
 * ## Why a shadow and not enforcement
 *
 * `logEvent` validates with `AuditDetailsJsonSchema`, one flat object with
 * `.passthrough()`. The canonical `AuditDetailsSchema` is a discriminated
 * union whose members are `.strict()`, and it is enforced nowhere. Measured on
 * production, 15.9% of stored rows satisfied it; after the vocabulary
 * convergence that reached 99.8%.
 *
 * Rows are not the population that matters, though. Enforcement breaks CALL
 * SITES, and the two attempts to count those statically both produced wrong
 * answers — 82, then 63 with a confirmed false positive — because a static
 * scan cannot read a single-line literal reliably, and 33 sites build the
 * category dynamically or spread `...details` so it cannot read them at all.
 *
 * So the census comes from traffic instead. This parses every payload that
 * reaches `logEvent`, logs the ones that would have been refused, and refuses
 * nothing. When the log goes quiet, enforcement is safe; until then the log
 * says exactly which call sites to fix, including the ones no regex can see.
 *
 * ## Shapes only, never values
 *
 * `detailsJson` carries operator-authored text — summaries, reasons, entity
 * names — and `TenantSchema` declares an `ownerEmail`. A mismatch line records
 * the category, the zod issue PATHS and CODES, and the entry's `action` and
 * `entityType` as the handle on a call site. Nothing from the payload itself. Owner ruling, and
 * the same discipline `scripts/audit-details-conformance.ts` already applies.
 *
 * ## It can never break a write
 *
 * It runs on the hot path of every audited write, so it is wrapped in its own
 * try/catch and returns void. A bug in a diagnostic must not fail the thing
 * being diagnosed — and `logEvent`'s whole contract is that best-effort audit
 * writes never break the caller's work.
 */
import { AuditDetailsSchema } from '@/lib/audit/event-schema';
import { logger } from '@/lib/observability/logger';

/**
 * Report `detailsJson` payloads the canonical schema would refuse.
 *
 * @param detailsJson what the caller passed, before the permissive validator.
 * @param action      the audit action.
 * @param entityType  the audited model. Paired with `action` this is the
 *                    handle on a call site; `action` alone is not, because
 *                    `UPDATE` is shared by most of the 222 of them.
 */
export function shadowParseAuditDetails(
    detailsJson: unknown,
    action: string,
    entityType: string,
): void {
    try {
        if (detailsJson === null || detailsJson === undefined) return;

        const result = AuditDetailsSchema.safeParse(detailsJson);
        if (result.success) return;

        // The category is a closed discriminator, not operator text, so it is
        // safe to name — and it is the first thing anybody fixing this needs.
        const category =
            typeof detailsJson === 'object' && detailsJson !== null && 'category' in detailsJson
                ? String((detailsJson as { category?: unknown }).category)
                : '<none>';

        // Paths and codes only. `issue.message` can quote the offending VALUE
        // for some zod codes, which is exactly what must not be logged.
        const issues = result.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}:${i.code}`)
            .sort();

        logger.warn('audit.details_not_canonical', {
            component: 'audit-details-shadow',
            issue: 2109,
            action,
            // A Prisma model name — closed vocabulary, never operator text.
            entityType,
            category,
            issues,
            // The top-level key NAMES are structural — they are what
            // `.strict()` rejects — and naming them is what makes a mismatch
            // actionable without a second round trip.
            keys:
                typeof detailsJson === 'object' && detailsJson !== null
                    ? Object.keys(detailsJson).sort()
                    : [],
        });
    } catch {
        // A diagnostic that throws into an audit write would convert a
        // reporting gap into a lost audit row, which is the opposite trade.
    }
}
