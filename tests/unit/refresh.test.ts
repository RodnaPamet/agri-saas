/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for OAuth token refresh logic.
 */
import {
    isTokenExpired,
    refreshGoogleToken,
    refreshMicrosoftToken,
} from '@/lib/auth/refresh';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
    mockFetch.mockReset();
    process.env.GOOGLE_CLIENT_ID = 'test-google-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'; // pragma: allowlist secret -- test fixture for OAuth refresh flow
    process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
    process.env.MICROSOFT_TENANT_ID = 'test-tenant';
});

describe('isTokenExpired', () => {
    it('returns true when token is expired', () => {
        const pastTimestamp = Math.floor(Date.now() / 1000) - 100;
        expect(isTokenExpired(pastTimestamp)).toBe(true);
    });

    it('returns true when token expires within skew window (60s)', () => {
        const nearExpiry = Math.floor(Date.now() / 1000) + 30; // 30s from now
        expect(isTokenExpired(nearExpiry)).toBe(true);
    });

    it('returns false when token has time remaining beyond skew', () => {
        const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour
        expect(isTokenExpired(futureTimestamp)).toBe(false);
    });
});

describe('refreshGoogleToken', () => {
    it('successfully refreshes a Google token', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-google-access-token', // pragma: allowlist secret -- mock OAuth response
                expires_in: 3600,
            }),
        });

        const result = await refreshGoogleToken('google-refresh-token');

        expect(result.accessToken).toBe('new-google-access-token');
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(result.refreshToken).toBeUndefined(); // Google doesn't always rotate

        // Verify correct endpoint was called
        expect(mockFetch).toHaveBeenCalledWith(
            'https://oauth2.googleapis.com/token',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('handles refresh token rotation (new refresh_token returned)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-access',
                refresh_token: 'new-refresh-rotated',
                expires_in: 3600,
            }),
        });

        const result = await refreshGoogleToken('old-refresh-token');

        expect(result.accessToken).toBe('new-access');
        expect(result.refreshToken).toBe('new-refresh-rotated');
    });

    it('throws on refresh failure', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'invalid_grant',
        });

        await expect(refreshGoogleToken('bad-token')).rejects.toThrow(
            'Google token refresh failed: 401'
        );
    });
});

describe('refreshMicrosoftToken', () => {
    it('successfully refreshes a Microsoft token', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-ms-access-token', // pragma: allowlist secret -- mock OAuth response
                expires_in: 3600,
            }),
        });

        const result = await refreshMicrosoftToken('ms-refresh-token');

        expect(result.accessToken).toBe('new-ms-access-token');
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

        // Verify correct tenant-specific endpoint
        expect(mockFetch).toHaveBeenCalledWith(
            'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('handles refresh token rotation for Microsoft', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-access',
                refresh_token: 'rotated-ms-refresh',
                expires_in: 3600,
            }),
        });

        const result = await refreshMicrosoftToken('old-token');
        expect(result.refreshToken).toBe('rotated-ms-refresh');
    });

    it('throws on Microsoft refresh failure', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            text: async () => 'invalid_grant',
        });

        await expect(refreshMicrosoftToken('bad-token')).rejects.toThrow(
            'Microsoft token refresh failed: 400'
        );
    });
});

/*
 * `describe('refreshAccessToken')` stood here until #1986 — three tests over a
 * switch that routed to the two functions above.
 *
 * It went with its subject. The proactive refresh in the `jwt` callback was
 * the dispatcher's only caller, and both integration token modules call the
 * provider functions directly because each knows which provider it is. The
 * routing it tested is covered by those functions' own tests above; what is
 * gone is a layer, not a behaviour.
 */
