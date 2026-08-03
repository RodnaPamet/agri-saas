/**
 * The credentials `authorize` callback must surface exactly ONE failure
 * reason and collapse every other into NextAuth's generic
 * CredentialsSignin, preserving account-enumeration safety.
 */
const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/credentials', () => ({
    __esModule: true,
    authenticateWithPassword: (...a: unknown[]) => mockAuthenticate(...a),
}));

import { authOptions } from '@/auth';

type AuthorizeFn = (creds: Record<string, string>) => Promise<unknown>;

function getAuthorize(): AuthorizeFn {
    const provider = (authOptions.providers as unknown as Array<Record<string, unknown>>).find(
        (p) => p.id === 'credentials',
    );
    if (!provider) throw new Error('credentials provider not registered');
    // NextAuth's `Credentials(...)` factory (node_modules/next-auth/providers/credentials.js)
    // returns a fixed shell object — `{ id: 'credentials', ..., authorize: () => null,
    // options: <the config object we actually passed in> }`. The real `authorize` we
    // define in src/auth.ts lives under `.options`, not on the provider object itself;
    // `provider.authorize` is a permanent stub that always resolves `null`. NextAuth's
    // own request-time `parseProviders()` merges `.options` back over the shell before
    // dispatching a real sign-in, so this reflects production behaviour, not a bypass
    // of it.
    const providerOptions = (provider as { options?: { authorize?: AuthorizeFn } }).options;
    if (!providerOptions?.authorize) {
        throw new Error('credentials provider authorize not registered');
    }
    return providerOptions.authorize;
}

const CREDS = { email: 'user@example.com', password: 'pw' };

beforeEach(() => jest.clearAllMocks());

it('throws EmailNotVerified when the password was correct but the email is not confirmed', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'email_not_verified' });
    await expect(getAuthorize()(CREDS)).rejects.toThrow('EmailNotVerified');
});

it.each(['credentials_invalid', 'unknown_email', 'rate_limited'])(
    'collapses %s into a null return (generic CredentialsSignin)',
    async (reason) => {
        mockAuthenticate.mockResolvedValue({ ok: false, reason });
        await expect(getAuthorize()(CREDS)).resolves.toBeNull();
    },
);

it('returns the user on success', async () => {
    mockAuthenticate.mockResolvedValue({
        ok: true, userId: 'u1', email: CREDS.email, name: 'User',
    });
    await expect(getAuthorize()(CREDS)).resolves.toEqual({
        id: 'u1', email: CREDS.email, name: 'User',
    });
});
