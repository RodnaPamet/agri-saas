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
 * ## The exemption was a forcing function, and it fired — 2026-10-30
 *
 * `STILL_ENGLISH` is EMPTY now, and the history is the point. It held
 * `agro.ts`, whose body interpolated `spray.reasons[0]` — a pre-rendered
 * English sentence built in `src/lib/agro/rules.ts`. Translating that title
 * alone would have shipped a Bulgarian sentence with an English clause inside
 * it: visibly fixed and actually not.
 *
 * The entry therefore asserted the file STILL had English prose, so the
 * carve-out could not outlive its reason. #2490 converted the disease reasons
 * to `{ code, params }`, rendered the push detail through the catalogue and
 * put the three titles behind keys — and this guard went RED on the
 * no-stale-entries assertion until the entry was deleted, in that same diff.
 * That is the mechanism working, not a failure: the exemption is what made
 * the fix impossible to forget and impossible to half-do.
 *
 * Keep the map and its no-stale test even while empty. A future kind that
 * needs a staged fix gets an entry with its issue number, and the assertion
 * below is what collects it again.
 *
 * ## The population is DERIVED from who writes a row — #2511
 *
 * It used to be `src/app-layer/notifications` alone, and that is how a guard
 * called "notification copy is localised" stayed green while the owner opened
 * «Известия» on a Bulgarian phone and read English. Eight producers write a
 * `Notification` row from `src/app-layer/jobs` and `src/app-layer/usecases`,
 * outside that directory and so outside the scan: five hardcoded English,
 * three hardcoded Bulgarian. The guard was correctly named and its population
 * was a fraction of what the name implied — `count-the-routes-a-gate-covers`.
 *
 * So the population is now the union of two sets: every module under the
 * notifications directory (they exist to produce copy), and every file under
 * `src/app-layer` that WRITES a notification row. The second half is derived
 * from the call, the way `past-due-capability-coverage` derives its upload
 * population from `FileRepository.markStored` callers — so a ninth producer
 * is covered the moment it writes its first row, rather than when somebody
 * remembers to list it.
 *
 * ## The detector had to grow a second shape too
 *
 * The English title that reached production was a TEMPLATE literal —
 * `` title: `New interest in your ${listing.commodity} listing` `` — and the
 * pattern only matched single-quoted strings. A detector blind to the exact
 * form the defect took is the `an-empty-window-passes-a-negated-assertion`
 * shape: it reported clean over a file that was not.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const COPY_ROOT = 'src/app-layer/notifications';
const PRODUCER_ROOT = 'src/app-layer';
const REPO = path.resolve(__dirname, '../..');

/**
 * Writes a notification ROW. `create(` and `createMany(` on a `notification`
 * delegate, however the client is spelled (`db`, `prisma`, `sellerDb`, `tx`).
 *
 * `create(?:Many)?` and NOT `createMany?` — the second reads as "create or
 * createMany" and means `createMan` plus an optional `y`, so it matches
 * `createMany` and misses every plain `create(`. Shipped that way for one run
 * of this guard, which silently dropped `usecases/insurance.ts` from the
 * population while reporting 22 modules graded. A population regex needs its
 * own positive control, which is what the detector describe below provides.
 */
const WRITES_NOTIFICATION = /\bnotification\s*\.\s*create(?:Many)?\s*\(/;

/**
 * Still English, with the issue that tracks it. Delete the entry in the same
 * diff as the fix — the test below fails if a listed file has no English prose
 * left.
 */
/**
 * Producers that resolve NO recipient locale, on purpose (#2511).
 *
 * Distinct from `STILL_ENGLISH`, which stages a FIX. An entry here is a
 * decision that there is nothing to translate, so it carries no issue number
 * and is not expected to leave.
 */
const DELIBERATELY_UNLOCALISED: Record<string, string> = {
    'src/app-layer/jobs/classify-photo.ts':
        'OWNER RULING 2026-11-01: the pest notification stays Bulgarian for every recipient. '
        + 'Its TITLE is a Bulgarian frame around `stored.identifiedPest`, which a key could '
        + 'carry — but its MESSAGE is `${recommendation} ${disclaimer}`, entirely MODEL output '
        + 'with no frame at all, so the only way to localise the body is to pin the vision '
        + 'prompt\'s output language (the `generateCopilotExplanation` precedent). The owner was '
        + 'offered that and chose not to: the advice is explicitly PROVISIONAL pending an '
        + 'agronomist, and four of five users read Bulgarian. Keying the title alone was offered '
        + 'and refused for the right reason — it gives an `en` recipient an English heading over '
        + 'Bulgarian advice, which reads as a defect rather than a limitation. So this is a '
        + 'decision, not debt: do NOT "finish" it by keying the title.',
    'src/app-layer/automation/action-executor.ts':
        'Writes `rule.name` and `cfg.title ?? rule.name` — strings the TENANT authored in '
        + 'their own rule builder. A tenant\'s rule name must not be run through a catalogue, '
        + 'and there is nothing to translate it TO: no catalogue has a key for a sentence a '
        + 'farmer typed yesterday. The one producer here whose copy is correctly untranslated, '
        + 'and recorded rather than swept so the distinction survives.',
};

/**
 * Producers that resolve no recipient locale YET, each with the issue that
 * tracks it (#2511).
 *
 * Separate from `DELIBERATELY_UNLOCALISED` above, and the distinction is the
 * point: that map is a decision that there is nothing to translate, this one is
 * a debt. An entry here is expected to leave, and the no-stale test below is
 * what makes it leave — the moment a listed producer gains a `translateFor`,
 * this guard goes red until the entry goes with it, in that same diff.
 *
 * Same forcing function `STILL_ENGLISH` uses, for the reason its own docblock
 * gives: the exemption is what makes the fix impossible to forget and
 * impossible to half-do.
 */
/**
 * Empty since the owner's 2026-11-01 ruling discharged the last entry. The map
 * and its no-stale test stay for the next staged fix — a producer localised in
 * two steps needs somewhere to sit between them, and deleting the mechanism
 * because it is momentarily empty is how the next one ends up with no home.
 */
const STAGED_UNLOCALISED: Record<string, string> = {};

const STILL_ENGLISH: Record<string, string> = {
    // Empty since #2490 discharged the `agro.ts` entry. See the docblock —
    // the map and its no-stale test stay for the next staged fix.
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
 *
 * The `(?<![.\w])` is load-bearing and arrived with the widened population. A
 * TERNARY reads exactly like a property:
 *
 *     codedBadRequest('X', err instanceof Error ? err.message : 'File upload failed')
 *
 * `.message : 'File upload failed'` matched `message\s*:\s*'…'` and reported
 * error copy as notification copy. The lookbehind requires the key to start a
 * token rather than follow a dot. Error prose is a DIFFERENT mechanism with
 * its own guard — `errors.<CODE>` in both catalogues — so the fix is for this
 * detector not to claim it, never to exempt the file.
 */
const PROSE =
    /(?<![.\w])(?:title|phrase|body|message|subject)\s*:\s*(?:'([A-Z][a-z]+(?: [A-Za-z’']+){1,})'|`([A-Z][a-z]+(?:[ ]+(?:\$\{[^}]*\}|[A-Za-z’']+))+)`)/g;

function proseIn(src: string): string[] {
    return [...blankNonCode(src).matchAll(PROSE)].map((m) => m[1] ?? m[2]);
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
    const copy = collectSourceFiles({
        roots: [COPY_ROOT],
        extensions: ['.ts'],
        exclude: (rel) => rel.endsWith('.test.ts'),
        floor: 10,
    });
    // Each half is floored SEPARATELY. A combined floor would let the derived
    // half collapse to zero while the directory half kept the total above it —
    // which is exactly the silent shrink the floor exists to catch.
    const producers = collectSourceFiles({
        roots: [PRODUCER_ROOT],
        extensions: ['.ts'],
        exclude: (rel) => rel.endsWith('.test.ts'),
        floor: 100,
    }).filter((abs) => WRITES_NOTIFICATION.test(fs.readFileSync(abs, 'utf8')));
    expect(producers.length).toBeGreaterThanOrEqual(6);

    return [...new Set([...copy, ...producers])]
        .map((abs) => path.relative(REPO, abs))
        .sort();
}

describe('notification copy is written in the recipient language', () => {
    const files = modules();

    it('reports the population it graded', () => {
        const producers = files.filter((f) =>
            WRITES_NOTIFICATION.test(fs.readFileSync(path.join(REPO, f), 'utf8')),
        );
        // The INTERSECTION, not two independent counts (#2511).
        //
        // This read `${producers.length} write a Notification row,
        // ${localising.length} call translateFor`, where `localising` ranged
        // over all 27 GRADED modules rather than over the writers. The two
        // numbers therefore measured different sets while reading as a subset
        // relation — "16 write a row, 13 call translateFor" invites "so 3 do
        // not", and the real figure was 5: the 13 included modules that
        // resolve a locale WITHOUT writing a row (the digest templates, the
        // enqueue) and excluded writers that do not resolve one at all.
        //
        // `a-coverage-number-names-its-axis`, in a line I wrote myself. The
        // question this guard exists to answer is "how many producers of
        // recipient-addressed copy resolve the recipient's language", and only
        // the intersection answers it.
        const localisingProducers = producers.filter((f) =>
            fs.readFileSync(path.join(REPO, f), 'utf8').includes('translateFor'),
        );
        const unlocalised = producers.filter((f) => !localisingProducers.includes(f));
        console.log(
            `[notification-copy-localised] graded ${files.length} module(s): `
                + `${producers.length} write a Notification row, of which `
                + `${localisingProducers.length} resolve a recipient locale and `
                + `${unlocalised.length} do not`,
        );
        for (const f of unlocalised) {
            console.log(
                `[notification-copy-localised] no recipient locale: ${f}`
                    + `${f in DELIBERATELY_UNLOCALISED ? ' (deliberate)' : ''}`,
            );
        }
        console.log(
            `[notification-copy-localised] ${Object.keys(STILL_ENGLISH).length} exempt `
                + `(${Object.keys(STILL_ENGLISH).join(', ') || 'none'}); `
                + `${Object.keys(DELIBERATELY_UNLOCALISED).length} deliberately unlocalised; `
                + `${Object.keys(STAGED_UNLOCALISED).length} staged (#2511)`,
        );
        // A detector over an empty population would pass every assertion below.
        expect(files.length).toBeGreaterThanOrEqual(16);
        // And a FLOOR on the intersection, which the two independent counts
        // could not express: a writer losing its `translateFor` would have
        // moved one number and not the other, so neither had a floor that
        // meant anything.
        expect(producers.length).toBeGreaterThanOrEqual(16);
        // At the MEASURED value, so it ratchets: localising one more producer
        // raises this line in the same diff, and losing one goes red. 11 → 12
        // with the lease sweep (#2592), 12 → 14 with the contract-delivery
        // sweep and the field-operation review (the rest of #2511).
        expect(localisingProducers.length).toBeGreaterThanOrEqual(14);
    });

    it.each(Object.keys({ ...DELIBERATELY_UNLOCALISED, ...STAGED_UNLOCALISED }))(
        '%s is still unlocalised — the entry has not gone stale',
        (file) => {
            // Without this, a producer that GAINED a `translateFor` would keep
            // its exemption, and the map would rot into a permanent allowlist
            // — which is the one thing an exemption map must not become. Same
            // assertion `STILL_ENGLISH` carries, for the same reason.
            const src = fs.readFileSync(path.join(REPO, file), 'utf8');
            expect(src.includes('translateFor')).toBe(false);
        },
    );

    it('every unlocalised producer is a DELIBERATE one', () => {
        const producers = files.filter((f) =>
            WRITES_NOTIFICATION.test(fs.readFileSync(path.join(REPO, f), 'utf8')),
        );
        const unlocalised = producers
            .filter((f) => !fs.readFileSync(path.join(REPO, f), 'utf8').includes('translateFor'))
            .filter((f) => !(f in DELIBERATELY_UNLOCALISED) && !(f in STAGED_UNLOCALISED));

        if (unlocalised.length) {
            throw new Error(
                `${unlocalised.length} producer(s) of recipient-addressed copy resolve NO `
                    + `recipient locale:\n\n`
                    + unlocalised.map((f) => `    ${f}`).join('\n')
                    + `\n\nA notification is addressed to a PERSON, and four of five users on `
                    + `this deployment carry \`uiLanguage: 'bg'\`. Resolve the recipient's locale `
                    + `with \`translateFor(resolveRecipientLocale(user.uiLanguage), key)\` and put `
                    + `the copy in both catalogues.\n\n`
                    + `If the string genuinely must not be translated — a tenant-authored rule `
                    + `name, say — add it to DELIBERATELY_UNLOCALISED with the reason. The `
                    + `English-prose check above cannot see this: it only catches copy in the `
                    + `WRONG language, and a producer hardcoding BULGARIAN passes it while being `
                    + `just as wrong for an \`en\` recipient.`,
            );
        }
    });

    it.each(modules().filter((f) => !(f in STILL_ENGLISH)))(
        '%s holds no English copy prose',
        (file) => {
            const found = proseIn(fs.readFileSync(path.join(REPO, file), 'utf8'));
            expect(found).toEqual([]);
        },
    );

    // ONE test looping the map, not `it.each`. Jest THROWS on
    // `it.each([])` — "called with an empty Array of table data" — so the
    // `.each` form made an empty map a failing suite, and the map is
    // SUPPOSED to reach empty: that is what a discharged exemption looks
    // like. #2490 emptied it and this is the shape that survives it.
    //
    // The loop's assertions run `proseIn`, whose own behaviour is pinned by
    // the positive controls in the second describe below — so this cannot
    // pass by having a broken detector, only by having nothing to check.
    it('no exemption outlives its cause', () => {
        const entries = Object.entries(STILL_ENGLISH);
        console.log(
            `[notification-copy-localised] ${entries.length} staged exemption(s)` +
                `${entries.length === 0 ? ' — none outstanding' : `: ${entries.map(([f]) => f).join(', ')}`}`,
        );
        for (const [file, reason] of entries) {
            expect(reason.length).toBeGreaterThan(40);
            const found = proseIn(fs.readFileSync(path.join(REPO, file), 'utf8'));
            // If this fails, the file was FIXED — delete its STILL_ENGLISH
            // entry in the same diff. The exemption must not outlive its cause.
            expect(found.length).toBeGreaterThan(0);
        }
    });
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

    it('does not flag a ternary whose left side ENDS in a copy field name', () => {
        // `err.message : 'File upload failed'` is error copy reached through a
        // ternary, and it matched before the lookbehind landed.
        expect(
            proseIn(
                `codedBadRequest('X', err instanceof Error ? err.message : 'File upload failed');`,
            ),
        ).toEqual([]);
    });

    it('flags an English TEMPLATE literal title, interpolation and all', () => {
        // The shape that actually reached production, and that a single-quote
        // pattern could never see.
        expect(
            proseIn('const n = { title: `New interest in your ${listing.commodity} listing` };'),
        ).toEqual(['New interest in your ${listing.commodity} listing']);
    });

    it('does not flag a single word', () => {
        expect(proseIn(`const C = { title: 'Pending' };`)).toEqual([]);
    });
});
