/**
 * The APNs transport — #1764 step 3, P7.4 (#1993).
 *
 * ## What is worth asserting here, and what is not
 *
 * Not "does Apple accept it" — nothing local can answer that, and the key is
 * not installed. What IS answerable, and what costs an outage if wrong:
 *
 *   - the provider token's SHAPE, including the signature encoding whose
 *     failure mode is a token Apple rejects with an error that names the wrong
 *     cause;
 *   - its CACHING, which Apple bounds from both ends — too old is 403, minted
 *     per request is 429, so neither "sign once" nor "sign always" works;
 *   - the HOST chosen per row, because a token is valid at exactly one of two;
 *   - which status prunes a row, because pruning on the wrong one deletes
 *     working registrations;
 *   - and that an unconfigured deployment touches no network at all.
 */
import { generateKeyPairSync } from 'node:crypto';

import { makeRequestContext } from '../helpers/make-context';

const mockFetch = jest.fn();
const mockFindMany = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            pushSubscription: { findMany: mockFindMany, deleteMany: mockDeleteMany },
        }),
}));

const warn = jest.fn();
const info = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: (...a: unknown[]) => error(...a),
    },
}));

import {
    apnsProviderToken,
    isApnsConfigured,
    sendApnsToUser,
    APNS_HOSTS,
    PROVIDER_TOKEN_TTL_SECONDS,
    _clearApnsProviderToken,
} from '@/lib/notifications/apns';

/** A real P-256 key, so the signing path is exercised rather than mocked. */
const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}) as unknown as { privateKey: string };

/**
 * A context, built by the shared helper rather than cast.
 *
 * `as any` would have been shorter and is what the file-level
 * `no-explicit-any` disable existed to permit — but the lint ceiling counts a
 * suppression the same as a warning, and the helper already produces the real
 * shape. Removing the cast removed the need for the disable.
 */
const CTX = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });
const TOKEN = 'ab'.repeat(32);

function configure(over: Record<string, string | undefined> = {}) {
    process.env.APNS_KEY_ID = over.APNS_KEY_ID ?? 'KEYID12345';
    process.env.APNS_TEAM_ID = over.APNS_TEAM_ID ?? '9423GKWL67';
    process.env.APNS_TOPIC = over.APNS_TOPIC ?? 'bg.agrent.app';
    process.env.APNS_PRIVATE_KEY = over.APNS_PRIVATE_KEY ?? privateKey;
}

function unconfigure() {
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_TOPIC;
    delete process.env.APNS_PRIVATE_KEY;
}

beforeEach(() => {
    _clearApnsProviderToken();
    mockFetch.mockReset();
    mockFindMany.mockReset();
    mockDeleteMany.mockReset();
    warn.mockReset();
    info.mockReset();
    error.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    mockDeleteMany.mockResolvedValue({ count: 1 });
    configure();
});

afterAll(() => unconfigure());

describe('the provider token', () => {
    it('is an ES256 JWT carrying the Key ID and the Team ID', () => {
        const [h, p] = apnsProviderToken()!.split('.');
        const header = JSON.parse(Buffer.from(h, 'base64url').toString());
        const payload = JSON.parse(Buffer.from(p, 'base64url').toString());

        expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
        expect(payload.iss).toBe('9423GKWL67');
        expect(typeof payload.iat).toBe('number');
        // No `exp`: APNs applies its own one-hour window from `iat`, so an
        // `exp` here would imply a control this token does not carry.
        expect(payload.exp).toBeUndefined();
    });

    it('signs RAW r||s, not DER — the silent failure', () => {
        // THE assertion this file exists for. `crypto.sign` emits DER by
        // default; a JWS ES256 signature is the raw pair. DER is well-formed,
        // base64url-encodes cleanly, and produces a token Apple rejects with
        // an error that reads like a wrong Key ID — so every local check
        // passes and production breaks pointing at the wrong thing.
        const sig = Buffer.from(apnsProviderToken()!.split('.')[2], 'base64url');

        // Raw ES256 is exactly 64 bytes: r and s, 32 each.
        expect(sig.length).toBe(64);
        // DER would open with 0x30 (SEQUENCE) and vary in length. This is the
        // discriminator, not the length alone.
        expect(sig[0]).not.toBe(0x30);
    });

    it('is REUSED within the window, and re-minted after it', () => {
        // Apple bounds this from both ends: older than an hour is 403
        // ExpiredProviderToken, minted per request is 429
        // TooManyProviderTokenUpdates. So neither "sign once at boot" nor
        // "sign every send" is correct, and a test that only checked one call
        // would not notice either mistake.
        const t0 = Date.parse('2026-10-20T12:00:00Z');
        const first = apnsProviderToken(t0);

        expect(apnsProviderToken(t0 + 60_000)).toBe(first);
        expect(apnsProviderToken(t0 + (PROVIDER_TOKEN_TTL_SECONDS - 1) * 1000)).toBe(first);

        const after = apnsProviderToken(t0 + (PROVIDER_TOKEN_TTL_SECONDS + 1) * 1000);
        expect(after).not.toBe(first);
    });

    it('stays inside the one-hour window Apple enforces', () => {
        // The TTL is the one number that would turn every send into a 403 if
        // somebody raised it "a bit".
        expect(PROVIDER_TOKEN_TTL_SECONDS).toBeLessThan(60 * 60);
        expect(PROVIDER_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(20 * 60);
    });

    it('accepts a key with ESCAPED newlines', () => {
        // A PEM is multi-line and `.env` is not, so a pasted key usually
        // arrives escaped. `createPrivateKey` refuses it with
        // `error:0909006C:PEM routines`, which names nothing about newlines.
        _clearApnsProviderToken();
        configure({ APNS_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') });
        expect(apnsProviderToken()).not.toBeNull();
        expect(error).not.toHaveBeenCalled();
    });

    it('returns NULL and logs when the key will not load', () => {
        // Null rather than a throw: a malformed key must leave web push and
        // the rest of the application working, and the operator needs
        // something to read.
        _clearApnsProviderToken();
        configure({ APNS_PRIVATE_KEY: 'not a key' });
        expect(apnsProviderToken()).toBeNull();
        expect(error).toHaveBeenCalledWith(
            'apns.provider_token_mint_failed',
            expect.objectContaining({ component: 'apns' }),
        );
    });
});

describe('an unconfigured deployment', () => {
    it('is not configured, mints nothing, and touches no network', async () => {
        unconfigure();
        _clearApnsProviderToken();

        expect(isApnsConfigured()).toBe(false);
        expect(apnsProviderToken()).toBeNull();

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });
        expect(mockFetch).not.toHaveBeenCalled();
        // Not even the device read: an unconfigured deployment should cost
        // nothing at all, including a query.
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});

describe('sending', () => {
    it('picks the host from the ROW, not from the deployment', async () => {
        // One deployment serves both: a development-signed install and a
        // TestFlight build register against the same server, and a token is
        // valid at exactly one host.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
            { id: 's2', deviceToken: 'cd'.repeat(32), apnsEnvironment: 'PRODUCTION' },
        ]);
        mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        const urls = mockFetch.mock.calls.map((c) => String(c[0]));
        expect(urls[0]).toContain(APNS_HOSTS.DEVELOPMENT);
        expect(urls[1]).toContain(APNS_HOSTS.PRODUCTION);
        expect(APNS_HOSTS.DEVELOPMENT).not.toBe(APNS_HOSTS.PRODUCTION);
    });

    it('REFUSES a row with no environment, and says so', async () => {
        // A guess is wrong half the time and fails as BadDeviceToken —
        // indistinguishable from a revoked token, so guessing would get a
        // working registration pruned.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: null },
        ]);

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(mockFetch).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
            'apns.row_has_no_environment',
            expect.objectContaining({ subscriptionId: 's1' }),
        );
    });

    it('sends the topic, the push type and a root-relative link', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

        await sendApnsToUser(CTX, 'u2', { title: 'Заглавие', body: 'Тяло', link: '/t/acme/tasks/1' });

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['apns-topic']).toBe('bg.agrent.app');
        expect(headers['apns-push-type']).toBe('alert');
        expect(headers.authorization).toMatch(/^bearer /);

        const body = JSON.parse(String(init.body));
        expect(body.aps.alert).toEqual({ title: 'Заглавие', body: 'Тяло' });
        // Beside `aps`, never inside it — a custom key inside `aps` is ignored.
        expect(body.link).toBe('/t/acme/tasks/1');
        expect(body.aps.link).toBeUndefined();
    });
});

describe('pruning', () => {
    it('prunes on 410 Unregistered', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockResolvedValue({ ok: false, status: 410, text: async () => 'Unregistered' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { platform: 'IOS', deviceToken: { in: [TOKEN] } },
        });
    });

    it('does NOT prune on 400 BadDeviceToken — the control', async () => {
        // 400 can mean a malformed token OR the right token sent to the wrong
        // environment. Pruning on it would delete working registrations
        // whenever a host was misconfigured, which is the failure that looks
        // like "push stopped working for everyone".
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => '{"reason":"BadDeviceToken"}',
        });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(mockDeleteMany).not.toHaveBeenCalled();
        // And the REASON is logged, so an operator can tell this from a 403
        // or a 429 rather than seeing one undifferentiated failure.
        expect(warn).toHaveBeenCalledWith(
            'apns.send_failed',
            expect.objectContaining({ status: 400, reason: expect.stringContaining('BadDeviceToken') }),
        );
    });

    it('keys the delete on the TOKEN, not on one row id', async () => {
        // Measured in production 2026-10-20: 2 rows, 1 user, 1 TOKEN — the
        // same device registered once per farm. So a 410 kills every row
        // carrying that token, and deleting by row id would leave the other
        // farm's row to be sent to until it earned its own 410.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockResolvedValue({ ok: false, status: 410, text: async () => '' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        const where = (mockDeleteMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
        expect(where).toHaveProperty('deviceToken');
        expect(where).not.toHaveProperty('id');
    });

    it('logs the row COUNT, not just that it ran', async () => {
        // A delete under RLS removes zero rows SILENTLY when SELECT hides
        // them, so "it ran" and "it deleted" are different facts and only one
        // is useful.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockResolvedValue({ ok: false, status: 410, text: async () => '' });
        mockDeleteMany.mockResolvedValue({ count: 2 });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(info).toHaveBeenCalledWith(
            'apns.pruned_dead_tokens',
            expect.objectContaining({ rowsRemoved: 2 }),
        );
    });

    it('never throws when the network does', async () => {
        // Best-effort: a notification is a courtesy on top of a record that is
        // already written, so a push failure must not fail the operation that
        // triggered it.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        mockFetch.mockRejectedValue(new Error('ECONNRESET'));

        await expect(sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' })).resolves.toBeUndefined();
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });
});
