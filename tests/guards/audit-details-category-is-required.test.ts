/**
 * Every `logEvent` payload carries the `category` discriminator — enforced by
 * the TYPE, and this file is what stops the type being widened back.
 *
 * ## Why this exists
 *
 * `logEvent` runs `validateAuditDetailsJson`, which REFUSES a `detailsJson`
 * with no `category`, throwing an **uncoded** `badRequest('Invalid detailsJson
 * structure')`. And since #1223 the audit append is on the caller's
 * transaction, so that refusal is not a cosmetic logging miss — it is a 400 on
 * the write, and for a fail-closed entity it aborts the business write.
 *
 * Twelve live write paths shipped without one. The owner found three of them
 * in a release check of «Документи» — upload, settings and purge all answered
 * a 400 whose code the phone could not word, because there IS no code. The
 * other nine were the Drive copy and requeue, four automation-rule verbs, the
 * farm profile image upload, the admin session revoke (whenever no reason was
 * given, where `reason: null` fails a declared optional string) and the SLA
 * breach job.
 *
 * ## Why a type and not a regex
 *
 * A regex sweep for `category:` found 10 of the 12. It could not see the other
 * two, and the two it missed are the instructive ones: an invalid VALUE
 * (`category: 'content'`, which is not a member of the enum) and a null where
 * the schema declares an optional string. Both satisfy "the word category
 * appears in the literal" and both throw at runtime. So the enforcement is
 * `AuditEventPayload.detailsJson: AuditDetailsJson`, which the compiler checks
 * at every call site and for every future one — and the structural half of
 * this file is therefore about keeping that TYPE, not about counting sites.
 *
 * `.passthrough()` on the schema is what makes the narrowing free: a bespoke
 * domain payload may still carry whatever fields it likes beside the
 * discriminator. 193 of the 221 call sites already used a domain verb with a
 * bespoke payload and needed no change.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { validateAuditDetailsJson } from '@/app-layer/schemas/json-columns.schemas';
import type { AuditEventPayload } from '@/app-layer/events/audit';

const ROOT = process.cwd();

/**
 * The selection, at MODULE level and named, so `selector-teeth` can
 * mutation-audit it (#2423). Inline inside `it()` it would pass whether or not
 * it selected anything — which is exactly the failure mode this whole file is
 * about one level down.
 *
 * `{ strings: true }` (#1774): the subject is a DECLARATION, and this file's
 * own docblocks quote both the narrow and the wide spelling, so an unblanked
 * read would match its own prose and pass whatever `audit.ts` says.
 */
export function auditPayloadDeclaration(): string {
    return blankNonCode(
        readFileSync(join(ROOT, 'src/app-layer/events/audit.ts'), 'utf8'),
        { strings: true },
    );
}

describe('§1 the schema still refuses a payload with no category', () => {
    /**
     * The teeth. If someone makes `category` optional to "fix" a failing
     * write, this is what goes red — and §2's compile-time half would go
     * quiet, because an optional field cannot be missing.
     */
    it('throws when category is absent', () => {
        expect(() => validateAuditDetailsJson({ retention: 'P1Y' })).toThrow(
            /Invalid detailsJson structure/,
        );
    });

    it('throws when category is not a member of the enum', () => {
        // The `farm-brand-media` defect: present, spelled, and invalid.
        expect(() => validateAuditDetailsJson({ category: 'content' })).toThrow(
            /Invalid detailsJson structure/,
        );
    });

    it('throws when a DECLARED optional string is null', () => {
        // The `admin/sessions` defect. `.passthrough()` admits unknown keys,
        // so this is easy to misread as permitted — `reason` is declared, so
        // `null` fails it where an unknown key would not.
        expect(() =>
            validateAuditDetailsJson({ category: 'access', reason: null }),
        ).toThrow(/Invalid detailsJson structure/);
    });

    it('accepts a bespoke payload alongside the discriminator', () => {
        // The positive control, and the reason the narrowing costs nothing:
        // without it, a schema that refused everything would pass every
        // assertion above.
        expect(() =>
            validateAuditDetailsJson({
                category: 'custom',
                event: 'automation_sla_breached',
                ruleId: 'r-1',
                slaWindowMinutes: 30,
            }),
        ).not.toThrow();
    });

    it('accepts every member of the enum', () => {
        const members = [
            'entity_lifecycle',
            'data_lifecycle',
            'status_change',
            'relationship',
            'access',
            'custom',
        ] as const;
        for (const category of members) {
            expect(() => validateAuditDetailsJson({ category })).not.toThrow();
        }
        console.log(`[audit-details-category] enum members accepted: ${members.length}`);
    });
});

describe('§2 the TYPE is the enforcement, and stays narrow', () => {
    /**
     * A COMPILE-TIME ratchet, and **the check that enforces it is CI's
     * `Typecheck` job — not this suite.**
     *
     * Measured, because the obvious reading is wrong: widening
     * `detailsJson` back to `Record<string, unknown>` leaves both
     * `@ts-expect-error` tests below GREEN under jest. ts-jest does not
     * report an unused directive, so as jest assertions these two are
     * controls that cannot express failure. `npm run typecheck` does report
     * it — `TS2578: Unused '@ts-expect-error' directive`, on both lines —
     * and `tests/` is inside the typecheck population, so the ratchet is
     * real and lives in a different job.
     *
     * They are kept here rather than moved because this is where a reader
     * looks for the rule, and the text pin below is what gives THIS suite
     * teeth against the same mutation. Do not read a green run of this file
     * as proof the type is still narrow; that is the Typecheck job's answer.
     */
    it('refuses a detailsJson with no category at compile time', () => {
        const payload: AuditEventPayload = {
            action: 'WIDGET_CREATED',
            entityType: 'Widget',
            entityId: 'w-1',
            // @ts-expect-error — `category` is required; this is the ratchet.
            detailsJson: { name: 'a widget' },
        };
        expect(payload.entityId).toBe('w-1');
    });

    it('refuses an invalid category value at compile time', () => {
        const payload: AuditEventPayload = {
            action: 'WIDGET_CREATED',
            entityType: 'Widget',
            entityId: 'w-2',
            // @ts-expect-error — 'content' is not a member of the enum.
            detailsJson: { category: 'content' },
        };
        expect(payload.entityId).toBe('w-2');
    });

    it('admits a valid payload with bespoke fields', () => {
        const payload: AuditEventPayload = {
            action: 'WIDGET_CREATED',
            entityType: 'Widget',
            entityId: 'w-3',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Widget', bespoke: 1 },
        };
        expect(payload.detailsJson?.category).toBe('entity_lifecycle');
    });

    /**
     * The type is only load-bearing while `audit.ts` declares it. A reader
     * "simplifying" the annotation away would leave §1 green and every call
     * site unchecked, so the declaration is pinned as text too.
     */
    it('audit.ts declares detailsJson as AuditDetailsJson', () => {
        const src = auditPayloadDeclaration();
        expect(src).toMatch(/detailsJson\?:\s*AuditDetailsJson;/);
        expect(src).not.toMatch(/detailsJson\?:\s*Record<string,\s*unknown>;/);
    });
});
