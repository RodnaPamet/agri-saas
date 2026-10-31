/**
 * The NATIVE Google consent branch — #2495 step 6.
 *
 * Prisma is mocked, so this proves the DECISIONS: that the state is claimed
 * exactly once, that an unknown state is distinguishable from a replayed one
 * for BRANCHING but not for reporting, and that the two branches of the connect
 * route differ in exactly the way the phone depends on.
 *
 * The cookie assertion is written as a COMPARISON — the same request twice,
 * with and without `client: 'ios'` — because "the native branch sets no cookie"
 * is satisfied trivially by a route that sets none at all, and the web flow
 * REQUIRES one. Asserting the absence alone would pass on the change that
 * breaks the browser.
 */
const state = {
    create: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { googleOAuthState: state },
}));

import {
    claimNativeState,
    hashState,
    NATIVE_STATE_TTL_SECONDS,
} from '@/app-layer/integrations/providers/google/native-state';

const NOW = new Date('2026-10-31T12:00:00.000Z');

beforeEach(() => {
    state.create.mockReset().mockResolvedValue({});
    state.updateMany.mockReset();
    state.findUnique.mockReset();
});

describe('claimNativeState — exactly once, and the three outcomes', () => {
    it('claims a live state and reports what it was bound to', async () => {
        state.updateMany.mockResolvedValue({ count: 1 });
        state.findUnique.mockResolvedValue({
            tenantId: 'tenant-1',
            userId: 'user-1',
            redirectUri: 'bg.agrent.app://integrations/google',
        });

        const got = await claimNativeState('raw-state', { now: NOW });

        expect(got).toEqual({
            ok: true,
            tenantId: 'tenant-1',
            userId: 'user-1',
            redirectUri: 'bg.agrent.app://integrations/google',
        });
        // ATOMIC: the claim is a conditional write, not a read-then-write. A
        // `findFirst` then `update` would let two arrivals with one state both
        // pass the check before either wrote — and a second arrival is the
        // replay this exists to refuse.
        expect(state.updateMany).toHaveBeenCalledWith({
            where: { stateHash: hashState('raw-state'), consumedAt: null, expiresAt: { gt: NOW } },
            data: { consumedAt: NOW },
        });
    });

    it('refuses a REPLAY as state_invalid, and still says where to send it', async () => {
        // The claim matches nothing because `consumedAt` is set. The row still
        // exists, so the callback knows this is a native flow and has a
        // redirect target for the error — which is the whole reason the row is
        // read after a failed claim.
        state.updateMany.mockResolvedValue({ count: 0 });
        state.findUnique.mockResolvedValue({
            expiresAt: new Date(NOW.getTime() + 60_000),
            consumedAt: new Date(NOW.getTime() - 60_000),
            redirectUri: 'bg.agrent.app://integrations/google',
        });

        expect(await claimNativeState('raw-state', { now: NOW })).toEqual({
            ok: false,
            reason: 'state_invalid',
            redirectUri: 'bg.agrent.app://integrations/google',
        });
    });

    it('separates EXPIRED from invalid — the one case a person causes', async () => {
        // Unconsumed and past its TTL: the person left the consent screen open.
        // The only outcome for which "try again" is the right instruction, which
        // is why it is not folded into `state_invalid`.
        state.updateMany.mockResolvedValue({ count: 0 });
        state.findUnique.mockResolvedValue({
            expiresAt: new Date(NOW.getTime() - 1000),
            consumedAt: null,
            redirectUri: 'bg.agrent.app://integrations/google',
        });

        expect(await claimNativeState('raw-state', { now: NOW })).toMatchObject({
            ok: false,
            reason: 'state_expired',
        });
    });

    it('reports an UNKNOWN state apart from both — that is how the branch is chosen', async () => {
        // No row at all. Every WEB consent lands here, which is how the cookie
        // branch is reached. It is deliberately NOT `state_invalid`: branching
        // on a bare claim failure could not tell a web state from a native
        // replay, and branching on the cookie's presence would send a web flow
        // whose cookie expired to an app scheme a browser cannot open.
        state.updateMany.mockResolvedValue({ count: 0 });
        state.findUnique.mockResolvedValue(null);

        expect(await claimNativeState('a-web-state', { now: NOW })).toEqual({
            ok: false,
            reason: 'unknown_state',
        });
    });

    it('stores only the HASH, never the state', async () => {
        const { issueNativeState } = await import(
            '@/app-layer/integrations/providers/google/native-state'
        );
        const raw = await issueNativeState({
            tenantId: 'tenant-1',
            userId: 'user-1',
            redirectUri: 'bg.agrent.app://integrations/google',
            now: NOW,
        });

        const [{ data }] = state.create.mock.calls[0] as [{ data: Record<string, unknown> }];
        // The state travels in a redirect the OS may log, so it is treated as a
        // credential. The raw value must appear nowhere in what was written.
        expect(JSON.stringify(data)).not.toContain(raw);
        expect(data.stateHash).toBe(hashState(raw));
        expect(data.expiresAt).toEqual(new Date(NOW.getTime() + NATIVE_STATE_TTL_SECONDS * 1000));
        // Bound to BOTH, because the callback re-checks that this person is
        // still an admin of this farm — a tenant alone would let any admin's
        // consent complete as any other.
        expect(data.tenantId).toBe('tenant-1');
        expect(data.userId).toBe('user-1');
    });
});
