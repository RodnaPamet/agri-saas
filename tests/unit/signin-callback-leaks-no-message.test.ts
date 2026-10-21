/**
 * A database failure during OAuth sign-in must not put its message in a URL.
 *
 * next-auth interpolates a thrown error's MESSAGE into the redirect query
 * string — `core/routes/callback.js`, the `catch` around each
 * `callbacks.signIn` call does `?error=${encodeURIComponent(error.message)}`.
 * Our `signIn` callback runs three unguarded Prisma queries, so a pool
 * timeout, a dropped connection or a `P2002` on the `Account` create used to
 * land its text in a URL the person sees, the browser keeps in history, and
 * which travels in `Referer` and any proxy log. Prisma messages name
 * constraints and fields.
 *
 * The sign-in still FAILS — an unhandled throw failed it too, so this changes
 * no decision. Only the message changes, and `'Callback'` is chosen because
 * in that interpolation the message IS the code: `?error=Callback`, which
 * `lib/auth/redirect-error-codes.ts` maps to the generic copy.
 */
const userFindFirst = jest.fn();
const accountFindUnique = jest.fn();
const accountCreate = jest.fn();
const loggerError = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
        account: {
            findUnique: (...a: unknown[]) => accountFindUnique(...a),
            create: (...a: unknown[]) => accountCreate(...a),
        },
    },
}));

jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: {
        error: (...a: unknown[]) => loggerError(...a),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import { authOptions } from '@/auth';

type SignInCb = NonNullable<NonNullable<typeof authOptions.callbacks>['signIn']>;
const signInCallback = authOptions.callbacks!.signIn as SignInCb;

/**
 * next-auth's signIn params type is not exported and the callback reads only
 * `user`, `account` and `profile` on these paths. Cast through `unknown`
 * rather than `any`: `as any` sits at its ratchet cap, and a new
 * `eslint-disable` would breach the lint ceiling, which is also at cap.
 */
type SignInArgs = Parameters<SignInCb>[0];
const callSignIn = (args: {
    user: Record<string, unknown>;
    account: Record<string, unknown> | null;
    profile?: Record<string, unknown>;
}) => signInCallback(args as unknown as SignInArgs);

/** What a real Prisma unique-constraint error reads like. */
const PRISMA_DETAIL =
    'Unique constraint failed on the fields: (`provider`,`providerAccountId`)';

const oauthAccount = {
    provider: 'google',
    providerAccountId: 'sub-123',
    type: 'oauth',
};

describe('the signIn callback does not leak a cause into the redirect', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        accountFindUnique.mockResolvedValue(null);
        accountCreate.mockResolvedValue({});
    });

    it('control: the happy path still links and returns true', () => {
        // Without this, every assertion below could be passing because the
        // branch is never entered.
        userFindFirst.mockResolvedValue({ id: 'user-existing' });
        return expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            }),
        ).resolves.toBe(true);
    });

    it('control: the link branch really was reached in that happy path', async () => {
        userFindFirst.mockResolvedValue({ id: 'user-existing' });
        await callSignIn({
            user: { id: 'provider-subject', email: 'owner@example.com' },
            account: oauthAccount,
        });
        expect(accountCreate).toHaveBeenCalledTimes(1);
    });

    it('throws the CODE, not the database message, when a query fails', async () => {
        userFindFirst.mockRejectedValue(new Error(PRISMA_DETAIL));
        await expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            }),
        ).rejects.toThrow('Callback');
    });

    it('the thrown message contains NO part of the database detail', async () => {
        // The assertion that matters. `rejects.toThrow('Callback')` is a
        // substring match and would pass for a message that merely began
        // with it, so the absence is checked explicitly.
        userFindFirst.mockRejectedValue(new Error(PRISMA_DETAIL));
        let message = '<callback did not throw>';
        try {
            await callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            });
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toBe('Callback');
        expect(message).not.toContain('Unique constraint');
        expect(message).not.toContain('providerAccountId');
    });

    it('still fails for a create that rejects, not only a read', async () => {
        // All three queries are inside the guard, not just the first.
        userFindFirst.mockResolvedValue({ id: 'user-existing' });
        accountCreate.mockRejectedValue(new Error(PRISMA_DETAIL));
        await expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            }),
        ).rejects.toThrow('Callback');
    });

    it('keeps the real cause in the log', async () => {
        // Sanitising the redirect is only acceptable because the cause is
        // still recoverable by an operator.
        userFindFirst.mockRejectedValue(new Error(PRISMA_DETAIL));
        await expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            }),
        ).rejects.toThrow();
        expect(loggerError).toHaveBeenCalledTimes(1);
        const [, fields] = loggerError.mock.calls[0] as [string, Record<string, unknown>];
        expect(fields.error).toContain('Unique constraint');
        expect(fields.provider).toBe('google');
    });

    it('does not log the email address', async () => {
        // The log is the safe place for the cause, not for the person.
        userFindFirst.mockRejectedValue(new Error(PRISMA_DETAIL));
        await expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
            }),
        ).rejects.toThrow();
        expect(JSON.stringify(loggerError.mock.calls[0])).not.toContain('owner@example.com');
    });

    it('a provider reporting email_verified=false still RETURNS FALSE, not a throw', async () => {
        // That branch is a deliberate access decision and sits outside the
        // try. Converting it into `?error=Callback` would turn a refusal into
        // "something went wrong, try again" — advice that cannot work.
        await expect(
            callSignIn({
                user: { id: 'provider-subject', email: 'owner@example.com' },
                account: oauthAccount,
                profile: { email_verified: false },
            }),
        ).resolves.toBe(false);
    });

    it('a credentials sign-in does not enter the guarded branch at all', async () => {
        await expect(
            callSignIn({
                user: { id: 'user-1', email: 'owner@example.com' },
                account: { ...oauthAccount, provider: 'credentials' },
            }),
        ).resolves.toBe(true);
        expect(userFindFirst).not.toHaveBeenCalled();
    });
});
