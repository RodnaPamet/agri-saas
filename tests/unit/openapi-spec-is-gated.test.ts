/* eslint-disable @typescript-eslint/no-explicit-any -- route handlers are
 * invoked with the Next-shaped signature; the codebase's standard disable. */
/**
 * The OpenAPI document is served by a SESSION-GATED route, not from public/.
 *
 * #944: the spec described zero endpoints, so nothing was exposed by it being
 * anonymous. Filling it in changes that — a complete spec is a complete map of
 * the API surface, and publishing one anonymously is a decision rather than a
 * side effect of fixing the generator. The product owner chose to gate it.
 *
 * WHY THE FILE MOVED rather than the gate being added where it was: a file in
 * `public/` is served by Next's static handler BEFORE any application code
 * runs. It is not covered by `src/middleware.ts`, not referenced by
 * `isPublicPath`, and not gated by the Caddyfile. There is no way to gate it
 * in place — the only honest fix is for it to stop being a public file.
 *
 * The gate itself is the middleware's, deliberately: it verifies the JWT for
 * every API route outside `PUBLIC_PATH_PREFIXES` and answers an
 * unauthenticated one with 401 JSON. So the assertions here are (a) the route
 * serves the spec, and (b) the route is NOT public — which is what makes the
 * middleware's gate apply to it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/auth/guard';
import { GET } from '@/app/api/openapi/route';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('the OpenAPI spec is no longer an anonymous static file', () => {
    it('is NOT in public/', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'public/openapi.json'))).toBe(false);
    });

    it('is generated somewhere the static handler cannot reach', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'src/generated/openapi.json'))).toBe(true);
    });

    it('the serving route is NOT public, so the middleware gate applies', () => {
        // The whole gate. If this path were public the route would be exactly
        // as anonymous as the file it replaced.
        expect(isPublicPath('/api/openapi')).toBe(false);
    });

    // CONTROL — the check can distinguish, or the assertion above proves
    // nothing about this path in particular.
    it('CONTROL: isPublicPath still reports a genuinely public path as public', () => {
        expect(isPublicPath('/api/health')).toBe(true);
    });
});

describe('GET /api/openapi', () => {
    it('serves the generated document', async () => {
        const res = await (GET as any)(
            new NextRequest('https://app.agrent.bg/api/openapi', { method: 'GET' }),
            { params: Promise.resolve({}) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.openapi).toBe('3.1.0');
        expect(body.info?.title).toBe('Agrent API');
    });

    it('is never stored in a shared cache — it is per-session gated', async () => {
        const res = await (GET as any)(
            new NextRequest('https://app.agrent.bg/api/openapi', { method: 'GET' }),
            { params: Promise.resolve({}) },
        );
        const cc = res.headers.get('cache-control') ?? '';
        expect(cc).toContain('no-store');
        expect(cc).toContain('private');
    });
});
