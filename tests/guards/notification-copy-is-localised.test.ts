/**
 * Guard: a notification's copy is written in the RECIPIENT's language.
 *
 * ## What went wrong
 *
 * The owner reported that notifications arrive in English. Three of the
 * fifteen modules under `src/app-layer/notifications/` held English literals
 * and never called `translateFor`:
 *
 *   assignment.ts   TASK_ASSIGNED, ASSET_ASSIGNED
 *   task-due.ts     week / day / today
 *   agro.ts         spray window, disease risk, copilot
 *
 * Eight titles, in a product whose `User.uiLanguage` column defaults to `bg`.
 * Nothing failed, because a notification row stores RENDERED text: the write
 * succeeds whatever language it is in, and the only observer is the farmer
 * reading their bell.
 *
 * `templates.ts` (16 `translateFor` calls), `digest-templates.ts` (13) and
 * `bulk-task-summary.ts` (5) already did it correctly, so the pattern was
 * established in-tree the whole time — and `bulk-task-summary.ts`'s docblock
 * named the debt explicitly rather than guarding it, which is how it survived.
 *
 * ## Why a guard rather than care
 *
 * The population grows. A new notification kind is a natural place to write
 * prose inline, it reads fine in review to an English-speaking reviewer, and
 * the defect is invisible in CI because the row is valid either way. This is
 * the `no-hardcoded-ui-strings` ratchet's argument, one layer down: that scan
 * covers `src/app` and `src/components`, and notification copy lives in
 * neither.
 *
 * ## The exemption is a forcing function, not a carve-out
 *
 * `agro.ts` is still English, deliberately, and tracked on #2490: its body
 * interpolates `spray.reasons[0]`, which is a pre-rendered English sentence
 * built in `src/lib/agro/rules.ts`. Translating the title alone would ship a
 * Bulgarian sentence with an English clause inside it — visibly fixed and
 * actually not. CLAUDE.md already settled that shape for `DueItem.reason`: a
 * recipient-facing string produced far from its reader wants `{ key, params }`.
 *
 * The exemption therefore asserts the file STILL has English prose. When
 * #2490 lands, this guard fails until the entry is deleted, so the carve-out
 * cannot outlive its reason — the no-stale-entries rule every exemption map
 * in this repo carries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = 'src/app-layer/notifications';
const DIR = path.resolve(__dirname, '../..', ROOT);

/**
 * Still English, with the issue that tracks it. Delete the entry in the same
 * diff as the fix — the test below fails if a listed file has no English prose
 * left.
 */
const STILL_ENGLISH: Record<string, string> = {
    'agro.ts':
        '#2490 — the body interpolates spray.reasons[0], a pre-rendered English ' +
        'sentence from lib/agro/rules.ts. Needs the { key, params } descriptor ' +
        'conversion first; translating this layer alone ships a Bulgarian ' +
        'sentence with an English clause in it.',
};

/**
 * Comments blanked so a docblock QUOTING prose is not a hit — through
 * `blankNonCode`, not a local stripper.
 *
 * The shape this replaces ran BLOCK comments before LINE comments, which is
 * the defect `comment-stripper-order` exists for and which CI caught here: a
 * line comment containing a block-open is ordinary in this repo, and with
 * blocks stripped first the regex runs to the next block-close and deletes
 * every real line between. Measured on the live tree at 511 lines lost across
 * nine files — a scanner reporting clean over 40% of a file.
 *
 * `blankNonCode` is state-aware, keeps string contents, and BLANKS rather than
 * removes, so positions survive for anything anchored.
 */

/**
 * English prose assigned to a copy field. Two or more words, first one
 * capitalised, ASCII letters only — so a Bulgarian string never matches, and
 * neither does an identifier, a key path (`notifications.taskDue.week.title`)
 * or a single word like a status.
 */
const PROSE = /\b(?:title|phrase|body|message|subject)\s*:\s*'([A-Z][a-z]+(?: [A-Za-z’']+){1,})'/g;

function proseIn(src: string): string[] {
    return [...blankNonCode(src).matchAll(PROSE)].map((m) => m[1]);
}

/**
 * Through `collectSourceFiles` rather than `readdirSync`, because
 * `file-collection-is-not-silently-empty` is right about what it prevents: a
 * hand-rolled collector can be gutted to return `[]` with every assertion
 * built on it still green. CI caught exactly that here — this guard shipped
 * with a private walker and shard 1/6 refused it. The floor is what separates
 * "no module holds English prose" from "no module was read".
 */
function modules(): string[] {
    return collectSourceFiles({
        roots: [ROOT],
        extensions: ['.ts'],
        exclude: (rel) => rel.endsWith('.test.ts'),
        floor: 10,
    })
        .map((abs) => path.basename(abs))
        .sort();
}

describe('notification copy is written in the recipient language', () => {
    const files = modules();

    it('reports the population it graded', () => {
        const localising = files.filter((f) =>
            fs.readFileSync(path.join(DIR, f), 'utf8').includes('translateFor'),
        );
        console.log(
            `[notification-copy-localised] graded ${files.length} module(s) in ` +
                `src/app-layer/notifications; ${localising.length} call translateFor; ` +
                `${Object.keys(STILL_ENGLISH).length} exempt (${Object.keys(STILL_ENGLISH).join(', ')})`,
        );
        // A detector over an empty directory would pass every assertion below.
        expect(files.length).toBeGreaterThanOrEqual(10);
    });

    it.each(modules().filter((f) => !(f in STILL_ENGLISH)))(
        '%s holds no English copy prose',
        (file) => {
            const found = proseIn(fs.readFileSync(path.join(DIR, file), 'utf8'));
            expect(found).toEqual([]);
        },
    );

    it.each(Object.entries(STILL_ENGLISH))(
        '%s is still English, so its exemption is not stale',
        (file, reason) => {
            expect(reason.length).toBeGreaterThan(40);
            const found = proseIn(fs.readFileSync(path.join(DIR, file), 'utf8'));
            // If this fails, the file was fixed — delete its STILL_ENGLISH
            // entry in the same diff. The exemption must not outlive its cause.
            expect(found.length).toBeGreaterThan(0);
        },
    );
});

describe('the detector can express each failure', () => {
    it('flags an English literal title', () => {
        expect(proseIn(`const C = { title: 'You were assigned a task' };`)).toEqual([
            'You were assigned a task',
        ]);
    });

    it('does not flag a copy KEY', () => {
        expect(proseIn(`const C = { titleKey: 'notifications.taskDue.week.title' };`)).toEqual([]);
        expect(proseIn(`const C = { title: 'notifications.assignment.task.title' };`)).toEqual([]);
    });

    it('does not flag Bulgarian prose', () => {
        expect(proseIn(`const C = { title: 'Възложена Ви е задача' };`)).toEqual([]);
    });

    it('does not flag prose quoted inside a comment', () => {
        expect(
            proseIn(`/** was title: 'Task due tomorrow' before #2490 */\nconst C = {};`),
        ).toEqual([]);
    });

    it('does not flag a single word', () => {
        expect(proseIn(`const C = { title: 'Pending' };`)).toEqual([]);
    });
});
