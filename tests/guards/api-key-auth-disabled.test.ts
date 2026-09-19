/**
 * API-key authentication stays off until the things that make it work exist.
 *
 * ## Why a guard rather than a comment
 *
 * A tenant API key (`iflk_…`) has never authenticated a request. The Edge
 * middleware calls `getToken()`, which runs an `Authorization: Bearer` value
 * through NextAuth's JWE decode; an `iflk_` token is not a JWE, decode throws,
 * `getToken` returns null, and the request is 401'd before any handler — and
 * therefore before `verifyApiKey` — runs. Confirmed over real HTTP.
 *
 * Meanwhile the admin UI minted keys and told operators to copy them.
 *
 * Flipping `API_KEY_AUTH_ENABLED` back to `true` looks like a one-line change
 * and is not. Without an Edge carve-out the flag changes nothing at all — the
 * key still cannot reach a handler — so the most likely outcome of a naive
 * revival is shipping the SAME dead feature a second time, now with a flag
 * that claims it works. This guard makes that impossible: turn the flag on
 * without the Edge work, and CI fails with the list of what is missing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Re-read rather than imported, so the guard sees the SOURCE, not a bundle.
 *
 * The source is a PARAMETER with the real file as its default, so the parse
 * can be exercised both ways (#971). Without that, this returns the switch's
 * actual value — `false` — for every call, `return false` reproduces it
 * exactly, and no assertion can tell the implementation from a gutted one.
 * `selector-teeth` reported exactly that.
 *
 * The direction that would actually hurt is the opposite one. Every test below
 * is `if (!apiKeyAuthEnabled()) { ...assert... }`, so a function stuck at TRUE
 * skips all of them and the suite passes having checked nothing — and `true`
 * is not in the tool's gut set, which is falsy/empty values only. A predicate
 * whose hazard is the truthy side cannot be found by that tool at all, which
 * is why the control below drives both branches explicitly.
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
    it('is readable, and this guard knows which way it is set', () => {
        expect(typeof apiKeyAuthEnabled()).toBe('boolean');
    });

    it('control: the parse reports BOTH settings, not a constant', () => {
        // Drives the branch the tool cannot reach. A predicate pinned at
        // `true` would skip every conditional assertion in this file; one
        // pinned at `false` is indistinguishable from today's real value.
        expect(apiKeyAuthEnabled('export const API_KEY_AUTH_ENABLED = true;')).toBe(true);
        expect(apiKeyAuthEnabled('export const API_KEY_AUTH_ENABLED = false;')).toBe(false);
        // And it still THROWS when the switch is absent, which is what stops
        // this guard silently protecting nothing after a rename.
        expect(() => apiKeyAuthEnabled('export const SOMETHING_ELSE = true;')).toThrow(
            /API_KEY_AUTH_ENABLED not found/,
        );
    });

    it('control: the switch is currently OFF, so the assertions below run', () => {
        // An honest record of today's value. The conditional tests in this
        // file are no-ops if the switch is ever turned on, so this is the
        // line that fails and forces them to be revisited rather than
        // quietly skipped.
        expect(apiKeyAuthEnabled()).toBe(false);
    });

    it('creation is refused while the switch is off', () => {
        const route = read('src/app/api/t/[tenantSlug]/admin/api-keys/route.ts');
        if (!apiKeyAuthEnabled()) {
            // Not a bare throw: the whole failure being fixed is a credential
            // that fails indistinguishably from a wrong one, so the refusal
            // has to say why.
            expect(route).toMatch(/if \(!API_KEY_AUTH_ENABLED\) throw gone\(/);
            expect(route).toContain('API_KEY_DISABLED_MESSAGE');
        }
    });

    it('the admin page hides the create affordance while the switch is off', () => {
        const page = read('src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx');
        if (!apiKeyAuthEnabled()) {
            expect(page).toMatch(/API_KEY_AUTH_ENABLED && !showCreate/);
            // …but the page itself stays reachable: listing and REVOKING
            // already-issued keys is the one operation that still works.
            expect(page).toContain('api-keys-unavailable');
        }
    });

    it('the context path cannot swap a session for a key context', () => {
        // `tryApiKeyAuth` returns a context that REPLACES the session's:
        // tenantId/tenantSlug become the KEY's, and role is re-derived from
        // the key's SCOPES. Reachable today only with a valid session cookie
        // AND an iflk_ header — not a machine client, but a browser session
        // whose tenant and role would silently change.
        const ctx = read('src/app-layer/context.ts');
        expect(ctx).toMatch(/if \(!API_KEY_AUTH_ENABLED\) return null;/);
        // The tenant comparison is REQUIRED, not optional, so a revival cannot
        // reintroduce the confusion by forgetting an argument.
        expect(ctx).toMatch(/expectedTenantSlug: string,/);
        expect(ctx).toMatch(/result\.ctx\.tenantSlug !== expectedTenantSlug/);
        // getLegacyCtx has no slug to compare, so it must not try at all.
        // Bound the slice to that function — reading to end-of-file would
        // sweep in tryApiKeyAuth's own definition and never fail.
        const start = ctx.indexOf('export async function getLegacyCtx');
        expect(start).toBeGreaterThan(-1);
        const rest = ctx.slice(start + 1);
        const next = rest.indexOf('\nexport ');
        const legacyBody = next === -1 ? rest : rest.slice(0, next);
        expect(legacyBody.includes('tryApiKeyAuth(')).toBe(false);
    });

    it('turning the switch ON requires the Edge to recognise an API-key bearer', () => {
        // The load-bearing assertion. With the flag true and no Edge carve-out,
        // every request still 401s before the handler — the flag would claim a
        // working feature and deliver the identical dead one.
        if (!apiKeyAuthEnabled()) return;

        const guard = read('src/lib/auth/guard.ts');
        const middleware = read('src/middleware.ts');
        const edgeAware = /iflk_|API_KEY_PREFIX|isApiKeyToken/.test(guard + middleware);
        if (!edgeAware) {
            throw new Error(
                'API_KEY_AUTH_ENABLED is true, but nothing in src/middleware.ts or ' +
                    'src/lib/auth/guard.ts recognises an API-key bearer. The Edge calls ' +
                    'getToken(), which cannot decode an `iflk_` token, so it will 401 every ' +
                    'request before the handler runs — exactly the state this flag was ' +
                    'introduced to end.\n\nEnabling this needs, at minimum:\n' +
                    '  1. an Edge carve-out (and a fail-closed guard, as for SCIM)\n' +
                    '  2. enforceApiKeyScope wired up — it has ZERO callers today\n' +
                    '  3. a rate tier for the now-anonymous surface\n' +
                    '  4. an HTTP-level test that sends the header through the middleware',
            );
        }

        // Scopes must actually be enforced, not merely used to derive a role.
        const callers = /enforceApiKeyScope\s*\(/.test(
            read('src/lib/security/permission-middleware.ts'),
        );
        expect(callers).toBe(true);
    });

    it('the docs do not describe the flow as working while it is off', () => {
        if (apiKeyAuthEnabled()) return;
        const doc = read('docs/enterprise-identity-custom-roles-api-keys.md');
        expect(doc).toMatch(/not currently available|cannot authenticate/i);
    });
});
