/**
 * SCIM provisioning works over real HTTP — the socket-level backstop.
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention).
 *
 * ## The regression class
 *
 * SCIM shipped complete — token minting, hashing, revocation, tenant
 * isolation, an admin UI, Users and Groups endpoints, integration tests — and
 * NO SCIM request had ever reached a handler. `src/middleware.ts` called
 * `getToken()`, which understands only a NextAuth JWE, got `null` for an
 * opaque `scim_…` bearer, and 401'd. An IdP configured against this app saw
 * `{"error":"Unauthorized"}` and nothing else, from the first day.
 *
 * The existing suites could not see it: `tests/integration/scim.test.ts`
 * imports `authenticateScimRequest` and hands it a request it built itself.
 * It proves the auth function is correct — which it always was. Nothing
 * crossed the middleware, so nothing could notice the function was never
 * called.
 *
 * ## Why this spec exists ALONGSIDE tests/unit/scim-edge-reachability.test.ts
 *
 * That jest file drives the real middleware in-process and runs on every
 * shard, which is the cheap everyday guard. It never opens a socket, so it
 * cannot see a Next upgrade that changes how the matcher is applied or how
 * `NextResponse.next()` is serialised over the wire. This spec is the only
 * check that a real HTTP request from a real client reaches a real handler.
 *
 * ## The assertion that carries the weight
 *
 * Not "a valid token returns 200" — a bad token returning the **SCIM Error
 * schema** rather than the Edge's `{"error":"Unauthorized"}`. That is the
 * difference between "the handler ran and rejected you" and "the handler never
 * ran", and it is precisely the distinction that was invisible for the entire
 * life of the feature.
 */
import { test, expect } from './fixtures';

test.describe('SCIM 2.0 provisioning is reachable', () => {
    test('an IdP bearer reaches the handler, and a bad one is refused BY the handler', async ({
        authedPage,
        isolatedTenant,
    }) => {
        test.setTimeout(120_000);
        const slug = isolatedTenant.tenantSlug;

        // ── Mint a real SCIM token as the tenant admin ───────────────────
        const mint = await authedPage.request.post(`/api/t/${slug}/admin/scim`, {
            data: { name: 'e2e-idp' },
        });
        expect(mint.ok(), `mint token: ${mint.status()}`).toBeTruthy();
        const plaintext = (await mint.json()).plaintext as string;
        expect(plaintext).toMatch(/^scim_/);

        // ── A COOKIE-LESS context: exactly what Okta or Entra sends ──────
        // Using authedPage.request would carry the session cookie and prove
        // nothing — the cookie alone clears the Edge, so the bearer would
        // never be the thing under test.
        const idp = await authedPage.context().browser()!.newContext();
        const api = idp.request;

        try {
            // 1. VALID bearer → the handler runs and returns SCIM JSON.
            const ok = await api.get(`/api/scim/v2/Users`, {
                headers: { Authorization: `Bearer ${plaintext}` },
            });
            expect(ok.status(), 'a valid SCIM bearer must reach the handler').toBe(200);
            const body = await ok.json();
            expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');

            // 2. BAD bearer → 401, but from the HANDLER, not the Edge.
            const bad = await api.get(`/api/scim/v2/Users`, {
                headers: { Authorization: 'Bearer scim_definitely_not_a_real_token' },
            });
            expect(bad.status()).toBe(401);
            const badBody = await bad.json();
            // THE load-bearing assertion. `{"error":"Unauthorized"}` is the
            // Edge's generic body and is what this endpoint returned for every
            // request, valid or not, before the carve-out.
            expect(
                badBody.schemas,
                `expected a SCIM Error body (handler ran and rejected); got ` +
                    `${JSON.stringify(badBody)} — if this is {"error":"Unauthorized"} ` +
                    `then the middleware is 401ing SCIM again and provisioning is dead.`,
            ).toContain('urn:ietf:params:scim:api:messages:2.0:Error');

            // 3. NO bearer at all → still the handler's refusal, not the Edge's.
            const none = await api.get(`/api/scim/v2/Users`);
            expect(none.status()).toBe(401);
            expect((await none.json()).schemas).toContain(
                'urn:ietf:params:scim:api:messages:2.0:Error',
            );

            // 4. Discovery is anonymous by spec (RFC 7644 §4) and returns only
            //    capability metadata — no tenant data, no token needed.
            const cfg = await api.get('/api/scim/v2/ServiceProviderConfig');
            expect(cfg.status()).toBe(200);
            const cfgBody = await cfg.json();
            expect(cfgBody.schemas).toContain(
                'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
            );

            // 5. The admin route that MINTS tokens must stay behind the session
            //    gate — a SCIM bearer must not be able to mint another one.
            const escalate = await api.post(`/api/t/${slug}/admin/scim`, {
                headers: { Authorization: `Bearer ${plaintext}` },
                data: { name: 'should-not-work' },
            });
            expect(
                escalate.status(),
                'a SCIM bearer must not reach the token-minting admin route',
            ).toBe(401);
        } finally {
            await idp.close();
        }
    });
});
