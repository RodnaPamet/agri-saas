import * as fs from 'fs';
import * as path from 'path';

/**
 * CSP Script Guardrails — CI regression scanner.
 *
 * These tests scan the src/ tree for patterns that would require
 * `unsafe-inline` or `unsafe-eval` in the Content-Security-Policy.
 * If any pattern is introduced, these tests fail and block the build.
 *
 * This is a defense-in-depth layer — the CSP header itself will block
 * execution at runtime, but catching violations at CI time is faster
 * and produces better developer error messages.
 */

const SRC_DIR = path.resolve(__dirname, '../../src');

// Dub-ported files with known CSP patterns that are safe in context
const CSP_ALLOWLIST = new Set([
    'components/ui/form.tsx', // Dub-ported — dangerouslySetInnerHTML for pre-sanitized helpText
    // Epic 45.2 — policy detail renders the published HTML body. The
    // body is sanitised twice (server-side on write via
    // `sanitizePolicyContent('HTML', …)` AND client-side on render via
    // `sanitizeRichTextHtml(...)` — defence in depth). Both calls
    // funnel through the same DOMPurify allowlist; widening the
    // allowlist requires a security review.
    'app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
    // Field-journal detail renders the entry's rich-text notes. Same
    // defence-in-depth as the policy body: notes are sanitised
    // server-side on write (`sanitizeRichTextHtml` at the usecase
    // boundary) AND client-side on render via `sanitizeRichTextHtml(...)`
    // before `dangerouslySetInnerHTML`. Both calls funnel through the
    // same allowlist; widening it requires a security review.
    'app/t/[tenantSlug]/(app)/journal/[id]/page.tsx',
    // Knowledge Base article detail renders the published version body
    // (the Policy detail's twin). Same defence-in-depth: the body is
    // sanitised server-side on write (`sanitizeRichTextHtml` at the
    // knowledge usecase boundary) AND client-side on render via
    // `sanitizeRichTextHtml(...)` before `dangerouslySetInnerHTML`. Both
    // calls funnel through the same DOMPurify allowlist; widening it
    // requires a security review.
    'app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx',
    // W5 final task (2026-08-09) — the satellite-imagery guide renders
    // the GLOBAL article's HTML body in place of its old hardcoded i18n
    // text. Same defence-in-depth as the knowledge detail page above:
    // sanitised server-side on write (`sanitizeRichTextHtml` in
    // `scripts/rag/ingest-satellite-guide.ts`) AND client-side on render
    // via `sanitizeRichTextHtml(...)` before `dangerouslySetInnerHTML`.
    // Both calls funnel through the same DOMPurify allowlist; widening
    // it requires a security review.
    'app/t/[tenantSlug]/(app)/knowledge/satellite/page.tsx',
    // 2026-05-14 — CSP `strict-dynamic` webpack chunk loader bridge.
    // The root layout renders an inline <script nonce={nonce}> that
    // sets `__webpack_nonce__` so webpack stamps the same nonce on
    // every dynamic chunk it injects (R16 charts, code-split
    // components). The script is:
    //   • Always nonced (CSP allows it via the per-request nonce).
    //   • Deterministic — body is `__webpack_nonce__='<nonce>'` with
    //     JSON.stringify-escaped nonce; no user input, no XSS surface.
    //   • Load-bearing — without it, strict-dynamic blocks every
    //     `_next/static/chunks/*.js` URL and the app is broken.
    // The shape is locked by tests/guards/csp-webpack-nonce-bridge.test.ts.
    'app/layout.tsx',
]);

// ── Helpers ──────────────────────────────────────────────────────────

function collectFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules and .next
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            results.push(...collectFiles(fullPath, extensions));
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

interface Violation {
    file: string;
    line: number;
    pattern: string;
    content: string;
}

function scanForPatterns(
    files: string[],
    patterns: { name: string; regex: RegExp }[]
): Violation[] {
    const violations: Violation[] = [];

    for (const file of files) {
        const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');
        if (CSP_ALLOWLIST.has(relPath)) continue;

        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip comments (rough heuristic — catches //, /*, and * lines)
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            for (const { name, regex } of patterns) {
                if (regex.test(line)) {
                    violations.push({
                        file: relPath,
                        line: i + 1,
                        pattern: name,
                        content: trimmed.substring(0, 120),
                    });
                }
            }
        }
    }

    return violations;
}

// ── Patterns that require unsafe-inline ──

const UNSAFE_INLINE_PATTERNS = [
    {
        name: 'inline-event-handler',
        regex: /\bon(?:click|load|error|submit|change|focus|blur|mouse\w+|key\w+)\s*=\s*["']/i,
    },
    {
        name: 'javascript-uri',
        regex: /href\s*=\s*["']javascript:/i,
    },
    {
        name: 'dangerouslySetInnerHTML',
        regex: /dangerouslySetInnerHTML/,
    },
    {
        name: 'document.write',
        regex: /document\.write\s*\(/,
    },
    {
        name: 'innerHTML-assignment',
        regex: /\.innerHTML\s*=/,
    },
];

// ── Patterns that require unsafe-eval ──

const UNSAFE_EVAL_PATTERNS = [
    {
        name: 'eval()',
        regex: /\beval\s*\(/,
    },
    {
        name: 'new-Function',
        regex: /new\s+Function\s*\(/,
    },
    {
        name: 'setTimeout-string',
        regex: /setTimeout\s*\(\s*["'`]/,
    },
    {
        name: 'setInterval-string',
        regex: /setInterval\s*\(\s*["'`]/,
    },
];

// ── Patterns for dynamic script injection ──

const DYNAMIC_SCRIPT_PATTERNS = [
    {
        name: 'createElement-script',
        regex: /createElement\s*\(\s*['"]script/,
    },
];

// ── Tests ────────────────────────────────────────────────────────────

describe('CSP Script Guardrails', () => {
    const tsxFiles = collectFiles(SRC_DIR, ['.ts', '.tsx', '.js', '.jsx']);

    describe('unsafe-inline patterns', () => {
        it('should not contain any inline event handlers, javascript: URIs, dangerouslySetInnerHTML, document.write, or innerHTML assignments', () => {
            const violations = scanForPatterns(tsxFiles, UNSAFE_INLINE_PATTERNS);

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}:${v.line} [${v.pattern}] ${v.content}`)
                    .join('\n');
                fail(
                    `Found ${violations.length} pattern(s) requiring unsafe-inline in CSP:\n${report}\n\n` +
                    'These patterns violate Content-Security-Policy. ' +
                    'Use React event handlers, external scripts with nonce, or framework-safe alternatives.'
                );
            }
        });
    });

    describe('unsafe-eval patterns', () => {
        it('should not contain eval(), new Function(), or string-based setTimeout/setInterval', () => {
            const violations = scanForPatterns(tsxFiles, UNSAFE_EVAL_PATTERNS);

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}:${v.line} [${v.pattern}] ${v.content}`)
                    .join('\n');
                fail(
                    `Found ${violations.length} pattern(s) requiring unsafe-eval in CSP:\n${report}\n\n` +
                    'These patterns violate Content-Security-Policy. ' +
                    'Use direct function references instead.'
                );
            }
        });
    });

    describe('dynamic script injection', () => {
        it('should not dynamically create script elements', () => {
            const violations = scanForPatterns(tsxFiles, DYNAMIC_SCRIPT_PATTERNS);

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}:${v.line} [${v.pattern}] ${v.content}`)
                    .join('\n');
                fail(
                    `Found ${violations.length} dynamic script injection pattern(s):\n${report}\n\n` +
                    'Dynamically created scripts will be blocked by CSP unless they carry the request nonce. ' +
                    'Use next/script with the nonce prop or load scripts at build time.'
                );
            }
        });
    });
});

describe('CSP Production Header', () => {
    it('production script-src does not contain unsafe-inline', () => {
        // style-src intentionally allows 'unsafe-inline' (see
        // csp-style-guardrails.test.ts). script-src must never.
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false); // production
        const scriptSrc = csp.split(';').find((d: string) => d.trim().startsWith('script-src'))!;
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    it('production CSP does not contain unsafe-eval', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false); // production
        expect(csp).not.toContain("'unsafe-eval'");
    });

    it('production script-src uses nonce + strict-dynamic only', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false);

        // Extract script-src directive
        const scriptSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('script-src'));

        expect(scriptSrc).toBeDefined();
        expect(scriptSrc).toContain("'self'");
        expect(scriptSrc).toContain(`'nonce-${nonce}'`);
        expect(scriptSrc).toContain("'strict-dynamic'");
        // Must not have any unsafe directives
        expect(scriptSrc).not.toContain('unsafe-');
    });

    it('dev CSP allows unsafe-eval for HMR but NOT unsafe-inline in script-src', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, true); // development

        const scriptSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('script-src'));

        expect(scriptSrc).toContain("'unsafe-eval'"); // HMR requirement
        expect(scriptSrc).not.toContain("'unsafe-inline'"); // NEVER in script-src
    });
});
