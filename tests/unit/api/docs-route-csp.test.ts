/**
 * The interactive API-docs page must actually execute (#798).
 *
 * WHY THIS IS NOT A GUARD TEST. A structural check for `nonce=` in the
 * source would have passed over the previous implementation the moment
 * anyone added a nonce to ONE of the three scripts, and would never have
 * caught the original defect at all — the page returned HTTP 200 with
 * well-formed HTML while every script was blocked, so "renders" and
 * "returns 200" were the same observation. These tests parse the actual
 * response body and assert on the relationship between the nonce in the
 * markup and the nonce supplied to that request.
 *
 * The relationship is the point. Asserting "some nonce is present" would
 * pass on a hard-coded string; asserting the nonce MATCHES the one the
 * middleware set for this request is what proves the page would run.
 */
import { NextRequest } from 'next/server';

const headerStore = { nonce: null as string | null };

jest.mock('next/headers', () => ({
    headers: async () => ({
        get: (k: string) => (k === 'x-csp-nonce' ? headerStore.nonce : null),
    }),
}));

function setEnv(v: string) {
    Object.defineProperty(process.env, 'NODE_ENV', { value: v, configurable: true });
}

const ORIGINAL_ENV = process.env.NODE_ENV;
afterAll(() => setEnv(ORIGINAL_ENV as string));

async function getPage(): Promise<Response> {
    const { GET } = await import('@/app/api/docs/route');
    return (await GET(
        new NextRequest('http://localhost:3000/api/docs'),
        { params: Promise.resolve({}) } as never,
    )) as unknown as Response;
}

/**
 * Every `<script>` tag in the markup, with its nonce (or null).
 *
 * Case-INSENSITIVE deliberately. A case-sensitive matcher would find zero
 * tags against `<SCRIPT>` markup, and "every script carries the nonce" is
 * vacuously true of an empty list — the loop below would simply not run. The
 * `expect(found.length).toBe(3)` guard already catches that, but a matcher
 * that cannot see a tag it is meant to audit is the wrong primitive to build
 * on. (CodeQL flags the case-sensitive form as `js/bad-tag-filter`.)
 */
function scripts(html: string): Array<{ tag: string; nonce: string | null; src: string | null }> {
    return [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => {
        const attrs = m[1];
        return {
            tag: m[0],
            nonce: /\bnonce="([^"]+)"/i.exec(attrs)?.[1] ?? null,
            src: /\bsrc="([^"]+)"/i.exec(attrs)?.[1] ?? null,
        };
    });
}

describe('GET /api/docs — the page must be able to execute', () => {
    beforeEach(() => {
        jest.resetModules();
        headerStore.nonce = null;
        setEnv('development');
    });

    it('nonces EVERY script with the nonce supplied to THAT request', async () => {
        headerStore.nonce = 'nonce-for-this-request-abc123';
        const res = await getPage();
        expect(res.status).toBe(200);
        const html = await res.text();

        const found = scripts(html);
        // Anti-vacuity: an empty list would satisfy "every script is nonced".
        expect(found.length).toBe(3);
        for (const s of found) {
            expect(s.nonce).toBe('nonce-for-this-request-abc123');
        }
    });

    it('re-reads the nonce per request rather than baking one in', async () => {
        headerStore.nonce = 'first-nonce';
        const a = await (await getPage()).text();
        headerStore.nonce = 'second-nonce';
        const b = await (await getPage()).text();

        expect(scripts(a).every((s) => s.nonce === 'first-nonce')).toBe(true);
        expect(scripts(b).every((s) => s.nonce === 'second-nonce')).toBe(true);
    });

    it('loads every script from our own origin — no third-party host', async () => {
        headerStore.nonce = 'n';
        const html = await (await getPage()).text();

        expect(html).not.toContain('cdn.jsdelivr.net');
        expect(html).not.toMatch(/<script[^>]+src="https?:\/\//);
        for (const s of scripts(html)) {
            if (s.src) expect(s.src.startsWith('/api/docs/assets/')).toBe(true);
        }
        expect(html).toContain('href="/api/docs/assets/swagger-ui.css"');
    });

    it('says so when the nonce is missing instead of serving a blank page', async () => {
        headerStore.nonce = null;
        const res = await getPage();
        // 503 + a diagnosis, NOT a 200 that renders empty — the original
        // defect was precisely a 200 that looked healthy.
        expect(res.status).toBe(503);
        const html = await res.text();
        expect(html).toContain('No CSP nonce');
        expect(html).not.toContain('SwaggerUIBundle(');
    });

    it.each(['production', 'test'])('hard-404s under NODE_ENV=%s', async (envName) => {
        setEnv(envName);
        headerStore.nonce = 'n';
        const res = await getPage();
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Not Found');
    });
});
