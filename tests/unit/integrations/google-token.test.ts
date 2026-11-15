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

    it('asks for DRIVE ONLY — the calendar sync was scrapped (2026-11-15)', () => {
        const scope =
            new URL(buildGoogleAuthorizeUrl({ redirectUri: REDIRECT, state: 's', env: ENV }))
                .searchParams.get('scope') ?? '';
        // Drive only. Asking for a scope with no feature behind it is the
        // opposite of least privilege, and a reviewer asks for each sensitive
        // scope to be DEMONSTRATED — a calendar scope with no sync has
        // nothing to show, which is a rejection rather than a tidy-up.
        expect(scope.split(' ')).toEqual([GOOGLE_DRIVE_SCOPE]);
        expect(scope).not.toContain(GOOGLE_CALENDAR_SCOPE);
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

    it('keeps a calendar scope that calendars.insert would ACCEPT (#3053)', () => {
        // Not requested any more (the sync was scrapped), but the CONSTANT
        // still governs what a stored grant means and is what the sync would
        // ask for if it returns. #3053's lesson survives the scrapping: the
        // value that shipped, `calendar.events`, cannot create a calendar at
        // all, so restoring the sync with it would 403 on the first run.
        // The integration CREATES a dedicated farm calendar
        // (`ensureFarmCalendar` → `POST /calendars`) and reads it back by id.
        // Google accepts `calendars.insert` under only these three, and
        // `calendars.get` likewise rejects `calendar.events`:
        const INSERT_ACCEPTS = [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.app.created',
            'https://www.googleapis.com/auth/calendar.calendars',
        ];
        expect(INSERT_ACCEPTS).toContain(GOOGLE_CALENDAR_SCOPE);
        // And it is genuinely not in today's consent.
        expect(GOOGLE_SCOPES).not.toContain(GOOGLE_CALENDAR_SCOPE);

        // …and `calendar` (unqualified) is restricted, so of the three only
        // two are available to us. Asserted as the INTERSECTION rather than as
        // a single equality, so the reason survives if Google adds a fourth.
        const usable = INSERT_ACCEPTS.filter(
            (sc) => sc !== 'https://www.googleapis.com/auth/calendar',
        );
        expect(usable).toContain(GOOGLE_CALENDAR_SCOPE);

        // The specific regression: `calendar.events` reads and writes events
        // on every calendar the person owns and still cannot create one, so it
        // is both wider AND insufficient. It shipped, and the first real sync
        // would have answered 403 `insufficientPermissions`.
        expect(GOOGLE_CALENDAR_SCOPE).not.toBe(
            'https://www.googleapis.com/auth/calendar.events',
        );
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
            // `calendar.events` ON PURPOSE, and it is no longer a scope this
            // app requests (#3053 moved to `calendar.app.created`). That makes
            // the case stronger rather than stale: granted scopes are recorded
            // VERBATIM, including ones we never asked for and ones left over
            // from an earlier release's consent screen.
            scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events',
        });
        const out = await exchangeCodeForGoogleToken({ code: 'c', redirectUri: REDIRECT }, { fetchImpl, env: ENV });

        expect(out.grantedScopes).toEqual([
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/calendar.events',
        ]);
        // And the recorded scope is NOT what we now request, which is the
        // property this fixture is really about.
        expect(out.grantedScopes).not.toContain(GOOGLE_CALENDAR_SCOPE);
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

    it('an OLD calendar.events grant does not count as calendar (#3053)', () => {
        // The migration consequence, and it is correct rather than a
        // regression: such a grant cannot create the farm calendar, so the
        // person must be told to reconnect instead of meeting a 403 at use
        // time — which is the whole reason this function exists. No working
        // calendar connection can be broken by it, because creating one under
        // `calendar.events` was impossible.
        expect(
            grantedProducts([
                GOOGLE_DRIVE_SCOPE,
                'https://www.googleapis.com/auth/calendar.events',
            ]),
        ).toEqual({ drive: true, calendar: false });
    });

    it('reports both when both were granted', () => {
        // The two scopes NAMED, not `GOOGLE_SCOPES` — which no longer
        // contains the calendar one. This models a connection made BEFORE
        // the sync was scrapped, and asserting it still reads as
        // calendar-granted is the point: `grantedProducts` describes a stored
        // grant, not today's request, and the dormant farm sync reads it.
        expect(
            grantedProducts([GOOGLE_DRIVE_SCOPE, GOOGLE_CALENDAR_SCOPE]),
        ).toEqual({ drive: true, calendar: true });
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
