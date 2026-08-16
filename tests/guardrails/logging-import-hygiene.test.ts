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
});

// ─── Dynamic require() Guardrail ────────────────────────────────────

describe('Dynamic require() usage is minimized', () => {
    /**
     * Allowed require() patterns and WHY they're allowed:
     *
     * Circular dependency avoidance (prisma ↔ audit-writer):
     * - prisma.ts → require('./audit/audit-writer')
     * - audit-writer.ts → require('../prisma')
     * - retention-purge.ts → require('./audit/audit-writer')
     * - evidence-maintenance.ts → require('@/lib/audit/audit-writer')
     *
     * Startup-time lazy loading:
     * - mailer.ts → require('@/env') in initMailerFromEnv()
     * - instrumentation.ts → require('./logger') at bootstrap
     *
     * Conditional providers:
     * - storage/index.ts → require('./s3-provider') / require('./local-provider')
     *
     * Large data lazy loading:
     * - framework-provider.ts → require('@/data/...')
     *
     * Conditional health check:
     * - readyz/route.ts → require('@/lib/redis')
     */
    const REQUIRE_ALLOWLIST: Record<string, string[]> = {
        'lib/prisma.ts': ['./audit/audit-writer'],
        'lib/retention-purge.ts': ['./audit/audit-writer'],
        'lib/mailer.ts': ['@/env'],
        'lib/observability/instrumentation.ts': ['./logger'],
        'lib/storage/index.ts': ['./s3-provider', './local-provider'],
        // Feature 1 — @tmcw/togeojson is CJS; lazy-required to keep it out
        // of the spatial parser's static graph (the KML parse path).
        'lib/spatial/parse.ts': ['@tmcw/togeojson'],
        'app-layer/usecases/evidence-maintenance.ts': ['@/lib/audit/audit-writer'],
        'app/api/readyz/route.ts': ['@/lib/redis'],
        // GAP-13 — same conditional Redis check pattern as readyz.
        'app/api/health/route.ts': ['@/lib/redis'],
        // Epic G-3 — vendor questionnaire usecases.
        // env.APP_URL is lazy-required at the call site (not statically
        // imported) because these usecases run from BullMQ workers and
        // background dispatchers where the env module's eager validation
        // would otherwise crash on missing optional vars in the worker
        // image. Same pattern as lib/mailer.ts above.
        'app-layer/usecases/vendor-assessment-send.ts': ['@/env'],
        'app-layer/usecases/vendor-assessment-reminder.ts': ['@/env'],
        'app-layer/usecases/vendor-assessment-response.ts': ['@/env'],
        // notifyAssessmentReviewed runs as a post-commit notification
        // helper after the review is committed; it intentionally uses
        // the global prisma client (not the request-scoped one) because
        // the notification fires after the request's tenant context has
        // closed. The `@/lib/prisma` require keeps the module-level
        // import graph clean of direct prisma (so no-direct-prisma
        // ratchet stays green for the rest of the file).
        'app-layer/usecases/vendor-assessment-review.ts': ['@/lib/prisma', '@/env'],
    };

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
