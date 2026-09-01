import { generateNonce, buildCspHeader, CSP_NONCE_HEADER } from '../../src/lib/security/csp';

describe('CSP Module', () => {
    describe('generateNonce', () => {
        it('returns a base64 string of expected length', () => {
            const nonce = generateNonce();
            // 16 bytes → 24 chars base64
            expect(typeof nonce).toBe('string');
            expect(nonce.length).toBe(24);
            // Validate base64 charset
            expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
        });

        it('produces unique values per call', () => {
            const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
            // All 100 should be unique (collision probability is astronomically low)
            expect(nonces.size).toBe(100);
        });
    });

    describe('buildCspHeader', () => {
        const nonce = generateNonce();

        it('includes nonce in script-src', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).toContain(`'nonce-${nonce}'`);
            expect(csp).toContain('script-src');
        });

        it('style-src uses unsafe-inline (no nonce)', () => {
            // Nonce in style-src invalidates 'unsafe-inline' per CSP L3,
            // which would block every `style=""` attribute. Drop the
            // nonce; <style> tags are already kept out by the style
            // guardrail.
            const csp = buildCspHeader(nonce);
            const styleSrc = csp.split(';').find(d => d.trim().startsWith('style-src'))!;
            expect(styleSrc).toContain("'unsafe-inline'");
            expect(styleSrc).not.toContain(`'nonce-${nonce}'`);
        });

        it('includes strict-dynamic for script-src', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).toContain("'strict-dynamic'");
        });

        it('does NOT include unsafe-eval in production mode', () => {
            const csp = buildCspHeader(nonce, false);
            expect(csp).not.toContain("'unsafe-eval'");
        });

        it('does NOT include unsafe-inline in script-src in production mode', () => {
            const csp = buildCspHeader(nonce, false);
            const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'));
            expect(scriptSrc).not.toContain("'unsafe-inline'");
        });

        it('DOES include unsafe-inline in style-src in production mode', () => {
            // Style attributes can't be nonced (per CSP L3), so we
            // accept 'unsafe-inline' on style-src. <style> tags stay
            // nonce-gated because nonce takes precedence there.
            const csp = buildCspHeader(nonce, false);
            const styleSrc = csp.split(';').find(d => d.trim().startsWith('style-src'));
            expect(styleSrc).toContain("'unsafe-inline'");
        });

        it('includes unsafe-eval in development mode for HMR', () => {
            const csp = buildCspHeader(nonce, true);
            expect(csp).toContain("'unsafe-eval'");
        });

        it('includes unsafe-inline for style-src in development mode', () => {
            const csp = buildCspHeader(nonce, true);
            // style-src should have unsafe-inline for dev
            const styleSrc = csp.split(';').find(d => d.trim().startsWith('style-src'));
            expect(styleSrc).toContain("'unsafe-inline'");
        });

        it('includes all required security directives', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).toContain("default-src 'self'");
            expect(csp).toContain("object-src 'none'");
            expect(csp).toContain("base-uri 'self'");
            expect(csp).toContain("frame-ancestors 'none'");
            expect(csp).toContain("form-action 'self'");
        });

        it('allows NO third-party stylesheet origin — fonts are self-hosted (#779)', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).not.toContain('https://fonts.googleapis.com');
        });

        it('allows NO third-party font origin — fonts are self-hosted (#779)', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).not.toContain('https://fonts.gstatic.com');
        });

        it("font-src is 'self' + data: only", () => {
            // The positive half. `not.toContain` alone would also pass if
            // font-src vanished entirely, which would break every face.
            const csp = buildCspHeader(nonce);
            const fontSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('font-src'));
            expect(fontSrc).toBe("font-src 'self' data:");
        });

        it('allows blob: in connect-src for PDF downloads', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).toContain('blob:');
        });

        it('includes report-uri for violation reporting', () => {
            const csp = buildCspHeader(nonce);
            expect(csp).toContain('report-uri');
            expect(csp).toContain('/api/security/csp-report');
        });

        it('includes upgrade-insecure-requests in production', () => {
            const csp = buildCspHeader(nonce, false);
            expect(csp).toContain('upgrade-insecure-requests');
        });

        it('omits upgrade-insecure-requests in development', () => {
            const csp = buildCspHeader(nonce, true);
            expect(csp).not.toContain('upgrade-insecure-requests');
        });

        it('allows WebSocket connections in development mode', () => {
            const csp = buildCspHeader(nonce, true);
            expect(csp).toContain('ws://localhost:*');
        });
    });

    describe('CSP_NONCE_HEADER', () => {
        it('is the expected header name', () => {
            expect(CSP_NONCE_HEADER).toBe('x-csp-nonce');
        });
    });
});
