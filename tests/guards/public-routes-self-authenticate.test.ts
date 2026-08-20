/**
 * Two directions of one rule, and the repo has been bitten by both.
 *
 * **A. Every credential-verifying route must be REACHABLE.** A handler that
 * checks a signature or a bearer is useless if the Edge refuses the request
 * first. That is not hypothetical: SCIM, the `iflk_` API key, and all three
 * signed webhooks each shipped complete — minting, hashing, revocation,
 * tests — and each was answered `401 {"error":"Unauthorized"}` by
 * `unauthorizedJson()` before its handler ran. Six instances of one shape.
 *
 * **B. Every route behind a public prefix must AUTHENTICATE ITSELF.** The
 * fix for A opens the Edge, so B is what keeps that from being a hole.
 *
 * A guard for only one direction is worse than none: fixing A without B
 * turns dead endpoints into anonymous ones, and enforcing B without A
 * leaves the endpoints dead.
 *
 * Derived from the FILESYSTEM, so a route added tomorrow is covered the
 * moment it exists rather than when someone remembers this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(ROOT, 'src/app/api');

/** Header reads that mean "this route carries its own credential". */
const CREDENTIAL_HEADERS =
    /get\(\s*['"](stripe-signature|x-av-signature|x-hub-signature[^'"]*|x-signature|x-webhook-signature|x-seed-token|x-platform-admin-key|authorization)['"]\s*\)/i;

/** Calls that mean "this route verifies that credential". */
const VERIFIES =
    /constructWebhookEvent|verifySignature|timingSafeEqual|authenticateScimRequest|verifyPlatformApiKey|processIncomingWebhook|verifyApiKey|STAGING_SEED_TOKEN/;

function routeFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) routeFiles(full, acc);
        else if (entry.name === 'route.ts') acc.push(full);
    }
    return acc;
}

/** URL path for a route file, e.g. `/api/stripe/webhook`. */
function urlPath(file: string): string {
    const rel = path.relative(path.join(ROOT, 'src/app'), path.dirname(file));
    return '/' + rel.split(path.sep).join('/');
}

function publicPrefixes(): string[] {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/auth/guard.ts'), 'utf8');
    const block = src.match(/const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/);
    if (!block) throw new Error('PUBLIC_PATH_PREFIXES not found — this guard is inert; fix it.');
    return [...block[1].matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
}

/** Mirrors `isPublicPath`'s prefix test for the API surface. */
function isPublic(p: string, prefixes: string[]): boolean {
    return prefixes.some((prefix) => p.startsWith(prefix));
}

describe('credential-verifying routes are reachable, and public routes verify', () => {
    const files = routeFiles(API_DIR);
    const prefixes = publicPrefixes();

    it('scans a real route tree and a real prefix list', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(prefixes.length).toBeGreaterThan(5);
    });

    it('A — a route that reads a credential header is not refused by the Edge', () => {
        const unreachable: string[] = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            // Calling a verification function IS the signal. Requiring an
            // INLINE header read as well was too strict and produced a false
            // negative on a known instance: the platform-admin routes call
            // `verifyPlatformApiKey(req)` and let the helper read
            // `x-platform-admin-key`, so they were skipped entirely — by a
            // guard written to catch exactly that bug. The header pattern is
            // now an OR, widening the net rather than narrowing it.
            if (!VERIFIES.test(src) && !CREDENTIAL_HEADERS.test(src)) continue;
            const p = urlPath(file);
            if (!isPublic(p, prefixes)) {
                unreachable.push(`${p}  (${path.relative(ROOT, file)})`);
            }
        }
        if (unreachable.length > 0) {
            throw new Error(
                `${unreachable.length} route(s) verify their own credential but are ` +
                    `refused at the Edge before the handler runs:\n  ` +
                    unreachable.join('\n  ') +
                    `\n\nThe middleware calls getToken(), which understands only a NextAuth ` +
                    `session cookie. A Stripe signature / HMAC / opaque bearer yields null ` +
                    `and the request is 401'd — so the verification below never executes. ` +
                    `This exact shape shipped six times (token.error, iflk_, SCIM, and three ` +
                    `webhooks).\n\nEither add the path to PUBLIC_PATH_PREFIXES (and keep ` +
                    `assertion B below true), or delete the credential check as dead code.`,
            );
        }
        expect(unreachable).toEqual([]);
    });

    it('B — every API route behind a public prefix authenticates itself', () => {
        // The compensating half. Opening the Edge is only safe while this
        // holds; a new route dropped under an opened prefix is anonymous.
        const EXEMPT: Record<string, string> = {
            '/api/health': 'liveness probe — no data, operators need it during an incident',
            '/api/livez': 'liveness probe — as above',
            '/api/readyz': 'readiness probe — as above',
            '/api/metrics': 'anonymous RUM beacon sink, by design',
            '/api/scim/v2/ServiceProviderConfig':
                'RFC 7644 §4 discovery metadata — static capability flags, no DB, read before a token exists',
        };
        // NOTE: /api/staging/seed and /api/integrations/webhooks/[provider]
        // are NOT exempt — they authenticate (an x-seed-token comparison
        // against STAGING_SEED_TOKEN, and processIncomingWebhook returning
        // `auth_failed`). Both were flagged when this guard was first run and
        // the DETECTOR was widened rather than the routes excused: an
        // exemption would have hidden the next genuinely-anonymous route
        // added under either prefix.
        const anonymous: string[] = [];
        for (const file of files) {
            const p = urlPath(file);
            if (!isPublic(p, prefixes)) continue;
            // Auth.js's own routes and the invite//register flows are the
            // session-establishing surface; they are public by definition.
            if (p.startsWith('/api/auth') || p.startsWith('/api/invites') || p.startsWith('/api/org/invite')) continue;
            if (EXEMPT[p]) continue;
            const src = fs.readFileSync(file, 'utf8');
            if (!VERIFIES.test(src)) {
                anonymous.push(`${p}  (${path.relative(ROOT, file)})`);
            }
        }
        if (anonymous.length > 0) {
            throw new Error(
                `${anonymous.length} route(s) sit behind a PUBLIC prefix without verifying ` +
                    `anything:\n  ` +
                    anonymous.join('\n  ') +
                    `\n\nThe middleware does not authenticate these — they are reachable ` +
                    `anonymously from the internet. Verify a credential in the handler, or ` +
                    `add an entry to EXEMPT with a written reason saying what it returns ` +
                    `and why that is harmless.`,
            );
        }
        expect(anonymous).toEqual([]);
    });

    it('the three webhooks specifically are now reachable', () => {
        // Named, because they are the instances this guard was written for
        // and a regression on them is the one worth failing loudly.
        for (const p of [
            '/api/stripe/webhook',
            '/api/storage/av-webhook',
            '/api/integrations/webhooks/slack',
        ]) {
            expect(isPublic(p, prefixes)).toBe(true);
        }
    });

    it('the detector discriminates — it is not matching everything', () => {
        // Mutation proof for the regexes themselves.
        expect(CREDENTIAL_HEADERS.test("req.headers.get('stripe-signature')")).toBe(true);
        expect(CREDENTIAL_HEADERS.test("req.headers.get('content-type')")).toBe(false);
        expect(VERIFIES.test('constructWebhookEvent(body, sig)')).toBe(true);
        expect(VERIFIES.test('processIncomingWebhook({provider, rawBody})')).toBe(true);
        expect(VERIFIES.test('JSON.parse(body)')).toBe(false);
        expect(VERIFIES.test('await prisma.user.findMany()')).toBe(false);
    });
});
