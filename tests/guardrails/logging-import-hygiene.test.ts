/**
 * Logging & Import Hygiene Guardrails
 *
 * Prevents regression of:
 *   1. console.* in backend server code (must use structured logger)
 *   2. Unnecessary dynamic require() in production code
 *   3. Ensures edge-logger is used for edge-safe files
 *
 * Allowlisted exceptions are documented inline.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

const SRC_DIR = path.resolve(__dirname, '../../src');

// ─── Helpers ────────────────────────────────────────────────────────

function readSrcFile(relativePath: string): string {
    return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8');
}

async function getFiles(pattern: string): Promise<string[]> {
    return glob(pattern, { cwd: SRC_DIR, posix: true });
}

/**
 * What does an allowlist key name on disk right now?
 *
 * Every exemption map in this file is keyed by a path relative to `src/`, and
 * an exemption for a path that no longer exists is worse than untidy — see the
 * no-stale-entries tests below. `'missing'` also covers a key that escapes
 * `src/` (`../…`), which would otherwise satisfy a bare existence check while
 * naming something this guard never scans.
 */
function srcEntryKind(relativePath: string): 'file' | 'dir' | 'missing' {
    const abs = path.resolve(path.join(SRC_DIR, relativePath));
    if (abs !== SRC_DIR && !abs.startsWith(SRC_DIR + path.sep)) return 'missing';
    if (!fs.existsSync(abs)) return 'missing';
    return fs.statSync(abs).isDirectory() ? 'dir' : 'file';
}

// ─── Console.* Guardrail ────────────────────────────────────────────

describe('No console.* in backend server code', () => {
    /**
     * Files explicitly allowed to use console.*:
     * - edge-logger.ts: IS the console-based logger for edge runtime
     * - api-client.ts: client-side file, dev-only validation warning
     * - error.tsx / global-error.tsx: React error boundaries (browser-only)
     * - Client components (*.tsx with 'use client'): browser-side
     */
    const CONSOLE_ALLOWLIST = new Set([
        'lib/observability/edge-logger.ts',   // Edge runtime console adapter
        'lib/api-client.ts',                   // Client-side dev validation
        'instrumentation.ts',                  // Pre-init bootstrap (R-6 startup abort runs before logger)
    ]);

    // Adapted / vendored modules. `lib/dub-utils/` was REMOVED from
    // this list (Roadmap-6 P2) — adapted, dub-ported code is held to
    // the same console.* discipline as the rest of src/. The remaining
    // entries are client-component directories: their browser-side
    // console.* is acceptable, and their .tsx files are also caught by
    // the isClientComponent skip below.
    const CONSOLE_ALLOWLIST_PREFIXES = [
        'components/ui/charts/',
        'components/ui/hooks/',
        'components/ui/filter/',
        'components/ui/file-upload.tsx',
    ];

    // Client components (browser-side) are always allowed
    function isClientComponent(content: string): boolean {
        // Check first non-empty line for 'use client'
        const firstLine = content.split('\n').find(l => l.trim().length > 0);
        return firstLine?.includes("'use client'") || firstLine?.includes('"use client"') || false;
    }

    it('control: getFiles returns the source tree it is meant to scan', async () => {
        // Both ratchets in this file are "iterate every file, collect
        // violations, expect none". An empty file list collects nothing and
        // passes — `selector-teeth` (#971) confirmed `getFiles` survives
        // being gutted to `[]`, `''`, `new Set()` and `new Map()`.
        //
        // Nothing else here can catch that: the allowlists above are
        // subtractive, so they stay satisfied by a smaller population, and
        // the assertion at the end is `expect(violations).toEqual([])`, which
        // an unscanned tree satisfies perfectly.
        const tsx = await getFiles('**/*.{ts,tsx}');
        const ts = await getFiles('**/*.ts');
        // src/ is ~2000 files; the floors are deliberately an order of
        // magnitude below that, so ordinary deletions never move them.
        expect(tsx.length).toBeGreaterThan(200);
        expect(ts.length).toBeGreaterThan(200);
        // The pattern must actually discriminate, or `getFiles` could be
        // returning one fixed list regardless of what it was asked for.
        expect(tsx.length).toBeGreaterThan(ts.length);
        // And the entries must be readable relative paths, not absolute or
        // empty strings that `readSrcFile` would then join into nonsense.
        for (const f of [tsx[0], ts[0]]) {
            expect(typeof f).toBe('string');
            expect(f.length).toBeGreaterThan(0);
            expect(path.isAbsolute(f)).toBe(false);
        }
    });

    it('no console.log/warn/error/info in server-side src/ files', async () => {
        const tsFiles = await getFiles('**/*.{ts,tsx}');
        const violations: string[] = [];

        for (const file of tsFiles) {
            if (CONSOLE_ALLOWLIST.has(file)) continue;
            if (CONSOLE_ALLOWLIST_PREFIXES.some(p => file.startsWith(p))) continue;
            // Skip node_modules just in case
            if (file.includes('node_modules')) continue;

            const content = readSrcFile(file);

            // Skip client components
            if (isClientComponent(content)) continue;

            // Check for console.* calls
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/console\.(log|warn|error|info|debug)\(/.test(line)) {
                    // Allow if eslint-disable-line no-console is present
                    if (line.includes('eslint-disable-line no-console')) continue;
                    // Allow if inside a comment
                    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
                    violations.push(`${file}:${i + 1}: ${line.trim()}`);
                }
            }
        }

        if (violations.length > 0) {
            fail(
                `Found ${violations.length} console.* call(s) in server code ` +
                `(use logger from @/lib/observability/logger instead):\n` +
                violations.map(v => `  ${v}`).join('\n'),
            );
        }
    });

    it('lib/dub-utils/ has no blanket console.* exemption (Roadmap-6 P2)', () => {
        // The dub-ported utility tree was once exempt wholesale, a
        // semi-blind spot where noisy logging could persist. Adapted
        // external code obeys the same logging standard as the rest of
        // src/. Re-adding a `lib/dub-utils/` prefix or an individual
        // `lib/dub-utils/*` file here silently reopens that blind spot.
        expect(CONSOLE_ALLOWLIST_PREFIXES).not.toContain('lib/dub-utils/');
        for (const f of CONSOLE_ALLOWLIST) {
            expect(f.startsWith('lib/dub-utils/')).toBe(false);
        }
    });

    it('control: the console allowlists are non-empty and the probe discriminates', () => {
        // The no-stale assertion below is "this filtered list is empty", which
        // an empty allowlist and a probe that answers "present" for everything
        // both satisfy. No upper population floor: these lists are allowed to
        // shrink to nothing, so only emptiness-of-input is pinned.
        expect(CONSOLE_ALLOWLIST.size).toBeGreaterThan(0);
        expect(CONSOLE_ALLOWLIST_PREFIXES.length).toBeGreaterThan(0);
        expect(srcEntryKind('lib/api-client.ts')).toBe('file');
        expect(srcEntryKind('components/ui/charts/')).toBe('dir');
        expect(srcEntryKind('__no-such-path-console-probe__/')).toBe('missing');
        expect(srcEntryKind('../package.json')).toBe('missing');
    });

    it('the console allowlists only shrink — no stale entries', () => {
        // Same rule as REQUIRE_ALLOWLIST below (#1285): a carve-out whose
        // subject has been deleted keeps that PATH pre-approved for whatever
        // is created there next. CONSOLE_ALLOWLIST keys are files;
        // CONSOLE_ALLOWLIST_PREFIXES mixes directory prefixes with one file,
        // so either kind counts as live.
        const staleFiles = [...CONSOLE_ALLOWLIST].filter((rel) => srcEntryKind(rel) !== 'file');
        const stalePrefixes = CONSOLE_ALLOWLIST_PREFIXES.filter(
            (rel) => srcEntryKind(rel) === 'missing',
        );
        const stale = [...staleFiles, ...stalePrefixes];
        if (stale.length > 0) {
            throw new Error(
                `${stale.length} console.* exemption(s) name a path that no longer exists ` +
                    `under src/:\n` +
                    stale.map((s) => `  ${s}`).join('\n') +
                    `\n\nDelete the entry in the same diff as the file or directory.`,
            );
        }
        expect(stale).toEqual([]);
    });
});

// ─── Dynamic require() Guardrail ────────────────────────────────────

describe('Dynamic require() usage is minimized', () => {
    /**
     * Allowed require() patterns and WHY they're allowed:
     *
     *
     * Circular dependency avoidance:
     * - audit-writer.ts → require('../prisma')   [see its ARCHITECTURE NOTE]
     *
     * The four audit-writer entries that used to sit here are GONE, and must
     * not come back: `require()` of that module returned it WITHOUT the
     * `appendAuditEntry` export in the webpack production bundle, so every
     * audited write threw and #1269's catch swallowed it — 275 failures and
     * zero successes in one E2E shard on green main. The three call sites are
     * static imports now (a namespace import with a deferred read in
     * prisma.ts, where the cycle is real; plain named imports elsewhere).
     *
     * Startup-time lazy loading:
     * - mailer.ts → require('@/env') in initMailerFromEnv()
     * - observability/instrumentation.ts → require('./logger') at bootstrap
     *
     * Conditional providers:
     * - storage/index.ts → require('./s3-provider') / require('./local-provider')
     *
     * CJS-only dependency:
     * - spatial/parse.ts → require('@tmcw/togeojson') on the KML parse path
     *
     * Conditional health check:
     * - readyz/route.ts, health/route.ts → require('@/lib/redis')
     *
     * The map is SHRINK-ONLY, pinned to disk by the no-stale-entries test
     * below. #1285: four Epic G-3 vendor-questionnaire entries outlived the
     * modules the GRC teardown (#547) deleted — each still carrying a written
     * reason for a file nobody could read, and still pre-approving a
     * `require('@/env')` for whatever might be created at those paths next.
     * Nothing detected it, because this map had no existence test while every
     * other baseline in the repo has one. A `framework-provider.ts →
     * require('@/data/...')` line in this very docblock had rotted the same
     * way (#570 deleted that subsystem); prose cannot be ratcheted, so keep it
     * honest by hand.
     */
    const REQUIRE_ALLOWLIST: Record<string, string[]> = {
        'lib/mailer.ts': ['@/env'],
        'lib/observability/instrumentation.ts': ['./logger'],
        'lib/storage/index.ts': ['./s3-provider', './local-provider'],
        // Feature 1 — @tmcw/togeojson is CJS; lazy-required to keep it out
        // of the spatial parser's static graph (the KML parse path).
        'lib/spatial/parse.ts': ['@tmcw/togeojson'],
        'app/api/readyz/route.ts': ['@/lib/redis'],
        // GAP-13 — same conditional Redis check pattern as readyz.
        'app/api/health/route.ts': ['@/lib/redis'],
    };

    it('control: the staleness probe can tell present from absent', () => {
        // `stale` below is a filtered list asserted empty: an empty map and a
        // probe that answers "present" for everything both pass it. Deliberately
        // no upper floor on the population — legitimately removing a lazy
        // require() shrinks this map, and a floor would then be a false alarm.
        expect(Object.keys(REQUIRE_ALLOWLIST).length).toBeGreaterThan(0);
        expect(srcEntryKind('lib/mailer.ts')).toBe('file');
        expect(srcEntryKind('__no-such-file-require-probe__.ts')).toBe('missing');
        // A directory is not a valid key here — keys name the scanned file.
        expect(srcEntryKind('lib')).toBe('dir');
        expect(srcEntryKind('../package.json')).toBe('missing');
    });

    it('REQUIRE_ALLOWLIST only shrinks — no stale entries', () => {
        const stale = Object.keys(REQUIRE_ALLOWLIST).filter(
            (rel) => srcEntryKind(rel) !== 'file',
        );
        if (stale.length > 0) {
            throw new Error(
                `${stale.length} REQUIRE_ALLOWLIST entr${stale.length === 1 ? 'y names a path' : 'ies name paths'} ` +
                    `that is not a file under src/:\n` +
                    stale.map((s) => `  ${s}`).join('\n') +
                    `\n\nAn entry that outlives its file keeps the PATH pre-approved: whatever ` +
                    `is created there\nnext inherits the require() exemption, justified by a ` +
                    `reason written for a module nobody\ncan read. That is #1285 — four Epic G-3 ` +
                    `entries survived the GRC teardown (#547) that\ndeleted their files, and no ` +
                    `test noticed.\n\nDelete the entry in the same diff as the file.`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('no unexpected require() in src/ files', async () => {
        const tsFiles = await getFiles('**/*.ts');
        const violations: string[] = [];

        for (const file of tsFiles) {
            if (file.includes('node_modules')) continue;

            const content = readSrcFile(file);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Match require('...') or require("...")
                const match = line.match(/require\(['"]([^'"]+)['"]\)/);
                if (!match) continue;

                // Skip comments
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

                const moduleName = match[1];
                const allowed = REQUIRE_ALLOWLIST[file];
                if (allowed && allowed.includes(moduleName)) continue;

                violations.push(`${file}:${i + 1}: require('${moduleName}') — ${line.trim().substring(0, 80)}`);
            }
        }

        if (violations.length > 0) {
            fail(
                `Found ${violations.length} unexpected require() call(s) in src/:\n` +
                violations.map(v => `  ${v}`).join('\n') +
                '\n\nIf this require() is justified, add it to REQUIRE_ALLOWLIST in this test.',
            );
        }
    });
});

// ─── Structured Logger Coverage ─────────────────────────────────────

describe('Structured logger is used across backend', () => {
    it('logger module exports expected API', () => {
        const content = readSrcFile('lib/observability/logger.ts');
        expect(content).toContain('export const logger');
        expect(content).toContain('export function log(');
        expect(content).toContain('export function extractErrorMeta(');
    });

    it('edge-logger module exports expected API', () => {
        const content = readSrcFile('lib/observability/edge-logger.ts');
        expect(content).toContain('export const edgeLogger');
    });

    it('Pino redaction covers sensitive fields', () => {
        const content = readSrcFile('lib/observability/logger.ts');
        for (const field of ['password', 'secret', 'token', 'accessToken', 'refreshToken', 'privateKey']) {
            expect(content).toContain(`'${field}'`);
        }
    });
});
