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

const REPO = path.resolve(__dirname, '../..');
const DOC = 'docs/assistant-memory-rules.md';

/** Files that may cite a rule. Derived, not listed — see §2. */
const CITING_ROOTS = [
    'prisma/schema/ai.prisma',
    'src/app-layer/usecases/assistant-memory.ts',
    'src/app/api/account/assistant-memory',
    'src/lib/schemas/assistant-memory-limits.ts',
];

const EXPECTED_RULE_COUNT = 9;

function readIfFile(p: string): string {
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : '';
}

function filesUnder(rel: string): string[] {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [rel];
    return fs
        .readdirSync(abs, { withFileTypes: true, recursive: true })
        .filter((d) => d.isFile())
        .map((d) => path.relative(REPO, path.join(d.parentPath ?? abs, d.name)));
}

/** `### 4. Latest wins.` -> 4 */
function declaredRules(): number[] {
    const body = readIfFile(path.join(REPO, DOC));
    const nums = [...body.matchAll(/^###\s+(\d+)\.\s+\S/gm)].map((m) => Number(m[1]));
    return [...new Set(nums)].sort((a, b) => a - b);
}

/** Every `rule N` / `rules N and M` citation, with the file it sits in. */
function citations(): { file: string; rule: number }[] {
    const out: { file: string; rule: number }[] = [];
    for (const root of CITING_ROOTS) {
        for (const rel of filesUnder(root)) {
            const text = readIfFile(path.join(REPO, rel));
            // `rule 6`, `rules 4 and 5`, `rules 4\n * and 5` — the second form
            // is why this is two passes rather than one anchored regex.
            for (const m of text.matchAll(/\brules?\s+(\d+)/gi)) out.push({ file: rel, rule: Number(m[1]) });
            for (const m of text.matchAll(/\brules\s+\d+\s*(?:and|,)\s*(\d+)/gi)) {
                out.push({ file: rel, rule: Number(m[1]) });
            }
        }
    }
    return out;
}

describe('the nine assistant-memory rules have a written referent', () => {
    it('the doc exists and declares exactly nine numbered rules', () => {
        expect(fs.existsSync(path.join(REPO, DOC))).toBe(true);
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
            const text = readIfFile(path.join(REPO, rel));
            expect(text).not.toMatch(/rules borrowed from akitaonrails/i);
        }
    });
});
