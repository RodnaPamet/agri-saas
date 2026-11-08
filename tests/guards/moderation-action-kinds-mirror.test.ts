/**
 * Guard: the zod list a NOTICE DECISION validates against is a strict subset
 * of the Prisma enum, and the difference is named (#2867).
 *
 * The same shape `report-subject-kinds-mirror` holds one table over, and for
 * the same reason: `MODERATION_ACTION_KINDS` in `src/lib/schemas/index.ts` is a
 * hand-written list that `ActOnNoticeSchema` validates against, and until this
 * file there was **nothing comparing it to the enum**.
 *
 * #2867 diverges them on purpose. `CONTENT_RESTORED` exists as the subject of
 * an ACTION — the reversal of a removal — and must NOT be something a caller
 * can send to `POST /api/admin/moderation/notices`, because a restore recorded
 * against a notice that asked for a removal is an action attributed to a case
 * it is not about. That is the thing P5.4a refuses by denormalising the subject
 * from the notice rather than accepting it from the body.
 *
 * So the relationship is not equality and never was:
 *
 *     MODERATION_ACTION_KINDS  ⊂  ModerationActionKind
 *
 * with every member of the difference listed below and justified. An enum
 * value added tomorrow lands in neither list and fails here, which forces
 * "may a notice decision be this?" to be answered rather than inherited.
 *
 * ## Which direction this exists for
 *
 * A zod member missing from the enum is a loud runtime failure — Prisma
 * rejects the write — so that direction is self-correcting. The dangerous one
 * is quiet: an enum value silently becoming acceptable on a notice because
 * somebody "kept the mirror in sync". Both are asserted; the second is why the
 * file exists.
 *
 * ## It is NOT the same question as "can the platform perform it"
 *
 * `CONTENT_DEMOTED` is in BOTH lists and the usecase refuses it anyway
 * (#2868): nothing in this product can demote, so `assertPerformable` throws.
 * That is a third axis — what a caller may SEND, what the enum can HOLD, and
 * what the platform can DO — and conflating the first two with the third is
 * how a value ends up unsendable for the wrong reason. This guard is about the
 * first two only.
 */
import { ModerationActionKind } from '@prisma/client';

import { MODERATION_ACTION_KINDS } from '@/lib/schemas';

/**
 * Enum values a notice DECISION may not carry, each with why.
 *
 * An entry here is a value that exists for a different verb. The reason has to
 * say what sending it to the notices route would record.
 */
const NOT_A_NOTICE_DECISION: Readonly<Record<string, string>> = {
    CONTENT_RESTORED:
        'The reversal of a `CONTENT_REMOVED` (#2867), recorded by '
        + '`POST /api/admin/moderation/restore` and addressed by the ACTION id '
        + 'of the removal it reverses. Sending it to the notices route would '
        + 'record a restore against a notice that asked for a removal — an '
        + 'action attributed to a case it is not about, which is exactly what '
        + 'P5.4a refuses by denormalising the subject from the notice instead '
        + 'of accepting it from the body. It would also skip the thing that '
        + 'makes a restore a restore: clearing `removedByModerationAt` on the '
        + 'subject the ORIGINAL action named, which a notice id cannot '
        + 'identify, because that column carries no record of which decision '
        + 'set it.',
};

/**
 * The SELECTOR, at module level so `Selector teeth` can audit it.
 *
 * It was inline inside the `it()` that uses it, which made this file
 * `NOT AUDITED` — and that population has a CEILING (200), so adding the file
 * took it to 201 and `selector-teeth-reports-its-denominator` failed. The rule
 * it prints is the point: "a guard whose selecting happens inline inside
 * `it()` cannot be mutation-audited, so it passes whether or not it selects
 * anything."
 *
 * Extracting it is the fix P8.3 recorded rather than raising the ceiling, and
 * the extraction comes with the control below — a selector with no control is
 * a function the audit can reach and still cannot grade.
 */
export function unclassifiedKinds(
    enumValues: readonly string[],
    sendable: readonly string[],
    namedForAnotherVerb: Readonly<Record<string, string>>,
): string[] {
    return enumValues.filter(
        (v) => !sendable.includes(v) && !(v in namedForAnotherVerb),
    );
}

describe('MODERATION_ACTION_KINDS mirrors the enum, minus a named difference', () => {
    const enumValues = Object.values(ModerationActionKind) as string[];
    const zodValues = [...MODERATION_ACTION_KINDS] as string[];

    it('prints both populations', () => {
        console.log(
            `[moderation-action-kinds-mirror] enum ${enumValues.length} `
            + `(${enumValues.join(', ')}); sendable ${zodValues.length}; `
            + `other-verb ${Object.keys(NOT_A_NOTICE_DECISION).length}.`,
        );
        // Neither may be empty, or the comparisons below pass over nothing.
        expect(enumValues.length).toBeGreaterThan(1);
        expect(zodValues.length).toBeGreaterThan(1);
    });

    it('every sendable kind exists in the enum', () => {
        // The self-correcting direction, asserted so the failure arrives here
        // rather than as a Prisma error on a moderator's request.
        for (const v of zodValues) expect(enumValues).toContain(v);
    });

    it('CONTROL — the selector can actually select', () => {
        // Without this, `unclassifiedKinds` returning `[]` unconditionally
        // passes every assertion below: the subject is an ABSENCE, and an
        // empty window satisfies a negated assertion. Synthetic inputs,
        // because the live populations are (correctly) fully classified, so
        // nothing real exercises the finding branch.
        expect(unclassifiedKinds(['A', 'B'], ['A'], { B: 'why' })).toEqual([]);
        expect(unclassifiedKinds(['A', 'B'], ['A'], {})).toEqual(['B']);
        expect(unclassifiedKinds(['A', 'B', 'C'], [], { A: 'why' })).toEqual(['B', 'C']);
    });

    it('every enum value is EITHER sendable or named for another verb', () => {
        const unclassified = unclassifiedKinds(
            enumValues, zodValues, NOT_A_NOTICE_DECISION,
        );
        if (unclassified.length > 0) {
            throw new Error(
                `${unclassified.length} ModerationActionKind value(s) are neither `
                + `sendable on a notice nor named for another verb:\n\n`
                + unclassified.map((v) => `  ${v}`).join('\n')
                + `\n\nDecide: add it to MODERATION_ACTION_KINDS if a notice `
                + `DECISION may carry it, or add a NOT_A_NOTICE_DECISION entry `
                + `here saying which verb records it and what sending it to the `
                + `notices route would record instead.`,
            );
        }
        expect(unclassified).toEqual([]);
    });

    it('no named difference is stale', () => {
        // An entry is COVER. One naming a value the enum no longer has, or one
        // that has since become sendable, keeps that cover alive for whatever
        // is added at the same name next (#1285).
        const gone = Object.keys(NOT_A_NOTICE_DECISION).filter(
            (v) => !enumValues.includes(v),
        );
        const nowSendable = Object.keys(NOT_A_NOTICE_DECISION).filter(
            (v) => zodValues.includes(v),
        );
        expect({ gone, nowSendable }).toEqual({ gone: [], nowSendable: [] });
    });

    it('every named difference carries a real reason', () => {
        for (const why of Object.values(NOT_A_NOTICE_DECISION)) {
            expect(why.length).toBeGreaterThan(120);
        }
    });

    it('CONTENT_RESTORED has the Art 17 copy its statement is built from', () => {
        // A kind with no `statementOfReasons.action.<KIND>` entry composes a
        // statement with the KEY where its action line should be — and
        // `translateFor` is a plain interpolator with no ICU, so a missing key
        // comes back as the key itself rather than throwing. The person would
        // receive a legal notice reading `statementOfReasons.action.
        // CONTENT_RESTORED`.
        //
        // Asserted HERE rather than left to key parity because parity compares
        // the two CATALOGUES to each other: a key missing from both is
        // perfectly balanced.
        for (const locale of ['en', 'bg'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
            const messages = require(`../../messages/${locale}/app.json`);
            const line = messages?.statementOfReasons?.action?.CONTENT_RESTORED;
            expect(typeof line).toBe('string');
            expect((line as string).length).toBeGreaterThan(10);
        }
    });
});
