/**
 * API-key authentication is on, and the things that make it safe stay wired.
 *
 * ## Why a guard rather than a comment
 *
 * A tenant API key (`iflk_…`) never authenticated a request from the day the
 * feature shipped until 2026-09-24: the Edge called `getToken()`, which ran an
 * `Authorization: Bearer` value through NextAuth's JWE decode, and an `iflk_`
 * token is not a JWE — so every request was 401'd before any handler, and
 * therefore before `verifyApiKey`, ran. Meanwhile the admin UI minted keys and
 * told operators to copy them.
 *
 * This guard was written while the switch was OFF, to make sure nobody flipped
 * it back on as a one-line change and shipped the same dead feature with a
 * flag that claimed it worked. Turning it on inverted its job: the four things
 * that had to exist now have to KEEP existing. Deleting the Edge carve-out
 * would not fail a type-check or a unit test — it would simply return the
 * feature to being dead, silently, which is exactly how it spent its first
 * life.
 *
 * Each assertion below names the specific failure it prevents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Re-read rather than imported, so the guard sees the SOURCE, not a bundle.
 *
 * The source is a PARAMETER with the real file as its default, so the parse
 * can be exercised both ways (#971). Without that it returns the switch's
 * actual value for every call, `return true` reproduces it exactly, and no
 * assertion can tell the implementation from a gutted one.
 */
function apiKeyAuthEnabled(src: string = read('src/lib/auth/api-key-availability.ts')): boolean {
    const m = src.match(/export const API_KEY_AUTH_ENABLED\s*=\s*(true|false)/);
    if (!m) {
        throw new Error(
            'API_KEY_AUTH_ENABLED not found in src/lib/auth/api-key-availability.ts. ' +
                'If the switch was renamed or removed, this guard is no longer protecting ' +
                'anything — update it in the same change.',
        );
    }
    return m[1] === 'true';
}

describe('the API-key feature switch', () => {
    it('control: the parse reports BOTH settings, not a constant', () => {
        expect(apiKeyAuthEnabled('export const API_KEY_AUTH_ENABLED = true;')).toBe(true);
        expect(apiKeyAuthEnabled('export const API_KEY_AUTH_ENABLED = false;')).toBe(false);
        expect(() => apiKeyAuthEnabled('export const SOMETHING_ELSE = true;')).toThrow(
            /API_KEY_AUTH_ENABLED not found/,
        );
    });

    it('control: the switch is currently ON, so the assertions below run', () => {
        // An honest record of today's value, and the line that forces this
        // file to be revisited if the feature is ever switched back off —
        // rather than its assertions quietly becoming no-ops.
        expect(apiKeyAuthEnabled()).toBe(true);
    });
});

describe('the Edge can actually admit an API key', () => {
    const middleware = read('src/middleware.ts');

    it('recognises an API-key bearer before the JWT gate', () => {
        // Without this the flag changes nothing at all: `getToken()` cannot
        // decode an `iflk_` token, so every request 401s before the handler.
        expect(/isApiKeyRateLimited|API_KEY_PREFIX|isApiKeyToken/.test(middleware)).toBe(true);
    });

    it('the carve-out is gated on the switch', () => {
        // So that turning the feature off closes the hole, rather than leaving
        // an unauthenticated path open and merely unreachable.
        expect(middleware).toContain('API_KEY_AUTH_ENABLED &&');
    });

    it('the carve-out rate-limits before letting the request through', () => {
        // The carve-out makes /api/t a surface where an ANONYMOUS caller
        // reaches a key-hash comparison. Unbudgeted that is a brute-force
        // oracle and unbounded database load.
        const start = middleware.indexOf('API_KEY_AUTH_ENABLED &&');
        expect(start).toBeGreaterThan(-1);
        const block = middleware.slice(start, start + 400);
        expect(block).toContain('checkApiKeyRateLimit');
        // The 429 must be returned, not merely computed.
        expect(block).toMatch(/return rl\.response/);
    });

    it('admits by the SAME predicate the limiter claims', () => {
        // A limiter narrower than the hole it defends is worse than none. One
        // definition, called by both, cannot drift.
        expect(middleware).toContain('isApiKeyRateLimited(pathname');
    });
});

describe('a key cannot reach more than its scopes name', () => {
    it('the per-request gate runs in getTenantCtx, which every tenant route reaches', () => {
        // NOT requirePermission: only ~23 of the 273 tenant routes use it. The
        // rest gate on `assertCanWrite`, which reads a role derived coarsely
        // from the key's scopes — so a `tasks:write` key could write journal
        // entries, field operations and insurance leads.
        const ctx = read('src/app-layer/context.ts');
        expect(ctx).toContain('assertApiKeyMayReachPath(');
    });

    it('scopes are enforced per operation, not just used to derive a role', () => {
        expect(/enforceApiKeyScope\s*\(/.test(read('src/lib/security/permission-middleware.ts'))).toBe(
            true,
        );
    });

    it('a family nobody has reviewed for key access is refused, wildcard included', () => {
        // `enforceApiKeyScope` returns early for a `*` key, which is right for
        // an action check and wrong for a reachability one. New path families
        // must start closed.
        const auth = read('src/lib/auth/api-key-auth.ts');
        const start = auth.indexOf('export function assertApiKeyMayReachPath');
        expect(start).toBeGreaterThan(-1);
        const body = auth.slice(start, start + 1200);
        expect(body).toContain('isScopableFamily');
        // The family check must precede the scope check, or `*` bypasses it.
        expect(body.indexOf('isScopableFamily')).toBeLessThan(body.indexOf('enforceApiKeyScope'));
    });
});

describe('the protections written while the switch was off still hold', () => {
    const ctx = read('src/app-layer/context.ts');

    it('a key cannot execute against a tenant other than the URL names', () => {
        expect(ctx).toMatch(/expectedTenantSlug: string,/);
        expect(ctx).toMatch(/result\.ctx\.tenantSlug !== expectedTenantSlug/);
    });

    it('getLegacyCtx does not attempt key auth — it has no slug to compare', () => {
        const start = ctx.indexOf('export async function getLegacyCtx');
        expect(start).toBeGreaterThan(-1);
        const rest = ctx.slice(start + 1);
        const next = rest.indexOf('\nexport ');
        const legacyBody = next === -1 ? rest : rest.slice(0, next);
        expect(legacyBody.includes('tryApiKeyAuth(')).toBe(false);
    });
});

describe('the docs match the state of the feature', () => {
    it('no longer describe the flow as unavailable', () => {
        if (!apiKeyAuthEnabled()) return;
        const doc = read('docs/enterprise-identity-custom-roles-api-keys.md');
        // BOTH phrasings the previous guard accepted as "correctly says it is
        // off". Checking only one would have passed on a doc still telling
        // customers their keys cannot authenticate.
        expect(doc).not.toMatch(/not currently available/i);
        expect(doc).not.toMatch(/\*\*cannot authenticate a request\*\*/i);
        // And it must positively say it works, so an empty or truncated doc
        // cannot satisfy this by containing neither phrase.
        expect(doc).toMatch(/API-key authentication is ENABLED/);
    });
});
