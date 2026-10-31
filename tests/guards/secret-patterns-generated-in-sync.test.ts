/**
 * The generated secret-pattern module matches `.secret-patterns` — #2578.
 *
 * Same arrangement as `tokens-generated-in-sync`: a generator, a committed
 * output, and a guard that regenerates and compares. The reason it is a guard
 * rather than a convention is the `fonts:vendor` lesson — regenerating the
 * output and its own verification in one step makes a changed pattern a green
 * diff.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE = '.secret-patterns';
const TARGET = 'src/lib/security/generated/secret-patterns.ts';
const DOCKERFILE = 'Dockerfile';

describe('generated secret patterns (#2578)', () => {
    it('is in sync with .secret-patterns', () => {
        // The generator's own `--check`, so the comparison cannot drift from
        // the thing that writes the file.
        const out = execFileSync('node', ['scripts/generate-secret-patterns.mjs', '--check'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        console.log(`[secret-patterns] ${out.trim()}`);
        expect(out).toContain('in sync');
    });

    it('carries a real pattern set — an empty one would report every scan clean', () => {
        // Not `module` — Next's `no-assign-module-variable` rule forbids the
        // name outright, and the lint ceiling allows zero errors.
        const generated = readFileSync(path.join(REPO_ROOT, TARGET), 'utf8');
        const rows = (generated.match(/^\s{4}\{ name: /gm) ?? []).length;
        const sourceRows = readFileSync(path.join(REPO_ROOT, SOURCE), 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('|')).length;
        console.log(`[secret-patterns] ${rows} generated row(s) from ${sourceRows} source line(s)`);
        expect(rows).toBe(sourceRows);
        expect(rows).toBeGreaterThanOrEqual(10);
    });

    it('the PREMISE still holds: .secret-patterns is not in the runtime image', () => {
        // This generator exists only because the pattern file does not reach
        // production. That is a fact about the Dockerfile, and a fact can
        // change without anybody revisiting the reasoning built on it — the
        // `a-safety-argument-expires-silently` shape.
        //
        // If someone adds the file to the runtime stage, this fails and asks
        // for a decision rather than leaving a generator nobody needs.
        const dockerfile = readFileSync(path.join(REPO_ROOT, DOCKERFILE), 'utf8');
        const runner = dockerfile.slice(dockerfile.lastIndexOf('AS runner'));
        const copiesIt = /^COPY[^\n]*\.secret-patterns/m.test(runner);
        expect({
            premise: '.secret-patterns is absent from the runtime image',
            stillTrue: !copiesIt,
            note: 'If you added it deliberately, the generator may be redundant — decide, do not just silence this.',
        }).toEqual({
            premise: '.secret-patterns is absent from the runtime image',
            stillTrue: true,
            note: 'If you added it deliberately, the generator may be redundant — decide, do not just silence this.',
        });
    });

    it('refuses an inline (?i) that is not at the start', () => {
        // The one translation that would be WRONG rather than merely
        // unsupported: PCRE scopes `(?i)` from where it appears, so hoisting a
        // mid-pattern one to the flag set WIDENS the match. Both live
        // occurrences are at index 0; this proves the refusal exists for the
        // day one is not.
        //
        // Driven through the CLI rather than by importing the module: ts-jest
        // rewrites a dynamic `import()` to `require()`, which throws against a
        // `.mjs`. The CLI is also the path CI uses, so this tests the real one.
        const dir = mkdtempSync(path.join(tmpdir(), 'secpat-'));
        try {
            const bad = path.join(dir, 'patterns');
            writeFileSync(bad, 'Mid-pattern modifier | abc(?i)def\n', 'utf8');
            let status = 0;
            let stderr = '';
            try {
                execFileSync('node', ['scripts/generate-secret-patterns.mjs'], {
                    cwd: REPO_ROOT,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        SECRET_PATTERNS_FILE: bad,
                        SECRET_PATTERNS_TARGET: path.join(dir, 'out.ts'),
                    },
                });
            } catch (error) {
                const e = error as { status?: number; stderr?: string };
                status = e.status ?? 1;
                stderr = e.stderr ?? '';
            }
            expect({ status, mentionsTheReason: /not at the start/.test(stderr) }).toEqual({
                status: 1,
                mentionsTheReason: true,
            });
            // And a LEADING one is accepted, so the refusal is about placement
            // rather than about the modifier.
            const good = path.join(dir, 'good');
            writeFileSync(good, 'Leading modifier | (?i)abc\n', 'utf8');
            const out = execFileSync('node', ['scripts/generate-secret-patterns.mjs'], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    SECRET_PATTERNS_FILE: good,
                    SECRET_PATTERNS_TARGET: path.join(dir, 'out.ts'),
                },
            });
            expect(out).toContain('wrote 1 pattern');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses an EMPTY pattern file — every scan would report clean', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'secpat-'));
        try {
            const empty = path.join(dir, 'patterns');
            writeFileSync(empty, '# only a comment\n\n', 'utf8');
            let status = 0;
            let stderr = '';
            try {
                execFileSync('node', ['scripts/generate-secret-patterns.mjs'], {
                    cwd: REPO_ROOT,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        SECRET_PATTERNS_FILE: empty,
                        SECRET_PATTERNS_TARGET: path.join(dir, 'out.ts'),
                    },
                });
            } catch (error) {
                const e = error as { status?: number; stderr?: string };
                status = e.status ?? 1;
                stderr = e.stderr ?? '';
            }
            expect({ status, says: /No patterns parsed/.test(stderr) }).toEqual({
                status: 1,
                says: true,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
