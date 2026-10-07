/**
 * `isFarmVerified` — which claim states count, and which deliberately do not.
 *
 * The budget gate in `assertAiBudget` is only as good as this predicate. A
 * version that counted PENDING would make the whole of P3.5f decorative: a
 * speculative signup could claim any ЕИК and immediately have an AI budget,
 * which is the exact cost the gate exists to withhold until a human has looked.
 */
const mockCount = jest.fn();
const mockRunInTenantContext = jest.fn(
    async (_ctx: unknown, cb: (db: unknown) => Promise<unknown>) =>
        cb({ farmIdentityClaim: { count: (...a: unknown[]) => mockCount(...a) } }),
);

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (...a: unknown[]) =>
        mockRunInTenantContext(...(a as [unknown, (db: unknown) => Promise<unknown>])),
}));

import { makeRequestContext } from '../helpers/make-context';
import { isFarmVerified } from '@/lib/farm-identity/verification-status';

const ctx = makeRequestContext('ADMIN');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('isFarmVerified', () => {
    it('is true when a VERIFIED claim exists', async () => {
        mockCount.mockResolvedValue(1);
        await expect(isFarmVerified(ctx)).resolves.toBe(true);
    });

    it('is false when there is no claim at all', async () => {
        mockCount.mockResolvedValue(0);
        await expect(isFarmVerified(ctx)).resolves.toBe(false);
    });

    it('asks ONLY for status VERIFIED, scoped to this tenant', async () => {
        // The two halves that make the predicate mean what its name says.
        // PENDING is "submitted, nobody has looked" and DISPUTED is "collided
        // with an existing VERIFIED claim" — counting either would hand an AI
        // budget to a farm no human has confirmed, which is the whole cost
        // P3.5f withholds.
        mockCount.mockResolvedValue(0);
        await isFarmVerified(ctx);

        const where = mockCount.mock.calls[0][0].where;
        expect(where.status).toBe('VERIFIED');
        expect(where.tenantId).toBe(ctx.tenantId);
    });

    it('runs in TENANT context, so RLS scopes the read', async () => {
        mockCount.mockResolvedValue(0);
        await isFarmVerified(ctx);
        expect(mockRunInTenantContext).toHaveBeenCalledTimes(1);
        // Asking "has MY farm a verified claim" is what RLS is for. The
        // hazardous pattern is the opposite — asking whether someone ELSE
        // holds a value, which returns zero rows precisely when the incumbent
        // is in another tenant. P3.4 put a partial UNIQUE index behind that
        // case rather than a lookup, for exactly that reason.
        expect(mockRunInTenantContext.mock.calls[0][0]).toBe(ctx);
    });

    it('counts rather than loading the claim', async () => {
        // The question's answer is a boolean, so nothing about the claim —
        // not the ЕИК blind index, not who claimed it — should be read to
        // answer it.
        mockCount.mockResolvedValue(3);
        await expect(isFarmVerified(ctx)).resolves.toBe(true);
        expect(mockCount.mock.calls[0][0].select).toBeUndefined();
        expect(mockCount.mock.calls[0][0].include).toBeUndefined();
    });
});
