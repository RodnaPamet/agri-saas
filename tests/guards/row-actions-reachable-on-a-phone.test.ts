/**
 * A row action a phone never renders (#2610).
 *
 * `MobileCardList` omits every column with no `mobileCard` meta, which is
 * documented and correct — a card should stay to the three or four fields that
 * matter in a field. The consequence is that an action declared only on the
 * table is UNREACHABLE on a phone, and nothing on screen says so. #2583 was a
 * farmer in a phone browser unable to delete an expense at all; the iOS app
 * having its own delete is why nobody noticed.
 *
 * Fixing one and leaving five is how that gap survives, so this derives the
 * population instead of listing it: every `src/app` list with a CARD fallback
 * and a real `actions` column, each of which must put the action somewhere a
 * thumb can reach.
 *
 * ## Three ways to satisfy it
 *
 *   1. the actions column carries `mobileCard` meta — ANY slot, not just
 *      `'actions'`. `farm-tasks` uses `slot: 'meta'` and its «Приключи» button
 *      is perfectly reachable there; demanding one slot name would have called
 *      that a defect and "fixed" a working screen.
 *   2. the list declares a `swipeAction` — the journal's Epic 67
 *      swipe-to-withdraw (#2175), where the destructive action IS the gesture.
 *   3. the file is recorded in `DESKTOP_ONLY` with a written reason.
 *
 * `DESKTOP_ONLY` is EMPTY and the no-stale test keeps it honest. It exists
 * because "find a desktop" is a defensible answer for some administrative
 * surfaces — it was the owner's call that all six of #2610's go to the card,
 * so nothing claims the exemption today.
 *
 * ## A VISIBILITY DESCRIPTOR IS NOT A COLUMN, and that is what fooled me
 *
 * `evidence` contains `{ id: 'actions', label: t.actions, alwaysVisible: true }`
 * — a column-visibility entry — 285 lines above its real table column. A
 * detector taking the first `id: 'actions'` it finds reads the descriptor,
 * sees no `mobileCard`, and reports a defect on a screen that is fine. So
 * every candidate is brace-matched and kept only if it RENDERS something
 * (`cell:` or `header:`), and `describes a visibility descriptor` below pins
 * that.
 *
 * ## Why brace matching rather than line proximity
 *
 * Line-grepping this question gave three different wrong answers in a row:
 * `evidence` covered-then-not, `farm-tasks` not-then-covered, and `grain/yield`
 * in the population at all — its `mobileFallback` hit was inside a COMMENT
 * explaining why the yield matrix scrolls instead. The question is structural
 * (does THIS column carry THIS meta), so the read has to be.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

/** Lists whose row actions are deliberately desktop-only. Keyed by file, with a reason. */
const DESKTOP_ONLY: Record<string, string> = {};

/** A card fallback, declared as a prop or in an options object. */
const CARD_FALLBACK = /mobileFallback[=:]\s*[{'"]?\s*['"]card['"]/;

/** Every object literal containing a match, by brace matching. */
export function objectsAround(src: string, pattern: RegExp): Array<{ text: string; line: number }> {
    const out: Array<{ text: string; line: number }> = [];
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        let i = m.index;
        let depth = 0;
        while (i > 0) {
            if (src[i] === '}') depth += 1;
            else if (src[i] === '{') {
                if (depth === 0) break;
                depth -= 1;
            }
            i -= 1;
        }
        let j = i;
        depth = 0;
        while (j < src.length) {
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
            j += 1;
        }
        out.push({ text: src.slice(i, j + 1), line: src.slice(0, i).split('\n').length });
    }
    return out;
}

export interface Verdict {
    readonly file: string;
    readonly line: number;
    readonly reachable: boolean;
}

/** Classify one file's real actions columns. */
export function classify(relPath: string, source: string): Verdict[] {
    const src = blankNonCode(source);
    if (!CARD_FALLBACK.test(src)) return [];
    const swipe = /swipeAction/.test(src);
    return objectsAround(src, /id:\s*['"]actions['"]/)
        // A visibility descriptor renders nothing. Only a real column does.
        .filter((c) => /\b(cell|header)\s*:/.test(c.text))
        .map((c) => ({
            file: relPath,
            line: c.line,
            reachable: /\bmobileCard\b/.test(c.text) || swipe,
        }));
}

describe('#2610 — a row action is reachable on a phone, or recorded as not', () => {
    const files = collectSourceFiles({ roots: ['src/app'], extensions: ['.tsx'], floor: 200 });
    const verdicts = files.flatMap((abs) =>
        classify(path.relative(ROOT, abs), fs.readFileSync(abs, 'utf-8')),
    );

    it('every actions column on a card list is reachable', () => {
        const unreachable = verdicts
            .filter((v) => !v.reachable)
            .filter((v) => !(v.file in DESKTOP_ONLY));

        console.log(
            `[row-actions-reachable] ${files.length} app .tsx files; `
                + `${verdicts.length} actions column(s) on a CARD list; `
                + `${verdicts.filter((v) => v.reachable).length} reachable; `
                + `${Object.keys(DESKTOP_ONLY).length} recorded desktop-only`,
        );

        // A floor on the population, not just the gap: a brace matcher that
        // stopped matching would report zero unreachable columns and pass.
        expect(verdicts.length).toBeGreaterThanOrEqual(12);
        expect(unreachable).toEqual([]);
    });

    it('DESKTOP_ONLY has no stale entries', () => {
        for (const [file, reason] of Object.entries(DESKTOP_ONLY)) {
            expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
            expect(reason.length).toBeGreaterThan(30);
            // An entry for a list that is now reachable is cover it no longer
            // needs — delete it in the diff that fixed the screen.
            expect(verdicts.some((v) => v.file === file && !v.reachable)).toBe(true);
        }
    });

    describe('the detector has teeth', () => {
        const card = `<DataTable mobileFallback="card" columns={cols} />`;

        it('flags an actions column with no mobileCard', () => {
            const src = `${card}\nconst cols = [{ id: 'actions', cell: () => <Button /> }];`;
            expect(classify('s.tsx', src).map((v) => v.reachable)).toEqual([false]);
        });

        it('accepts ANY slot, not only slot: actions', () => {
            // `farm-tasks` is the real case: `slot: 'meta'`, and reachable.
            const src = `${card}\nconst cols = [{ id: 'actions', cell: () => <B />, meta: { mobileCard: { slot: 'meta' } } }];`;
            expect(classify('s.tsx', src).map((v) => v.reachable)).toEqual([true]);
        });

        it('accepts a swipeAction instead', () => {
            const src = `${card}\nconst cols = [{ id: 'actions', cell: () => <B /> }];\nconst s = swipeAction;`;
            expect(classify('s.tsx', src).map((v) => v.reachable)).toEqual([true]);
        });

        it('describes a visibility descriptor as no column at all', () => {
            // The `evidence` shape. A descriptor renders nothing, so it is not
            // a place an action could be reached FROM — reporting it is a false
            // alarm on a working screen.
            const src = `${card}\nconst vis = [{ id: 'actions', label: 'Actions', alwaysVisible: true }];`;
            expect(classify('s.tsx', src)).toEqual([]);
        });

        it('ignores a scroll fallback, even when a comment says the word card', () => {
            // `grain/yield`: its `mobileFallback` hit was in a comment
            // explaining why the yield matrix scrolls rather than becoming a
            // card. Blanking comments is what keeps it out of the population.
            const src = `// mobileFallback: 'card' was rejected here — the matrix is wide.\n`
                + `<DataTable mobileFallback="scroll" />\nconst cols = [{ id: 'actions', cell: () => <B /> }];`;
            expect(classify('s.tsx', src)).toEqual([]);
        });

        it('finds BOTH actions columns when a file has two tables', () => {
            // `org/members` has a members table and a pending-invites table,
            // both card-fallback. A detector returning the first match would
            // have left one of #2610's six unfixed and reported success.
            const src = `${card}\nconst a = [{ id: 'actions', cell: () => <B /> }];\n`
                + `const b = [{ id: 'actions', cell: () => <C /> }];`;
            expect(classify('s.tsx', src)).toHaveLength(2);
        });
    });
});
