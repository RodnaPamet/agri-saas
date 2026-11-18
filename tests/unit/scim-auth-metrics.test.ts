/**
 * EI-4 — `authenticateScimRequest` records a `scim.auth.count` metric at every
 * terminal branch. Operators alert on `not_found` (brute-force / stale
 * connector) and `revoked` (IdP still pushing a rotated token); without the
 * metric those failures are only visible as pino warns, which dashboards miss.
 *
 * Every external dependency (Prisma, logger) is mocked — no DB.
 */
const mockRecord = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordScimAuth: (...args: unknown[]) => mockRecord(...args),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantScimToken: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        },
    },
}));

// SCIM is turned OFF in production (owner ruling 2026-11-18). These cases
// exercise the dormant mechanism, so the flag is ON unless a case says not.
const mockScimEnabled = jest.fn(async () => true);
jest.mock('@/lib/auth/tenant-sso-availability', () => ({
    isScimEnabled: () => mockScimEnabled(),
}));

import { authenticateScimRequest, ScimAuthError } from '@/lib/scim/auth';

/** Minimal NextRequest stand-in — the function only reads the auth header. */
function reqWith(authorization?: string) {
    return {
        headers: { get: (k: string) => (k === 'authorization' ? authorization ?? null : null) },
    } as unknown as Parameters<typeof authenticateScimRequest>[0];
}

beforeEach(() => {
    mockScimEnabled.mockResolvedValue(true);
    mockRecord.mockClear();
    mockFindUnique.mockReset();
    mockUpdate.mockClear().mockResolvedValue(undefined);
});

describe('authenticateScimRequest — scim.auth.count metric', () => {
    it('missing_header when there is no Bearer header', async () => {
        await expect(authenticateScimRequest(reqWith(undefined))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'missing_header' });
    });

    it('empty_token when the Bearer value is blank', async () => {
        await expect(authenticateScimRequest(reqWith('Bearer    '))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'empty_token' });
    });

    it('not_found when the token hash matches no row', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(authenticateScimRequest(reqWith('Bearer abc'))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'not_found' });
    });

    it('revoked when the token row is revoked', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'l', revokedAt: new Date() });
        await expect(authenticateScimRequest(reqWith('Bearer abc'))).rejects.toBeInstanceOf(ScimAuthError);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'failure', reason: 'revoked' });
    });

    it('success on a live token, and returns the resolved tenant', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null });
        const ctx = await authenticateScimRequest(reqWith('Bearer abc'));
        expect(ctx).toEqual({ tenantId: 'ten1', tokenId: 't1', tokenLabel: 'okta' });
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'success', reason: 'ok' });
    });

    it('records exactly one metric per call', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null });
        await authenticateScimRequest(reqWith('Bearer abc'));
        expect(mockRecord).toHaveBeenCalledTimes(1);
    });
});

describe('authenticateScimRequest — while SCIM is turned off', () => {
    it('answers 404 before looking at the token, so a live token is not confirmed', async () => {
        mockScimEnabled.mockResolvedValue(false);
        // A token that WOULD authenticate, so the refusal is the switch's.
        mockFindUnique.mockResolvedValue({ id: 't1', tenantId: 'ten1', label: 'okta', revokedAt: null });
        const err = await authenticateScimRequest(reqWith('Bearer abc')).catch((e) => e);
        expect(err).toBeInstanceOf(ScimAuthError);
        expect(err.status).toBe(404);
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('answers the same 404 with no Authorization header at all', async () => {
        mockScimEnabled.mockResolvedValue(false);
        const err = await authenticateScimRequest(reqWith(undefined)).catch((e) => e);
        expect(err.status).toBe(404);
    });
});
