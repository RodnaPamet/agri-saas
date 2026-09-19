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


    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `collectFiles` to `[]` / `''` / `new Set()`
    // / `new Map()` and NO test failed: every scan below iterates
    // `tsxFiles` with a for-of, so an empty list means zero violations
    // and three green assertions. "Scanned 1960 files, found nothing"
    // and "scanned nothing" were the same green.

    it('control: collectFiles discovers the real src/ tree and recurses into it', () => {
        // Floor from a MEASURED count: this call returns 1960 files today
        // (1123 .ts + 837 .tsx; the tree carries no .js/.jsx). 800 sits far
        // below that, so ordinary feature PRs never touch it — it fires only
        // when discovery COLLAPSES. Asserted on `tsxFiles` itself, the value
        // the three scans consume, not on a fresh call.
        expect(tsxFiles.length).toBeGreaterThanOrEqual(800);
        expect(tsxFiles.every((f) => f.startsWith(SRC_DIR + path.sep))).toBe(true);
        expect(tsxFiles.every((f) => /\.(ts|tsx|js|jsx)$/.test(f))).toBe(true);

        // Recursion is the one behaviour a constant return cannot express:
        // a top-level-only walker still returns files. Measured max depth is
        // 11 segments, with 1087 files at >= 4.
        const depths = tsxFiles.map(
            (f) => path.relative(SRC_DIR, f).split(path.sep).length,
        );
        expect(Math.max(...depths)).toBeGreaterThanOrEqual(4);
        expect(depths.filter((d) => d >= 4).length).toBeGreaterThanOrEqual(100);

        // The extension list is an INPUT, not decoration: narrowing it must
        // narrow the result (837 .tsx of 1960 today).
        const tsxOnly = collectFiles(SRC_DIR, ['.tsx']);
        expect(tsxOnly.length).toBeGreaterThan(0);
        expect(tsxOnly.length).toBeLessThan(tsxFiles.length);
        expect(tsxOnly.every((f) => f.endsWith('.tsx'))).toBe(true);
    });

    it('control: collectFiles recurses, and its node_modules / .next skips bite', () => {
        // src/ contains no node_modules and no .next directory (measured:
        // zero), so those two `continue`s have no live instance to prove
        // themselves against. Build one. Asserted EXACTLY rather than as a
        // floor, so a top-level-only walk, a dropped skip and a vanished
        // extension filter each fail differently.
        const os = require('os');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-collect-files-'));
        try {
            fs.mkdirSync(path.join(root, 'deep', 'deeper'), { recursive: true });
            fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
            fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true });
            fs.writeFileSync(path.join(root, 'top.ts'), '');
            fs.writeFileSync(path.join(root, 'deep', 'deeper', 'nested.tsx'), '');
            fs.writeFileSync(path.join(root, 'notes.md'), '');
            fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'vendor.ts'), '');
            fs.writeFileSync(path.join(root, '.next', 'static', 'chunk.js'), '');

            const found = collectFiles(root, ['.ts', '.tsx', '.js', '.jsx'])
                .map((f) => path.relative(root, f).split(path.sep).join('/'))
                .sort();

            // nested.tsx is reachable only by recursing twice; vendor.ts and
            // chunk.js are inside the two skipped directories; notes.md fails
            // the extension filter.
            expect(found).toEqual(['deep/deeper/nested.tsx', 'top.ts']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

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


    it('control: scanForPatterns detects every shape it bans and ignores near-misses', () => {
        // `selector-teeth` (#971): gutting this function to [] / '' / 0 /
        // false / {} / Set / Map failed nothing, because all three call sites
        // only ask `violations.length > 0`. The scan returns 0 violations for
        // real input today, so "the detector works" and "the detector returns
        // a constant" are the same green. This exercises the mechanism.
        const os = require('os');
        const ALL_PATTERNS = [
            ...UNSAFE_INLINE_PATTERNS,
            ...UNSAFE_EVAL_PATTERNS,
            ...DYNAMIC_SCRIPT_PATTERNS,
        ];

        // One probe per banned pattern, keyed by the pattern's OWN name, so a
        // new pattern added without a probe fails here rather than shipping
        // an unexercised regex.
        const PROBES: Record<string, string> = {
            'inline-event-handler': '<div onClick="doThing()" />',
            'javascript-uri': '<a href="javascript:void(0)">x</a>',
            dangerouslySetInnerHTML: '<div dangerouslySetInnerHTML={{ __html: raw }} />',
            'document.write': "document.write('<b>hi</b>');",
            'innerHTML-assignment': 'node.innerHTML = raw;',
            'eval()': "eval('1 + 1');",
            'new-Function': "const f = new Function('return 1');",
            'setTimeout-string': "setTimeout('tick()', 100);",
            'setInterval-string': 'setInterval("tick()", 100);',
            'createElement-script': "document.createElement('script');",
        };
        const names = ALL_PATTERNS.map((p) => p.name);
        expect(Object.keys(PROBES).sort()).toEqual([...names].sort());

        // Near-misses the scanner must NOT report: the three comment forms its
        // heuristic skips, an innerHTML READ, a non-script createElement,
        // function-valued timers, and JSX handler/href props (no quote after
        // `=`). The comment lines also pin the skip's dangerous direction —
        // gutted TRUE it would swallow the probes above, which the gut set
        // never tries.
        const NEAR_MISSES = [
            '// dangerouslySetInnerHTML was removed here — prose only',
            '/* document.write("x") lives in a block comment */',
            " * eval('legacy') in a jsdoc continuation",
            'const current = node.innerHTML;',
            "const el = document.createElement('div');",
            'setTimeout(() => tick(), 100);',
            'setInterval(refresh, 1000);',
            '<button onClick={handleClick}>ok</button>',
            '<a href={hrefFromProps}>ok</a>',
        ];

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-scan-probe-'));
        try {
            const probeFile = path.join(dir, 'probe.tsx');
            fs.writeFileSync(probeFile, names.map((n) => PROBES[n]).join('\n'), 'utf-8');
            const found: Violation[] = scanForPatterns([probeFile], ALL_PATTERNS);

            // Exactly one hit per line, in line order — so a scanner that
            // stops at the first match, double-counts, or loses the `i + 1`
            // line accounting is caught as well as one returning a constant.
            expect(found.map((v) => v.pattern)).toEqual(names);
            expect(found.map((v) => v.line)).toEqual(names.map((_, i) => i + 1));

            const cleanFile = path.join(dir, 'near-miss.tsx');
            fs.writeFileSync(cleanFile, NEAR_MISSES.join('\n'), 'utf-8');
            // Paired with the positive IN THE SAME TEST on purpose: an empty
            // result alone is what every gut already produces, so it certifies
            // nothing standing by itself.
            expect(scanForPatterns([cleanFile], ALL_PATTERNS)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('control: CSP_ALLOWLIST suppresses real live violations, and carries nothing stale', () => {
        const os = require('os');
        const ALL_PATTERNS = [
            ...UNSAFE_INLINE_PATTERNS,
            ...UNSAFE_EVAL_PATTERNS,
            ...DYNAMIC_SCRIPT_PATTERNS,
        ];

        // src/ has no live NON-exempt instance of any banned shape by
        // construction — that is what this guard enforces — so the only real
        // product source available as a positive is what the allowlist
        // exempts. Scanning the same BYTES at a path the allowlist does not
        // key on is what separates "suppressed" from "never matched", and it
        // is also the only thing that catches a `has(...)` that answers true
        // for everything (a direction the falsy gut set never tries).
        //
        // Measured: 4 of the 5 entries carry a live `dangerouslySetInnerHTML`
        // (journal/[id]:467, knowledge/[id]:275, knowledge/satellite:199,
        // app/layout.tsx:178). `components/ui/form.tsx` carries NONE — Epic 55
        // replaced the call with plain text and left only a comment saying so
        // — so that entry is named here rather than silently counted.
        const COMMENT_ONLY = new Set(['components/ui/form.tsx']);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-allowlist-'));
        try {
            const livePositives: string[] = [];
            for (const rel of Array.from(CSP_ALLOWLIST)) {
                const abs = path.join(SRC_DIR, rel);
                expect(fs.existsSync(abs)).toBe(true);

                // In place: the allowlist key matches, nothing is reported.
                expect(scanForPatterns([abs], ALL_PATTERNS)).toEqual([]);

                // Same bytes, a path the allowlist does not key on.
                const copy = path.join(dir, rel.replace(/[^A-Za-z0-9.]/g, '_'));
                fs.writeFileSync(copy, fs.readFileSync(abs, 'utf-8'), 'utf-8');
                if (scanForPatterns([copy], ALL_PATTERNS).length > 0) {
                    livePositives.push(rel);
                }
            }

            // The only difference between the two scans is the allowlist, so
            // this is both the positive control (the detector DID find real
            // banned product source) and proof the exemption bites. A detector
            // gutted to a constant empties this set; an entry whose file stops
            // carrying the shape it exempts drops out of it.
            expect(livePositives.sort()).toEqual(
                Array.from(CSP_ALLOWLIST)
                    .filter((rel) => !COMMENT_ONLY.has(rel))
                    .sort(),
            );
            expect(livePositives.length).toBeGreaterThanOrEqual(2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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
