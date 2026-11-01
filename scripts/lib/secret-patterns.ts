/**
 * The ONE translation from `.secret-patterns` to a JS `RegExp` — #2586.
 *
 * `.secret-patterns` is this repo's single source of truth for secret
 * detection (Epic C.2). Three things read it:
 *
 *   1. `scripts/detect-secrets.sh` — the pre-commit hook. Hands the patterns
 *      to `grep -P`, which speaks PCRE, so it needs no translation and is NOT
 *      a consumer of this module.
 *   2. `tests/guardrails/no-secrets.test.ts` — the CI guardrail.
 *   3. `scripts/generate-secret-patterns.ts` — which bundles them into
 *      `src/lib/security/generated/secret-patterns.ts` for the server, because
 *      the pattern FILE does not reach the runtime image.
 *
 * Consumers 2 and 3 need the same PCRE→RegExp answer, and until #2586 each had
 * its own: this module (added by #2584) and `loadPatterns` inline in the
 * guardrail. Two copies of a selection rule is how two answers diverge — the
 * reason `scripts/lib/api-routes.ts` is shared by the route generator and five
 * guards, and `scripts/lib/coverage-groups.mjs` is held once for the coverage
 * checker and the differ.
 *
 * ## The two copies did NOT agree, and the older one failed confusingly
 *
 * `loadPatterns` handled a LEADING `(?i)` and left a mid-pattern one sitting in
 * the body. JavaScript has no inline modifiers, so `new RegExp('a(?i)b')`
 * throws — and it threw at MODULE LOAD, because the guardrail's pattern list
 * was a module-level `const`. So the C.2 guardrail would have failed with a
 * message about an invalid group, when what actually happened is that somebody
 * wrote a pattern whose case-insensitivity does not mean what they think.
 *
 * `translatePattern` refuses it by name and says why. That matters in one
 * direction specifically: hoisting a mid-pattern `(?i)` to the flag set
 * **widens** the match, and a silently wider secret pattern is the direction
 * that stops being a control.
 *
 * ## The guardrail still reads `.secret-patterns` itself
 *
 * Only the PARSER is shared. Pointing a C.2 guardrail at the GENERATED module
 * would let a stale generated file weaken it, which is the one change here that
 * would make things worse. (#2584's docblock gave that as a reason not to share
 * at all, conflating the parser with the data; it is not a reason.)
 *
 * CommonJS-compatible on purpose — no `import.meta`. `tsx` runs the generator
 * and `ts-jest` compiles the tests, and `api-routes.ts` is the precedent for
 * both reaching the same `.ts` file through `__dirname`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Repo root, so a caller need not re-derive it. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The default source, overridable by callers that test the parser. */
export const SECRET_PATTERNS_FILE = path.join(REPO_ROOT, '.secret-patterns');

/** A pattern as it is stored: a RegExp source plus its flags, never compiled. */
export interface SecretPatternSpec {
    readonly name: string;
    readonly source: string;
    readonly flags: string;
}

/** A pattern as a scanner wants it. */
export interface CompiledSecretPattern {
    readonly name: string;
    readonly regex: RegExp;
}

/**
 * PCRE → `{ source, flags }`.
 *
 * Node's `RegExp` takes everything the live file uses once the inline modifier
 * is lifted to the flag set: measured, 12 of 14 patterns compile unchanged and
 * the 2 that do not fail only on a leading `(?i)`. PCRE `\x27` is `'`, which
 * Node accepts verbatim.
 *
 * Hoisting `(?i)` is equivalent ONLY at the start, because PCRE scopes an
 * inline modifier from where it appears. Both live occurrences are at index 0;
 * a mid-pattern one is refused rather than hoisted.
 */
export function translatePattern(name: string, pcre: string): { source: string; flags: string } {
    const at = pcre.indexOf('(?i)');
    if (at > 0) {
        throw new Error(
            `Pattern "${name}" has an inline (?i) at index ${at}, not at the start. `
                + `PCRE scopes it from that point, so lifting it to the flag set would `
                + `WIDEN the match. Rewrite the pattern with the modifier leading, or `
                + `make it explicitly case-sensitive.`,
        );
    }
    const flags = at === 0 ? 'i' : '';
    const source = at === 0 ? pcre.slice(4) : pcre;
    // Compile here so a bad pattern fails the PARSER, naming the pattern,
    // rather than whichever consumer happens to compile it first.
    new RegExp(source, flags);
    return { source, flags };
}

/**
 * Parse the whole file.
 *
 * Both refusals are load-bearing: a malformed line throws rather than being
 * skipped, and an EMPTY result throws — an empty pattern set makes every scan
 * report "clean", which is the `absence-reads-as-success` shape and the worst
 * available outcome for a secret scanner.
 */
export function parseSecretPatterns(text: string): SecretPatternSpec[] {
    const out: SecretPatternSpec[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('|');
        if (idx <= 0) {
            throw new Error(`Malformed line in .secret-patterns: ${JSON.stringify(raw)}`);
        }
        const name = line.slice(0, idx).trim();
        const { source, flags } = translatePattern(name, line.slice(idx + 1).trim());
        out.push({ name, source, flags });
    }
    if (out.length === 0) {
        throw new Error('No patterns parsed from .secret-patterns');
    }
    return out;
}

/**
 * What a scanner wants: live `RegExp` objects, read from the pattern FILE.
 *
 * This is the guardrail's entry point. It takes a path rather than text so the
 * call site reads as "the guardrail loads .secret-patterns", which is the fact
 * that matters about it.
 */
export function compilePatterns(file: string = SECRET_PATTERNS_FILE): CompiledSecretPattern[] {
    return parseSecretPatterns(fs.readFileSync(file, 'utf8')).map((p) => ({
        name: p.name,
        regex: new RegExp(p.source, p.flags),
    }));
}

/** The committed module's text, so the generator and its guard cannot disagree. */
export function renderModule(patterns: readonly SecretPatternSpec[]): string {
    const rows = patterns
        .map(
            (p) =>
                `    { name: ${JSON.stringify(p.name)}, source: ${JSON.stringify(p.source)}, flags: ${JSON.stringify(p.flags)} },`,
        )
        .join('\n');
    return `// GENERATED by scripts/generate-secret-patterns.ts — do not edit.
//
// Source of truth: \`.secret-patterns\` at the repo root. Run
// \`npm run secret-patterns:generate\` after changing it;
// \`tests/guards/secret-patterns-generated-in-sync.test.ts\` fails CI on drift.
//
// ## Why this file exists at all
//
// \`.secret-patterns\` is NOT copied into the production image — the runner
// stage takes \`public\`, \`.next\`, \`node_modules\`, \`package.json\`, \`prisma\`,
// two scripts, \`dist\` and the PDF fonts, and nothing else. A server-side
// \`readFileSync('.secret-patterns')\` therefore throws ENOENT in production
// while passing every test, and the shared reader throws on an empty set, so
// the egress control would crash the route or be caught and fail OPEN. Green
// in CI, wrong in the image — #929's shape.
//
// Generated into a module instead, so it is bundled and reaches the place it
// has to work. Same arrangement as \`design/tokens.json\` → \`tokens.css\`.

export interface SecretPattern {
    readonly name: string;
    readonly source: string;
    readonly flags: string;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
${rows}
] as const;
`;
}
