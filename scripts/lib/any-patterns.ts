/**
 * The `any`-debt patterns, and the one place that counts them.
 *
 * Held once, for the reason `scripts/lib/api-routes.ts` is held once: two
 * copies of a selection rule is how two answers diverge. Before this module
 * there were three copies of the `as any` regex —
 * `tests/guards/no-explicit-any-ratchet.test.ts`, `scripts/count-any.js`, and
 * `tests/guardrails/no-explicit-any-ratchet.test.ts` — and they did not agree.
 *
 * ## The disagreement, and what it cost (#1526)
 *
 * The guard and the script both spelled it `/as\s+any\b/` — trailing `\b`, **no
 * leading one**. The guardrail spelled it `/\bas\s+any\b/`. Only one of those
 * can be right, and the enforcing copy was the wrong one.
 *
 * Without a leading boundary the match runs into the preceding word, so the
 * ordinary English words **"has any"** count as an explicit-any cast:
 *
 *     "One entry per overhead category that has any history"
 *                                          h|as any|
 *
 * That docblock pushed `src/` from 18 to 19 against a cap of 18 and reddened
 * `Test (shard 5/6)` on #1523 — a prose edit failing a type-debt ratchet, with
 * no mention of `as any` anywhere in the sentence. Two such hits were already
 * on main (`src/lib/grain/allocate.ts`, `src/components/ui/filter/filter-state.ts`),
 * silently consuming the cap. Any word ending in `as` works: `has`, `was`,
 * `alias`, `whereas`.
 *
 * This is NOT the same thing as the deliberate decision to count comment
 * mentions. The guard's own cap comment says it counts prose that names the
 * pattern, and that is defensible — a comment saying `as any` is evidence the
 * cast was there. "has any history" names nothing; the match is an artefact of
 * a missing boundary.
 *
 * ## Why the counting lives here too
 *
 * The guard and the script each had their own `walk` and their own accumulate
 * loop. The guard's docblock told a reader to run the script to get the number
 * to re-floor the caps with — so the script's answer had to equal the gate's,
 * and nothing enforced it. Now there is one `countAll`, so the number a human
 * reads and the number CI enforces cannot drift apart.
 *
 * `: any` keeps NO leading boundary on purpose: `:` is not a word character,
 * so there is no preceding word for it to run into, and a leading `\b` would
 * change what it matches rather than fix anything.
 *
 * @module scripts/lib/any-patterns
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AnyPattern {
    label: string;
    regex: RegExp;
}

/**
 * Every pattern is `g`, and `countAll` resets `lastIndex` before each use —
 * a shared global regex carries state between files otherwise, and the
 * undercount would be silent and load-dependent.
 */
export const ANY_PATTERNS: readonly AnyPattern[] = [
    { label: ': any', regex: /:\s*any\b/g },
    { label: '<any>', regex: /<any>/g },
    { label: 'useState<any>', regex: /useState<any>/g },
    // BOTH boundaries. See the module docblock — the leading one is the fix.
    { label: 'as any', regex: /\bas\s+any\b/g },
    { label: '// @ts-ignore', regex: /\/\/\s*@ts-ignore/g },
];

export const SRC_DIR = path.resolve(__dirname, '../../src');

/** Every `.ts`/`.tsx` file under `src/`, the population both callers count. */
export function walkSrc(dir: string = SRC_DIR): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            out.push(...walkSrc(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

export interface AnyCounts {
    totals: Record<string, number>;
    /** The denominator. A count without it cannot tell zero from "found no files". */
    filesScanned: number;
}

export function countAll(dir: string = SRC_DIR): AnyCounts {
    const totals: Record<string, number> = {};
    for (const { label } of ANY_PATTERNS) totals[label] = 0;

    const files = walkSrc(dir);
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const { label, regex } of ANY_PATTERNS) {
            regex.lastIndex = 0;
            const matches = content.match(regex);
            totals[label] += matches ? matches.length : 0;
        }
    }

    return { totals, filesScanned: files.length };
}
