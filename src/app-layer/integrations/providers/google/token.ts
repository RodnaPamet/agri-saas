/**
 * Google delegated-token lifecycle for the Drive and Calendar integrations — #2005.
 *
 * Deliberately shaped after
 * `src/app-layer/integrations/providers/sharepoint/token.ts`, which already
 * solves the hard part: an OAuth round trip that is SEPARATE from the NextAuth
 * sign-in flow, so connecting an integration re-consents for extra scopes
 * without disturbing the login session, and disconnecting does not sign the
 * user out.
 *
 * ## Why this is not the sign-in token
 *
 * `src/auth.ts` requests `openid email profile` and nothing else, so the
 * session's Google token cannot read Drive or Calendar no matter how fresh it
 * is (see #1986, which was closed on the opposite assumption and reopened).
 * These scopes have to be granted separately, and the resulting token belongs
 * to a tenant's integration rather than to a person's session — hence
 * `IntegrationConnection.secretEncrypted`, not `Account`.
 *
 * ## ONE connection covering both products
 *
 * Owner's decision 2026-10-16: a single "Connect Google" with one consent
 * screen, rather than a row per product. Simpler for the admin and one round
 * trip instead of two.
 *
 * The consequence to design for is that it does NOT mean both products are
 * always available. Google's consent screen lets a user grant the scopes
 * individually, so one connect can return Calendar without Drive — a case that
 * could not arise with a row per product. `grantedProducts()` reads what was
 * actually granted off the stored secret, and callers must check it rather
 * than assume the row's existence implies both.
 *
 * ## Google-specific behaviour the Microsoft version does not have
 *
 * Three differences, each of which would be a silent bug if carried over
 * unchanged:
 *
 *   1. **A refresh token arrives only with `prompt=consent`.** Google returns
 *      `refresh_token` on the first authorisation, and on later ones ONLY if
 *      consent is forced. Without it the connection works until the access
 *      token expires an hour later and then fails with no way to recover.
 *   2. **`include_granted_scopes=true` is the incremental-authorisation
 *      mechanism.** Its role is narrower now that one consent asks for both
 *      scopes at once: it no longer guards a Drive-then-Calendar sequence,
 *      because there isn't one. It still matters for the case where a scope is
 *      ADDED later — without it, re-consenting for a third product would
 *      return a token carrying only that product and silently narrow the
 *      existing grant. Kept deliberately, with its reason restated rather
 *      than inherited.
 *   3. **Google does not rotate the refresh token on refresh.** Microsoft may,
 *      which is why the SharePoint code keeps the old one when absent; here
 *      absent is the NORMAL case rather than the exception.
 *
 * Everything is dependency-injectable (`fetchImpl`, `now`, `refresh`,
 * `persist`) so the token math is unit-testable without env, network or a DB.
 *
 * @module integrations/providers/google/token
 */
import { env } from '@/env';
import { refreshGoogleToken, isTokenExpired, type TokenRefreshResult } from '@/lib/auth/refresh';

/** `IntegrationConnection.provider` value. ONE row covering both products. */
export const GOOGLE_PROVIDER = 'google';

/** The products a grant can cover, keyed to the scope that enables each. */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Least-privilege scopes, and the choice matters beyond tidiness.
 *
 * `drive.file` grants access ONLY to files this app creates or the user
 * explicitly opens with it — not the user's Drive. Full `drive` is a Google
 * RESTRICTED scope: it would put this app through a security assessment and
 * hand us read access to everything the user owns, to write a few documents.
 *
 * `calendar.events` likewise covers events without granting calendar
 * management (sharing, ACLs, deletion of whole calendars).
 */
export const GOOGLE_SCOPES: readonly string[] = [GOOGLE_DRIVE_SCOPE, GOOGLE_CALENDAR_SCOPE];

/**
 * Which products a stored grant actually covers.
 *
 * NOT derivable from the request, and that is the point. Google's consent
 * screen lets a user tick the scopes individually, so one "Connect Google"
 * can come back with Calendar granted and Drive denied. A single connection
 * row therefore has to carry WHICH products work rather than assuming both —
 * otherwise the first Drive export fails at use time with a 403 the UI never
 * warned about.
 *
 * With two provider rows this case could not arise; with one it is ordinary.
 */
export function grantedProducts(grantedScopes: readonly string[]): {
    drive: boolean;
    calendar: boolean;
} {
    return {
        drive: grantedScopes.includes(GOOGLE_DRIVE_SCOPE),
        calendar: grantedScopes.includes(GOOGLE_CALENDAR_SCOPE),
    };
}

/**
 * Default `IntegrationConnection.name`.
 *
 * Not translated: it is a row identity that appears in the unique key
 * `(tenantId, provider, name)`, and a name that changed with the admin's
 * locale would create a SECOND connection on the next connect from a
 * different language.
 */
export const GOOGLE_CONNECTION_NAME = 'Google';

/** The shape persisted (encrypted) in `IntegrationConnection.secretEncrypted`. */
export interface GoogleSecret {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds. */
    expiresAt: number;
    /** The scopes Google actually granted, which may exceed what was asked. */
    grantedScopes: string[];
}

interface GoogleEnv {
    clientId: string;
    clientSecret: string;
}

function googleEnv(override?: Partial<GoogleEnv>): GoogleEnv {
    return {
        clientId: override?.clientId ?? env.GOOGLE_CLIENT_ID,
        clientSecret: override?.clientSecret ?? env.GOOGLE_CLIENT_SECRET,
    };
}

/**
 * Build the Google authorization URL for an integration consent redirect.
 *
 * `access_type=offline` + `prompt=consent` are both required for a refresh
 * token, and `include_granted_scopes=true` is what makes this incremental
 * rather than replacing the previous grant — see the module docblock.
 */
export function buildGoogleAuthorizeUrl(opts: {
    redirectUri: string;
    state: string;
    env?: Partial<GoogleEnv>;
}): string {
    const { clientId } = googleEnv(opts.env);
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        scope: GOOGLE_SCOPES.join(' '),
        state: opts.state,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an authorization code for the first Google token pair.
 *
 * Mirrors `refreshGoogleToken` but with the `authorization_code` grant. Throws
 * when no refresh token comes back: the connection would appear to work and
 * then stop within the hour, which is worse than refusing to create it.
 */
export async function exchangeCodeForGoogleToken(
    opts: { code: string; redirectUri: string },
    deps: { fetchImpl?: typeof fetch; env?: Partial<GoogleEnv> } = {},
): Promise<GoogleSecret> {
    const { clientId, clientSecret } = googleEnv(deps.env);
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: opts.code,
            redirect_uri: opts.redirectUri,
        }),
    });
    if (!res.ok) throw new Error(`Google code exchange failed: ${res.status}`);
    const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope?: string;
    };
    if (!data.refresh_token) {
        throw new Error(
            'Google consent returned no refresh token — access_type=offline and prompt=consent are both required',
        );
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        // Recorded rather than assumed: with `include_granted_scopes` the
        // grant can be WIDER than this provider asked for, and a later health
        // check should compare against what was actually granted.
        grantedScopes: (data.scope ?? '').split(' ').filter(Boolean),
    };
}

/**
 * Return a still-valid access token for a connection, refreshing and
 * persisting when the current one is within the expiry skew.
 *
 * The DB row is the authoritative copy and this persists through `deps.persist`
 * — the same discipline #1963 established for the sign-in token, where a
 * refresh wrote one place and the decision read another.
 */
export async function resolveGoogleAccessToken(
    current: GoogleSecret,
    deps: {
        now?: () => number;
        refresh?: (refreshToken: string) => Promise<TokenRefreshResult>;
        persist?: (secret: GoogleSecret) => Promise<void>;
    } = {},
): Promise<{ accessToken: string; rotated: GoogleSecret | null }> {
    const expired = deps.now
        ? deps.now() / 1000 >= current.expiresAt - 60
        : isTokenExpired(current.expiresAt);
    if (!expired) return { accessToken: current.accessToken, rotated: null };

    const refreshed = await (deps.refresh ?? refreshGoogleToken)(current.refreshToken);
    const rotated: GoogleSecret = {
        accessToken: refreshed.accessToken,
        // Google does NOT return a refresh token on refresh — absent is the
        // normal case here, not the exception it is for Microsoft. Dropping
        // the old one would make the connection unrecoverable after one hour.
        refreshToken: refreshed.refreshToken ?? current.refreshToken,
        expiresAt: refreshed.expiresAt,
        grantedScopes: current.grantedScopes,
    };
    if (deps.persist) await deps.persist(rotated);
    return { accessToken: rotated.accessToken, rotated };
}
