/**
 * Guard: a local comment stripper does not run BLOCK comments before LINE
 * comments (#1442 / #1497), on a shrink-only ratchet.
 *
 * ## The defect
 *
 * A stripper shaped like this is wrong, and 61 files in `tests/` carried it:
 *
 *     src.replace(BLOCK_RE, '').replace(LINE_RE, '')   // blocks FIRST
 *
 * A line comment that CONTAINS a block-open is ordinary in this repo — nine
 * files under `src/` have one, always an innocuous comment naming a glob such
 * as `/api/auth/` or `messages/` followed by a star. With blocks stripped
 * first, that opens a block as far as a regex is concerned and the match runs
 * to the next block-close marker, deleting every real line in between.
 *
 * Measured on the live tree: the wrong order kept **130 of
 * `src/middleware.ts`'s 326** non-blank code lines and **433 of `src/auth.ts`'s
 * 551** — 511 lines across the nine files. A guard scanning past 40% of a file
 * and reporting clean.
 *
 * The fix is `blankNonCode` from `tests/helpers/blank-non-code.ts`, a
 * state-aware scanner that cannot be fooled by either nesting and blanks
 * character-for-character so `^`-anchored patterns keep their positions.
 *
 * ## The ratchet reached its floor, and the floor is 2
 *
 * It began as a cap of 61 because that was too many to convert at once, and
 * most were latent — the defect only fires when a trigger lands in a file the
 * guard scans. All 61 are now converted, so the cap is 2.
 *
 * The residue is not work left undone. Those two strip comments from **CSS**
 * (`globals.css` and the generated design tokens), where the block form is the
 * only comment syntax and `blankNonCode` — a TS/JS scanner — is the wrong
 * tool. `NOT_TYPESCRIPT` names them with a per-file reason, and the suite
 * requires the set to be EXACTLY those files, so the effective cap for a
 * TypeScript stripper is 0.
 *
 * ## What the conversion changed, which is not nothing
 *
 * `blankNonCode` is not equivalent to the strippers it replaced, and the
 * differences run in BOTH directions. Measured over the 2106 files under
 * `src/`, against the two dominant shapes:
 *
 *   - `/\/\/[^\n]*\/g`        differs on 405 files   (the `*` + `/` here is
 *     escaped because an unescaped one TERMINATES this very docblock)
 *   - `/^[ \t]*\/\/.*$/gm`   differs on 201 files
 *
 * Two causes, each a case of the local stripper being WRONG:
 *
 *   1. A TRAILING `// comment` on a code line. The line-anchored shape only
 *      matches at line start, so it kept those; `blankNonCode` removes them.
 *      Blanking therefore removes MORE, and an "offence" that was only ever
 *      comment text stops being reported.
 *   2. A comment-like sequence INSIDE a string. `src/app/api/docs/route.ts`
 *      has a `/* … *\/` in a CSS block inside an HTML template literal; the
 *      block regex ate it, `blankNonCode` correctly keeps string content.
 *      Blanking therefore removes LESS, and such text becomes visible to a
 *      scanner for the first time.
 *
 * Line numbers also move, and in the right direction: deleting a comment
 * removes its newlines, so every line computed from the stripped text shifts
 * EARLIER. Blanking preserves them. 22 of the 26 files in one guard's corpus
 * were reporting a shifted line, worst −101 (`EntityDetailLayout.tsx`). The
 * migration FIXES those pointers rather than disturbing them — the opposite of
 * what the issue originally argued.
 *
 * ## The discriminator needed its own control, and that is the real lesson
 *
 * Two attempts at this classification returned confident wrong answers before
 * one worked, and both failures were the same shape: a detector with no
 * discriminating power.
 *
 *   1. A 900-character window from the declaration ended BEFORE the regexes in
 *      any stripper carrying a long explanatory comment — including the one
 *      file whose answer was known.
 *   2. Searching for the three characters `/` `\` `/` as the line-comment
 *      marker. A block-open regex literal BEGINS with those three characters,
 *      so every block regex matched as a line regex too and the comparison
 *      decided nothing. It reported 1 offender where there are 61.
 *
 * Hence `DISCRIMINATOR_SAMPLES`: before counting anything, this suite proves
 * the two patterns tell the known shapes apart in both directions. A count
 * from an untested classifier is not a measurement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';

const REPO = process.cwd();

/**
 * The four characters each regex literal must contain.
 *
 * A block-open is written `\/\*` in a regex literal and a line-open `\/\/`.
 * Matching fewer characters than four is what broke attempt (2) above: `/\/`
 * occurs at the START of a block literal as its own delimiter plus the first
 * escaped slash.
 */
const BLOCK_OPEN = /\\\/\\\*/;
const LINE_OPEN = /\\\/\\\//;

/**
 * A stripping `.replace(/…/)` call, found by SHAPE rather than by the NAME of
 * whatever declares it.
 *
 * This replaced a four-name pattern — `stripComments|stripped|withoutComments|
 * decomment` — and #1605 is why it had to go. A stripper in
 * `social-routes-flag-gated` is called `codeOf`, four lines long and exactly
 * the wrong order, and this ratchet could not see it while reporting 2 against
 * a cap of 2 with a drift sentinel confirming no slack. A reader had every
 * reason to believe the class was closed.
 *
 * Measured on the clean tree when the scan was widened: 61 strippers inside the
 * name-based population (all converted by #1588), **31 outside it**, of which
 * 29 were block-first and real. The name list was never derived from anything;
 * this is, so "what is a comment stripper called in this repo" stops being a
 * question whose answer matters.
 */
const STRIPPING_REPLACE = /\.replace\(\s*\//;

/**
 * Lines that LOOK like a stripper and are test DATA.
 *
 * `DISCRIMINATOR_SAMPLES` below holds the shapes verbatim, so a shape-based
 * scan counts this file's own fixtures without this guard. The first run of the
 * widened scan reported this file as an offender.
 */
const IS_FIXTURE = /String\.raw|expect:/;

/** Known shapes with known answers, both polarities. */
const DISCRIMINATOR_SAMPLES: Array<{ expect: 'BLOCK' | 'LINE'; src: string }> = [
    { expect: 'BLOCK', src: String.raw`.replace(/\/\*[\s\S]*?\*\//g, '')` },
    { expect: 'BLOCK', src: String.raw`.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')` },
    { expect: 'LINE', src: String.raw`.replace(/^[ \t]*\/\/.*$/gm, '')` },
    { expect: 'LINE', src: String.raw`.replace(/\/\/[^\n]*/g, '')` },
    { expect: 'LINE', src: String.raw`.map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))` },
];

function classifyLine(line: string): 'BLOCK' | 'LINE' | null {
    const b = line.match(BLOCK_OPEN);
    const l = line.match(LINE_OPEN);
    if (b && l) return (b.index ?? 0) < (l.index ?? 0) ? 'BLOCK' : 'LINE';
    if (b) return 'BLOCK';
    if (l) return 'LINE';
    return null;
}

/**
 * Which marker a file's first stripping `.replace` reaches for, or null if the
 * file has none.
 *
 * ORDER, and nothing else. An earlier attempt of mine to size the unnamed
 * population looked for a block strip with a line strip *within eight lines* —
 * PROXIMITY — and was wrong in both directions: it called two line-first
 * strippers offenders and missed eight whose two strips sit further apart. A
 * threshold I invented measured my guess rather than the subject.
 *
 * Walks the whole file rather than a window from a declaration, for the same
 * reason: the 900-character window in this guard's own history ended before the
 * regexes in any stripper carrying a long explanatory comment.
 */
function firstMarker(src: string): 'BLOCK' | 'LINE' | null {
    for (const line of src.split('\n')) {
        if (IS_FIXTURE.test(line)) continue;
        if (!STRIPPING_REPLACE.test(line)) continue;
        const v = classifyLine(line);
        if (v) return v;
    }
    return null;
}

/**
 * 6 block-first strippers today — 61 at the start of #1497, 2 after #1588
 * converted the named population, 6 once #1605 widened the scan to find the
 * 31 it could not see. Measured by this suite on a clean tree.
 *
 * LOWER this when you convert one; never raise it. A new stripper with the
 * wrong order is what the cap exists to refuse.
 *
 * It cannot reach 0, and the reason is that not every corpus is TypeScript —
 * see `NOT_TYPESCRIPT` below. The effective cap for a stripper over TS/TSX
 * source is 0.
 */
const BLOCK_FIRST_CAP = 6;

/**
 * The survivors, and why converting each would be WRONG.
 *
 * `blankNonCode` is a TypeScript/JavaScript scanner. Pointed at another
 * language it does not merely fail to help — it mis-reads that language's
 * strings and comment syntax, which is worse than the block-first ordering it
 * would replace.
 *
 * Pinned by IDENTITY as well as by count, because a bare cap of 6 would let a
 * seventh block-first TS stripper land in slack vacated by one of these.
 * Requiring the set to be EXACTLY these files makes the cap for a TypeScript
 * stripper 0.
 */
const NOT_TYPESCRIPT: Readonly<Record<string, string>> = {
    // ── CSS: the block form is the ONLY comment syntax there ──
    //
    // `//` is not a comment in CSS, so there is no line pass to order wrongly,
    // and a TS scanner would mis-read `url(…)` and quoted font names.
    'tests/guards/animation-vocabulary.test.ts':
        'reads src/app/globals.css to check a retired keyframe is gone',
    'tests/guards/r22-prb-border-and-focus.test.ts':
        'reads the generated design tokens',
    'tests/guards/tokens-generated-in-sync.test.ts':
        'iterates cssFiles comparing colour declarations against the canonical '
        + 'tokens.css — 757 lines of prose carrying token names and hex values, '
        + 'which is why it strips comments at all',
    'tests/unit/fonts/vendored-font-integrity.test.ts':
        'strips comments from the vendored font CSS before reading @font-face rules',

    // ── SQL: a different comment syntax again ──
    //
    // Strips `--` as well as `/* */`, and `--` is not a comment in
    // TypeScript at all. `blankNonCode` would leave every SQL line comment in
    // place, which for a migration-safety guard means reading commented-out
    // DDL as real DDL.
    'tests/guardrails/ag-ledger-migration-safety.test.ts':
        'strips SQL comments (-- and /* */) from migration files',

    // ── Not a comment stripper at all ──
    //
    // `/\/\*\*|\*\/|\*/g` removes JSDoc MARKERS so the prose inside can be
    // read. The opposite purpose: it un-comments rather than strips, and
    // `blankNonCode` would blank exactly the text it exists to examine. It
    // matches the shape scan because a marker and a block-open share
    // characters, which is the cost of keying on shape and cheaper than
    // keying on a name.
    'tests/guards/nav-item-geometry-discipline.test.ts':
        'strips JSDoc markers to READ the doc prose, not to remove it',
};

/** A cap far above reality has stopped ratcheting. */
const DRIFT_ALLOWANCE = 3;

describe('a local comment stripper strips LINE comments first (#1497)', () => {
    const files = collectSourceFiles({
        roots: ['tests'],
        extensions: ['.ts', '.tsx'],
        // ~1200 at the time of writing; a floor well below it separates
        // "nothing is wrong" from "nothing was examined".
        floor: 600,
    });

    // The population is every file with a stripping `.replace`, derived from
    // the SHAPE. It used to be filtered by `DECL.test(...)` — the four-name
    // pattern — which is precisely the narrowing #1605 removed: a file whose
    // stripper is called something else was dropped here before it could be
    // counted.
    const classified = files
        .map((full) => ({ file: relative(REPO, full), first: firstMarker(readFileSync(full, 'utf8')) }))
        .filter((r) => r.first !== null);

    const blockFirst = classified.filter((r) => r.first === 'BLOCK');
    const lineFirst = classified.filter((r) => r.first === 'LINE');
    const unreadable = classified.filter((r) => r.first === null);

    it('the discriminator tells the two markers apart — the control it needs', () => {
        // Without this the counts below are produced by an untested
        // classifier, which is how the first two attempts at this guard
        // reported 1 offender where there are 61.
        for (const { expect: want, src } of DISCRIMINATOR_SAMPLES) {
            expect(classifyLine(src)).toBe(want);
        }
        // And neither pattern matches a line carrying no regex at all.
        expect(classifyLine("const x = 'plain string';")).toBeNull();
    });

    it('ranges over a real population — the denominator', () => {
        // The CORPUS floor is the "did we look" check, and it is the one that
        // must stay large: it catches an exclude predicate or a scan root that
        // ate the tree rather than reporting it clean.
        expect(files.length).toBeGreaterThan(600);

        // The STRIPPER count is deliberately NOT floored near its old value.
        // It read `> 50`, which was right when 61 existed and became wrong the
        // moment the conversions succeeded — a floor set to yesterday's
        // population fails on the work going well. 15 remain (6 block-first,
        // 9 line-first); it floors at the allowlist size because below that
        // the identity assertion below could not hold, and anything more
        // specific would have to be edited every time a stripper is converted.
        expect(classified.length).toBeGreaterThanOrEqual(
            Object.keys(NOT_TYPESCRIPT).length,
        );

        // A known answer per polarity, so a classifier that has gone blind in
        // one direction fails here rather than reporting a clean tree.
        expect(
            classified.find((r) => r.file.endsWith('schemas-barrel-has-no-orphans.test.ts'))?.first,
        ).toBe('LINE');
        // `date-input-rollout.test.ts` was the BLOCK example until #1497
        // converted it. The anchor has to be a file that is STILL block-first,
        // and the only ones left are the non-TypeScript corpora in
        // `NOT_TYPESCRIPT` — which is also why this assertion and that list
        // must not drift apart.
        expect(
            classified.find((r) => r.file.endsWith('animation-vocabulary.test.ts'))?.first,
        ).toBe('BLOCK');
        expect(Object.keys(NOT_TYPESCRIPT)).toContain('tests/guards/animation-vocabulary.test.ts');
    });

    it('prints what it found — all three numbers, not just the one that fails', () => {
        // A bare offender count hides whether the population moved. Stated
        // unconditionally so a reader of a GREEN run can see the denominator.
        expect(blockFirst.length + lineFirst.length + unreadable.length).toBe(classified.length);
        expect(classified.length).toBeGreaterThanOrEqual(blockFirst.length);
    });

    it('no NEW block-first stripper — the cap', () => {
        if (blockFirst.length > BLOCK_FIRST_CAP) {
            throw new Error(
                `${blockFirst.length} block-first comment strippers, cap ${BLOCK_FIRST_CAP}.\n\n` +
                    blockFirst.map((r) => `    ${r.file}`).join('\n') +
                    `\n\nStripping BLOCK comments before LINE comments deletes real code: a ` +
                    `line comment containing a block-open (nine files under src/ have one, ` +
                    `each naming a glob) opens a block that runs to the next close marker.\n\n` +
                    `Measured: the wrong order kept 130 of src/middleware.ts's 326 non-blank ` +
                    `code lines.\n\n` +
                    `Use \`blankNonCode\` from tests/helpers/blank-non-code.ts. Do NOT raise ` +
                    `this cap to make a new stripper fit.`,
            );
        }
    });

    it('the only block-first strippers left are the non-TypeScript corpora', () => {
        // The count alone is not enough. With a cap of 6 and no identity
        // check, converting one of these and adding a block-first TypeScript
        // stripper would both pass — so this pins WHICH files may be in the
        // set, making the effective cap for a TS stripper 0.
        //
        // And every entry carries a REASON, because an entry without one is
        // indistinguishable from an omission — the failure the sibling
        // `GLOBAL_BY_DESIGN_MODELS` list in rls-coverage exists to prevent.
        expect(blockFirst.map((r) => r.file).sort()).toEqual(Object.keys(NOT_TYPESCRIPT).sort());
    });

    it('every NOT_TYPESCRIPT entry says WHY, and names a real file', () => {
        const problems: string[] = [];
        for (const [file, reason] of Object.entries(NOT_TYPESCRIPT)) {
            if (!reason || reason.trim().length < 30) problems.push(`${file} — reason too thin`);
            if (!existsSync(join(REPO, file))) problems.push(`${file} — file does not exist`);
        }
        expect(problems).toEqual([]);
    });

    it('the cap tracks reality — no accumulated slack', () => {
        const gap = BLOCK_FIRST_CAP - blockFirst.length;
        if (gap > DRIFT_ALLOWANCE) {
            throw new Error(
                `ratchet has slack: ${blockFirst.length} block-first strippers but the cap is ` +
                    `${BLOCK_FIRST_CAP} (gap ${gap}, max ${DRIFT_ALLOWANCE}).\n\n` +
                    `Lower BLOCK_FIRST_CAP to ${blockFirst.length} so the gap cannot be spent ` +
                    `by a later regression.`,
            );
        }
    });
});
