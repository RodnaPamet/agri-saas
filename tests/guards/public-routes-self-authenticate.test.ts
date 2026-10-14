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
import { isPublicPath } from '../../src/lib/auth/guard';

const ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(ROOT, 'src/app/api');

/** Header reads that mean "this route carries its own credential". */
const CREDENTIAL_HEADERS =
    /get\(\s*['"](stripe-signature|x-av-signature|x-hub-signature[^'"]*|x-signature|x-webhook-signature|x-seed-token|x-platform-admin-key|authorization)['"]\s*\)/i;

/** Calls that mean "this route verifies that credential". */
const VERIFIES =
    /constructWebhookEvent|verifySignature|verifyResendSignature|timingSafeEqual|authenticateScimRequest|verifyPlatformApiKey|processIncomingWebhook|verifyApiKey|STAGING_SEED_TOKEN/;

function routeFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
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

/**
 * Reachability is asked of the REAL `isPublicPath`, not re-derived from source.
 *
 * This used to regex the `PUBLIC_PATH_PREFIXES` array out of `guard.ts` and
 * re-implement the prefix test locally. Two problems, and #704 hit the first:
 *
 *   1. The regex captured STRING LITERALS only (`/^\s*'([^']+)',/`). An entry
 *      spelled as an imported constant was invisible to it — so a path that
 *      genuinely IS public read as unreachable, and this guard failed on a
 *      correct fix. Spelling an entry as a constant is the better practice
 *      (`CSP_REPORT_PATH` is the same value that goes into three response
 *      headers, so a literal here could drift from what browsers are told);
 *      a guard that punishes it is the thing to change.
 *   2. A local re-implementation of a rule is a mirror that can fall out of
 *      sync with the original. `isPublicPath` also honours `PUBLIC_PATH_EXACT`
 *      and `STATIC_EXTENSIONS`, neither of which the mirror knew about.
 *
 * Calling the real function is strictly stronger AND it makes this file
 * partly an EXECUTING test rather than pure source-text matching. The
 * resolving-power check below replaces the old "guard is inert" throw.
 */
function isPublic(p: string): boolean {
    return isPublicPath(p);
}

describe('credential-verifying routes are reachable, and public routes verify', () => {
    const files = routeFiles(API_DIR);

    it('scans a real route tree, and isPublicPath still discriminates', () => {
        expect(files.length).toBeGreaterThan(100);
        // Resolving power, replacing the old "PUBLIC_PATH_PREFIXES not found"
        // throw: an `isPublicPath` that answered true (or false) to everything
        // would make both assertions below vacuous rather than red.
        expect(isPublicPath('/api/auth/session')).toBe(true);
        expect(isPublicPath('/api/t/acme/journal')).toBe(false);
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
            if (!isPublic(p)) {
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
            '/api/public/eik-check':
                'P3.7 — anonymous by design: it runs while someone types their ЕИК into the ' +
                'registration form, before an account exists. Returns {valid, looksLikeEgn, ' +
                'registryName} and nothing else; reads no tenant data. `valid` is a checksum ' +
                'the caller could compute offline, and `registryName` is null for a natural ' +
                'person or sole trader (ADR 0002 OD2: a 9-digit БУЛСТАТ can itself be personal ' +
                'data), so what it discloses is bounded to legal entities. Rate-limited with ' +
                'PUBLIC_READ_LIMIT, which is the control here because uniformity cannot be — ' +
                'telling a typo from an unregistered company IS the feature.',
            '/api/public/farms':
                'P6.8 — anonymous by design, and the design IS the product: a stranger '
                + 'holding a shared link or scanning a printed QR code browses the directory '
                + 'with no account, which is what a public directory means. It verifies no '
                + 'credential because there is none to verify.\n\n'
                + 'What it discloses is bounded by the TABLE rather than by this route. It '
                + 'reads one parameterised query against `PublicFarmProfile`, which has no '
                + 'PII columns at all — ЕГН, ЕИК, address, municipality and settlement live '
                + 'on `FarmProfile` and have no counterpart there — and no `tenantId`, so '
                + 'there is nothing to join through even by accident. Every row it can see '
                + 'belongs to a farm that chose to publish: a projection row EXISTS only '
                + 'while published, because withdrawing DELETES it rather than flagging it.\n\n'
                + 'It is not an enumeration oracle, and the reason is structural rather than '
                + 'a uniform response: there is no hidden population to enumerate. An '
                + 'unpublished farm has no row, so no query shape can distinguish "not '
                + 'published" from "does not exist" — the same property that makes '
                + '`/f/[handle]` return one 404 for both.\n\n'
                + 'Rate-limited at the EDGE by the public-read tier (60/min per IP), which '
                + 'is also P6.10\u2019s requirement that the 61st anonymous request in a '
                + 'minute gets 429. At the edge rather than in the handler because a trigram '
                + 'search is a database read, so a flood should cost a comparison and not a '
                + 'query. Results are capped at 50 and the endpoint is deliberately not '
                + 'pageable: a visitor who needs more narrows by oblast or crop.',
            '/api/public/notices':
                'P5.2 — anonymous by design, and by LEGAL DUTY. DSA Art 16 requires a '
                + 'mechanism any person or entity can use to notify illegal content, so '
                + 'requiring an account would be requiring an account to exercise a right. '
                + 'It verifies no credential because it accepts a body from nobody. What it '
                + 'discloses is nothing: the response is {id, status} and never says whether '
                + 'the subject existed, because a form that told a real listing id from a '
                + 'made-up one would be an enumeration oracle on an unauthenticated route — '
                + 'SUBJECT_NOT_FOUND goes to the snapshot for the moderator instead. There is '
                + 'no GET here, and an anonymous notice stores reporterUserId NULL, so the '
                + 'reporter read arm (which matches app.user_id) can never return it. '
                + 'Rate-limited with PUBLIC_NOTICE_LIMIT at 10/min per IP, tightened from the '
                + '60/min default because a notice flood buries real notices in the triage '
                + 'queue.',
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
            if (!isPublic(p)) continue;
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
            '/api/webhooks/resend',
        ]) {
            expect(isPublic(p)).toBe(true);
        }
    });

    it('the detector discriminates — it is not matching everything', () => {
        // Mutation proof for the regexes themselves.
        expect(CREDENTIAL_HEADERS.test("req.headers.get('stripe-signature')")).toBe(true);
        expect(CREDENTIAL_HEADERS.test("req.headers.get('content-type')")).toBe(false);
        expect(VERIFIES.test('constructWebhookEvent(body, sig)')).toBe(true);
        expect(VERIFIES.test('processIncomingWebhook({provider, rawBody})')).toBe(true);
        // Added with the Resend bounce feed (#1753). `verifyResendSignature`
        // does NOT contain `verifySignature` as a substring, so the route read
        // as anonymous under assertion B until the name was listed — the guard
        // caught it, and widening the detector is the precedent this file sets
        // for itself above (`/api/staging/seed`).
        expect(VERIFIES.test('verifyResendSignature({ rawBody, secret })')).toBe(true);
        expect(VERIFIES.test('JSON.parse(body)')).toBe(false);
        expect(VERIFIES.test('await prisma.user.findMany()')).toBe(false);
    });
});
