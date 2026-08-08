/**
 * Guardrail: Epic C.5 / D.2 — rich-text sanitiser coverage (structural).
 *
 * ─── Why this is structural, not a numeric floor ────────────────────
 *
 * The previous incarnation kept a hand-curated list of usecases plus
 * `SANITISER_COVERAGE_FLOOR = 8` — a MINIMUM. That was a weak signal:
 * the floor went green while the real coverage drifted to 15 sanitised
 * usecases, and — worse — a *new* rich-text write path could land with
 * no sanitiser and the floor-of-8 would never notice (the eight known
 * entries were all still present). "At least N" cannot prove
 * completeness.
 *
 * This version derives the rich-text inventory from an authoritative,
 * already-maintained registry: `ENCRYPTED_FIELDS` in
 * `src/lib/security/encrypted-fields.ts`. Epic B REQUIRES every
 * business-content text field to be listed there (it drives
 * encrypt-on-write / decrypt-on-read). So:
 *
 *   - every encrypted business-content model IS a rich-text surface;
 *   - this guardrail asserts every such model is CLASSIFIED — either
 *     `RICH_TEXT_COVERAGE` (a usecase sanitises it),
 *     `NON_RICH_TEXT_MODELS` (the encrypted value is not user-supplied
 *     rich text — e.g. a generated secret), or `KNOWN_UNCOVERED`
 *     (a real, named gap, ratcheting to zero);
 *   - a NEW encrypted model — which a new rich-text field forces into
 *     `ENCRYPTED_FIELDS` — that is in NONE of the three buckets fails
 *     this test. That is the completeness guarantee the floor lacked.
 *
 * Server-side sanitisation must run BEFORE the row is persisted:
 * render-time sanitisation alone leaves the row dangerous to PDF
 * export, audit-pack share links, and SDK consumers reading it
 * verbatim.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

const REPO_ROOT = path.resolve(__dirname, '../..');

type Sanitizer = 'sanitizeRichTextHtml' | 'sanitizePlainText' | 'sanitizePolicyContent';

/**
 * Encrypted-content model → the usecase file(s) that route its
 * user-supplied free text through a sanitiser before the repository
 * write, and the sanitiser they are expected to use.
 *
 * Keyed by Prisma model name (matching `ENCRYPTED_FIELDS`). When a new
 * encrypted business-content model lands, add it here (or to one of
 * the two exclusion maps below) — the completeness test fails until
 * every `ENCRYPTED_FIELDS` model is classified.
 */
const RICH_TEXT_COVERAGE: Readonly<
    Record<string, { usecases: readonly string[]; sanitizer: Sanitizer }>
> = {
    PolicyVersion: { usecases: ['src/app-layer/usecases/policy.ts'], sanitizer: 'sanitizePolicyContent' },
    Task: { usecases: ['src/app-layer/usecases/task.ts'], sanitizer: 'sanitizePlainText' },
    TaskComment: {
        usecases: ['src/app-layer/usecases/task.ts', 'src/app-layer/usecases/issue.ts'],
        sanitizer: 'sanitizePlainText',
    },
    Finding: { usecases: ['src/app-layer/usecases/finding.ts'], sanitizer: 'sanitizePlainText' },
    // Lease counterparty PII — sanitised at the single `mapLeaseData` write
    // seam that both create and update route through.
    ParcelLease: { usecases: ['src/app-layer/usecases/parcel-lease.ts'], sanitizer: 'sanitizePlainText' },
    // Supplier contact PII + support notes (#12) — sanitised at the single
    // `sanitizeCompanyInput` seam that both create and update route through,
    // mirroring ParcelLease's `mapLeaseData`.
    Company: { usecases: ['src/app-layer/usecases/company.ts'], sanitizer: 'sanitizePlainText' },
    // The farmer's free-text offer request (#12). One write path only —
    // `createPromotionLead` — and it sanitises before the row is created, so
    // the ciphertext the supplier's digest later decrypts is already clean.
    PromotionLead: {
        usecases: ['src/app-layer/usecases/promotions.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // RQ3-6 — loss-event narrative + reviewer justification; sanitised
    // at the single createLossEvent write seam before the Epic B
    // middleware persists them.
    Vendor: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorDocument: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorAssessment: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorEvidenceBundle: {
        usecases: ['src/app-layer/usecases/vendor-assessment-review.ts'],
        sanitizer: 'sanitizePlainText',
    },
    Audit: { usecases: ['src/app-layer/usecases/audit.ts'], sanitizer: 'sanitizePlainText' },
    AuditChecklistItem: { usecases: ['src/app-layer/usecases/audit.ts'], sanitizer: 'sanitizePlainText' },
    AccessReview: { usecases: ['src/app-layer/usecases/access-review.ts'], sanitizer: 'sanitizePlainText' },
    AccessReviewDecision: { usecases: ['src/app-layer/usecases/access-review.ts'], sanitizer: 'sanitizePlainText' },
    // RQ2-1/RQ2-2 — score-change justification narrative; sanitised
    // at the single recordScoreEvent write seam.
    // Enterprise-grain — Contract.terms / Contract.pricingNotes and
    // YieldRecord.valuationNotes are encrypted at rest (Epic B manifest)
    // AND sanitised at the usecase boundary before the write, so every
    // downstream renderer (PDF / share link / SDK) that decrypts them sees
    // safe content.
    Contract: { usecases: ['src/app-layer/usecases/contract.ts'], sanitizer: 'sanitizePlainText' },
    YieldRecord: { usecases: ['src/app-layer/usecases/yield-record.ts'], sanitizer: 'sanitizePlainText' },
    // БАБХ farm-record — FarmProfile.egn/eik are encrypted at rest (Epic B
    // manifest) AND sanitised at the upsertFarmProfile write seam before the
    // middleware persists them, so every renderer that decrypts them (the
    // ДНЕВНИК PDF) sees safe content.
    FarmProfile: { usecases: ['src/app-layer/usecases/farm-profile.ts'], sanitizer: 'sanitizePlainText' },
};

/**
 * Encrypted models whose encrypted field is NOT user-supplied rich
 * text — sanitisation does not apply. Each carries a written reason.
 */
const NON_RICH_TEXT_MODELS: Readonly<Record<string, string>> = {
    TenantSecuritySettings:
        'auditStreamSecretEncrypted is a system-generated HMAC secret, ' +
        'never user-supplied free text — there is nothing to sanitise.',
};

/**
 * Real, named coverage gaps — encrypted business-content models whose
 * write path is not yet proven to sanitise. This is a RATCHET: it must
 * trend to zero. Each entry carries a written reason + a ratchet
 * target. A new entry here is a deliberate, reviewed admission — not a
 * place to silently park new rich-text surfaces.
 */
const KNOWN_UNCOVERED: Readonly<Record<string, string>> = {
    EvidenceReview:
        'EvidenceReview.comment (reviewer rationale) is encrypted at ' +
        'rest but its write path is not yet registered with a ' +
        'sanitiser. Ratchet target: identify the write usecase and ' +
        'either register it in RICH_TEXT_COVERAGE (if it already ' +
        'sanitises) or wire sanitizePlainText into it.',
};

const fileExists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));
const readFile = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('rich-text sanitiser coverage — structural completeness', () => {
    it('every encrypted-content model is classified (the completeness guarantee)', () => {
        // A new rich-text field forces its model into ENCRYPTED_FIELDS
        // (Epic B requirement). If that model is in none of the three
        // buckets, it is an unclassified rich-text surface — fail.
        const classified = new Set([
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ]);
        const unclassified = Object.keys(ENCRYPTED_FIELDS).filter(
            (m) => !classified.has(m),
        );
        if (unclassified.length > 0) {
            throw new Error(
                [
                    `Encrypted business-content model(s) not classified for`,
                    `rich-text sanitiser coverage:`,
                    ...unclassified.map((m) => `  - ${m}`),
                    ``,
                    `Each ENCRYPTED_FIELDS model is a rich-text surface. Add`,
                    `it to RICH_TEXT_COVERAGE (with the sanitising usecase),`,
                    `NON_RICH_TEXT_MODELS (if the value is not user rich`,
                    `text), or KNOWN_UNCOVERED (a real gap, with a reason).`,
                ].join('\n'),
            );
        }
    });

    it('detects an unclassified new encrypted model (regression proof)', () => {
        // Simulate a new rich-text field landing on a new model — Epic B
        // forces it into ENCRYPTED_FIELDS. With no classification entry
        // it must be flagged: this is the bypass the old numeric floor
        // could not catch.
        const classified = new Set([
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ]);
        const withNewModel = { ...ENCRYPTED_FIELDS, NewlyAddedRichTextModel: ['body'] };
        const unclassified = Object.keys(withNewModel).filter(
            (m) => !classified.has(m),
        );
        expect(unclassified).toEqual(['NewlyAddedRichTextModel']);
    });

    it('no classification entry references a model absent from ENCRYPTED_FIELDS (no stale)', () => {
        const stale = [
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ].filter((m) => !(m in ENCRYPTED_FIELDS));
        expect(stale).toEqual([]);
    });

    it('NON_RICH_TEXT_MODELS + KNOWN_UNCOVERED each carry a written reason', () => {
        for (const reason of [
            ...Object.values(NON_RICH_TEXT_MODELS),
            ...Object.values(KNOWN_UNCOVERED),
        ]) {
            expect(reason.trim().length).toBeGreaterThan(20);
        }
    });

    it('KNOWN_UNCOVERED is a ratchet — it should trend to zero', () => {
        // Not a hard cap — but a visible reminder. If this grows, the
        // diff is the conversation. Today: 1 (EvidenceReview).
        expect(Object.keys(KNOWN_UNCOVERED).length).toBeLessThanOrEqual(1);
    });

    const coverageEntries = Object.entries(RICH_TEXT_COVERAGE).flatMap(
        ([model, { usecases, sanitizer }]) =>
            usecases.map((u) => [model, u, sanitizer] as const),
    );

    it.each(coverageEntries)(
        '%s — %s imports AND calls %s',
        (model, relPath, sanitizer) => {
            if (!fileExists(relPath)) {
                throw new Error(
                    `RICH_TEXT_COVERAGE[${model}] references a missing file: ` +
                        `${relPath}. If the usecase moved, update the path.`,
                );
            }
            const src = readFile(relPath);
            const importRe = new RegExp(
                String.raw`import\s+\{[^}]*\b${sanitizer}\b[^}]*\}\s+from\s+['"]@/lib/security/sanitize['"]`,
            );
            if (!importRe.test(src)) {
                throw new Error(
                    `${relPath} (rich-text writer for ${model}) does not ` +
                        `import { ${sanitizer} } from '@/lib/security/sanitize'. ` +
                        `Server-side sanitisation must run before the repository ` +
                        `write.`,
                );
            }
            const withoutImport = src.replace(src.match(importRe)?.[0] ?? '', '');
            if (!new RegExp(String.raw`\b${sanitizer}\s*\(`).test(withoutImport)) {
                throw new Error(
                    `${relPath} imports ${sanitizer} but never calls it — ` +
                        `a dangling import is a silent bypass for ${model}.`,
                );
            }
        },
    );
});
