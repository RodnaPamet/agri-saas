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
 *
 * ## The transport is REAL here, and that is the point
 *
 * Every send below goes through `node:http2` to a local HTTP/2 server. It used
 * to go through a mocked `global.fetch`, and the whole suite passed while not
 * one notification could ever have reached Apple: APNs is HTTP/2-only and
 * undici's `fetch` is HTTP/1.1, so every real send threw before a status
 * existed. A mocked transport cannot catch a transport fault — it answers
 * whatever it was told to answer.
 *
 * Cleartext h2c (`http2.createServer`), not TLS. The framing, the stream
 * lifecycle, the `:status` pseudo-header and the `apns-id` response header are
 * what the old code could not do and what these cases exercise; ALPN
 * negotiation is the one part left out, and it was verified separately against
 * Apple's own host from the production container — `http2.connect` negotiated
 * `h2` where `fetch` threw. Spelling that out so nobody reads h2c as the
 * claim that TLS is covered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    createPublicKey,
    generateKeyPairSync,
    sign as cryptoSign,
    verify as cryptoVerify,
    type KeyObject,
} from 'node:crypto';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import { makeRequestContext } from '../helpers/make-context';

/** One request the stub received, reduced to what the assertions need. */
interface Received {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}

/**
 * A local HTTP/2 server standing in for Apple.
 *
 * Answers from a queue of scripted replies so one send can be given a 200 and
 * the next a 410 — which is the pruning case, and the one that needs two
 * different answers in a single `sendApnsToUser` call.
 */
function h2Stub() {
    const received: Received[] = [];
    const replies: Array<{ status: number; apnsId?: string; body?: string }> = [];
    const server = http2.createServer();

    server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
        let body = '';
        stream.on('data', (d) => {
            body += d.toString('utf8');
        });
        stream.on('end', () => {
            received.push({
                method: String(headers[':method']),
                path: String(headers[':path']),
                headers: Object.fromEntries(
                    Object.entries(headers)
                        .filter(([k]) => !k.startsWith(':'))
                        .map(([k, v]) => [k, String(v)]),
                ),
                body,
            });
            const reply = replies.shift() ?? { status: 200 };
            stream.respond({
                ':status': reply.status,
                ...(reply.apnsId ? { 'apns-id': reply.apnsId } : {}),
                'content-type': 'application/json',
            });
            stream.end(reply.body ?? '');
        });
    });

    return {
        received,
        /** Queue the next reply. Unqueued requests get a bare 200. */
        reply(r: { status: number; apnsId?: string; body?: string }) {
            replies.push(r);
        },
        async start(): Promise<string> {
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            const { port } = server.address() as AddressInfo;
            return `http://127.0.0.1:${port}`;
        },
        async stop(): Promise<void> {
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}

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
    _setApnsTargetForTesting,
    _resetApnsSessionsForTesting,
} from '@/lib/notifications/apns';

/** A real P-256 key, so the signing path is exercised rather than mocked. */
const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}) as unknown as { privateKey: string };

/**
 * Does this signature verify when read as `enc`?
 *
 * `verify` answers false for a signature it cannot parse and throws for some
 * inputs; both mean "not this encoding" here. Mirrors the helper in
 * `apple-client-secret.test.ts` — the two suites assert the same property
 * about two different ES256 token minters.
 */
const verifiesAs = (
    enc: 'ieee-p1363' | 'der',
    sig: Buffer,
    input: Buffer,
    key: KeyObject,
): boolean => {
    try {
        return cryptoVerify('sha256', input, { key, dsaEncoding: enc }, sig);
    } catch {
        return false;
    }
};

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
        const [header, payload, encodedSig] = apnsProviderToken()!.split('.');
        const sig = Buffer.from(encodedSig, 'base64url');
        const signingInput = Buffer.from(`${header}.${payload}`);
        const pub = createPublicKey(privateKey);

        // Raw ES256 is exactly 64 bytes: r and s, 32 each.
        expect(sig.length).toBe(64);

        // Then prove the encoding BY VERIFYING IN IT. This used to be
        // `expect(sig[0]).not.toBe(0x30)` — the DER SEQUENCE tag — and the
        // first byte of a raw r||s signature is the top byte of `r`, which is
        // uniformly random, so a correct signature failed about 1 run in 256.
        // The sibling instance in `apple-client-secret.test.ts` reddened main
        // that way on 2026-10-21, on a commit that changed two lines of JSON.
        expect(verifiesAs('ieee-p1363', sig, signingInput, pub)).toBe(true);
        expect(verifiesAs('der', sig, signingInput, pub)).toBe(false);
    });

    it('control: the same check can TELL a DER signature apart', () => {
        // Otherwise both assertions above are satisfied by a `verify` that
        // answers true for one encoding and false for the other whatever it is
        // handed — green about a property never tested.
        const [header, payload] = apnsProviderToken()!.split('.');
        const signingInput = Buffer.from(`${header}.${payload}`);
        const pub = createPublicKey(privateKey);
        const der = cryptoSign('sha256', signingInput, { key: privateKey, dsaEncoding: 'der' });

        expect(verifiesAs('der', der, signingInput, pub)).toBe(true);
        expect(verifiesAs('ieee-p1363', der, signingInput, pub)).toBe(false);
        expect(der.length).not.toBe(64);
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

describe('sending — over the real HTTP/2 transport', () => {
    let stub: ReturnType<typeof h2Stub>;

    beforeEach(async () => {
        stub = h2Stub();
        const origin = await stub.start();
        _setApnsTargetForTesting({ origin });
    });

    afterEach(async () => {
        _resetApnsSessionsForTesting();
        _setApnsTargetForTesting(null);
        await stub.stop();
    });

    it('actually completes a request — the case the fetch mock could not fail', async () => {
        // The regression test for the defect itself. Under the old sender this
        // threw `fetch failed` against any HTTP/2 peer, and the suite passed
        // because the peer was a jest mock.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        stub.reply({ status: 200, apnsId: 'AAAA-BBBB-CCCC' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(stub.received).toHaveLength(1);
        expect(info).toHaveBeenCalledWith(
            'apns.sent',
            expect.objectContaining({ status: 200, apnsId: 'AAAA-BBBB-CCCC' }),
        );
    });

    it('POSTs to /3/device/<token>', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(stub.received[0].method).toBe('POST');
        expect(stub.received[0].path).toBe(`/3/device/${TOKEN}`);
    });

    it('sends the topic, the push type, the bearer and a root-relative link', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);

        await sendApnsToUser(CTX, 'u2', {
            title: 'Заглавие',
            body: 'Тяло',
            link: '/t/acme/tasks/1',
            collapseId: 'task-1',
        });

        const { headers, body } = stub.received[0];
        expect(headers['apns-topic']).toBe('bg.agrent.app');
        expect(headers['apns-push-type']).toBe('alert');
        expect(headers['apns-collapse-id']).toBe('task-1');
        expect(headers.authorization).toMatch(/^bearer /);

        const parsed = JSON.parse(body);
        expect(parsed.aps.alert).toEqual({ title: 'Заглавие', body: 'Тяло' });
        // Beside `aps`, never inside it — a custom key inside `aps` is ignored.
        expect(parsed.link).toBe('/t/acme/tasks/1');
        expect(parsed.aps.link).toBeUndefined();
    });

    it('REFUSES a row with no environment, and says so', async () => {
        // A guess is wrong half the time and fails as BadDeviceToken —
        // indistinguishable from a revoked token, so guessing would get a
        // working registration pruned.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: null },
        ]);

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(stub.received).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(
            'apns.row_has_no_environment',
            expect.objectContaining({ subscriptionId: 's1' }),
        );
    });

    it('reuses ONE session across sends to the same host', async () => {
        // Apple asks providers to hold connections open, and a TLS handshake
        // per device would dominate a fan-out. Observed through the server: a
        // single session means both streams arrive on one connection.
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
            { id: 's2', deviceToken: 'cd'.repeat(32), apnsEnvironment: 'DEVELOPMENT' },
        ]);

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(stub.received).toHaveLength(2);
    });

    it('picks the host from the ROW, not from the deployment', () => {
        // Asserted on the map rather than on a URL, because the test redirects
        // the ORIGIN — so the host a request lands on here is the stub's by
        // construction and could not distinguish the two.
        //
        // What the redirect cannot hide is the map itself and that `deliver`
        // indexes it by `row.apnsEnvironment`, which is checked in source
        // below. One deployment serves both: a development-signed install and
        // a TestFlight build register against the same server, and a token is
        // valid at exactly one host.
        expect(APNS_HOSTS.DEVELOPMENT).toBe('api.sandbox.push.apple.com');
        expect(APNS_HOSTS.PRODUCTION).toBe('api.push.apple.com');
        expect(APNS_HOSTS.DEVELOPMENT).not.toBe(APNS_HOSTS.PRODUCTION);
    });
});

describe('pruning — over the real HTTP/2 transport', () => {
    let stub: ReturnType<typeof h2Stub>;

    beforeEach(async () => {
        stub = h2Stub();
        _setApnsTargetForTesting({ origin: await stub.start() });
    });

    afterEach(async () => {
        _resetApnsSessionsForTesting();
        _setApnsTargetForTesting(null);
        await stub.stop();
    });

    it('prunes on 410 Unregistered', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        stub.reply({ status: 410, body: '{"reason":"Unregistered"}' });

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
        stub.reply({ status: 400, body: '{"reason":"BadDeviceToken"}' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(mockDeleteMany).not.toHaveBeenCalled();
        // And the REASON is logged, so an operator can tell this from a 403
        // or a 429 rather than seeing one undifferentiated failure.
        expect(warn).toHaveBeenCalledWith(
            'apns.send_failed',
            expect.objectContaining({
                status: 400,
                reason: expect.stringContaining('BadDeviceToken'),
            }),
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
        stub.reply({ status: 410, body: '' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        const where = mockDeleteMany.mock.calls[0][0].where;
        expect(where.deviceToken).toEqual({ in: [TOKEN] });
        expect(where).not.toHaveProperty('id');
    });

    it('prunes the dead token while the live one still delivers', async () => {
        // The production shape as of tonight: four rows, two tokens, one
        // stale. The stale one must be removed without costing the live one
        // its notification.
        const LIVE = 'ef'.repeat(32);
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
            { id: 's2', deviceToken: LIVE, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        stub.reply({ status: 410, body: '{"reason":"Unregistered"}' });
        stub.reply({ status: 200, apnsId: 'LIVE-ID' });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(stub.received).toHaveLength(2);
        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { platform: 'IOS', deviceToken: { in: [TOKEN] } },
        });
        expect(info).toHaveBeenCalledWith(
            'apns.sent',
            expect.objectContaining({ apnsId: 'LIVE-ID' }),
        );
    });

    it('logs the row COUNT, not just that it ran', async () => {
        mockFindMany.mockResolvedValue([
            { id: 's1', deviceToken: TOKEN, apnsEnvironment: 'DEVELOPMENT' },
        ]);
        stub.reply({ status: 410, body: '' });
        mockDeleteMany.mockResolvedValue({ count: 2 });

        await sendApnsToUser(CTX, 'u2', { title: 't', body: 'b' });

        expect(info).toHaveBeenCalledWith(
            'apns.pruned_dead_tokens',
            // `rowsRemoved` is the delete's own count and `tokens` is what was
            // asked for. Both, because a delete under RLS removes zero rows
            // SILENTLY when SELECT hides them — so "it ran" and "it deleted"
            // are different facts and asserting only the first would pass on a
            // prune that removed nothing.
            expect.objectContaining({ rowsRemoved: 2, tokens: 1 }),
        );
    });

    it('indexes the host map by the ROW, in source', () => {
        // The half the origin redirect cannot observe. Paired with the map
        // assertion above, this is what keeps "one deployment, two hosts"
        // honest without a second live server.
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/lib/notifications/apns.ts'),
            'utf8',
        );
        expect(src).toMatch(/APNS_HOSTS\[row\.apnsEnvironment/);
    });
});
