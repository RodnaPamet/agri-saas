import * as fs from 'fs';
import * as path from 'path';

/**
 * CSP Style Guardrails — CI regression scanner.
 *
 * These tests enforce that specific style-related CSP violations
 * do not regress into the codebase. They complement the runtime CSP
 * header which blocks violations in the browser.
 *
 * What IS blocked:
 *   - <style> tags without nonce (use globals.css or CSS modules instead)
 *   - Inline style attributes in global-error.tsx (must use CSS module)
 *   - CSS-in-JS runtime injections (styled-components, emotion, etc.)
 *
 * What is ALLOWED:
 *   - React `style={{}}` props anywhere — style-src is set to
 *     `'self' 'unsafe-inline' https://fonts.googleapis.com` (no
 *     nonce), because per CSP L3 a nonce on style-src invalidates
 *     'unsafe-inline' and blocks every SSR `style=""` attribute.
 *     <style> tags are kept out of the codebase by the guardrails
 *     below, and script-src remains strict (nonce + strict-dynamic).
 */

const SRC_DIR = path.resolve(__dirname, '../../src');

function collectFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            results.push(...collectFiles(fullPath, extensions));
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('CSP Style Guardrails', () => {
    const tsxFiles = collectFiles(SRC_DIR, ['.ts', '.tsx', '.js', '.jsx']);

    describe('<style> tags', () => {
        // Files that legitimately emit a <style> tag inside a server-side
        // string template (NOT JSX), where the CSP-style-src argument
        // doesn't apply. Each entry must be a server-only route, not a
        // React component.
        const STYLE_TAG_EXEMPTIONS = new Set([
            // GAP-10 — Swagger UI route returns a fully self-contained
            // HTML document (loads the Swagger UI CDN bundle). The page
            // is HARD 404'd in production by isDocsEnabled(), so the
            // <style> never reaches a prod browser; a CSP exemption for
            // dev/staging is acceptable.
            'app/api/docs/route.ts',
        ]);

        it('should not contain any <style> tags in JSX (use CSS files instead)', () => {
            const violations: { file: string; line: number; content: string }[] = [];

            for (const file of tsxFiles) {
                const rel = path.relative(SRC_DIR, file);
                if (STYLE_TAG_EXEMPTIONS.has(rel)) continue;
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    // Skip comments
                    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
                    // Match <style> or <style>{
                    if (/<style[\s>]/.test(lines[i]) && !lines[i].includes('</style>')) {
                        violations.push({
                            file: rel,
                            line: i + 1,
                            content: line.substring(0, 120),
                        });
                    }
                }
            }

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}:${v.line} ${v.content}`)
                    .join('\n');
                fail(
                    `Found ${violations.length} <style> tag(s) in JSX:\n${report}\n\n` +
                    'Inline <style> tags require unsafe-inline in style-src. ' +
                    'Move styles to globals.css, a CSS module, or a separate .css file.'
                );
            }
        });
    });

    describe('global-error.tsx', () => {
        it('should not use inline style attributes', () => {
            const errorFile = path.resolve(SRC_DIR, 'app/global-error.tsx');
            const content = fs.readFileSync(errorFile, 'utf-8');

            // The error boundary must NOT use style={{}} because it's a root boundary
            // that ships SSR HTML without hydration guarantees. Use CSS module instead.
            const styleProps = (content.match(/style=\{\{/g) || []).length;
            expect(styleProps).toBe(0);
        });

        it('should import a CSS module for styles', () => {
            const errorFile = path.resolve(SRC_DIR, 'app/global-error.tsx');
            const content = fs.readFileSync(errorFile, 'utf-8');
            expect(content).toContain("import styles from './global-error.module.css'");
        });
    });

    describe('CSS-in-JS libraries', () => {
        it('should not import CSS-in-JS runtime libraries', () => {
            const bannedImports = [
                'styled-components',
                '@emotion/react',
                '@emotion/styled',
                '@emotion/css',
                '@stitches/react',
            ];

            const violations: { file: string; lib: string }[] = [];

            for (const file of tsxFiles) {
                const content = fs.readFileSync(file, 'utf-8');
                for (const lib of bannedImports) {
                    if (content.includes(`from '${lib}'`) || content.includes(`from "${lib}"`)) {
                        violations.push({
                            file: path.relative(SRC_DIR, file),
                            lib,
                        });
                    }
                }
            }

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}: imports ${v.lib}`)
                    .join('\n');
                fail(
                    `Found CSS-in-JS library imports:\n${report}\n\n` +
                    'CSS-in-JS libraries inject <style> tags at runtime, requiring unsafe-inline. ' +
                    'Use Tailwind utilities, CSS modules, or globals.css instead.'
                );
            }
        });
    });

    describe('runtime stylesheet injection', () => {
        it('should not use CSSOM injection APIs', () => {
            const patterns = [
                { name: 'insertRule', regex: /\.insertRule\s*\(/ },
                { name: 'addRule', regex: /\.addRule\s*\(/ },
                { name: 'new CSSStyleSheet', regex: /new\s+CSSStyleSheet/ },
            ];

            const violations: { file: string; pattern: string; line: number }[] = [];

            for (const file of tsxFiles) {
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('//') || line.startsWith('*')) continue;
                    for (const { name, regex } of patterns) {
                        if (regex.test(lines[i])) {
                            violations.push({
                                file: path.relative(SRC_DIR, file),
                                pattern: name,
                                line: i + 1,
                            });
                        }
                    }
                }
            }

            if (violations.length > 0) {
                const report = violations
                    .map(v => `  ${v.file}:${v.line} [${v.pattern}]`)
                    .join('\n');
                fail(
                    `Found runtime stylesheet injection patterns:\n${report}\n\n` +
                    'Direct CSSOM injection bypasses CSP style-src. ' +
                    'Use CSS modules or Tailwind utilities instead.'
                );
            }
        });
    });
});

describe('CSP Production style-src', () => {
    it('production style-src allows unsafe-inline for dynamic style attributes', () => {
        // Nonces/hashes don't match `style=""` attributes (only <style>
        // tags), so progress-bar widths and colour-coded badges need
        // 'unsafe-inline'. CSS injection has far lower blast radius than
        // JS injection; script-src stays strict (nonce + strict-dynamic).
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false); // production

        const styleSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('style-src'));

        expect(styleSrc).toBeDefined();
        expect(styleSrc).toContain("'unsafe-inline'");
    });

    it('production style-src allows self but omits the nonce', () => {
        // A nonce on style-src would invalidate 'unsafe-inline' (per
        // CSP L3) and block every SSR `style=""` attribute.
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false);

        const styleSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('style-src'));

        expect(styleSrc).toContain("'self'");
        expect(styleSrc).not.toContain(`'nonce-${nonce}'`);
    });

    it('style-src allows NO third-party origin — fonts are self-hosted (#779)', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, false);

        const styleSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('style-src'));

        expect(styleSrc).toBeDefined();
        expect(styleSrc).not.toContain('https://');
        // Positive half — `not.toContain` would also pass over a missing or
        // empty directive, which would block the app's own stylesheets.
        expect(styleSrc).toContain("'self'");
    });

    it('dev style-src allows unsafe-inline for HMR style injection', () => {
        const { buildCspHeader, generateNonce } = require('../../src/lib/security/csp');
        const nonce = generateNonce();
        const csp: string = buildCspHeader(nonce, true); // dev

        const styleSrc = csp
            .split(';')
            .map((d: string) => d.trim())
            .find((d: string) => d.startsWith('style-src'));

        expect(styleSrc).toContain("'unsafe-inline'");
    });
});
