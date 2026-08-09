/**
 * Guardrail: Middleware security hardening scan.
 *
 * Ensures the middleware applies security headers and uses
 * the centralized CORS module (not inline permissive logic).
 */
import * as fs from 'fs';
import * as path from 'path';

const MIDDLEWARE_PATH = path.resolve(__dirname, '../../src/middleware.ts');

describe('Middleware security hardening', () => {
    let content: string;
    beforeAll(() => {
        content = fs.readFileSync(MIDDLEWARE_PATH, 'utf-8');
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
