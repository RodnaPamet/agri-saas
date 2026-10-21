/**
 * An unseen OAuth identity must not attach itself to whoever is signed in.
 *
 * The behaviour under test is next-auth 4's, not ours: its callback handler
 * resolves `user` from the existing session BEFORE looking at the incoming
 * account, and then links an unrecognised provider account to that user. The
 * wrapper refuses that while still allowing the link a first-time signup
 * needs, and those two are indistinguishable from the account object alone —
 * so the tests below are about WHICH of the two call sites is being served.
 *
 * Each `it()` names what breaks in production if it fails.
 */
import {
    refuseImplicitAccountLinks,
    ImplicitAccountLinkRefused,
    IMPLICIT_LINK_GRACE_MS,
} from '@/lib/auth/refuse-implicit-links';

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Adapter = Parameters<typeof refuseImplicitAccountLinks>[0];

function baseAdapter(over: Partial<Adapter> = {}) {
    const calls: string[] = [];
    let n = 0;
    const base = {
        createUser: jest.fn(async (data: Record<string, unknown>) => {
            calls.push('createUser');
            return { ...data, id: `u${++n}` };
        }),
        linkAccount: jest.fn(async () => {
            calls.push('linkAccount');
            return undefined;
        }),
        getUser: jest.fn(),
        getUserByEmail: jest.fn(),
        getUserByAccount: jest.fn(),
        ...over,
    } as unknown as Adapter;
    return { base, calls };
}

const account = (userId: string, provider = 'google') => ({
    userId,
    provider,
    type: 'oauth' as const,
    providerAccountId: 'sub-abc',
});

describe('the legitimate path still works', () => {
    // Break: every new Google signup fails. `linkAccount` is how a first-time
    // OAuth user attaches their identity, twenty lines below the dangerous
    // call and with identical arguments.
    it('links an account to a user createUser just minted', async () => {
        const { base, calls } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        const user = await a.createUser!({ email: 'new@example.com' } as never);
        await expect(a.linkAccount!(account(user.id) as never)).resolves.toBeUndefined();
        expect(calls).toEqual(['createUser', 'linkAccount']);
        expect(base.linkAccount).toHaveBeenCalledWith(
            expect.objectContaining({ userId: user.id, provider: 'google' }),
        );
    });

    it('passes the user payload through untouched', async () => {
        const { base } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        const user = await a.createUser!({ email: 'x@example.com', name: 'X' } as never);
        expect(base.createUser).toHaveBeenCalledWith({ email: 'x@example.com', name: 'X' });
        expect(user).toMatchObject({ email: 'x@example.com', name: 'X', id: 'u1' });
    });
});

describe('the implicit link is refused', () => {
    // Break: THE one. A second person signing in on a shared device with their
    // own new provider account lands in the first person's account, and their
    // identity becomes a permanent credential for it from anywhere.
    it('refuses a link to a user it did not just create', async () => {
        const { base, calls } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        await expect(a.linkAccount!(account('u-already-signed-in') as never)).rejects.toThrow(
            ImplicitAccountLinkRefused,
        );
        // The load-bearing half: refusing with an error while still writing the
        // row would be no protection at all.
        expect(base.linkAccount).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it('names the provider in the refusal, so the log says which', async () => {
        const { base } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        await expect(a.linkAccount!(account('u9', 'apple') as never)).rejects.toThrow(/apple/);
    });

    // Break: one signup would authorise a second, different provider identity
    // riding in on the same window.
    it('consumes the allowance — a second link for the same user is refused', async () => {
        const { base } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        const user = await a.createUser!({ email: 'one@example.com' } as never);
        await expect(a.linkAccount!(account(user.id, 'google') as never)).resolves.toBeUndefined();
        await expect(a.linkAccount!(account(user.id, 'apple') as never)).rejects.toThrow(
            ImplicitAccountLinkRefused,
        );
        expect(base.linkAccount).toHaveBeenCalledTimes(1);
    });

    // Break: a `createUser` whose `linkAccount` never arrived would leave a
    // permanent allowance for that user id, which is the hole reopened for one
    // specific account.
    it('expires the allowance after the grace window', async () => {
        const { base } = baseAdapter();
        let clock = 1_000_000;
        const a = refuseImplicitAccountLinks(base, () => clock);
        const user = await a.createUser!({ email: 'slow@example.com' } as never);
        clock += IMPLICIT_LINK_GRACE_MS + 1;
        await expect(a.linkAccount!(account(user.id) as never)).rejects.toThrow(
            ImplicitAccountLinkRefused,
        );
        expect(base.linkAccount).not.toHaveBeenCalled();
    });

    it('keeps the allowance INSIDE the window', async () => {
        const { base } = baseAdapter();
        let clock = 1_000_000;
        const a = refuseImplicitAccountLinks(base, () => clock);
        const user = await a.createUser!({ email: 'ok@example.com' } as never);
        clock += IMPLICIT_LINK_GRACE_MS - 1;
        await expect(a.linkAccount!(account(user.id) as never)).resolves.toBeUndefined();
    });

    // Break: two people signing up at once would each consume the other's
    // allowance, so one of the two signups would fail.
    it('keeps two concurrent signups independent', async () => {
        const { base } = baseAdapter();
        const a = refuseImplicitAccountLinks(base);
        const u1 = await a.createUser!({ email: 'a@example.com' } as never);
        const u2 = await a.createUser!({ email: 'b@example.com' } as never);
        await expect(a.linkAccount!(account(u2.id) as never)).resolves.toBeUndefined();
        await expect(a.linkAccount!(account(u1.id) as never)).resolves.toBeUndefined();
        expect(base.linkAccount).toHaveBeenCalledTimes(2);
    });
});

describe('the rest of the adapter is untouched', () => {
    // Break: wrapping drops every method it does not name, which would take
    // out session lookup, verification tokens and the whole credentials path.
    it('forwards methods it does not override', () => {
        const extra = jest.fn();
        const { base } = baseAdapter({ getSessionAndUser: extra } as never);
        const a = refuseImplicitAccountLinks(base) as unknown as Record<string, unknown>;
        expect(a.getSessionAndUser).toBe(extra);
        expect(a.getUserByAccount).toBe(
            (base as unknown as Record<string, unknown>).getUserByAccount,
        );
    });
});
