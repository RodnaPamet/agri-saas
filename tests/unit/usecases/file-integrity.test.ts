/**
 * `verifyFileIntegrity` — executing tests.
 *
 * Written during GRC teardown phase 2 (work-order A3/T3). The function was
 * extracted from `audit-hardening.ts` when AuditPack was deleted, and the
 * extraction surfaced that it had NO executing test at all — only a
 * structural guard asserting the file existed. That is a bad place for a
 * gap: this function is the fix for a real cross-tenant hash-and-size
 * oracle, and the three things that closed it (the role gate, the
 * FileRecord-id lookup, the `assertTenantKey` on the RESOLVED key) are all
 * behavioural, so a source scan cannot see any of them.
 *
 * Each test below exercises one of those three, plus the streaming-size
 * accumulation that stops an integrity check from being a way to pull an
 * arbitrarily large object into memory.
 */
import { Readable } from 'stream';

const mockReadStream = jest.fn();
const mockGetById = jest.fn();
const mockAssertTenantKey = jest.fn();

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ readStream: mockReadStream }),
    assertTenantKey: (...a: unknown[]) => mockAssertTenantKey(...a),
    buildTenantObjectKey: jest.fn(),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

import { computeFileHash, verifyFileIntegrity } from '@/app-layer/usecases/file-integrity';
import type { RequestContext } from '@/app-layer/types';

const CONTENT = Buffer.from('the quick brown fox');
// sha256 of the buffer above, computed by the same primitive the function uses.
const CONTENT_HASH = computeFileHash(CONTENT);

function ctxFor(role: string): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: {},
    } as unknown as RequestContext;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetById.mockResolvedValue({
        id: 'file-1',
        originalName: 'evidence.pdf',
        pathKey: 'tenants/tenant-1/evidence/file-1.pdf',
    });
    mockReadStream.mockImplementation(() => Readable.from([CONTENT]));
});

describe('computeFileHash', () => {
    it('is a stable SHA-256 hex digest', () => {
        expect(computeFileHash(CONTENT)).toMatch(/^[0-9a-f]{64}$/);
        expect(computeFileHash(CONTENT)).toBe(computeFileHash(Buffer.from('the quick brown fox')));
        expect(computeFileHash(Buffer.from('x'))).not.toBe(CONTENT_HASH);
    });
});

describe('verifyFileIntegrity — the role gate', () => {
    // The gate is the narrow half of the oracle fix. READER and EDITOR must
    // NOT be able to enumerate hashes, even though both can read evidence.
    it.each(['OWNER', 'ADMIN', 'AUDITOR'])('allows %s', async (role) => {
        await expect(verifyFileIntegrity(ctxFor(role), 'file-1')).resolves.toMatchObject({
            fileId: 'file-1',
        });
    });

    it.each(['EDITOR', 'READER'])('rejects %s before touching storage', async (role) => {
        await expect(verifyFileIntegrity(ctxFor(role), 'file-1')).rejects.toThrow(/OWNER, ADMIN or AUDITOR/);
        // The throw must come BEFORE any storage read — otherwise the gate
        // would still leak timing/existence.
        expect(mockGetById).not.toHaveBeenCalled();
        expect(mockReadStream).not.toHaveBeenCalled();
    });
});

describe('verifyFileIntegrity — addressing', () => {
    it('reads the RESOLVED pathKey, never a caller-supplied string', async () => {
        await verifyFileIntegrity(ctxFor('ADMIN'), '../../other-tenant/secret.pdf');
        // The id went to the tenant-filtered repository lookup...
        expect(mockGetById).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ tenantId: 'tenant-1' }),
            '../../other-tenant/secret.pdf',
        );
        // ...and the READ used the pathKey that came back, not the input.
        expect(mockReadStream).toHaveBeenCalledWith('tenants/tenant-1/evidence/file-1.pdf');
    });

    it('asserts the resolved key belongs to the caller tenant', async () => {
        await verifyFileIntegrity(ctxFor('ADMIN'), 'file-1');
        expect(mockAssertTenantKey).toHaveBeenCalledWith(
            'tenants/tenant-1/evidence/file-1.pdf',
            'tenant-1',
        );
    });

    it('404s on a file the tenant cannot see', async () => {
        mockGetById.mockResolvedValue(null);
        await expect(verifyFileIntegrity(ctxFor('ADMIN'), 'file-1')).rejects.toThrow(/not found/i);
        expect(mockReadStream).not.toHaveBeenCalled();
    });
});

describe('verifyFileIntegrity — hashing', () => {
    it('computes the hash and size by streaming, across chunk boundaries', async () => {
        // Same bytes, arbitrary split — the digest must not depend on how
        // the storage layer happens to chunk the stream.
        mockReadStream.mockImplementation(() =>
            Readable.from([CONTENT.subarray(0, 4), CONTENT.subarray(4)]),
        );
        const r = await verifyFileIntegrity(ctxFor('ADMIN'), 'file-1');
        expect(r.computedHash).toBe(CONTENT_HASH);
        expect(r.fileSize).toBe(CONTENT.length);
    });

    it('reports matches=true / false against an expected hash', async () => {
        await expect(
            verifyFileIntegrity(ctxFor('ADMIN'), 'file-1', CONTENT_HASH),
        ).resolves.toMatchObject({ matches: true });

        await expect(
            verifyFileIntegrity(ctxFor('ADMIN'), 'file-1', 'f'.repeat(64)),
        ).resolves.toMatchObject({ matches: false });
    });

    it('reports matches=null when no expected hash is supplied', async () => {
        // null, not false — "not compared" and "compared and differed" are
        // different answers and the caller renders them differently.
        const r = await verifyFileIntegrity(ctxFor('ADMIN'), 'file-1');
        expect(r.matches).toBeNull();
        expect(r.fileName).toBe('evidence.pdf');
    });
});
