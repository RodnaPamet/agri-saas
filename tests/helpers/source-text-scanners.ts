/**
 * Find the guards that grep SOURCE TEXT for a code pattern without first
 * routing it through `blankNonCode` (#1774).
 *
 * ## The failure this locates
 *
 * A guard that matches a code pattern against raw file text cannot tell the
 * pattern from a DISCUSSION of the pattern, and the mistake runs both ways:
 *
 *   • prose inflates a count — a docblock sentence reading "compares the two:
 *     any farm the database grants" pushed `no-explicit-any-ratchet` from 131
 *     to 132 and reddened three shards (#1773);
 *   • prose fakes a presence — `api-error-wrapper-coverage` read a
 *     deliberately bare webhook as wrapped because its docblock NAMED the
 *     wrapper, and then skipped the very assertion that would have demanded a
 *     written exemption. A genuinely unprotected route could hide behind a
 *     comment.
 *
 * The second is the one worth fearing: the guard does not merely miscount, it
 * stops covering the file.
 *
 * ## What counts as at risk, and what deliberately does not
 *
 * Three conditions, all required:
 *
 *   1. the file reads source text (`readFileSync` / `collectSourceFiles`);
 *   2. it matches a CODE-SHAPED literal — camelCase, SCREAMING_CASE, a call
 *      with `(`, a JSX open — against that text. A plain English word is
 *      excluded, because a guard searching for the word "deprecated" is
 *      asking about prose on purpose;
 *   3. the receiver is file CONTENT, not a PATH. `p.includes('.tsx')` filters
 *      a filename and no amount of comment blanking changes it. Skipping
 *      path receivers is what takes this from 452 files of noise to a list a
 *      person can act on.
 *
 * Deliberately NOT a judgement about whether the guard is wrong today. It is
 * a list of guards whose answer DEPENDS on prose, which is the property
 * #1774 asks to remove.
 */
import { readFileSync } from 'node:fs';

import { blankNonCode } from './blank-non-code';
import { collectSourceFiles, REPO_ROOT } from './collect-files';

/** Roots that hold guards. Every one must resolve — `collectSourceFiles` throws otherwise. */
export const GUARD_ROOTS = [
    'tests/guards',
    'tests/guardrails',
    'tests/contracts',
    'tests/unit',
    'tests/regression',
] as const;

/**
 * A receiver that holds file CONTENT. Anything else is treated as a path and
 * ignored — the conservative direction, since a missed content scanner shows
 * up as a guard still reading prose, while a misclassified path receiver
 * would add permanent noise nobody can clear.
 */
const CONTENT_RECEIVER = /^(content|contents|src|code|text|body|raw|source|sourceText|fileContent)$/i;

/** camelCase, SCREAMING_CASE, a call, or a JSX open — never an English word. */
const CODE_SHAPED = /[a-z][A-Z]|[A-Z][a-z]+[A-Z]|^[A-Z][A-Z0-9_]{2,}$|\(|^<[A-Za-z]|_/;

const MATCHER = /(\w+)\s*\.\s*(?:includes|indexOf|match|matchAll|search)\(\s*['"]([^'"\n]{4,70})['"]/g;

export interface Scanner {
    /** Repo-relative path of the guard. */
    file: string;
    /** The code-shaped literals it matches against file content. */
    patterns: string[];
}

function codeShaped(pattern: string): boolean {
    // A sentence is prose by construction, whatever else it contains.
    if (/\s/.test(pattern.trim())) return false;
    // A bare path or extension is a filename test, not a code pattern.
    if (/^[./]?[\w./[\]-]+\.(ts|tsx|js|json|yml|yaml|sql|prisma|css|md)$/.test(pattern)) return false;
    if (/^(src|tests|scripts|prisma|public)\/$/.test(pattern)) return false;
    return CODE_SHAPED.test(pattern);
}

/**
 * Every guard that greps source content for a code pattern without blanking.
 *
 * Sorted by path so the output is stable across machines — an unsorted set
 * would make the exact-match assertion in the rail fail on filesystem order.
 */
export function findSourceTextScanners(): Scanner[] {
    const files = collectSourceFiles({
        roots: GUARD_ROOTS,
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx'),
        floor: 300,
    });

    const out: Scanner[] = [];
    for (const abs of files) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('readFileSync') && !raw.includes('collectSourceFiles')) continue;
        if (raw.includes('blankNonCode')) continue;

        // Dogfooding: blank the GUARD's own comments before reading its
        // patterns. Without this, a docblock explaining `.includes('logEvent')`
        // — the one in this very file, for instance — would be collected as a
        // live pattern. The bug being guarded against, committed by the guard.
        const code = blankNonCode(raw);

        const patterns = new Set<string>();
        for (const m of code.matchAll(MATCHER)) {
            const [, receiver, pattern] = m;
            if (!CONTENT_RECEIVER.test(receiver)) continue;
            if (!codeShaped(pattern)) continue;
            patterns.add(pattern);
        }
        if (patterns.size) {
            out.push({ file: abs.slice(REPO_ROOT.length + 1), patterns: [...patterns].sort() });
        }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
}
