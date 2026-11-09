/**
 * A route that authenticates WITHOUT a session cookie must satisfy
 * `isPublicPath` — #2645.
 *
 * ## The outage this derives from
 *
 * #2644: the native Google Drive connect handler was complete — atomic
 * single-use state claim, closed error set, active-admin re-check — and
 * `/api/integrations/google/callback` was on no `PUBLIC_PATH` list, so the Edge
 * answered `unauthorizedJson()` before any of it ran. Consent succeeded and
 * the user got a bare `{"error":"Unauthorized"}`.
 *
 * It is the ninth instance of one class, and CLAUDE.md enumerates the rest:
 * SCIM, signed webhooks, the CSP sink, `/api/metrics`, the manifest, the
 * feature-flag console, the moderation console, and the DSA Art 16 notice form
 * that 401'd for seven weeks. **It recurs because both halves are
 * individually correct and nothing reads them together.**
 *
 * ## Why the two existing guards could not see it
 *
 * - `public-routes-self-authenticate` asks whether a route behind a public
 *   prefix verifies something. It ranges over routes that are ALREADY public,
 *   so a route that SHOULD be public and is not is invisible to it.
 * - `public-route-exemptions-are-edge-reachable` closes the other direction,
 *   but derives its strong population from the filesystem under
 *   `src/app/api/public/`. The Google callback is not under that segment.
 *
 * The callback was in neither population. This guard is the population that
 * contains it.
 *
 * ## The property is COOKIE-LESS AUTHENTICATION, not "externally called"
 *
 * #2645 measured that "externally called" over-reports. Of the eight routes
 * whose path contains `callback`/`webhook`/`oauth`,
 * `/api/integrations/sharepoint/callback` is **correctly** not public: it is
 * web-only (an `sp_oauth_state` cookie plus `getTenantCtx` and
 * `assertCanAdmin`), so Microsoft's top-level redirect always carries the
 * session cookie and the Edge admits it on the token. Adding an entry for it
 * would be a gratuitous widening.
 *
 * What separates it from Google's is that Google's branch authenticates with a
 * **server-held, single-use token instead of a session** — which is the whole
 * reason `GoogleOAuthState` is a database row rather than a cookie: consent
 * runs in an ephemeral browser that has none.
 *
 * ## It imports the REAL `isPublicPath`
 *
 * Not a re-parse of the two lists. #2645's own method note records why: a
 * regex over `PUBLIC_PATH_PREFIXES` truncated at 25 of ~50 entries, dropped
 * `/api/auth`, and reported FOUR blocked routes including both SSO callbacks.
 * Running the real function gave one. Forking a selection rule is how two
 * answers diverge — the same reason `scripts/lib/api-routes.ts` is shared
 * between the route generator and the OpenAPI completeness test, and it is
 * reused here for the path derivation rather than re-deriving it.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { routeFiles, toOpenApiPath } from '../../scripts/lib/api-routes';
import { isPublicPath } from '@/lib/auth/guard';

const ROOT = process.cwd();

/**
 * Functions that authenticate a caller WITHOUT a session cookie, by verifying
 * a server-held single-use token.
 *
 * An ENUMERATION, deliberately, because the property is semantic and not
 * syntactic: no pattern distinguishes "verifies a single-use token in place of
 * a session" from "reads a row by id". The DERIVATION is in the route scan
 * below — a new route reaching any of these is covered the moment it exists,
 * which is the half that failed in #2644.
 *
 * EVERY NAME IS ASSERTED TO EXIST, and that control is not decoration. My
 * first pass at this list guessed five names and **four of them did not
 * exist** (`consumeAuthCode`, `verifyRefreshToken`,
 * `consumeEmailVerificationToken`, `consumePasswordResetToken`). Each would
 * have been a silently inert entry — a name matching nothing, contributing
 * nothing, and reading exactly like a covered case.
 */
const COOKIELESS_AUTHENTICATORS: ReadonlyArray<{ name: string; why: string }> = [
    {
        name: 'claimNativeState',
        why: 'atomic single-use claim on a `GoogleOAuthState` row; consent runs in an '
            + 'ephemeral browser that carries no session cookie (#2644)',
    },
    {
        name: 'exchangeAuthCode',
        why: 'PKCE code exchange for the native sign-in handoff — the caller is an app '
            + 'that has no cookie yet, which is the point of the exchange',
    },
    {
        name: 'rotateRefreshToken',
        why: 'a refresh token IS the credential here; a client with a live session cookie '
            + 'would not need to refresh',
    },
    {
        name: 'redeemMfaTicket',
        why: 'a server-held ticket stands in for the half-complete session an MFA step '
            + 'has not yet produced',
    },
    {
        name: 'consumeEmailVerification',
        why: 'the link is clicked from a mail client, which is a different browser from '
            + 'the one that signed up as often as not',
    },
    {
        name: 'consumePasswordReset',
        why: 'same as verification, and the whole point is that the person cannot sign in',
    },
];

/** Routes whose handler text reaches one of the authenticators above. */
function routesWithCookielessAuth(): { file: string; routePath: string; via: string[] }[] {
    const out: { file: string; routePath: string; via: string[] }[] = [];
    for (const file of routeFiles()) {
        const source = readFileSync(path.join(ROOT, file), 'utf8');
        const via = COOKIELESS_AUTHENTICATORS.filter((a) =>
            new RegExp(`\\b${a.name}\\b`).test(source),
        ).map((a) => a.name);
        if (via.length > 0) out.push({ file, routePath: toOpenApiPath(file), via });
    }
    return out;
}

/**
 * `isPublicPath` takes a CONCRETE pathname, so a template's `{param}` has to
 * become something. A literal placeholder is right rather than a realistic
 * value: the public lists match on prefixes and exact strings, so what the
 * segment contains cannot change the verdict — and a realistic-looking id
 * would invite a reader to think it did.
 */
function concretePath(template: string): string {
    return template.replace(/\{[^}]+\}/g, 'x');
}

describe('a cookie-less authenticator implies an Edge-reachable route', () => {
    it('every named authenticator EXISTS — the control on the list itself', () => {
        // Four of five names in my first draft did not exist. A missing name
        // matches nothing and reads exactly like a covered case, so the list's
        // own staleness is checked before anything is derived from it.
        const sources = routeFiles()
            .map((f) => readFileSync(path.join(ROOT, f), 'utf8'))
            .join('\n');
        const missing = COOKIELESS_AUTHENTICATORS.filter(
            (a) => !new RegExp(`\\b${a.name}\\b`).test(sources),
        ).map((a) => a.name);
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} named authenticator(s) are reached by no route handler: `
                + `${missing.join(', ')}.\n\nEither the function was renamed — in which case `
                + `this entry now matches nothing and silently covers nothing — or its last `
                + `route caller went away, in which case delete the entry in the same diff.`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('reports the population it graded', () => {
        const found = routesWithCookielessAuth();
        console.log(
            `[cookieless-auth-edge] ${COOKIELESS_AUTHENTICATORS.length} authenticator(s), `
            + `${routeFiles().length} route file(s), ${found.length} route(s) reaching one`,
        );
        for (const r of found) {
            console.log(
                `[cookieless-auth-edge]   ${isPublicPath(concretePath(r.routePath)) ? 'public ' : 'BLOCKED'} `
                + `${r.routePath}  via ${r.via.join(',')}`,
            );
        }
        // A FLOOR, because an extraction that stops matching passes over
        // nothing. Set at 1 rather than at today's count: a route legitimately
        // losing its last cookie-less branch should not redden the build, but
        // a scan matching NOTHING is the detector having broken.
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(routeFiles().length).toBeGreaterThan(100);
    });

    it('every such route satisfies isPublicPath', () => {
        const blocked = routesWithCookielessAuth().filter(
            (r) => !isPublicPath(concretePath(r.routePath)),
        );
        if (blocked.length > 0) {
            throw new Error(
                `${blocked.length} route(s) authenticate WITHOUT a session cookie and are `
                + `not Edge-reachable:\n`
                + blocked
                    .map((r) => {
                        const why = COOKIELESS_AUTHENTICATORS.filter((a) => r.via.includes(a.name))
                            .map((a) => `${a.name} — ${a.why}`)
                            .join('; ');
                        return `  ${r.routePath}\n      ${why}`;
                    })
                    .join('\n')
                + `\n\nThe Edge calls getToken(), which understands only a NextAuth cookie, so `
                + `it answers unauthorizedJson() BEFORE the handler runs — and the handler's own `
                + `verification never executes however correct it is. That is #2644, and the `
                + `eight instances before it.\n\n`
                + `Add the path to PUBLIC_PATH_EXACT (or a PUBLIC_PATH_PREFIXES entry WITH its `
                + `trailing slash) in src/lib/auth/guard.ts. Opening a prefix opens EVERY method `
                + `on it, so gate the privileged ones in the handler in the same diff.`,
            );
        }
        expect(blocked).toEqual([]);
    });
});

describe('the guard itself has teeth', () => {
    it('the rule can say NO — a non-public path is reported', () => {
        // The detector run against a path the real `isPublicPath` refuses, so
        // the assertion above is known to be capable of failing. Without this
        // a bug making `isPublicPath` return true unconditionally would leave
        // every case above green.
        expect(isPublicPath('/api/t/acme/tasks')).toBe(false);
    });

    it('and YES on one it admits — the positive control', () => {
        // Both directions, because a function returning false unconditionally
        // would satisfy the case above and redden every real route.
        expect(isPublicPath('/api/auth/callback/credentials')).toBe(true);
    });

    it('SharePoint is correctly NOT in the population — the over-report control', () => {
        // #2645 measured that "externally called" over-reports, and this is
        // the route that proves it: web-only, `sp_oauth_state` cookie plus
        // `getTenantCtx` and `assertCanAdmin`, so Microsoft's top-level
        // redirect always carries the session cookie. It must be absent from
        // the population AND blocked by the Edge lists, and both halves are
        // asserted — a population that included it would demand a gratuitous
        // widening of the public surface.
        const sharepoint = routesWithCookielessAuth().filter((r) =>
            r.routePath.includes('sharepoint'),
        );
        expect(sharepoint).toEqual([]);
        expect(isPublicPath('/api/integrations/sharepoint/callback')).toBe(false);
    });

    it('the path concretiser does not change a verdict', () => {
        // `{param}` -> `x` is a substitution, and a substitution that moved a
        // path across a prefix boundary would make the verdict an artefact of
        // this file rather than of the lists.
        expect(isPublicPath('/api/auth/sso/oidc/callback')).toBe(
            isPublicPath(concretePath('/api/auth/sso/oidc/callback')),
        );
        expect(concretePath('/api/t/{tenantSlug}/tasks')).toBe('/api/t/x/tasks');
    });
});
