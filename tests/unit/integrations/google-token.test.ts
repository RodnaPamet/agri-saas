/**
 * Google integration token lifecycle — #2005.
 *
 * The three Google-specific behaviours asserted here are each a silent failure
 * if carried over unchanged from the Microsoft version this module is shaped
 * after: a refresh token that only arrives with `prompt=consent`, an
 * incremental grant that needs `include_granted_scopes`, and a refresh
 * response that normally omits the refresh token rather than exceptionally.
 *
 * "Silent" is the operative word for all three — each produces a connection
 * that works for about an hour and then stops, or one that quietly narrows
 * what an earlier connection could do. None of them fails at connect time.
 */
import {
    GOOGLE_SCOPES,
    GOOGLE_DRIVE_SCOPE,
    GOOGLE_CALENDAR_SCOPE,
    buildGoogleAuthorizeUrl,
    exchangeCodeForGoogleToken,
    resolveGoogleAccessToken,
    grantedProducts,
    type GoogleSecret,
} from '@/app-layer/integrations/providers/google/token';

const REDIRECT = 'https://app.agrent.bg/api/integrations/google/callback';
const ENV = { clientId: 'cid-test', clientSecret: 'secret-test' };

const nowSec = () => Math.floor(Date.now() / 1000);

const secret = (over: Partial<GoogleSecret> = {}): GoogleSecret => ({
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: nowSec() + 3600,
    grantedScopes: ['https://www.googleapis.com/auth/drive.file'],
    ...over,
});

describe('buildGoogleAuthorizeUrl', () => {
    it('requests offline access AND forces consent, which is what yields a refresh token', () => {
        const url = new URL(
            buildGoogleAuthorizeUrl({
                redirectUri: REDIRECT,
                state: 'nonce-1',
                env: ENV,
            }),
        );
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('access_type')).toBe('offline');
        expect(url.searchParams.get('prompt')).toBe('consent');
    });

    it('sets include_granted_scopes, so a later scope addition cannot narrow the grant', () => {
        // The reason is narrower than it was with a row per product: one
        // consent now asks for both scopes, so there is no Drive-then-Calendar
        // sequence to protect. It still matters if a third product is added
        // later — re-consenting would otherwise return a token carrying only
        // the new scope and silently drop the rest.
        const url = new URL(
            buildGoogleAuthorizeUrl({
                redirectUri: REDIRECT,
                state: 'nonce-1',
                env: ENV,
            }),
        );
        expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    });

    it('carries the state nonce and redirect URI through unmodified', () => {
        const url = new URL(
            buildGoogleAuthorizeUrl({
                redirectUri: REDIRECT,
                state: 'nonce-xyz',
                env: ENV,
            }),
        );
        expect(url.searchParams.get('state')).toBe('nonce-xyz');
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
        expect(url.searchParams.get('client_id')).toBe('cid-test');
    });

    it('asks for BOTH products in one consent', () => {
        const scope =
            new URL(buildGoogleAuthorizeUrl({ redirectUri: REDIRECT, state: 's', env: ENV }))
                .searchParams.get('scope') ?? '';
        expect(scope.split(' ')).toEqual([GOOGLE_DRIVE_SCOPE, GOOGLE_CALENDAR_SCOPE]);
    });

    it('never asks for a RESTRICTED scope', () => {
        // `drive` and `calendar` (unqualified) are Google restricted scopes:
        // they trigger a security assessment and grant far more than this
        // integration needs. Asserted on the built URL rather than the
        // constant, because the URL is what the user consents to.
        const granted = (
            new URL(buildGoogleAuthorizeUrl({ redirectUri: REDIRECT, state: 's', env: ENV }))
                .searchParams.get('scope') ?? ''
        )
            .split(' ')
            .filter(Boolean);
        expect(granted).not.toContain('https://www.googleapis.com/auth/drive');
        expect(granted).not.toContain('https://www.googleapis.com/auth/calendar');
        expect(granted.length).toBeGreaterThan(0);
    });
});

describe('exchangeCodeForGoogleToken', () => {
    const okResponse = (body: Record<string, unknown>) =>
        jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => body,
        }) as unknown as typeof fetch;

    it('posts the authorization_code grant and returns the token pair', async () => {
        const fetchImpl = okResponse({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file',
        });
        const out = await exchangeCodeForGoogleToken(
            { code: 'code-1', redirectUri: REDIRECT },
            { fetchImpl, env: ENV },
        );

        expect(out.accessToken).toBe('at-new');
        expect(out.refreshToken).toBe('rt-new');
        expect(out.expiresAt).toBeGreaterThan(nowSec());
        const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
        expect(url).toBe('https://oauth2.googleapis.com/token');
        expect(String((init as { body: URLSearchParams }).body)).toContain('grant_type=authorization_code');
    });

    it('records the scopes Google actually GRANTED, which can exceed what was asked', async () => {
        // With `include_granted_scopes` the grant accumulates, so the response
        // may carry both products even when only one was requested. Recording
        // it lets a health check compare reality against intent.
        const fetchImpl = okResponse({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events',
        });
        const out = await exchangeCodeForGoogleToken({ code: 'c', redirectUri: REDIRECT }, { fetchImpl, env: ENV });

        expect(out.grantedScopes).toEqual([
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/calendar.events',
        ]);
    });

    it('REFUSES a grant with no refresh token rather than creating a connection that dies in an hour', async () => {
        // The Google-specific trap. A connection created from this response
        // works until the access token expires and then cannot recover, with
        // nothing failing at connect time to explain it.
        const fetchImpl = okResponse({ access_token: 'at', expires_in: 3600, scope: 'x' });

        await expect(
            exchangeCodeForGoogleToken({ code: 'c', redirectUri: REDIRECT }, { fetchImpl, env: ENV }),
        ).rejects.toThrow(/no refresh token/i);
    });

    it('throws on a non-ok response, naming the status', async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }) as unknown as typeof fetch;

        await expect(
            exchangeCodeForGoogleToken({ code: 'c', redirectUri: REDIRECT }, { fetchImpl, env: ENV }),
        ).rejects.toThrow(/400/);
    });
});

describe('resolveGoogleAccessToken', () => {
    it('returns the current token without refreshing when it is still valid', async () => {
        const refresh = jest.fn();
        const out = await resolveGoogleAccessToken(secret(), { refresh });

        expect(out.accessToken).toBe('at-old');
        expect(out.rotated).toBeNull();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('refreshes and persists when the token is within the expiry skew', async () => {
        const persist = jest.fn();
        const refresh = jest.fn().mockResolvedValue({
            accessToken: 'at-fresh',
            expiresAt: nowSec() + 3600,
            refreshToken: undefined,
        });

        const out = await resolveGoogleAccessToken(secret({ expiresAt: nowSec() - 10 }), {
            refresh,
            persist,
        });

        expect(out.accessToken).toBe('at-fresh');
        expect(out.rotated).not.toBeNull();
        expect(persist).toHaveBeenCalledTimes(1);
        expect((persist.mock.calls[0][0] as GoogleSecret).accessToken).toBe('at-fresh');
    });

    it('KEEPS the existing refresh token when the refresh omits one — the normal Google case', async () => {
        // Microsoft may rotate, so its version treats absence as the
        // exception. Google does not rotate at all, so dropping the old token
        // here would make every connection unrecoverable one hour after it was
        // created.
        const refresh = jest.fn().mockResolvedValue({
            accessToken: 'at-fresh',
            expiresAt: nowSec() + 3600,
            refreshToken: undefined,
        });

        const out = await resolveGoogleAccessToken(secret({ expiresAt: nowSec() - 10 }), { refresh });

        expect(out.rotated!.refreshToken).toBe('rt-old');
    });

    it('adopts a rotated refresh token if one IS returned', async () => {
        const refresh = jest.fn().mockResolvedValue({
            accessToken: 'at-fresh',
            expiresAt: nowSec() + 3600,
            refreshToken: 'rt-rotated',
        });

        const out = await resolveGoogleAccessToken(secret({ expiresAt: nowSec() - 10 }), { refresh });

        expect(out.rotated!.refreshToken).toBe('rt-rotated');
    });

    it('carries grantedScopes across a refresh', async () => {
        // The refresh response does not restate the scopes, so losing them
        // here would make a health check think the connection granted nothing.
        const refresh = jest.fn().mockResolvedValue({
            accessToken: 'at-fresh',
            expiresAt: nowSec() + 3600,
            refreshToken: undefined,
        });

        const out = await resolveGoogleAccessToken(
            secret({ expiresAt: nowSec() - 10, grantedScopes: ['a', 'b'] }),
            { refresh },
        );

        expect(out.rotated!.grantedScopes).toEqual(['a', 'b']);
    });

    it('honours an injected clock rather than the real one', async () => {
        const refresh = jest.fn();
        // A token that expires in 10 minutes, with a clock set an hour ahead.
        const out = await resolveGoogleAccessToken(secret({ expiresAt: nowSec() + 600 }), {
            now: () => (nowSec() + 3600) * 1000,
            refresh: refresh.mockResolvedValue({
                accessToken: 'at-fresh',
                expiresAt: nowSec() + 7200,
                refreshToken: undefined,
            }),
        });

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(out.accessToken).toBe('at-fresh');
    });
});

describe('grantedProducts', () => {
    /**
     * The case a single connection row makes possible and two rows did not.
     *
     * Google's consent screen lets a user tick the scopes individually, so the
     * row existing does NOT mean both products work. A caller that assumed it
     * would fail at use time with a 403 the UI never warned about.
     */
    it('reports a PARTIAL grant, where only Calendar was ticked', () => {
        expect(grantedProducts([GOOGLE_CALENDAR_SCOPE])).toEqual({ drive: false, calendar: true });
    });

    it('reports a partial grant the other way round', () => {
        expect(grantedProducts([GOOGLE_DRIVE_SCOPE])).toEqual({ drive: true, calendar: false });
    });

    it('reports both when both were granted', () => {
        expect(grantedProducts([...GOOGLE_SCOPES])).toEqual({ drive: true, calendar: true });
    });

    it('reports neither for an empty grant, rather than defaulting to available', () => {
        // Default-deny: an empty or unreadable scope list must not read as
        // "both work", or a broken grant looks like a healthy one.
        expect(grantedProducts([])).toEqual({ drive: false, calendar: false });
    });

    it('ignores scopes it does not know about', () => {
        expect(grantedProducts(['https://www.googleapis.com/auth/gmail.readonly'])).toEqual({
            drive: false,
            calendar: false,
        });
    });
});
