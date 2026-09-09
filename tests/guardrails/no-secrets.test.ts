/**
 * Guardrail: Epic C.2 — repository-wide secret-leak check.
 *
 * This is the CI half of the secret-detection layer. The local
 * pre-commit hook (`scripts/detect-secrets.sh` via `.husky/pre-commit`)
 * scans only staged files; if a developer commits with `--no-verify`,
 * or pushes from a tooling environment without husky installed, this
 * guardrail catches the leak before merge.
 *
 * Strategy:
 *   - Patterns are loaded from `.secret-patterns` (the same source the
 *     local hook reads). One source of truth; no drift.
 *   - Files to scan come from `git ls-files`. Deterministic, ignores
 *     `.gitignore`d artefacts, and stays fast (~1s on this repo).
 *   - The same path-skip + inline-allowlist semantics as the local
 *     scanner apply, so a developer who clears the local hook also
 *     clears CI without learning a second mental model.
 *
 * Failure UX:
 *   - One Jest failure per (file, pattern) hit.
 *   - Each failure carries `file:line`, the pattern name, the offending
 *     excerpt, and the same actionable footer the local scanner emits.
 *   - The repo-baseline `EXPECTED_KNOWN_FIXTURE_HITS` exists so an
 *     incidental new pattern can ratchet down without lying about
 *     existing test fixtures. Adding to it requires writing the
 *     reason in code, which a reviewer must approve.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PATTERN_FILE = path.join(REPO_ROOT, '.secret-patterns');
const ALLOWLIST_MARKER = 'pragma: allowlist secret';

// ─── Path skips ─────────────────────────────────────────────────────
//
// Mirror the bash scanner's SKIP_PATHS so the local + CI scanners scan
// the same surface. Substring match against the relative path.
const SKIP_PATHS: readonly string[] = [
    'node_modules/',
    '.next/',
    'dist/',
    'build/',
    'coverage/',
    'playwright-report/',
    'test-results/',
    '.git/',
    '.husky/_/',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'prisma/migrations/',
    'public/',

    // Self-skip: the scanner, the pattern source, and the tests that
    // exercise both — all contain secret-shaped strings on purpose.
    'scripts/detect-secrets.sh',
    '.secret-patterns',
    'tests/unit/security/detect-secrets.test.ts',
    'tests/guardrails/no-secrets.test.ts',

    // Canonical home for intentional secret-shaped fixtures.
    'tests/fixtures/secrets/',
];

function isSkippedPath(rel: string): boolean {
    return SKIP_PATHS.some((skip) => rel.includes(skip));
}

// ─── Repo-baseline allowlist ───────────────────────────────────────
//
// Pre-existing test fixtures and example envs that contain
// secret-shaped placeholders (NOT real credentials). Each entry must
// carry a one-line `reason`. New entries should almost always be
// avoided in favour of an inline `// pragma: allowlist secret`
// comment or moving the file under `tests/fixtures/secrets/`.

interface KnownHit {
    file: string;
    pattern: string;
    reason: string;
}

const REPO_BASELINE: readonly KnownHit[] = [
    // .env.example entry removed — its four placeholder literals
    // (`AUTH_SECRET="your-secret-key-here-…"` and the OAuth client
    // secrets) now carry inline `pragma: allowlist secret` markers, so
    // the scanner walks past them without surfacing a baseline entry.
    // Keeping the entry here would fail the "no stale baseline" check.
    //
    // This tightens the gate rather than loosening it: the entry exempted
    // the whole FILE from that pattern class, whereas the pragmas exempt
    // four named lines, so a fifth secret-shaped line in .env.example now
    // surfaces. The pragmas exist because the baseline did not stop the
    // pre-commit hook — any edit to .env.example failed it, and the only
    // escape was `--no-verify`, which skips the entire scan.

    // Test setup + integration/unit fixtures: every entry below is a
    // synthetic test value (auth secret stubs, encryption keys for
    // unit tests, hardcoded test passwords for credential flows).
    // jest.setup.js entry removed — the three test-fixture secret
    // literals there now carry inline `pragma: allowlist secret`
    // markers, so the scanner walks past them without surfacing a
    // baseline entry. Keeping the entry here would fail the
    // "no stale baseline" check.
    { file: 'tests/integration/credentials-end-to-end.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'Test fixtures for credential flow.' },
    { file: 'tests/integration/github-provider.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'GitHub provider test fixtures.' },
    // integration-regression.test.ts entry removed: the
    // quality-roadmap unused-imports sweep added an inline
    // `// pragma: allowlist secret` to the placeholder
    // webhook-secret fixture, so the scanner no longer flags it.
    { file: 'tests/integration/mfa-enrollment.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'MFA enrollment test fixtures.' },
    { file: 'tests/integration/webhook.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'Webhook test fixtures.' },
    { file: 'tests/unit/audit-redact.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'Audit redaction test fixtures.' },
    // auth-brute-force.test.ts entry removed (Roadmap-5 PR1): touching the file
    // for the async-progressive migration tripped the local pre-commit scanner,
    // so the fixture password now carries an inline `// pragma: allowlist secret`
    // carve-out — the baseline entry became stale.
    // av-webhook + refresh entries removed: PR-A.4 added explicit
    // `// pragma: allowlist secret` carve-outs to those lines, so the
    // scanner no longer flags them and the baseline entries became
    // stale. The carve-out comments are the durable record of why
    // those test fixtures are safe.
    // backfill-token-encryption.test.ts entry removed: same
    // reason as integration-regression above — inline carve-out
    // comment added during the quality-roadmap sweep, baseline
    // entry now stale.
    { file: 'tests/unit/oauth-token-encryption.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'OAuth token encryption test fixtures.' },
    { file: 'tests/unit/oauth-token-encryption.test.ts', pattern: 'GitHub Token', reason: 'Synthetic GitHub-shaped token used to verify provider-specific encryption envelopes.' },
    { file: 'tests/unit/password-check.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'Password-check test fixtures.' },
    { file: 'tests/unit/totp-crypto.test.ts', pattern: 'Hardcoded Password Assignment', reason: 'TOTP crypto test fixtures.' },
];

function isBaselineHit(file: string, patternName: string): boolean {
    return REPO_BASELINE.some(
        (h) => h.file === file && h.pattern === patternName,
    );
}

// ─── Pattern loader ─────────────────────────────────────────────────

interface Pattern {
    name: string;
    regex: RegExp;
}

function loadPatterns(file: string): Pattern[] {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const out: Pattern[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;
        const idx = line.indexOf('|');
        if (idx <= 0) {
            throw new Error(
                `Malformed line in .secret-patterns: ${JSON.stringify(raw)}`,
            );
        }
        const name = line.slice(0, idx).trim();
        const pcre = line.slice(idx + 1).trim();
        // The pattern file uses PCRE syntax that bash's `grep -P`
        // accepts. The Node `RegExp` engine accepts everything we use
        // (`(?i)`, alternation, character classes) once we strip the
        // inline-modifier and lift it to the flag set. Translate
        // `(?i)` → flags = 'i'; otherwise use no flags.
        let flags = '';
        let body = pcre;
        if (body.startsWith('(?i)')) {
            flags = 'i';
            body = body.slice(4);
        }
        // PCRE `\x27` is `'` — Node RegExp accepts this verbatim.
        out.push({ name, regex: new RegExp(body, flags) });
    }
    if (out.length === 0) {
        throw new Error('No patterns loaded from .secret-patterns');
    }
    return out;
}

const PATTERNS = loadPatterns(PATTERN_FILE);

// ─── File discovery ────────────────────────────────────────────────

/**
 * `git ls-files` lists every tracked file. Deterministic, fast, and
 * automatically respects `.gitignore`. We exclude binary blobs by
 * filtering on extension first, then by reading the first ~1KB and
 * checking for null bytes.
 */
function listTrackedFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
}

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp3', '.mp4', '.webm', '.mov', '.wav',
    '.so', '.dll', '.dylib', '.exe', '.wasm',
    '.psd', '.sketch', '.fig',
]);

function isBinaryFile(absPath: string): boolean {
    const ext = path.extname(absPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;
    // First-1KB null-byte sniff for unknown extensions.
    try {
        const fd = fs.openSync(absPath, 'r');
        const buf = Buffer.alloc(1024);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        for (let i = 0; i < bytes; i++) {
            if (buf[i] === 0) return true;
        }
    } catch {
        // Unreadable / dangling symlink — skip.
        return true;
    }
    return false;
}

// ─── Scan ──────────────────────────────────────────────────────────

interface Finding {
    file: string;
    line: number;
    pattern: string;
    excerpt: string;
}

function scanRepo(): Finding[] {
    const findings: Finding[] = [];
    const files = listTrackedFiles();

    for (const rel of files) {
        if (isSkippedPath(rel)) continue;
        const abs = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(abs)) continue;
        if (isBinaryFile(abs)) continue;

        const text = fs.readFileSync(abs, 'utf8');
        // Defer line splitting until at least one pattern matches —
        // keeps the average-case fast on a clean repo.
        let lines: string[] | null = null;

        for (const { name, regex } of PATTERNS) {
            // Compile a "global" variant per scan to walk all matches.
            const global = new RegExp(regex.source, regex.flags + 'g');
            let m: RegExpExecArray | null;
            while ((m = global.exec(text)) !== null) {
                if (lines === null) lines = text.split('\n');
                const upToMatch = text.slice(0, m.index);
                const lineNo = upToMatch.split('\n').length;
                const lineText = lines[lineNo - 1] ?? '';
                if (lineText.includes(ALLOWLIST_MARKER)) continue;
                const excerpt =
                    lineText.length > 200
                        ? `${lineText.slice(0, 200)}…`
                        : lineText;
                findings.push({ file: rel, line: lineNo, pattern: name, excerpt });
                // Avoid infinite loop on zero-width matches.
                if (m.index === global.lastIndex) global.lastIndex++;
            }
        }
    }
    return findings;
}

const findings = scanRepo();

// ─── Tests ─────────────────────────────────────────────────────────

describe('Epic C.2 — repository-wide secret-leak guardrail', () => {
    it('loads the .secret-patterns file', () => {
        expect(PATTERNS.length).toBeGreaterThan(0);
        for (const p of PATTERNS) {
            expect(p.name.length).toBeGreaterThan(0);
            expect(p.regex).toBeInstanceOf(RegExp);
        }
    });

    it('discovers tracked files (sanity check)', () => {
        expect(listTrackedFiles().length).toBeGreaterThan(100);
    });

    it('the scanner itself is excluded from self-scan', () => {
        const selfScan = findings.find(
            (f) => f.file === 'scripts/detect-secrets.sh',
        );
        expect(selfScan).toBeUndefined();
    });

    it('produces no NEW secret-shaped findings outside the documented baseline', () => {
        const novel = findings.filter(
            (f) => !isBaselineHit(f.file, f.pattern),
        );

        if (novel.length === 0) return;

        // Build a copy-paste-actionable failure message.
        const grouped = new Map<string, Finding[]>();
        for (const f of novel) {
            const key = `${f.file}::${f.pattern}`;
            const arr = grouped.get(key) ?? [];
            arr.push(f);
            grouped.set(key, arr);
        }

        const lines: string[] = [];
        lines.push('Possible secrets detected outside the allowed baseline:');
        lines.push('');
        for (const [key, hits] of grouped) {
            const [file, pattern] = key.split('::');
            lines.push(`  ${file}`);
            lines.push(`    ${pattern}`);
            for (const h of hits) {
                lines.push(`      :${h.line} ${h.excerpt.trim()}`);
            }
            lines.push('');
        }
        lines.push('How to proceed:');
        lines.push("  1. If this is a real secret — remove it, rotate it");
        lines.push('     immediately at the issuer, and re-push.');
        lines.push('  2. If this is a sample / fixture / unit-test input —');
        lines.push('     move it under tests/fixtures/secrets/ (auto-skipped)');
        lines.push('     OR append `// pragma: allowlist secret` to the line');
        lines.push('     with a short comment explaining why it is safe.');
        lines.push('  3. Re-run locally:  npm run secret-scan -- --all');
        lines.push('  4. Only if a hit is a known long-lived placeholder, add a');
        lines.push('     REPO_BASELINE entry in tests/guardrails/no-secrets.test.ts');
        lines.push('     with the file, pattern, and a written reason.');

        throw new Error(lines.join('\n'));
    });

    it('every REPO_BASELINE entry still applies (no stale entries)', () => {
        // Catches the case where a file was deleted/cleaned but its
        // baseline entry was forgotten — the entry quietly weakens
        // future enforcement.
        const stale = REPO_BASELINE.filter(
            (entry) =>
                !findings.some(
                    (f) => f.file === entry.file && f.pattern === entry.pattern,
                ),
        );

        if (stale.length > 0) {
            const msg = [
                'REPO_BASELINE in tests/guardrails/no-secrets.test.ts contains stale entries.',
                'Either the file was deleted or the secret-shaped content was cleaned;',
                'remove the entry from the array.',
                '',
                ...stale.map(
                    (s) => `  - ${s.file} (${s.pattern}) — ${s.reason}`,
                ),
            ].join('\n');
            throw new Error(msg);
        }
    });
});

// ─── Sanity test: the scanner WOULD catch a planted secret ─────────

describe('Epic C.2 — sanity: scanner catches planted secrets', () => {
    /**
     * Spawns the local scanner against a temporary file containing a
     * fake secret. Proves the local hook + CI guardrail actually catch
     * a credential, not just pass on a clean repo. Uses the bash
     * scanner so we exercise the real CI/local code path end-to-end.
     */
    it('the local scanner exits 1 on a planted AWS key', () => {
        const tmp = path.join(REPO_ROOT, 'tmp-no-secrets-test');
        try {
            fs.mkdirSync(tmp, { recursive: true });
            const planted = path.join(tmp, 'planted-aws.ts');
            fs.writeFileSync(
                planted,
                `const accessKey = "AKIAIOSFODNN7EXAMPLE";\n`,
            );
            const result = spawnSync(
                'bash',
                [path.join(REPO_ROOT, 'scripts/detect-secrets.sh'), planted],
                { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toMatch(/AWS Access Key ID/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ─── GAP-16 — env-file filename guard ─────────────────────────────────
//
// Pre-commit hook (scripts/detect-secrets.sh) refuses staged `.env` /
// `.env.<name>` files by name. The CI side mirrors that as a tracked-
// files invariant: no `.env` or `.env.<name>` should EVER exist in
// `git ls-files`. Templates (.env.<name>.example) are explicitly
// allowed.
//
// This complements the content-pattern scan above. Together they cover:
//   - accidental commits of secret-bearing .env files (content scan)
//   - deliberate -f overrides committing placeholder-only .env files
//     that don't trip any secret pattern (this filename guard)

describe('GAP-16 — no tracked .env files (filename guard)', () => {
    it('no `.env` or `.env.<name>` is in the git index (only .env.<>.example templates allowed)', () => {
        // Use git ls-files to enumerate tracked files. Cheaper than
        // walking the tree, and matches what reviewers see on the PR.
        const tracked = execFileSync('git', ['ls-files', '-z'], {
            encoding: 'utf8',
            cwd: REPO_ROOT,
        })
            .split('\0')
            .filter(Boolean);

        const violations: string[] = [];
        for (const file of tracked) {
            // basename() of the path
            const base = file.split('/').pop() ?? file;
            // Allow templates first.
            if (base.endsWith('.example')) continue;
            // Match `.env` or `.env.<anything>`.
            if (base === '.env' || base.startsWith('.env.')) {
                violations.push(file);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                'Tracked .env files detected (forbidden by GAP-16):\n' +
                    violations.map((v) => `  ${v}`).join('\n') +
                    '\n\n' +
                    'Templates must be named .env.<name>.example. Real env files ' +
                    'must never be committed. See scripts/detect-secrets.sh ' +
                    'env_reject_findings for the pre-commit equivalent.',
            );
        }
    });

    it('the pre-commit env-file guard refuses a planted .env file', () => {
        // Plant a `.env` file containing PLACEHOLDER content that does
        // NOT match any secret pattern. The filename guard MUST still
        // refuse it — that's the whole point of having a separate
        // filename check on top of content scanning.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-guard-'));
        const planted = path.join(tmp, '.env');
        fs.writeFileSync(planted, 'FOO=bar\nBAZ=qux\n');
        try {
            const result = spawnSync(
                'bash',
                [path.join(REPO_ROOT, 'scripts/detect-secrets.sh'), planted],
                { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toMatch(/Refusing to commit env file/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('the pre-commit env-file guard ALLOWS a .env.example template', () => {
        // Templates with the `.example` suffix are the canonical
        // committed-template shape. The filename guard must let them
        // through (the content scan still applies separately, but
        // a placeholder-only template should pass that too).
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-guard-'));
        const planted = path.join(tmp, '.env.example');
        fs.writeFileSync(planted, 'FOO=replace-me\n');
        try {
            const result = spawnSync(
                'bash',
                [path.join(REPO_ROOT, 'scripts/detect-secrets.sh'), planted],
                { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
            );
            expect(result.status).toBe(0);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
