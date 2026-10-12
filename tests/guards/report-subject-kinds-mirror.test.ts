/**
 * Guard: the zod list a NOTICE validates against is a strict subset of the
 * Prisma enum, and the difference is named (#1667).
 *
 * ## What was unchecked
 *
 * `src/lib/schemas/index.ts` carries:
 *
 * ```ts
 * /** The surfaces a notice can name. Mirrors the `ReportSubjectKind` enum. *\/
 * export const REPORT_SUBJECT_KINDS = ['LISTING', 'MESSAGE', 'PROFILE', 'THREAD'] as const;
 * ```
 *
 * A hand-written list claiming to mirror an enum, with **nothing comparing
 * them**. That is fine until the two diverge, and #1667 diverges them on
 * purpose: `ACCOUNT` is added to the enum as the subject of a moderation
 * ACTION — a proactive suspension is a decision about a person, not about
 * content — and must NOT become something a notifier can name, because
 * `POST /api/public/notices` needs no credential.
 *
 * So the relationship is not equality and never was. It is:
 *
 *     REPORT_SUBJECT_KINDS  ⊂  ReportSubjectKind
 *
 * with every member of the difference listed below and justified. An enum value
 * added tomorrow lands in neither list and fails here, which forces the
 * question "may a notice name this?" to be answered rather than inherited.
 *
 * ## Why the subset direction matters more than the superset one
 *
 * A zod member missing from the enum is a loud runtime failure — Prisma rejects
 * the write. A zod member the enum lacks is therefore self-correcting. The
 * dangerous direction is the quiet one: an enum value silently becoming
 * reportable because somebody "kept the mirror in sync". Both are asserted, but
 * that is the one this guard exists for.
 */
import { ReportSubjectKind } from '@prisma/client';

import { REPORT_SUBJECT_KINDS } from '@/lib/schemas';

/**
 * Enum values a notice may NOT name, each with why.
 *
 * An entry here is a value that exists for ACTIONS only. The reason has to say
 * what naming it in a notice would let an unauthenticated caller do.
 */
const ACTION_ONLY: Readonly<Record<string, string>> = {
    ACCOUNT:
        'The subject of a proactive suspension — a decision about a PERSON, ' +
        'not about content (#1667). Letting a notice name it would let an ' +
        'unauthenticated caller file a report against an account rather than ' +
        'against something it posted, which is a different product (and a ' +
        'different abuse surface) from the one DSA Art 16 asks for: ' +
        '`/api/public/notices` needs no credential, so the reportable set is ' +
        'the one place widening is an escalation rather than a convenience.',
};

describe('REPORT_SUBJECT_KINDS mirrors the enum, minus a named difference', () => {
    const enumValues = Object.values(ReportSubjectKind) as string[];
    const zodValues = [...REPORT_SUBJECT_KINDS] as string[];

    it('prints both populations', () => {
        console.log(
            `[report-subject-kinds-mirror] enum ${enumValues.length} ` +
                `(${enumValues.join(', ')}); reportable ${zodValues.length}; ` +
                `action-only ${Object.keys(ACTION_ONLY).length}.`,
        );
        // Neither may be empty, or the comparisons below pass over nothing.
        expect(enumValues.length).toBeGreaterThan(1);
        expect(zodValues.length).toBeGreaterThan(1);
    });

    it('every reportable kind exists in the enum', () => {
        // The self-correcting direction — Prisma would reject the write — but
        // asserted so the failure arrives here rather than at a farmer's
        // request.
        for (const v of zodValues) expect(enumValues).toContain(v);
    });

    it('every enum value is EITHER reportable or named action-only', () => {
        const unclassified = enumValues.filter(
            (v) => !zodValues.includes(v) && !(v in ACTION_ONLY),
        );
        if (unclassified.length > 0) {
            throw new Error(
                `${unclassified.length} ReportSubjectKind value(s) are neither ` +
                    `reportable nor named action-only:\n\n` +
                    unclassified.map((v) => `  ${v}`).join('\n') +
                    `\n\nDecide: add it to REPORT_SUBJECT_KINDS if a NOTICE may name ` +
                    `it — remembering that POST /api/public/notices needs no ` +
                    `credential — or add an ACTION_ONLY entry here saying what naming ` +
                    `it in a notice would let an unauthenticated caller do.`,
            );
        }
        expect(unclassified).toEqual([]);
    });

    it('nothing is in both lists, and no entry is stale', () => {
        for (const [value, reason] of Object.entries(ACTION_ONLY)) {
            // Stale in two directions: the value left the enum, or it has
            // since been made reportable and the entry now contradicts itself.
            expect(enumValues).toContain(value);
            expect(zodValues).not.toContain(value);
            expect(reason.trim().length).toBeGreaterThan(150);
        }
    });
});
