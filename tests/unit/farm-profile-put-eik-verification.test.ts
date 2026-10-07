/**
 * A farm-profile PUT reports the SAME verification state a GET would (#1358).
 *
 * ## The defect, and why it was invisible here
 *
 * `project()` took `eikVerification` with a default of `'NONE'`. `getFarmProfile`
 * passed the derived value; both of `upsertFarmProfile`'s return paths omitted
 * the argument. So a PUT answered `eikVerification: "NONE"` for a farm whose
 * claim was VERIFIED, while a GET on the same row answered `"VERIFIED"`.
 *
 * Nothing failed. The parameter was optional, so neither call site failed to
 * compile; the two existing farm-profile suites assert on the Prisma `update`
 * object rather than on the returned shape; and the only web caller re-GETs
 * after saving, so it never read the wrong value. **iOS found it** — by not
 * trusting the response, keeping its pre-save value instead.
 *
 * The spec lists `eikVerification` in `required` on the shared `FarmProfile`
 * response, which IS the PUT's 200 body, so a client taking the PUT response as
 * the new state is reading the contract correctly.
 *
 * ## The fix is the removed default, not the two added arguments
 *
 * `project()`'s parameter is required now. Passing the derived value at both
 * sites fixes today's bug; removing the default is what stops the next call
 * site reintroducing it, because omitting the argument no longer compiles.
 *
 * That is the upload convention's `scanStatus` rule — "never restore a default
 * on that argument" — in a second place: a default meaning "unknown" also
 * means "the reassuring answer", so omitting it is indistinguishable from
 * deciding it.
 *
 * ## What this file does NOT cover
 *
 * The claims are read through the same transaction client as the write, so
 * there is no cross-connection visibility question to test here. Whether the
 * ROUTE serialises the field is the contract test's business; this asserts the
 * usecase's return value.
 */
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

const mockDb: Record<string, unknown> = {};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) =>
            cb(mockDb),
        ),
    };
});

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => s,
    sanitizeRichTextHtml: (s: string) => s,
}));

import { upsertFarmProfile, getFarmProfile } from '@/app-layer/usecases/farm-profile';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

const ROW = { id: 'fp-1', tenantId: 'tenant-A', version: 2, producerName: 'Иван' };

function makeCtx(): RequestContext {
    return {
        requestId: 'req-fp-eik',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/** Seed the claim rows the deriver will read. */
function withClaims(statuses: string[]) {
    mockDb.farmIdentityClaim = {
        findMany: jest.fn().mockResolvedValue(statuses.map((status) => ({ status }))),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockDb)) delete mockDb[k];
    mockDb.farmProfile = {
        upsert: jest.fn().mockResolvedValue(ROW),
        findUnique: jest.fn().mockResolvedValue(ROW),
        findUniqueOrThrow: jest.fn().mockResolvedValue(ROW),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(ROW),
    };
    withClaims([]);
});

describe('the PUT response carries the DERIVED verification state (#1358)', () => {
    it.each([
        [['VERIFIED'], 'VERIFIED'],
        [['PENDING'], 'PENDING'],
        [['DISPUTED'], 'DISPUTED'],
        // Precedence, same as the GET: VERIFIED > PENDING > DISPUTED.
        [['DISPUTED', 'VERIFIED'], 'VERIFIED'],
        [['DISPUTED', 'PENDING'], 'PENDING'],
    ])('claims %j -> %s', async (statuses, expected) => {
        withClaims(statuses as string[]);
        const out = await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        expect(out.eikVerification).toBe(expected);
    });

    it('no claims is still NONE — the control', async () => {
        // Without this, a fix that hardcoded any non-NONE value would satisfy
        // every assertion above. NONE has to remain reachable.
        withClaims([]);
        const out = await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        expect(out.eikVerification).toBe('NONE');
    });

    it('a PUT and a GET agree on the same row', async () => {
        // The defect in one sentence: these two disagreed. Asserting the pair
        // rather than the PUT alone is what makes the test about the bug
        // instead of about one function's return value.
        withClaims(['VERIFIED']);
        const afterPut = await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        const afterGet = await getFarmProfile(makeCtx());
        expect(afterPut.eikVerification).toBe(afterGet.eikVerification);
        expect(afterPut.eikVerification).toBe('VERIFIED');
    });

    it('the NO-OP path derives too — a body that mentions nothing', async () => {
        // The second return path. It writes nothing, but it still answers with
        // the current state, and the claims are part of that state.
        withClaims(['PENDING']);
        const out = await upsertFarmProfile(makeCtx(), {});
        expect(out.eikVerification).toBe('PENDING');
        // Proves it really took the no-op branch rather than writing.
        expect((mockDb.farmProfile as { upsert: jest.Mock }).upsert).not.toHaveBeenCalled();
    });

    it('the claims read is scoped to the caller tenant', async () => {
        // A deriver that read every tenant's claims would report VERIFIED for a
        // farm whose neighbour is verified — worse than the bug it replaces.
        withClaims(['VERIFIED']);
        await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        const findMany = (mockDb.farmIdentityClaim as { findMany: jest.Mock }).findMany;
        expect(findMany).toHaveBeenCalled();
        expect(findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-A' } });
    });

    it('it selects only the status — never the ЕИК or its hash', async () => {
        // The field exists to say "verified or not" without handing the number
        // back out. Selecting the row wholesale would put `eikHash` one
        // careless spread away from a response body.
        withClaims(['VERIFIED']);
        await upsertFarmProfile(makeCtx(), { producerName: 'Иван' });
        const findMany = (mockDb.farmIdentityClaim as { findMany: jest.Mock }).findMany;
        expect(findMany.mock.calls[0][0].select).toEqual({ status: true });
    });
});
