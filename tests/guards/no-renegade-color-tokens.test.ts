/**
 * Every semantic colour class resolves to a token that EXISTS.
 *
 * ── the bug, twice ──
 *
 * `tests/guards/no-renegade-bg-tokens.test.ts` was written because
 * `bg-bg-surface` appeared at 5 callsites and `--bg-surface` did not exist:
 * Tailwind emitted nothing, and five surfaces silently took the browser
 * default. Its own docblock calls them "five surface bugs the user saw and we
 * didn't".
 *
 * That guard then locked exactly one prefix — `bg-bg-*`. So the identical
 * defect came back in a different one and grew to **108 callsites** before
 * anyone noticed:
 *
 *   text-content-secondary   95   (no `--content-secondary`; meant `muted`)
 *   text-content-danger       9   (no `--content-danger`;    meant `error`)
 *   text-content-strong       2   (no `--content-strong`;    meant `emphasis`)
 *   bg-surface-subtle         2   (there is no `surface` GROUP at all)
 *
 * Ninety-five uses of a class that painted nothing. A guard scoped to one
 * prefix is a guard that documents where the author had just been looking.
 *
 * ── why this reads the config instead of regexing CSS ──
 *
 * The old guard regexed `--bg-X:` out of `tokens.css` and then regexed a
 * `bg:\s*\{...\}` block out of `tailwind.config.js` to catch aliases. Two
 * parsers for one fact, and both silently yield an EMPTY set if the file's
 * formatting shifts — which would make the whole check pass over anything.
 *
 * `tailwind.config.js` is a JavaScript module, so this requires it and reads
 * the real object. Every colour GROUP and every token inside it is derived,
 * so adding a group (P2.2 adds bubble/presence/unread) extends the guard with
 * no edit here.
 *
 * ── what this does NOT catch, said plainly ──
 *
 * A class whose GROUP does not exist (`bg-surface-subtle`) cannot be found by
 * deriving from the config, because the config has nothing to compare against.
 * The general form — "every namespace must be one we know" — was measured and
 * rejected: Tailwind classes live inside string literals, so the scan cannot
 * strip strings, and `data-testid="rich-text-evidence-content-input"` then
 * reads as the namespace `evidence`. Thirty-eight namespaces appear that way
 * and only five are real.
 *
 * So the second arm is narrow and literal instead: `surface` is asserted never
 * to appear as a colour namespace. It is the one namespace this repo has
 * actually reached for twice and never had.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

/** Utilities that take a colour, and so can name a token. */
const COLOUR_UTILITIES = [
    'text', 'bg', 'border', 'ring', 'fill', 'stroke', 'divide',
    'outline', 'decoration', 'placeholder', 'accent', 'caret', 'shadow',
    'from', 'via', 'to',
] as const;

interface ColourTree {
    [group: string]: string | Record<string, unknown>;
}

/** The colour tree Tailwind actually compiles with. */
function colourTree(): ColourTree {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the config IS a CJS module; requiring it is the point
    const cfg = require(path.join(ROOT, 'tailwind.config.js'));
    const theme = cfg?.theme ?? {};
    return { ...(theme.colors ?? {}), ...(theme.extend?.colors ?? {}) };
}

/**
 * `boxShadow` names, which share the `shadow-` utility with colours.
 *
 * `shadow-canvas-recess` is a real class: Tailwind resolves `shadow-<name>`
 * against `theme.boxShadow` before it considers a colour, and this repo's
 * shadow names happen to begin with a colour GROUP name (`canvas-node`,
 * `canvas-recess`). Without this the guard flags a legitimate class — and a
 * guard that cries wolf is a guard that gets waived.
 */
function boxShadowNames(): Set<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- same CJS config
    const cfg = require(path.join(ROOT, 'tailwind.config.js'));
    return new Set(Object.keys(cfg?.theme?.extend?.boxShadow ?? {}));
}

/** group -> the token names defined under it. */
function definedTokens(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [group, value] of Object.entries(colourTree())) {
        if (value && typeof value === 'object') {
            out.set(group, new Set(Object.keys(value)));
        }
    }
    return out;
}

/**
 * `collectSourceFiles`, not a hand-rolled walk.
 *
 * The first version of this file walked `src/` with `readdirSync` and
 * `tests/guards/file-collection-is-not-silently-empty.test.ts` refused it —
 * correctly: a hand-rolled collector can be gutted to return `[]` with every
 * assertion built on it still green, measured at 81 percent of the guards an
 * automated sweep could audit. `floor` makes an empty result impossible rather
 * than merely unlikely. Second time this guard has corrected me today.
 */
function sourceFiles(): string[] {
    return collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 400 });
}

/** Comments stripped; strings are NOT, because classes live in them. */
function codeOf(raw: string): string {
    return blankNonCode(raw);
}

interface Offence {
    file: string;
    line: number;
    cls: string;
    why: string;
}

const UTIL_ALT = COLOUR_UTILITIES.join('|');

describe('no renegade colour tokens', () => {
    const groups = definedTokens();
    const shadows = boxShadowNames();
    const files = sourceFiles();

    it('the config is readable and the derivation is not empty', () => {
        // Both halves of the OLD guard degraded to an empty set on a
        // formatting change, and an empty set makes every later assertion
        // pass over everything. These are the floors that make the rest mean
        // something.
        expect(groups.size).toBeGreaterThanOrEqual(4);
        expect(groups.get('content')?.size ?? 0).toBeGreaterThanOrEqual(8);
        expect(groups.get('bg')?.size ?? 0).toBeGreaterThanOrEqual(10);
        expect(files.length).toBeGreaterThan(200);
        // The boxShadow exemption must not degrade to an empty set, or
        // `shadow-canvas-recess` starts failing again on a config reshuffle.
        expect(shadows.size).toBeGreaterThanOrEqual(4);
        expect(shadows.has('canvas-recess')).toBe(true);
    });

    it('CONTROL: the classes this guard was written for would be caught', () => {
        // The four real offenders, fed in directly. Without this the scan
        // could stop matching and the suite would still be green.
        const g = groups;
        const probe = (group: string, token: string): boolean =>
            g.has(group) && !g.get(group)!.has(token);
        expect(probe('content', 'secondary')).toBe(true);
        expect(probe('content', 'strong')).toBe(true);
        expect(probe('content', 'danger')).toBe(true);
        // And the defined ones they were remapped onto are NOT flagged.
        expect(probe('content', 'muted')).toBe(false);
        expect(probe('content', 'emphasis')).toBe(false);
        expect(probe('content', 'error')).toBe(false);
        expect(probe('bg', 'subtle')).toBe(false);
    });

    it('every <utility>-<group>-<token> names a token that exists', () => {
        const offenders: Offence[] = [];
        /**
         * Every class the scan RESOLVED, offending or not.
         *
         * `scripts/selector-teeth.mjs` found this gap: gutting `codeOf()` to
         * `return ''` made the guard read nothing from every file, so it found
         * no classes, so it found no offences, and it PASSED. The floors above
         * check the file count and the token groups — neither of which goes to
         * zero when the file CONTENTS vanish.
         *
         * So the population the assertion ranges over is counted and floored.
         * `text-content-muted` alone has over 900 uses after P2.2, so a floor
         * of 500 is far below the real figure and will not move on ordinary
         * feature work.
         */
        let resolved = 0;
        // `(?<![\w-])` lets a Tailwind modifier prefix through (`hover:`,
        // `md:`, `group-hover:`) while refusing a match mid-identifier.
        const re = new RegExp(
            `(?<![\\w-])(${UTIL_ALT})-([a-z][a-z0-9]*)-([a-z0-9][a-z0-9-]*?)(?:/\\d+)?(?![\\w-])`,
            'g',
        );
        for (const full of files) {
            const rel = path.relative(ROOT, full);
            const lines = codeOf(fs.readFileSync(full, 'utf-8')).split('\n');
            lines.forEach((line, i) => {
                for (const m of line.matchAll(re)) {
                    const [cls, , group, token] = m;
                    const defined = groups.get(group);
                    if (!defined) continue; // not one of ours — see the docblock
                    resolved++;
                    if (defined.has(token)) continue;
                    // `shadow-canvas-recess` names a boxShadow, not a colour.
                    if (cls.startsWith('shadow-') && shadows.has(`${group}-${token}`)) continue;
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        cls,
                        why: `--${group}-${token} is not defined; ${group} has: ${[...defined].sort().join(', ')}`,
                    });
                }
            });
        }
        // The denominator, asserted BEFORE the verdict — an empty scan must
        // never be able to report "no offences".
        expect(resolved).toBeGreaterThan(500);
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} colour class(es) name a token that does not exist. ` +
                    `Tailwind emits NOTHING for these, so the element silently takes the ` +
                    `browser default — 95 uses of one such class shipped before P2.2:\n` +
                    offenders
                        .map((o) => `  ${o.file}:${o.line} — ${o.cls}\n      ${o.why}`)
                        .join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('`surface` is never used as a colour namespace — there is no such group', () => {
        // The narrow second arm. `bg-surface-subtle` had a nonexistent GROUP,
        // which deriving from the config cannot catch. Anything reaching for a
        // surface tone means `bg-bg-*` (page chrome) or `bg-canvas-*` (the map
        // and diagram surfaces).
        const re = new RegExp(`(?<![\\w-])(${UTIL_ALT})-surface-[a-z0-9-]+`, 'g');
        const hits: string[] = [];
        for (const full of files) {
            const rel = path.relative(ROOT, full);
            codeOf(fs.readFileSync(full, 'utf-8'))
                .split('\n')
                .forEach((line, i) => {
                    for (const m of line.matchAll(re)) hits.push(`${rel}:${i + 1} — ${m[0]}`);
                });
        }
        expect(groups.has('surface')).toBe(false); // the premise
        expect(hits).toEqual([]);
    });
});
