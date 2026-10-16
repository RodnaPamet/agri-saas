/**
 * Google connection-management service — #2005.
 *
 * DB, encryption, audit and admin policy are mocked. The token module is
 * mocked PARTIALLY: `exchangeCodeForGoogleToken` is a double, but
 * `grantedProducts` runs for real because it is pure and is the function whose
 * behaviour these tests are about.
 *
 * The cases that matter are the partial grant and the empty grant. Google's
 * consent screen lets the scopes be ticked individually, so a connection can
 * exist with Calendar granted and Drive denied — a shape that could not occur
 * with one row per product, and one that fails at USE time rather than connect
 * time if the service does not record it.
 */
const mockDb = {
    integrationConnection: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
    },
};
const assertFlagMock = jest.fn();
const logEventMock = jest.fn();
const exchangeMock = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: typeof mockDb) => unknown) => fn(mockDb),
}));
// Identity crypto so the stored secret round-trips as plain JSON here.
jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    encryptField: (x: string) => x,
    decryptField: (x: string) => x,
}));
jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));
jest.mock('@/app-layer/policies/common', () => ({
    __esModule: true,
    assertCanAdmin: jest.fn(),
}));
jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    assertFeatureEnabled: (...a: unknown[]) => assertFlagMock(...a),
}));
jest.mock('@/app-layer/integrations/providers/google/token', () => {
    // Factory-local require: a top-level import is hoisted above this factory.
    const actual = jest.requireActual(
        '@/app-layer/integrations/providers/google/token',
    ) as typeof import('@/app-layer/integrations/providers/google/token');
    return {
        ...actual,
        exchangeCodeForGoogleToken: (...a: unknown[]) => exchangeMock(...a),
    };
});

import {
    completeGoogleConnect,
    disconnectGoogle,
    resolveGoogleConnectionToken,
    GOOGLE_INTEGRATION_FLAG,
} from '@/app-layer/integrations/providers/google/service';
import {
    GOOGLE_DRIVE_SCOPE,
    GOOGLE_CALENDAR_SCOPE,
} from '@/app-layer/integrations/providers/google/token';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';

/**
 * A minimal context. Cast through `unknown` rather than `any` so the file
 * needs no `no-explicit-any` suppression — the lint ceiling ratchets those,
 * and a file-level disable spends three of them to save two annotations.
 */
const ctx = { tenantId: 't-1', userId: 'u-1' } as unknown as RequestContext;
const INPUT = { code: 'code-1', redirectUri: 'https://app.agrent.bg/api/integrations/google/callback' };

const grant = (scopes: string[]) => ({
    accessToken: 'AT',
    refreshToken: 'RT',
    expiresAt: 9_999_999_999,
    grantedScopes: scopes,
});

beforeEach(() => {
    jest.clearAllMocks();
    assertFlagMock.mockResolvedValue(undefined);
    mockDb.integrationConnection.create.mockResolvedValue({ id: 'conn-1' });
});

describe('completeGoogleConnect', () => {
    it('checks the runtime flag for the CALLER before touching the database', async () => {
        // The gate lives here and not only in the connect route because the
        // callback is tenant-agnostic and re-authorises independently — a gate
        // only in the route would be absent from the path that writes the row.
        assertFlagMock.mockRejectedValue(new Error('flag off'));

        await expect(completeGoogleConnect(ctx, INPUT)).rejects.toThrow('flag off');

        expect(assertFlagMock).toHaveBeenCalledWith(GOOGLE_INTEGRATION_FLAG, 'u-1');
        expect(mockDb.integrationConnection.create).not.toHaveBeenCalled();
        expect(exchangeMock).not.toHaveBeenCalled();
    });

    it('records a PARTIAL grant in configJson, where only Calendar was ticked', async () => {
        exchangeMock.mockResolvedValue(grant([GOOGLE_CALENDAR_SCOPE]));

        const out = await completeGoogleConnect(ctx, INPUT);

        expect(out.grantedProducts).toEqual({ drive: false, calendar: true });
        const data = mockDb.integrationConnection.create.mock.calls[0][0].data;
        expect(data.configJson).toEqual({
            grantedProducts: { drive: false, calendar: true },
            grantedScopes: [GOOGLE_CALENDAR_SCOPE],
        });
    });

    it('records both products when both were granted', async () => {
        exchangeMock.mockResolvedValue(grant([GOOGLE_DRIVE_SCOPE, GOOGLE_CALENDAR_SCOPE]));

        const out = await completeGoogleConnect(ctx, INPUT);

        expect(out.grantedProducts).toEqual({ drive: true, calendar: true });
    });

    it('REFUSES a grant of nothing rather than storing a connection that cannot work', async () => {
        // The user reached the consent screen and ticked neither scope. A row
        // created here would read as "connected" in the UI and fail on first
        // use.
        exchangeMock.mockResolvedValue(grant([]));

        // Asserted on the CODE, not the copy. `ErrorResponse.error.code` is
        // what a client switches on and what the spec publishes; the message
        // is copy that gets reworded and translated. A test pinned to the
        // wording fails every time the wording improves — this one did,
        // when "no usable scopes" became "no usable permissions".
        await expect(completeGoogleConnect(ctx, INPUT)).rejects.toMatchObject({
            code: 'GOOGLE_SCOPES_MISSING',
        });
        expect(mockDb.integrationConnection.create).not.toHaveBeenCalled();
    });

    it('stores the credential encrypted and never in configJson', async () => {
        exchangeMock.mockResolvedValue(grant([GOOGLE_DRIVE_SCOPE]));

        await completeGoogleConnect(ctx, INPUT);

        const data = mockDb.integrationConnection.create.mock.calls[0][0].data;
        // Identity crypto in this suite, so the secret is readable here — the
        // assertion is about WHERE it goes, not whether it is ciphertext.
        expect(JSON.parse(data.secretEncrypted).refreshToken).toBe('RT');
        expect(JSON.stringify(data.configJson)).not.toContain('RT');
        expect(JSON.stringify(data.configJson)).not.toContain('AT');
    });

    it('audits the connection with WHICH products were obtained', async () => {
        exchangeMock.mockResolvedValue(grant([GOOGLE_DRIVE_SCOPE]));

        await completeGoogleConnect(ctx, INPUT);

        const entry = logEventMock.mock.calls[0][2];
        expect(entry.action).toBe('INTEGRATION_CONNECTION_CREATED');
        // A partial grant is the interesting case, so the trail records what
        // was obtained rather than what was asked for.
        expect(entry.detailsJson.summary).toContain('drive=true');
        expect(entry.detailsJson.summary).toContain('calendar=false');
    });

    it('turns a duplicate-name collision into a 400, not a 500', async () => {
        exchangeMock.mockResolvedValue(grant([GOOGLE_DRIVE_SCOPE]));
        mockDb.integrationConnection.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
        );

        await expect(completeGoogleConnect(ctx, INPUT)).rejects.toMatchObject({
            code: 'GOOGLE_CONNECTION_NAME_TAKEN',
        });
    });
});

describe('disconnectGoogle', () => {
    it('deletes a connection whose credential is already MISSING', async () => {
        // The case that made this bypass `loadConnection`: that helper refuses
        // a connection with no stored secret, which is right for "use it" and
        // wrong for "remove it" — it would leave a broken row the admin cannot
        // clear from the UI.
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });

        await disconnectGoogle(ctx, 'conn-1');

        expect(mockDb.integrationConnection.delete).toHaveBeenCalledWith({ where: { id: 'conn-1' } });
        expect(logEventMock.mock.calls[0][2].action).toBe('INTEGRATION_CONNECTION_DELETED');
    });

    it('does NOT consult the feature flag — turning the integration off must not strand connections', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });

        await disconnectGoogle(ctx, 'conn-1');

        expect(assertFlagMock).not.toHaveBeenCalled();
    });

    it('404s for a connection belonging to another tenant or provider', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);

        // ONE code for "not yours" and "not there" — the query filters on
        // tenantId, so another tenant's connection takes this same path.
        await expect(disconnectGoogle(ctx, 'conn-x')).rejects.toMatchObject({
            code: 'GOOGLE_CONNECTION_NOT_FOUND',
        });
        expect(mockDb.integrationConnection.delete).not.toHaveBeenCalled();
    });
});

describe('resolveGoogleConnectionToken', () => {
    it('persists a rotated secret before handing the token out', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            secretEncrypted: JSON.stringify({
                accessToken: 'AT-old',
                refreshToken: 'RT',
                expiresAt: 1, // long expired
                grantedScopes: [GOOGLE_DRIVE_SCOPE],
            }),
            configJson: { grantedProducts: { drive: true, calendar: false } },
        });

        const out = await resolveGoogleConnectionToken(ctx, 'conn-1', {
            refresh: async () => ({ accessToken: 'AT-new', expiresAt: 9_999_999_999, refreshToken: undefined }),
        });

        expect(out.accessToken).toBe('AT-new');
        expect(mockDb.integrationConnection.update).toHaveBeenCalledTimes(1);
        const persisted = JSON.parse(
            mockDb.integrationConnection.update.mock.calls[0][0].data.secretEncrypted,
        );
        expect(persisted.accessToken).toBe('AT-new');
        // Google does not return a refresh token on refresh; dropping the old
        // one would make the connection unrecoverable after an hour.
        expect(persisted.refreshToken).toBe('RT');
    });

    it('defaults to NO products when configJson is missing, rather than assuming both', async () => {
        // Default-deny. A connection whose granted products cannot be read
        // must not read as "both work", or the first export fails with a 403.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            secretEncrypted: JSON.stringify({
                accessToken: 'AT',
                refreshToken: 'RT',
                expiresAt: 9_999_999_999,
                grantedScopes: [],
            }),
            configJson: null,
        });

        const out = await resolveGoogleConnectionToken(ctx, 'conn-1');

        expect(out.grantedProducts).toEqual({ drive: false, calendar: false });
    });
});
