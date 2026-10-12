/**
 * "May this person stop their own erasure?" is answered in exactly one place.
 *
 * ## Why a guard and not a comment
 *
 * Two call sites need the answer and they must agree:
 *
 *   `cancelAccountDeletion`        enforces it — refuses with ACCOUNT_TERMINATED
 *   `GET /api/auth/me`             decides whether its 403 carries `erasesAt`,
 *                                  which the phone renders as a «stop the
 *                                  deletion» button
 *
 * They have now diverged TWICE, both times by a refusal signal reaching the
 * usecase and missing the route, and both times in the direction that offers a
 * person a control the server then refuses:
 *
 *   #1671   the initiator (`deletionRequestedBy === 'MODERATION'`)
 *   #1667   `terminatedAt`
 *
 * The second one shipped into a PR whose ten required checks were green, with a
 * comment in `me/route.ts` that described the first divergence as fixed and
 * warned the reader not to reintroduce it. A comment asking the next person to
 * remember is what failed; this asserts it instead. Both divergences were found
 * by agrent-ios reading the diff.
 *
 * ## What it grades, and the hop it refuses to count
 *
 * Calling `subjectMayCancelErasure` is not enough on its own — a route could
 * call it and then widen the result. So the route is also held to NOT
 * re-deriving the rule: no comparison against the deciding columns anywhere in
 * its code. Comments are blanked first (`blankNonCode`), because this file's
 * subject is named in prose all over both files — a scan that counted those
 * would be green for the wrong reason, and one that tripped on them would be
 * red for the wrong reason.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const root = path.resolve(__dirname, '../..');
const read = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(root, rel), 'utf8'));

/** The rule lives here. */
const RULE = 'src/app-layer/usecases/account-erasure.ts';

/**
 * Every file that decides cancellability. Adding one means adding it here —
 * which is the point: a new reader of this question is a new chance to diverge.
 */
const READERS = ['src/app/api/auth/me/route.ts'];

/**
 * The columns the rule is made of. A reader comparing any of these is deriving
 * the answer itself.
 *
 * `deletionRequestedAt` is deliberately NOT here: a reader legitimately tests
 * it for a different question — whether to emit a `deletion` block at all —
 * and `/api/auth/me` does exactly that on its 200 path.
 */
const DECIDING_COLUMNS = ['deletionRequestedBy', 'terminatedAt', 'pseudonymisedAt'];

describe('erasure cancellability has one rule (#1667)', () => {
    it('the rule is exported from the usecase that enforces it', () => {
        const src = read(RULE);
        expect(src).toMatch(/export function subjectMayCancelErasure\s*\(/);
    });

    it('the enforcing usecase refuses THROUGH the rule, not beside it', () => {
        // Without this the predicate could exist, be read by the route, and be
        // bypassed by the usecase — which is the same divergence with the sides
        // swapped, and strictly worse: the route would offer nothing and the
        // server would refuse nothing.
        const src = read(RULE);
        expect(src).toMatch(/if\s*\(\s*!\s*subjectMayCancelErasure\s*\(/);
    });

    it.each(READERS)('%s calls the rule', (rel) => {
        expect(read(rel)).toContain('subjectMayCancelErasure(');
    });

    it.each(READERS)('%s does not re-derive it from the columns', (rel) => {
        const src = read(rel);
        // A comparison, not a mention: `terminatedAt: true` in a Prisma
        // `select` is required and must stay legal. What is banned is testing
        // the value.
        const offenders = DECIDING_COLUMNS.flatMap((col) => {
            const re = new RegExp(
                `${col}\\s*(?:!==|===|==|!=)|(?:!==|===|==|!=)\\s*${col}\\b`,
                'g',
            );
            return [...src.matchAll(re)].map((m) => ({
                col,
                line: src.slice(0, m.index).split('\n').length,
            }));
        });
        expect(offenders).toEqual([]);
    });

    it('the rule reads every column the enforcing path selects', () => {
        // The failure this catches: a signal added to the usecase's `select`
        // and to its own logic, but never to the predicate's interface — the
        // divergence moving one level down, inside the file that owns the rule.
        const src = read(RULE);
        const iface = src.match(
            /export interface ErasureCancellability\s*\{([\s\S]*?)\n\}/,
        );
        expect(iface).not.toBeNull();
        for (const col of [...DECIDING_COLUMNS, 'deletionRequestedAt']) {
            expect(iface![1]).toContain(col);
        }
    });

    it('prints what it covered', () => {
        // The denominator, per `a-gate-narrow-enough-to-always-pass`: a guard
        // over an empty reader list passes every assertion above for free.
        expect(READERS.length).toBeGreaterThan(0);
        console.log(
            `[erasure-cancellability] rule=${RULE} readers=${READERS.length} ` +
                `columns=${DECIDING_COLUMNS.length}`,
        );
    });

    it('the column scan can actually see a comparison — positive control', () => {
        // `a-probe-with-no-discriminating-power`: the `.each` above passes when
        // the regex is broken in exactly the same way as when the code is
        // clean. This proves the regex fires, and that `blankNonCode` is not
        // blanking real code.
        const sample = blankNonCode(
            "// terminatedAt !== null in a comment\nif (u.terminatedAt !== null) return false;\n",
        );
        expect(sample).not.toContain('in a comment');
        const re = /terminatedAt\s*(?:!==|===|==|!=)/g;
        expect([...sample.matchAll(re)]).toHaveLength(1);
    });
});
