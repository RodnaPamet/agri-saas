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
 * There are THREE axes — what a caller may SEND, what the enum can HOLD, and
 * what the platform can DO — and this guard is about the first two only.
 * Conflating them with the third is how a value ends up unsendable for the
 * wrong reason.
 *
 * `CONTENT_DEMOTED` was the worked example: it sat in BOTH lists while
 * `assertPerformable` refused it, because nothing in this product can demote.
 * It was DELETED on 2026-11-09 (#2868, owner decision), so the example is now
 * history — and it is worth keeping as history, because the resolution shows
 * the axes are genuinely independent. The value left the first two lists and
 * the third axis did not move: `CONTENT_REMOVED` is still performable on some
 * subject kinds and not others, which no enum can express because it is a
 * property of the PAIR.
 *
 * The live divergence is now `CONTENT_RESTORED` and `CONTENT_AUTO_HIDDEN`, in
 * `NOT_A_NOTICE_DECISION` below — values the enum holds and a notice decision
 * may not carry.
 *
 * ## The fourth axis: whether the OUTCOME can be EXPLAINED
 *
 * The three axes above are what a caller may SEND, what the enum can HOLD and
 * what the platform can DO. P9.3d found a fourth, one table over: whether the
 * kind has the Art 17 copy its statement of reasons is composed from. A kind
 * can be holdable, performable and unexplainable all at once, and the failure
 * is delivered rather than raised — see the `describe` at the bottom.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { ModerationActionKind } from '@prisma/client';

import { MODERATION_ACTION_KINDS } from '@/lib/schemas';

/**
 * Enum values a notice DECISION may not carry, each with why.
 *
 * An entry here is a value that exists for a different verb. The reason has to
 * say what sending it to the notices route would record.
 */
const NOT_A_NOTICE_DECISION: Readonly<Record<string, string>> = {
    CONTENT_AUTO_HIDDEN:
        'The report-threshold job\'s own outcome (P9.3d, #2937), written with '
        + '`moderatorRef: \'auto:report-threshold\'` because no person decided. '
        + 'A moderator sending it would record a decision they DID make as one '
        + 'nobody made — the inverse of the honesty rule that gives the '
        + 'automatic action its own kind in the first place, and it would leave '
        + 'the notice RECEIVED, since the job deliberately does not triage. A '
        + 'human withholding a channel post records `CONTENT_REMOVED`, which '
        + 'sets `removedByModerationAt` and is what the restore route reverses; '
        + 'this kind sets `autoHiddenAt`, a different column cleared by a '
        + 'different act.',
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

    describe('EVERY kind has the Art 17 copy its statement is built from', () => {
        // ## Why this ranges over the enum and not over one name
        //
        // It asserted `CONTENT_RESTORED` alone, hardcoded, and that covered one
        // of six kinds. P9.3d added `CONTENT_AUTO_HIDDEN` and the catalogues
        // went on satisfying it — so the first author auto-hidden would have
        // received a legal notice whose action line read
        // `statementOfReasons.action.CONTENT_AUTO_HIDDEN`.
        //
        // `translateFor` is a plain interpolator with NO ICU and no throw on a
        // missing key: it returns the KEY. So the failure is silent, arrives in
        // somebody's inbox, and the statement is the artefact a regulator reads.
        //
        // Key parity cannot see it either, and that is not a gap in parity: it
        // compares the two CATALOGUES to each other, and a key missing from
        // both is perfectly balanced. The population has to come from the ENUM.
        //
        // ## Why this is asserted PER LOCALE, and why that is the strong half
        //
        // `translateFor` falls back across locales (measured 2026-11-10 on the
        // P9.3d statement): with the line removed from `bg` alone the notice
        // composes in ENGLISH and nothing fails, including the behavioural
        // assertion in `p9-3d-channel-auto-hide`, which can only see a key
        // missing from BOTH. So a Bulgarian farmer receiving an Art 17 notice
        // in English is invisible everywhere except here — and `bg` is the
        // fallback locale for a recipient whose preference never loaded, i.e.
        // the common case rather than an edge one.
        //
        // ## And the OTHER direction, which is how the count stayed honest
        //
        // When P9.3d found this, the catalogues held SIX keys for SIX enum
        // values — and one of them was `CONTENT_DEMOTED`, deleted from the enum
        // by #2868, while `CONTENT_AUTO_HIDDEN` was absent. A count check
        // passes that exactly. A stale key is also COVER (#1285): it keeps
        // copy alive for whatever is added under that name next, and nobody
        // reviews prose that is already there.
        const ACTION_PATH = 'statementOfReasons.action';

        function actionCopy(locale: string): Record<string, string> {
            // `readFileSync` + `JSON.parse`, not `require`: a `require` of a
            // JSON module needed an `eslint-disable` for two rules that are not
            // enabled on test files, and `lint-ceiling` counts an INERT
            // directive — ceiling 0 — so the suppression itself failed CI.
            const raw = readFileSync(
                join(process.cwd(), `messages/${locale}/app.json`),
                'utf8',
            );
            const messages = JSON.parse(raw) as {
                statementOfReasons?: { action?: Record<string, string> };
            };
            return messages.statementOfReasons?.action ?? {};
        }

        for (const locale of ['en', 'bg'] as const) {
            it(`${locale}: every enum value has a line, and no line is orphaned`, () => {
                const copy = actionCopy(locale);
                const keys = Object.keys(copy);
                // The denominator, so a catalogue that stopped parsing — which
                // would make both comparisons range over nothing — is visible
                // rather than green.
                console.log(
                    `[moderation-action-copy] ${locale}: ${keys.length} line(s) `
                    + `for ${enumValues.length} enum value(s) under ${ACTION_PATH}.`,
                );
                expect(keys.length).toBeGreaterThan(1);

                const missing = enumValues.filter((v) => typeof copy[v] !== 'string');
                const orphaned = keys.filter((k) => !enumValues.includes(k));
                expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] });

                // A present-but-empty line is the same defect one level in: the
                // action line simply vanishes from the notice.
                for (const v of enumValues) {
                    expect(copy[v].trim().length).toBeGreaterThan(10);
                }
            });
        }
    });

});
