/**
 * Guardrail: Middleware security hardening scan.
 *
 * Ensures the middleware applies security headers and uses
 * the centralized CORS module (not inline permissive logic).
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const MIDDLEWARE_PATH = path.resolve(__dirname, '../../src/middleware.ts');

/** src/middleware.ts is ~38 KB. A truncated read must fail, not pass a negated check. */
const MIDDLEWARE_MIN_BYTES = 10_000;

/**
 * The middleware source, comments blanked — and a NAMED selector, so
 * `scripts/selector-teeth` can reach this guard (#2483).
 *
 * Two assertions below are NEGATED, and **a negated assertion passes over an
 * empty string**: an unreadable or truncated read would report the permissive
 * localhost fallback and the wildcard CORS header absent having read nothing.
 * The three positive assertions happen to fail first today, which is
 * incidental coupling between tests rather than a control — split this file or
 * change those three and the negated pair stands alone.
 *
 * Comments are blanked because the negated patterns are precisely the OLD
 * VULNERABLE forms, which a comment explaining the fix would quote verbatim —
 * the test below does exactly that. Measured 2026-10-30: 0 prose hits in
 * src/middleware.ts for all five patterns, so this changes no verdict today
 * and removes a false positive a future explanatory comment would cause.
 */
export function readMiddlewareSource(): string {
    const raw = fs.readFileSync(MIDDLEWARE_PATH, 'utf-8');
    if (raw.length < MIDDLEWARE_MIN_BYTES) {
        throw new Error(
            `src/middleware.ts read as ${raw.length} bytes, under ${MIDDLEWARE_MIN_BYTES} — `
                + 'refusing to audit a truncated read, which would satisfy every negated check.',
        );
    }
    return blankNonCode(raw);
}

describe('Middleware security hardening', () => {
    const content = readMiddlewareSource();

    test('[middleware-security] the audited source is substantial — the denominator', () => {
        // Two assertions in this file are NEGATED, and a negated assertion
        // passes over an empty string. Gutting `readMiddlewareSource` to
        // `return ''` left exactly those two GREEN while the positive three
        // failed — so on their own they would report the permissive localhost
        // fallback and the wildcard CORS header absent having read nothing.
        //
        // This is the control that makes the negated pair mean something. The
        // size floor inside the selector covers a truncated read on disk; this
        // covers the population the assertions actually range over.
        console.log(`[middleware-security] ${content.length} byte(s) of middleware code audited`);
        expect(content.length).toBeGreaterThanOrEqual(MIDDLEWARE_MIN_BYTES);
        // ...and it is really middleware, not some other file that happens to
        // be long enough.
        expect(content).toContain('export');
    });

    test('middleware imports applySecurityHeaders', () => {
        expect(content).toContain('applySecurityHeaders');
    });

    test('middleware imports CORS module (not inline origin parsing)', () => {
        expect(content).toContain('resolveCorsConfig');
        expect(content).toContain('isOriginAllowed');
    });

    test('middleware does NOT contain permissive localhost fallback', () => {
        // The old vulnerable pattern: origin.startsWith('http://localhost:')
        expect(content).not.toContain("origin.startsWith('http://localhost:");
        expect(content).not.toContain('origin.startsWith("http://localhost:');
    });

    test('middleware does NOT set wildcard Access-Control-Allow-Origin', () => {
        expect(content).not.toContain("'Access-Control-Allow-Origin', '*'");
        expect(content).not.toContain('"Access-Control-Allow-Origin", "*"');
    });

    test('middleware applies CORS headers through centralized module', () => {
        expect(content).toContain('applyCorsHeaders');
    });
});
