#!/usr/bin/env node
/**
 * `.secret-patterns` → `src/lib/security/generated/secret-patterns.ts` — #2578.
 *
 *   node scripts/generate-secret-patterns.mjs            # write
 *   node scripts/generate-secret-patterns.mjs --check     # exit 1 on drift
 *
 * `--check` is what CI runs, and it exists for the reason the token generator's
 * does: regenerating the output and its own verification in one step would make
 * a changed pattern a green diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseSecretPatterns, renderModule } from './lib/secret-patterns.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Both paths take an env override, the same seam `detect-secrets.sh` uses for
 * its own `PATTERN_FILE`.
 *
 * It exists so a test can drive the REAL generator over a fixture — the
 * translation's one genuinely dangerous case is a mid-pattern `(?i)`, and
 * asserting the refusal by importing this module from jest does not work:
 * ts-jest rewrites a dynamic `import()` to `require()`, which throws against a
 * `.mjs`. Driving the CLI tests the path that production uses anyway.
 */
const SOURCE = process.env.SECRET_PATTERNS_FILE
    ? path.resolve(process.env.SECRET_PATTERNS_FILE)
    : path.join(ROOT, '.secret-patterns');
const TARGET = process.env.SECRET_PATTERNS_TARGET
    ? path.resolve(process.env.SECRET_PATTERNS_TARGET)
    : path.join(ROOT, 'src/lib/security/generated/secret-patterns.ts');

let patterns;
try {
    patterns = parseSecretPatterns(readFileSync(SOURCE, 'utf8'));
} catch (error) {
    // A refusal is the point, so it must exit non-zero with the reason rather
    // than a stack trace — this is what CI and the test both read.
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
const rendered = renderModule(patterns);

if (process.argv.includes('--check')) {
    let current = '';
    try {
        current = readFileSync(TARGET, 'utf8');
    } catch {
        console.error('::error::secret-patterns module is MISSING. Run `npm run secret-patterns:generate`.');
        process.exit(1);
    }
    if (current !== rendered) {
        console.error(
            '::error::secret-patterns module is STALE against .secret-patterns. '
                + 'Run `npm run secret-patterns:generate` and commit the result.',
        );
        process.exit(1);
    }
    console.log(`[secret-patterns] in sync — ${patterns.length} pattern(s)`);
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
    `[secret-patterns] wrote ${patterns.length} pattern(s) to `
        + (process.env.SECRET_PATTERNS_TARGET
            ? 'the SECRET_PATTERNS_TARGET override'
            : 'src/lib/security/generated/secret-patterns.ts'),
);
