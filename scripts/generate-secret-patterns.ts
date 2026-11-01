#!/usr/bin/env tsx
/**
 * `.secret-patterns` → `src/lib/security/generated/secret-patterns.ts` — #2586.
 *
 *   npm run secret-patterns:generate      # write
 *   npm run secret-patterns:check         # exit 1 on drift
 *
 * `--check` exists for the reason the token generator's does: regenerating the
 * output and its own verification in one step would make a changed pattern a
 * green diff.
 *
 * TypeScript run through `tsx`, not a `.mjs`, so the parser it imports is the
 * SAME module `tests/guardrails/no-secrets.test.ts` imports — a `.mjs` cannot
 * be loaded by a ts-jest suite, because a dynamic `import()` is rewritten to
 * `require()`. That mechanical detail was the whole reason the translation
 * existed twice. Same arrangement as `tsx scripts/generate-route-inventory.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseSecretPatterns, renderModule, REPO_ROOT } from './lib/secret-patterns';

/**
 * Both paths take an env override, the same seam `detect-secrets.sh` uses for
 * its own `PATTERN_FILE`. It exists so a test can drive the REAL CLI — the
 * exit code and the `::error::` prefix are what CI reads, and an in-process
 * call cannot exercise either.
 */
const SOURCE = process.env.SECRET_PATTERNS_FILE
    ? path.resolve(process.env.SECRET_PATTERNS_FILE)
    : path.join(REPO_ROOT, '.secret-patterns');
const TARGET = process.env.SECRET_PATTERNS_TARGET
    ? path.resolve(process.env.SECRET_PATTERNS_TARGET)
    : path.join(REPO_ROOT, 'src/lib/security/generated/secret-patterns.ts');

let rendered: string;
let count: number;
try {
    const patterns = parseSecretPatterns(readFileSync(SOURCE, 'utf8'));
    rendered = renderModule(patterns);
    count = patterns.length;
} catch (error) {
    // A refusal is the point, so it exits non-zero with the REASON rather than
    // a stack trace — this is what CI and the guard both read.
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

if (process.argv.includes('--check')) {
    let current = '';
    try {
        current = readFileSync(TARGET, 'utf8');
    } catch {
        console.error(
            '::error::secret-patterns module is MISSING. Run `npm run secret-patterns:generate`.',
        );
        process.exit(1);
    }
    if (current !== rendered) {
        console.error(
            '::error::secret-patterns module is STALE against .secret-patterns. '
                + 'Run `npm run secret-patterns:generate` and commit the result.',
        );
        process.exit(1);
    }
    console.log(`[secret-patterns] in sync — ${count} pattern(s)`);
    process.exit(0);
}

writeFileSync(TARGET, rendered, 'utf8');
// The destination is NOT interpolated, and that is CodeQL's finding rather
// than my taste: `TARGET` derives from `process.env.SECRET_PATTERNS_TARGET`,
// so printing it is an environment value reaching a log — "clear-text logging
// of sensitive information", high severity, raised against this exact line on
// #2584. It is only ever a path, so nothing was leaked; the reason to fix it
// rather than dismiss it is that this is the secret-pattern generator, and a
// tool in that position should not be the one place that pipes an env var into
// output. The default is a literal, and an override says only THAT it was
// overridden — which is all a reader needs, since only a test sets it.
console.log(
    `[secret-patterns] wrote ${count} pattern(s) to `
        + (process.env.SECRET_PATTERNS_TARGET
            ? 'the SECRET_PATTERNS_TARGET override'
            : 'src/lib/security/generated/secret-patterns.ts'),
);
