/**
 * Staff review of farm identity claims (P3.9).
 *
 * Three properties carry the weight here, and none of them is the happy path:
 *
 * 1. **The review queue discloses no ЕИК — not even the hash.** The hash is
 *    not reversible but it IS a stable per-identity token, so a console
 *    showing it would let anyone reading a screenshot correlate two farms'
 *    claims, which is most of what the blind index exists to prevent.
 *
 * 2. **The reviewer's number must MATCH.** `verifyFarmClaim` takes the ЕИК as
 *    input and refuses when it does not match the claim. That is the whole
 *    verification: without it, "verify" would mean "a button was pressed".
 *
 * 3. **A collision becomes DISPUTED in a SEPARATE transaction.** A P2002 on
 *    the partial unique index aborts the transaction it occurred in, so a
 *    catch-and-write inside the same block would silently fail and leave the
 *    claim PENDING while the response said DISPUTED.
 */
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockClaimUpdate = jest.fn();
const mockProfileUpsert = jest.fn();
// Typed explicitly, not inferred. `jest.fn(async () => [])` infers `never[]`
// and then rejects every `mockResolvedValue` carrying real rows — the same
// trap as the Turnstile mock in #1350, which CI caught and a stale
// tsconfig.tsbuildinfo hid locally.
const mockTenantFindMany = jest.fn(
    async (): Promise<{ id: string; name: string; slug: string }[]> => [],
);
const mockTransaction = jest.fn();
const mockAudit = jest.fn(async () => undefined);
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        farmIdentityClaim: {
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
            findMany: (...a: unknown[]) => mockFindMany(...a),
            update: (...a: unknown[]) => mockClaimUpdate(...a),
        },
        farmProfile: { upsert: (...a: unknown[]) => mockProfileUpsert(...a) },
        // The args are discarded: this test asserts on the RESULT shape (the
        // name reaching the reviewer), and the typed mock takes none.
        tenant: { findMany: (..._a: unknown[]) => mockTenantFindMany() },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => mockAudit(...(a as [])),
}));

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: (...a: unknown[]) => mockLogInfo(...a),
        warn: (...a: unknown[]) => mockLogWarn(...a),
        error: jest.fn(),
    },
}));

/**
 * Hashing is stubbed so a test can state "this is the hash of that number"
 * without holding the real HMAC key. `candidates` returns the current hash
 * plus a PREVIOUS-key one, so the rotation-window case is expressible.
 */
jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    hashForLookup: (v: string, kind: string) => `H:${kind}:${v}`,
    hashForLookupCandidates: (v: string, kind: string) => [`H:${kind}:${v}`, `OLD:${kind}:${v}`],
}));

import { Prisma } from '@prisma/client';
import {
    listFarmClaims,
    verifyFarmClaim,
    disputeFarmClaim,
} from '@/app-layer/usecases/farm-identity-review';

/** A real checksum-valid ЕИК (БУЛСТАТ mod-11). */
const VALID_EIK = '831641791';
const OTHER_EIK = '175074752';

/** Run the transaction callback against the mocked tx delegates. */
function runTx() {
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
            farmIdentityClaim: { update: (...a: unknown[]) => mockClaimUpdate(...a) },
            farmProfile: { upsert: (...a: unknown[]) => mockProfileUpsert(...a) },
        }),
    );
}

function p2002() {
    return new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    runTx();
    mockClaimUpdate.mockResolvedValue({});
    mockProfileUpsert.mockResolvedValue({});
    mockTenantFindMany.mockResolvedValue([]);
});

describe('the review queue discloses no ЕИК', () => {
    it('selects neither the plaintext nor the hash', async () => {
        mockFindMany.mockResolvedValue([]);
        await listFarmClaims();

        const select = mockFindMany.mock.calls[0][0].select;
        // The plaintext does not exist on this model at all; the HASH does,
        // and leaving it selected is the mistake this pins. A `select` was
        // used rather than a bare row precisely so widening it is a visible
        // edit.
        expect(select.eikHash).toBeUndefined();
        expect(select.eik).toBeUndefined();
        expect(select.id).toBe(true);
        // No `tenant` relation is selected — there is none to select. P3.4
        // made `tenantId` a plain column "matching every other tenant-scoped
        // model here", so the name comes from a second query.
        expect(select.tenant).toBeUndefined();
    });

    it('returns the farm NAME, which is what the reviewer works from', async () => {
        mockFindMany.mockResolvedValue([
            {
                id: 'c1',
                tenantId: 't1',
                status: 'PENDING',
                claimedByUserId: 'u1',
                createdAt: new Date('2026-10-01'),
                verifiedAt: null,
                disputedAt: null,
            },
        ]);
        // The name arrives from the SECOND query — there is no relation to
        // join through.
        mockTenantFindMany.mockResolvedValue([
            { id: 't1', name: 'ЗК Победа', slug: 'zk-pobeda' },
        ]);
        const [claim] = await listFarmClaims({ status: 'PENDING' });
        // The reviewer looks this name up in the Търговски регистър and types
        // the number they find. Without the name the queue is unusable.
        expect(claim.tenantName).toBe('ЗК Победа');
        expect(claim).not.toHaveProperty('eikHash');
    });

    it('is oldest-first and bounded', async () => {
        mockFindMany.mockResolvedValue([]);
        await listFarmClaims({ limit: 5000 });
        const args = mockFindMany.mock.calls[0][0];
        expect(args.orderBy).toEqual({ createdAt: 'asc' });
        // A caller asking for 5000 gets the cap, not 5000 — the console is a
        // queue, not an export.
        expect(args.take).toBe(200);
    });
});

describe('verifyFarmClaim requires the reviewer to supply the right number', () => {
    const PENDING = {
        id: 'c1',
        tenantId: 't1',
        status: 'PENDING',
        eikHash: `H:eik:${VALID_EIK}`,
    };

    it('promotes when the supplied ЕИК matches', async () => {
        mockFindUnique.mockResolvedValue(PENDING);
        await expect(
            verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'VERIFIED' });
    });

    it('REFUSES when the reviewer types a different company number', async () => {
        mockFindUnique.mockResolvedValue(PENDING);
        const out = await verifyFarmClaim({
            claimId: 'c1',
            eik: OTHER_EIK,
            reviewedBy: 'ops@x',
        });
        expect(out).toEqual({ result: 'EIK_MISMATCH' });
        // Nothing moves. This is the case review exists to catch — the farm
        // claimed one company and the register says another.
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockClaimUpdate).not.toHaveBeenCalled();
        expect(mockProfileUpsert).not.toHaveBeenCalled();
    });

    it('never logs the number the reviewer typed', async () => {
        mockFindUnique.mockResolvedValue(PENDING);
        await verifyFarmClaim({ claimId: 'c1', eik: OTHER_EIK, reviewedBy: 'ops@x' });
        // A mismatch log carrying the ЕИК would reintroduce the plaintext the
        // claim table deliberately avoids, in a store kept for longer.
        expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(OTHER_EIK);
    });

    it('rejects a structurally invalid ЕИК before touching the database', async () => {
        const out = await verifyFarmClaim({
            claimId: 'c1',
            eik: '123456789',
            reviewedBy: 'ops@x',
        });
        expect(out).toEqual({ result: 'EIK_INVALID' });
        // A number that cannot exist cannot match a claim, so it never reaches
        // the lookup — the same ordering /api/public/eik-check uses.
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('matches a row hashed under the PREVIOUS key, and rehashes it', async () => {
        // The rotation window. P3.4's implementation note left this to the
        // verification path explicitly: match on the full candidate set, then
        // rehash. Without the rehash the partial unique index is split across
        // two key generations and stops enforcing one-VERIFIED-per-ЕИК.
        mockFindUnique.mockResolvedValue({ ...PENDING, eikHash: `OLD:eik:${VALID_EIK}` });

        await expect(
            verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'VERIFIED' });

        const data = mockClaimUpdate.mock.calls[0][0].data;
        expect(data.eikHash).toBe(`H:eik:${VALID_EIK}`);
        expect(data.status).toBe('VERIFIED');
    });

    it('writes FarmProfile.eik in the SAME transaction as the promotion', async () => {
        mockFindUnique.mockResolvedValue(PENDING);
        await verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' });

        // A VERIFIED claim whose profile never got the number would leave the
        // ДНЕВНИК export blank for a farm the register says is verified.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockProfileUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 't1' },
                update: { eik: VALID_EIK },
            }),
        );
    });

    it.each([
        ['VERIFIED', 'ALREADY_VERIFIED'],
        ['DISPUTED', 'ALREADY_DISPUTED'],
    ])('a %s claim is not re-promoted (%s)', async (status, expected) => {
        mockFindUnique.mockResolvedValue({ ...PENDING, status });
        await expect(
            verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: expected });
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('reports NOT_FOUND for an unknown claim', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(
            verifyFarmClaim({ claimId: 'nope', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'NOT_FOUND' });
    });
});

describe('a collision becomes DISPUTED, in its own transaction', () => {
    it('catches P2002 and writes DISPUTED outside the aborted transaction', async () => {
        mockFindUnique.mockResolvedValue({
            id: 'c1',
            tenantId: 't1',
            status: 'PENDING',
            eikHash: `H:eik:${VALID_EIK}`,
        });
        mockTransaction.mockRejectedValue(p2002());

        const out = await verifyFarmClaim({
            claimId: 'c1',
            eik: VALID_EIK,
            reviewedBy: 'ops@x',
        });
        expect(out).toEqual({ result: 'DISPUTED_COLLISION' });

        // The DISPUTED write must be a call on the SINGLETON, after the
        // transaction rejected — a constraint violation aborts the block it
        // occurred in, so a write inside the catch of that same block would
        // silently do nothing and leave the claim PENDING while the response
        // said DISPUTED.
        expect(mockClaimUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'c1' },
                data: expect.objectContaining({ status: 'DISPUTED' }),
            }),
        );
        expect(JSON.stringify(mockLogWarn.mock.calls)).toContain('claim_verify_collision');
    });

    it('rethrows anything that is not P2002', async () => {
        // A guard against swallowing real failures as "collision". A
        // connection error reported as DISPUTED would mark a farm's claim bad
        // because the database hiccuped.
        mockFindUnique.mockResolvedValue({
            id: 'c1',
            tenantId: 't1',
            status: 'PENDING',
            eikHash: `H:eik:${VALID_EIK}`,
        });
        mockTransaction.mockRejectedValue(new Error('connection reset'));

        await expect(
            verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).rejects.toThrow('connection reset');
        expect(mockClaimUpdate).not.toHaveBeenCalled();
    });
});

describe('disputeFarmClaim', () => {
    it('marks a PENDING claim DISPUTED without needing the ЕИК', async () => {
        // Refusing must not be harder than approving: a reviewer who has
        // established a claim is wrong may have no correct number to supply.
        mockFindUnique.mockResolvedValue({ id: 'c1', tenantId: 't1', status: 'PENDING' });
        await expect(
            disputeFarmClaim({ claimId: 'c1', reason: 'not this company', reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'DISPUTED' });
        expect(mockClaimUpdate).toHaveBeenCalled();
    });

    it('refuses to dispute a VERIFIED claim', async () => {
        // Unwinding one has to also unwind FarmProfile.eik and whatever has
        // been filed from it — a deliberate operator action, not a queue
        // button.
        mockFindUnique.mockResolvedValue({ id: 'c1', tenantId: 't1', status: 'VERIFIED' });
        await expect(
            disputeFarmClaim({ claimId: 'c1', reason: 'x', reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'ALREADY_VERIFIED' });
        expect(mockClaimUpdate).not.toHaveBeenCalled();
    });

    it('records the reason in the audit entry', async () => {
        mockFindUnique.mockResolvedValue({ id: 'c1', tenantId: 't1', status: 'PENDING' });
        await disputeFarmClaim({ claimId: 'c1', reason: 'register says otherwise', reviewedBy: 'ops@x' });
        expect(JSON.stringify(mockAudit.mock.calls)).toContain('register says otherwise');
    });
});

describe('a lost audit write does not fail the review', () => {
    it('logs loudly and still reports the outcome', async () => {
        // The transition is durable before the hash chain extends. Failing the
        // response over a lost audit write would leave an operator unable to
        // tell whether the promotion happened — so it is logged at error
        // rather than swallowed or rethrown.
        mockFindUnique.mockResolvedValue({
            id: 'c1',
            tenantId: 't1',
            status: 'PENDING',
            eikHash: `H:eik:${VALID_EIK}`,
        });
        mockAudit.mockRejectedValue(new Error('chain unavailable'));

        await expect(
            verifyFarmClaim({ claimId: 'c1', eik: VALID_EIK, reviewedBy: 'ops@x' }),
        ).resolves.toEqual({ result: 'VERIFIED' });
    });
});
