/**
 * `assertPublicAddress` — layer 2 of the SSRF policy, finally a real function.
 *
 * The `webhook-safety.ts` docblock has named this symbol since the guard was
 * written, and until #696 it did not exist: `git grep assertPublicAddress`
 * returned exactly one hit, that docblock line. The DNS re-check lived as six
 * inline lines inside `fireWebhook`, which made it invisible to any second
 * consumer — the Web Push guard would have inherited only the weaker
 * structural half.
 *
 * Extracting it also upgraded it, and each upgrade is asserted below:
 *
 *   · `{ all: true }` — the inline version resolved ONE address, so a host
 *     with several A records passed as long as the first was public.
 *   · a timeout — `dns.lookup` has none of its own, and this runs inside an
 *     HTTP request on some paths.
 *   · a per-host cache — real endpoints concentrate on a handful of hosts, so
 *     the send path should not pay a resolve per subscription.
 */
const lookupMock = jest.fn();
jest.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

import {
    assertPublicAddress,
    _resetDnsVerdictCache,
} from '@/app-layer/automation/webhook-safety';

beforeEach(() => {
    lookupMock.mockReset();
    _resetDnsVerdictCache();
});

describe('assertPublicAddress', () => {
    it('allows a host resolving only to public addresses', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        await expect(assertPublicAddress('example.com')).resolves.toMatchObject({ ok: true });
    });

    it('refuses a host resolving to a private address', async () => {
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
        const v = await assertPublicAddress('evil.example.com');
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/private 10\.0\.0\.5/);
    });

    it('refuses when ANY address is private, not just the first', async () => {
        // The inline version this replaced took `const { address } = await
        // lookup(host)` — one record. A DNS-rebinding-lite setup that returns
        // a public A first and a private A second walked straight through it.
        lookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '169.254.169.254', family: 4 },
        ]);
        const v = await assertPublicAddress('mixed.example.com');
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/169\.254\.169\.254/);
    });

    it('asks for ALL addresses — the flag, not just the behaviour', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        await assertPublicAddress('example.com');
        expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true });
    });

    it('refuses a host that cannot be resolved — fails CLOSED', async () => {
        // Failing open here would undo layer 1: an attacker who can make a
        // lookup fail would get a free pass to the fetch.
        lookupMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
        const v = await assertPublicAddress('nx.example.com');
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/cannot resolve/);
    });

    it('refuses when the resolver hangs, rather than hanging with it', async () => {
        jest.useFakeTimers();
        lookupMock.mockImplementation(() => new Promise(() => {})); // never settles
        const pending = assertPublicAddress('slow.example.com');
        await jest.advanceTimersByTimeAsync(2_500);
        const v = await pending;
        expect(v.ok).toBe(false);
        jest.useRealTimers();
    });

    it('normalises the host, so a trailing dot is the same cache entry', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        await assertPublicAddress('example.com.');
        expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true });
    });

    it('caches a verdict per host', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        await assertPublicAddress('example.com');
        await assertPublicAddress('example.com');
        await assertPublicAddress('example.com');
        expect(lookupMock).toHaveBeenCalledTimes(1);
    });

    it('caches REFUSALS too — a blocked host must not re-resolve per send', async () => {
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
        await assertPublicAddress('bad.example.com');
        await assertPublicAddress('bad.example.com');
        expect(lookupMock).toHaveBeenCalledTimes(1);
    });

    it('keeps different hosts apart', async () => {
        lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
        lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
        await expect(assertPublicAddress('a.example.com')).resolves.toMatchObject({ ok: true });
        await expect(assertPublicAddress('b.example.com')).resolves.toMatchObject({ ok: false });
    });

    it('the reset seam actually clears — otherwise every test above is order-dependent', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        await assertPublicAddress('example.com');
        _resetDnsVerdictCache();
        await assertPublicAddress('example.com');
        expect(lookupMock).toHaveBeenCalledTimes(2);
    });
});
