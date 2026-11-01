/**
 * Every `rule N` cited by assistant-memory code resolves to a written rule.
 *
 * ## Why this exists
 *
 * Six comments in MERGED code — `prisma/schema/ai.prisma`,
 * `assistant-memory.ts`, the `[id]` route — cited "rule 2", "rule 3", "rule 6"
 * and so on, and the list they pointed at existed in NO FILE. It had been
 * decided in a conversation, summarised, and lost; the PR body credited an
 * external project that publishes no such numbering. Nothing failed, because a
 * comment citing a number is not checkable by any tool that reads types.
 *
 * It was found only when the next phase needed the rules in order to implement
 * them, and two of the nine were unrecoverable by then.
 *
 * So the guard is not "are the rules good" — it is the narrower, checkable
 * question: **does every citation have a referent, and does every rule have a
 * number somebody can cite?** Both directions, because each alone rots:
 *
 *   · a citation with no rule is the defect above;
 *   · a rule nobody cites is a rule the code may have quietly stopped
 *     honouring, which is worth a reading rather than a failure.
 */
import fs from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const DOC = 'docs/assistant-memory-rules.md';
const EXPECTED_RULE_COUNT = 9;

/**
 * The citing population, DERIVED rather than listed.
 *
 * It was a hand-written list of four paths with its own walk, which
 * `file-collection-is-not-silently-empty` (#865) correctly refused: that walk
 * returned `[]` for a root that had been renamed, so the dangling-citation
 * assertion would have passed over nothing. `collectSourceFiles` throws on a
 * missing root and on a result under `floor`.
 *
 * Deriving it also widened the population for free: any NEW file named
 * `assistant-memory*` under these roots is covered the moment it exists, which
 * matters because the extraction job is the next thing to cite these rules.
 */
function citingFiles(): string[] {
    return collectSourceFiles({
        roots: ['prisma/schema', 'src/app-layer', 'src/app/api/account', 'src/lib/schemas'],
        extensions: ['.ts', '.prisma'],
        // REPLACES the default, which drops `dist` and `coverage` BY NAME and
        // would hide a real path under `src` — the helper's own warning.
        skipDirs: ['node_modules', '.next', '.git'],
        // Grouped explicitly. `/a|b$/` binds the `$` to the SECOND alternative
        // only, which is what is wanted here — "contains assistant-memory" OR
        // "ends with /ai.prisma" — but precedence that has to be reasoned out
        // is precedence somebody will get wrong, and CodeQL flags it
        // (js/regex/missing-regexp-anchor) for that reason.
        exclude: (rel) => !/(?:assistant-memory)|(?:[/\\]ai\.prisma$)/.test(rel),
        floor: 4,
    });
}

/**
 * Read a file, or `''` if it is not one.
 *
 * Attempted directly rather than `existsSync` + `statSync` + read, which is a
 * TOCTOU race CodeQL flags as `js/file-system-race`: the three calls can
 * disagree, and in this repo that is not hypothetical — the selector-teeth
 * mutation runner edits files while suites read them.
 *
 * The empty string cannot turn into a silent pass. `declaredRules()` asserts
 * exactly 1-9, so an unreadable doc fails rather than reporting no rules, and
 * `citingFiles()` carries a floor.
 */
function readIfFile(p: string): string {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return '';
    }
}

/** `### 4. Latest wins.` -> 4 */
function declaredRules(): number[] {
    const body = readIfFile(path.join(REPO_ROOT, DOC));
    const nums = [...body.matchAll(/^###\s+(\d+)\.\s+\S/gm)].map((m) => Number(m[1]));
    return [...new Set(nums)].sort((a, b) => a - b);
}

/** Every `rule N` / `rules N and M` citation, with the file it sits in. */
function citations(): { file: string; rule: number }[] {
    const out: { file: string; rule: number }[] = [];
    for (const abs of citingFiles()) {
        const rel = path.relative(REPO_ROOT, abs);
        const text = readIfFile(abs);
        // `rule 6`, `rules 4 and 5` — two passes, because the second form puts
        // its second number out of reach of one anchored regex.
        for (const m of text.matchAll(/\brules?\s+(\d+)/gi)) out.push({ file: rel, rule: Number(m[1]) });
        for (const m of text.matchAll(/\brules\s+\d+\s*(?:and|,)\s*(\d+)/gi)) {
            out.push({ file: rel, rule: Number(m[1]) });
        }
    }
    return out;
}

describe('the nine assistant-memory rules have a written referent', () => {
    it('the doc exists and declares exactly nine numbered rules', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, DOC))).toBe(true);
        const rules = declaredRules();
        console.log(`[memory-rules] declared=${rules.length} (${rules.join(',')}) in ${DOC}`);
        expect(rules).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(rules).toHaveLength(EXPECTED_RULE_COUNT);
    });

    it('every `rule N` cited in code resolves to a declared rule', () => {
        const declared = new Set(declaredRules());
        const cited = citations();

        // A floor, because an extraction that stopped matching would pass this
        // over an empty set — the failure mode this repo keeps paying for.
        console.log(`[memory-rules] citations=${cited.length} across ${new Set(cited.map((c) => c.file)).size} file(s)`);
        expect(cited.length).toBeGreaterThanOrEqual(6);

        const dangling = cited.filter((c) => !declared.has(c.rule));
        expect(
            dangling.map((d) => `${d.file} cites rule ${d.rule}, which ${DOC} does not declare`),
        ).toEqual([]);
    });

    it('prints which declared rules nothing cites — a READING, not a gate', () => {
        const cited = new Set(citations().map((c) => c.rule));
        const uncited = declaredRules().filter((n) => !cited.has(n));
        console.log(
            `[memory-rules] uncited=${uncited.length ? uncited.join(',') : 'none'}` +
                ' (a rule nothing cites may be one the code stopped honouring)',
        );
        // Deliberately not asserted: rules 1 and 9 are intent and configuration
        // rather than a column, so they may legitimately have no inline citation.
        expect(Array.isArray(uncited)).toBe(true);
    });

    it('the false attribution is gone from tracked files', () => {
        // The schema credited an external project for a numbering it does not
        // publish. Keeping the correction is the point — the doc explains it —
        // but no tracked file may make the CLAIM again.
        for (const rel of ['prisma/schema/ai.prisma']) {
            const text = readIfFile(path.join(REPO_ROOT, rel));
            expect(text).not.toMatch(/rules borrowed from akitaonrails/i);
        }
    });
});
