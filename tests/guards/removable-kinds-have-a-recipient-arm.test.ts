/**
 * A removable subject kind must have a RECIPIENT arm — #2955.
 *
 * ## The failure this prevents, which is Art 17 and not hygiene
 *
 * `actOnNotice` records the decision and queues the statement in one
 * transaction, guarded by `if (recipientUserId)`. `resolveContentRecipient`
 * returns `null` for any kind it has no arm for. So for a kind that IS
 * removable but has no arm: **the content is removed, the notice reads
 * ACTIONED, the action row is written, the audit chain gets its entry — and no
 * statement of reasons is ever queued.** No error, no warning, and nothing in
 * `listUndeliveredStatements`, which lists statements that EXIST and have not
 * been sent, not decisions that produced none.
 *
 * Measured on #2937's first run of `p9-3c-channel-moderation`: the removal
 * worked perfectly and the author was never told.
 *
 * It is #2865's shape inverted. There an outcome was RECORDED WITHOUT BEING
 * PERFORMED — the statement said «Премахнахме съдържанието.» while the listing
 * stayed live — and P5.9 drew the rule from it: *the outcome cannot be recorded
 * without being performed.* This is the mirror: **performed without being
 * explained.** Arguably worse, because #2865 produced a FALSE statement a
 * recipient would notice and complain about, while this produces NO statement
 * and the absence is visible to nobody.
 *
 * ## Why a GUARD rather than a runtime check
 *
 * `if (recipientUserId)` cannot distinguish three different things, and all
 * three take the same branch:
 *
 *   1. a kind that legitimately has no recipient — `PROFILE`, `THREAD`. Fine.
 *   2. a kind whose arm nobody wrote. A compliance gap, and silent.
 *   3. a real id that resolved to nothing — a deleted row.
 *
 * This file closes (2) at BUILD time, which is the only place it can be closed:
 * by the time the code runs, a missing arm looks exactly like case (1). Case (3)
 * is a runtime fact a guard cannot see, and is covered separately by
 * `missingRow` in `statement-queue.ts`, which logs at `warn` under its own
 * event name so a log search can tell it from case (1).
 *
 * ## It derives from `REMOVABLE_SUBJECT_KINDS`, not from the enum
 *
 * `PROFILE` and `THREAD` are reportable and deliberately recipientless — a
 * profile's removable surface is P6's `FarmBrand`, and a thread is a collection
 * whose removal shape nobody has decided. Ranging over `ReportSubjectKind`
 * would force an arm for both and the guard would be wrong rather than strict.
 * `DIRECT_MESSAGE` is the same: reportable, and NOT removable by owner ruling
 * (2026-11-08 — suspension is the remedy there).
 *
 * ## Comments are blanked FIRST, and that is load-bearing here
 *
 * The docblock immediately above `REMOVABLE_SUBJECT_KINDS` names
 * `CHANNEL_POST` and `DIRECT_MESSAGE` in prose, explaining why one is in the
 * list and the other is not. A matcher reading raw source would extract
 * `DIRECT_MESSAGE` as a removable kind and then demand a recipient arm for the
 * one kind the owner ruled must not have one — failing on exactly the decision
 * it exists to protect. `a-scar-is-not-a-wound`.
 *
 * ## The population is COMPLETE today, so the detector is proved against
 * crafted sources
 *
 * All three removable kinds have both arms as of this commit. A guard that
 * passes on day one tells you nothing about whether it CAN fail, so the
 * synthetic cases below are the real evidence — the
 * `channels-are-never-auto-joined` precedent, whose allowlist is likewise
 * empty.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const MODERATION = path.join(ROOT, 'src/app-layer/usecases/moderation.ts');
const STATEMENT_QUEUE = path.join(ROOT, 'src/app-layer/usecases/statement-queue.ts');

/** Source with comments blanked — see the docblock on why that is not optional. */
function code(file: string): string {
    return blankNonCode(readFileSync(file, 'utf8'));
}

/**
 * The body of a named function or declaration, bounded by brace depth.
 *
 * Scoped extraction rather than a whole-file sweep: a `case 'X'` in some other
 * switch, or a `subjectKind === 'X'` in a different helper, would otherwise be
 * counted as an arm of the function under test — which is
 * `a-guard-that-grades-the-wrong-thing`, capable of failing and aimed one level
 * off.
 */
function bodyOf(src: string, signature: string): string {
    const start = src.indexOf(signature);
    if (start === -1) return '';
    let depth = 0;
    let seenOpen = false;
    for (let i = start; i < src.length; i += 1) {
        if (src[i] === '{') { depth += 1; seenOpen = true; }
        else if (src[i] === '}') {
            depth -= 1;
            if (seenOpen && depth === 0) return src.slice(start, i + 1);
        }
    }
    return '';
}

function removableKinds(src: string): string[] {
    const m = src.match(/REMOVABLE_SUBJECT_KINDS\s*=\s*\[([^\]]*)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

describe('#2955 — a removable kind cannot ship without a way to explain the removal', () => {
    const moderation = code(MODERATION);
    const queue = code(STATEMENT_QUEUE);

    const removable = removableKinds(moderation);
    const removeArms = [
        ...bodyOf(moderation, 'async function removeSubjectOnTx').matchAll(/case '([A-Z_]+)'/g),
    ].map((m) => m[1]);
    const recipientArms = [
        ...bodyOf(queue, 'export async function resolveContentRecipient').matchAll(
            /subjectKind === '([A-Z_]+)'/g,
        ),
    ].map((m) => m[1]);

    it('ranges over a real population — an empty extraction would pass vacuously', () => {
        // Every assertion below is "for each removable kind…", which is
        // trivially true of none. These floors are what stop a renamed constant
        // or a changed arm shape from turning this file into a no-op that still
        // reports green. `an-empty-window-passes-a-negated-assertion`.
        expect(removable.length).toBeGreaterThanOrEqual(3);
        expect(removeArms.length).toBeGreaterThanOrEqual(3);
        expect(recipientArms.length).toBeGreaterThanOrEqual(3);

        // And the extraction must not have swallowed a comment: `DIRECT_MESSAGE`
        // appears in the prose beside the constant and must NOT be in the list.
        expect(removable).not.toContain('DIRECT_MESSAGE');
        expect(removable).not.toContain('PROFILE');
        expect(removable).not.toContain('THREAD');

        console.log(
            `[removable-recipient-arms] removable=${removable.length} `
            + `remove_arms=${removeArms.length} recipient_arms=${recipientArms.length} `
            + `kinds=${removable.join(',')}`,
        );
    });

    it('every removable kind has a resolveContentRecipient arm', () => {
        const missing = removable.filter((k) => !recipientArms.includes(k));
        expect(missing).toEqual([]);
    });

    it('every removable kind has a removeSubjectOnTx arm', () => {
        // The pairing `REMOVABLE_SUBJECT_KINDS`'s own docblock already CLAIMS —
        // "removeSubjectOnTx has an arm per entry here" — enforced here rather
        // than trusted. A safety argument in a comment expires silently.
        const missing = removable.filter((k) => !removeArms.includes(k));
        expect(missing).toEqual([]);
    });

    it('does NOT demand an arm for a kind that is deliberately recipientless', () => {
        // The positive control in the other direction. A guard ranging over the
        // whole enum would pass every assertion above and be WRONG — it would
        // demand a recipient for `PROFILE`, `THREAD` and `DIRECT_MESSAGE`,
        // which is the owner's ruling inverted.
        for (const kind of ['PROFILE', 'THREAD', 'DIRECT_MESSAGE']) {
            expect(removable).not.toContain(kind);
        }
        expect(recipientArms).not.toContain('DIRECT_MESSAGE');
    });

    describe('the detector can actually fail — proved on crafted sources', () => {
        // Every real kind is paired today, so these synthetic cases are the only
        // evidence this file has teeth.
        const CRAFTED_MODERATION = `
            /** A comment naming DIRECT_MESSAGE and PROFILE, which must be ignored. */
            const REMOVABLE_SUBJECT_KINDS = ['LISTING', 'MESSAGE', 'CHANNEL_POST', 'NEW_KIND'] as const;
            async function removeSubjectOnTx(tx, subjectKind, subjectId) {
                switch (subjectKind) {
                    case 'LISTING': { break; }
                    case 'MESSAGE': { break; }
                    case 'CHANNEL_POST': { break; }
                    case 'NEW_KIND': { break; }
                    default: throw new Error('x');
                }
            }
        `;
        const CRAFTED_QUEUE = `
            export async function resolveContentRecipient(subjectKind, subjectId) {
                if (subjectKind === 'LISTING') { return null; }
                if (subjectKind === 'MESSAGE') { return null; }
                if (subjectKind === 'CHANNEL_POST') { return null; }
                return null;
            }
        `;

        it('DETECTS a removable kind with no recipient arm', () => {
            const kinds = removableKinds(blankNonCode(CRAFTED_MODERATION));
            const arms = [
                ...bodyOf(
                    blankNonCode(CRAFTED_QUEUE),
                    'export async function resolveContentRecipient',
                ).matchAll(/subjectKind === '([A-Z_]+)'/g),
            ].map((m) => m[1]);
            // This is the #2937 situation exactly: the kind is removable, the
            // removal has an arm, and nothing can explain it.
            expect(kinds.filter((k) => !arms.includes(k))).toEqual(['NEW_KIND']);
        });

        it('DETECTS a removable kind with no removal arm either', () => {
            const noRemoveArm = CRAFTED_MODERATION.replace("case 'NEW_KIND': { break; }", '');
            const kinds = removableKinds(blankNonCode(noRemoveArm));
            const arms = [
                ...bodyOf(blankNonCode(noRemoveArm), 'async function removeSubjectOnTx')
                    .matchAll(/case '([A-Z_]+)'/g),
            ].map((m) => m[1]);
            expect(kinds.filter((k) => !arms.includes(k))).toEqual(['NEW_KIND']);
        });

        it('does NOT report a kind named only in a COMMENT', () => {
            // The false-alarm half. Without comment blanking this extraction
            // yields DIRECT_MESSAGE and the guard demands an arm for the one
            // kind that must not have one.
            const kinds = removableKinds(blankNonCode(CRAFTED_MODERATION));
            expect(kinds).not.toContain('DIRECT_MESSAGE');
            expect(kinds).not.toContain('PROFILE');
            // And the control that the blanking did not simply empty everything.
            expect(kinds).toContain('LISTING');
        });

        it('bodyOf scopes to the named function, not the whole file', () => {
            // A `case 'ELSEWHERE'` outside the function under test must not be
            // read as one of its arms.
            const withDecoy = `
                function somethingElse(k) { switch (k) { case 'ELSEWHERE': break; } }
                async function removeSubjectOnTx(tx, k) { switch (k) { case 'LISTING': break; } }
            `;
            const arms = [
                ...bodyOf(blankNonCode(withDecoy), 'async function removeSubjectOnTx')
                    .matchAll(/case '([A-Z_]+)'/g),
            ].map((m) => m[1]);
            expect(arms).toEqual(['LISTING']);
        });

        it('bodyOf returns EMPTY for a signature that does not exist', () => {
            // Which is what the floors above are for: a renamed function makes
            // the arm list empty, and "every removable kind is in []" is false
            // for a non-empty removable list — so the guard FAILS rather than
            // passing over nothing.
            expect(bodyOf('const x = 1;', 'async function gone')).toBe('');
        });
    });
});
