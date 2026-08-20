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
    // `Task.description` / `Task.resolution` are written from FOUR places, not
    // one — tasks and issues are the same `Task` row shape, field-operation
    // review writes `resolution` via `WorkItemRepository.setStatus` directly
    // (bypassing `setTaskStatus`), and the retention job interpolates a
    // user-supplied evidence title into `description` with no request context
    // upstream to have sanitised it. Listing only `task.ts` is what let the
    // file-level check below pass for two years while both columns went raw.
    Task: {
        usecases: [
            'src/app-layer/usecases/task.ts',
            'src/app-layer/usecases/issue.ts',
            'src/app-layer/usecases/field-operation.ts',
            'src/app-layer/jobs/retention-notifications.ts',
        ],
        sanitizer: 'sanitizePlainText',
    },
    TaskComment: {
        usecases: ['src/app-layer/usecases/task.ts', 'src/app-layer/usecases/issue.ts'],
        sanitizer: 'sanitizePlainText',
    },
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
    // CostEntry.description is encrypted at rest and sanitised at the write
    // seam. `supplier` is NOT encrypted (it must stay filterable) but is
    // sanitised by the same call — encryption and sanitisation answer
    // different questions, and every renderer that shows a supplier name
    // deserves the same protection as one that shows a description.
    CostEntry: { usecases: ['src/app-layer/usecases/cost-entry.ts'], sanitizer: 'sanitizePlainText' },
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


/**
 * ─── Why a FILE-level check was not enough ──────────────────────────
 *
 * The `imports AND calls` test below asks whether a usecase file mentions a
 * sanitiser ANYWHERE. `task.ts` did — for a task-link `note` and a comment
 * `body` — so `Task` reported covered while `Task.description` and
 * `Task.resolution`, the two columns actually named in `ENCRYPTED_FIELDS`,
 * went to the database exactly as typed. Green for as long as the entry
 * existed. The file-level test is kept (a dangling import is still worth
 * catching) but it is no longer the guarantee.
 *
 * This is the guarantee: every FIELD in `ENCRYPTED_FIELDS[model]` must show a
 * sanitised binding by name. Three shapes are accepted, which between them
 * cover every idiom in the repo:
 *
 *   (a) `description: sanitizePlainText(input.description)` / `x = san(...)`
 *   (b) `sanitizePlainText(body)` — the field is the sanitiser's ARGUMENT
 *   (c) `const safe = sanitizePlainText(v)` … `notes: safe` — via an alias
 *
 * A repo-local helper counts as a sanitiser if it transitively calls one of
 * the three real ones — `company.ts::sanitizeOptional` is the canonical case,
 * and refusing to resolve it would have pushed five real fields into an
 * exemption list for no gain.
 */
const REAL_SANITISERS: readonly Sanitizer[] = [
    'sanitizePlainText',
    'sanitizeRichTextHtml',
    'sanitizePolicyContent',
];

/**
 * Fields whose sanitisation is real but structurally invisible — the write
 * goes through a whole-input seam that never names the field. Each entry
 * names the seam, and the test VERIFIES that seam exists and calls a real
 * sanitiser, so this cannot be used as a silent opt-out.
 */
const SEAM_COVERED: Readonly<
    Record<string, { seam: string; fieldList: string; reason: string }>
> = {
    'FarmProfile.egn': {
        seam: 'norm',
        fieldList: 'PROFILE_FIELDS',
        reason:
            'upsertFarmProfile builds its write object by reducing the ' +
            'PROFILE_FIELDS constant through `norm`, which sanitises. The ' +
            'field name never appears beside a sanitiser call because the ' +
            'seam covers every field generically — which is stronger than ' +
            'per-field, not weaker.',
    },
    'FarmProfile.eik': {
        seam: 'norm',
        fieldList: 'PROFILE_FIELDS',
        reason: 'Same PROFILE_FIELDS reduce seam as FarmProfile.egn.',
    },
};

/** Sanitiser names usable in `src`: the three real ones + verified local helpers. */
function resolveSanitisers(src: string): string[] {
    const set = new Set<string>(REAL_SANITISERS);
    const defs = [...src.matchAll(/(?:function|const)\s+(sanitize\w+)\b[\s\S]{0,900}?\n\}/g)];
    // Fixpoint: sanitizeCompanyInput → sanitizeOptional → sanitizePlainText.
    for (let pass = 0; pass < 3; pass++) {
        for (const d of defs) {
            if ([...set].some((n) => new RegExp(String.raw`\b${n}\s*\(`).test(d[0]))) {
                set.add(d[1]);
            }
        }
    }
    return [...set];
}

/** The binding shape that sanitises `field` in `src`, or null if there is none. */
function findFieldBinding(src: string, field: string): string | null {
    const S = `(?:${resolveSanitisers(src).join('|')})`;
    if (new RegExp(String.raw`\b${field}\s*[:=][^;\n]*\b${S}\s*\(`).test(src)) {
        return 'assigned from a sanitiser call';
    }
    if (
        new RegExp(
            String.raw`\b${S}\s*\(\s*(?:[\w$]+(?:\??\.[\w$]+)*\.)?${field}\b`,
        ).test(src)
    ) {
        return 'passed as the sanitiser argument';
    }
    for (const m of src.matchAll(
        new RegExp(String.raw`(?:const|let)\s+([\w$]+)\s*=[^;\n]*\b${S}\s*\(`, 'g'),
    )) {
        if (new RegExp(String.raw`\b${field}\s*[:=]\s*${m[1]}\b`).test(src)) {
            return `bound via the sanitised alias \`${m[1]}\``;
        }
    }
    return null;
}

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


    // ─── The FIELD-level guarantee ──────────────────────────────────
    //
    // This is the test that would have caught `Task.description` /
    // `Task.resolution`. It asks about the columns named in
    // ENCRYPTED_FIELDS, not about whether the file says "sanitize" once.

    const fieldEntries = Object.entries(RICH_TEXT_COVERAGE).flatMap(
        ([model, { usecases }]) =>
            (ENCRYPTED_FIELDS[model as keyof typeof ENCRYPTED_FIELDS] ?? []).map(
                (field: string) => [model, field, usecases] as const,
            ),
    );

    it('every RICH_TEXT_COVERAGE model declares at least one field to check', () => {
        // Guard the guard: if ENCRYPTED_FIELDS ever stopped yielding fields
        // for these models, `fieldEntries` would be empty and every
        // assertion below would pass vacuously.
        expect(fieldEntries.length).toBeGreaterThanOrEqual(
            Object.keys(RICH_TEXT_COVERAGE).length,
        );
    });

    it.each(fieldEntries)(
        '%s.%s is sanitised by name at its write path',
        (model, field, usecases) => {
            const key = `${model}.${field}`;
            const src = usecases
                .filter((u) => fileExists(u))
                .map((u) => readFile(u))
                .join('\n/* ── next usecase ── */\n');

            const seam = SEAM_COVERED[key];
            if (seam) {
                // An exemption is only honoured if the seam it names is real
                // AND sanitises. Otherwise it is just a way to turn the test
                // off, which is the failure mode this whole file exists for.
                const sans = resolveSanitisers(src);
                const seamBody = src.match(
                    new RegExp(String.raw`\b${seam.seam}\s*=[\s\S]{0,600}?\n\s*\};`),
                )?.[0];
                if (!seamBody) {
                    throw new Error(
                        `SEAM_COVERED[${key}] names a seam \`${seam.seam}\` that ` +
                            `no longer exists in ${usecases.join(', ')}. Either the ` +
                            `seam was renamed (update the entry) or it was removed ` +
                            `(the field is now unsanitised).`,
                    );
                }
                if (!sans.some((n) => new RegExp(String.raw`\b${n}\s*\(`).test(seamBody))) {
                    throw new Error(
                        `SEAM_COVERED[${key}]: seam \`${seam.seam}\` no longer calls ` +
                            `a sanitiser. ${field} is written unsanitised.`,
                    );
                }
                if (!new RegExp(String.raw`\b${seam.fieldList}\b[\s\S]{0,600}?'${field}'`).test(src)) {
                    throw new Error(
                        `SEAM_COVERED[${key}]: '${field}' is not listed in ` +
                            `\`${seam.fieldList}\`, so the seam does not cover it.`,
                    );
                }
                return;
            }

            const binding = findFieldBinding(src, field);
            if (!binding) {
                throw new Error(
                    `${key} is an ENCRYPTED_FIELDS column with NO sanitised binding ` +
                        `in its declared write path(s):\n` +
                        usecases.map((u) => `  - ${u}`).join('\n') +
                        `\n\n` +
                        `Encryption protects the value at rest; it does nothing for ` +
                        `the PDF export, audit-pack share link or SDK consumer that ` +
                        `decrypts and renders it. Sanitise at the usecase, before the ` +
                        `repository write — one of:\n` +
                        `  ${field}: sanitizePlainText(input.${field})\n` +
                        `  ${field} = sanitizePlainText(${field})\n` +
                        `  const safe = sanitizePlainText(v); … ${field}: safe\n\n` +
                        `If the write goes through a whole-input seam that never ` +
                        `names the field, add a SEAM_COVERED entry (the seam is ` +
                        `verified, not trusted).`,
                );
            }
            expect(binding).toEqual(expect.any(String));
        },
    );

    it('the field-level detector fails when a real sanitise is removed (mutation proof)', () => {
        // Without this, "every field is bound" could be a detector that
        // matches anything. Take the ACTUAL source that covers
        // Task.description, delete only that call, and require a MISS.
        const real = readFile('src/app-layer/usecases/task.ts');
        expect(findFieldBinding(real, 'description')).not.toBeNull();

        // BOTH sites must go — `createTask` and `updateTask` each sanitise
        // `description`, and leaving either one is (correctly) still a hit.
        const mutated = real.replace(
            /sanitizePlainText\((\w+\.description)\)/g,
            '$1',
        );
        const removed = real.split('sanitizePlainText(').length -
            mutated.split('sanitizePlainText(').length;
        expect(removed).toBe(2); // the mutation must have applied, to both sites
        expect(findFieldBinding(mutated, 'description')).toBeNull();
    });

    it('SEAM_COVERED entries carry a written reason', () => {
        for (const { reason } of Object.values(SEAM_COVERED)) {
            expect(reason.trim().length).toBeGreaterThan(20);
        }
    });

    it('no SEAM_COVERED entry references a field absent from ENCRYPTED_FIELDS', () => {
        const stale = Object.keys(SEAM_COVERED).filter((key) => {
            const [model, field] = key.split('.');
            const fields: readonly string[] =
                ENCRYPTED_FIELDS[model as keyof typeof ENCRYPTED_FIELDS] ?? [];
            return !fields.includes(field);
        });
        expect(stale).toEqual([]);
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
