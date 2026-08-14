/**
 * `downloadEvidenceFile` — the READER/AUDITOR provenance gate.
 *
 * Written during GRC teardown phase 2 (A20). The gate was RE-BASED from
 * `evidence.practiceId` onto `assetId ?? taskId ?? sourceLogEntryId`, and
 * the re-base surfaced that it had NO executing test at all — only prose in
 * a docblock. That is a bad gap for this particular function: it is the
 * difference between a read-only role seeing evidence attached to a farm
 * record and a read-only role seeing every file in the tenant.
 *
 * Deleting the condition instead of re-basing it would have widened
 * privilege silently and no test would have objected. These cases are what
 * make that a detectable change rather than an invisible one.
 *
 * Each block below pins one property of the gate:
 *   1. canWrite bypasses it entirely (ADMIN/EDITOR keep full access)
 *   2. each of the three provenance columns independently grants a reader
 *   3. a row with NO provenance denies a reader
 *   4. an ABSENT evidence row denies a reader — the shape `!evidence?.x`
 *      had by accident and the explicit form has to keep on purpose
 *   5. the gate is downstream of the AV + soft-delete guards, so a
 *      provenance-bearing infected file is still refused
 */

const mockGetById = jest.fn();
const mockFindFirst = jest.fn();
const mockLogEvent = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ evidence: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } }),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

jest.mock('@/lib/storage', () => ({
    assertTenantKey: jest.fn(),
    getStorageProvider: () => ({ readStream: jest.fn(), getSignedUrl: jest.fn() }),
    buildTenantObjectKey: jest.fn(),
}));

import { downloadEvidenceFile } from '@/app-layer/usecases/evidence';
import type { RequestContext } from '@/app-layer/types';

/** A reader: canRead true, canWrite FALSE — the role the gate exists for. */
function readerCtx(): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'u-reader',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'READER',
        permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        appPermissions: {},
    } as unknown as RequestContext;
}

function writerCtx(): RequestContext {
    const c = readerCtx() as unknown as { role: string; userId: string; permissions: Record<string, boolean> };
    c.role = 'EDITOR';
    c.userId = 'u-editor';
    c.permissions.canWrite = true;
    return c as unknown as RequestContext;
}

const STORED_FILE = {
    id: 'file-1',
    originalName: 'spray-record.pdf',
    pathKey: 'tenants/tenant-1/evidence/file-1.pdf',
    status: 'STORED',
    scanStatus: 'CLEAN',
};

/** No provenance: every attachment column null. */
const NO_PROVENANCE = {
    id: 'ev-1',
    assetId: null,
    taskId: null,
    sourceLogEntryId: null,
    deletedAt: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetById.mockResolvedValue({ ...STORED_FILE });
    mockFindFirst.mockResolvedValue({ ...NO_PROVENANCE });
    mockLogEvent.mockResolvedValue(undefined);
});

describe('downloadEvidenceFile — canWrite bypasses the provenance gate', () => {
    it('lets an EDITOR download evidence with no provenance at all', async () => {
        await expect(downloadEvidenceFile(writerCtx(), 'file-1')).resolves.toBeDefined();
    });

    it('lets an EDITOR download when no Evidence row exists', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(downloadEvidenceFile(writerCtx(), 'file-1')).resolves.toBeDefined();
    });
});

describe('downloadEvidenceFile — each provenance column independently admits a reader', () => {
    // Three separate writers populate these (linkAssetEvidence,
    // linkTaskEvidence, attachAutoEvidenceFromLogEntry), so each has to
    // work on its own — a gate that only honoured assetId would silently
    // lock readers out of auto-collected farm evidence.
    it.each([
        ['assetId', { assetId: 'asset-9' }],
        ['taskId', { taskId: 'task-9' }],
        ['sourceLogEntryId', { sourceLogEntryId: 'log-9' }],
    ])('a READER may download evidence attached via %s', async (_label, attach) => {
        mockFindFirst.mockResolvedValue({ ...NO_PROVENANCE, ...attach });
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).resolves.toBeDefined();
    });
});

describe('downloadEvidenceFile — the gate actually denies', () => {
    it('refuses a READER when the row carries no provenance', async () => {
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow(
            /attached to an asset, a task, or a farm record/,
        );
    });

    it('refuses a READER when NO evidence row exists for the file', async () => {
        // The pre-re-base expression `!evidence?.practiceId` denied this case
        // by accident, via optional chaining. The explicit ternary has to
        // deny it on purpose: a bare file with no Evidence row has no
        // provenance to speak of, and must not read as "unrestricted".
        mockFindFirst.mockResolvedValue(null);
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow(
            /attached to an asset, a task, or a farm record/,
        );
    });

    it('does not write an EVIDENCE_DOWNLOADED audit row when it refuses', async () => {
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});

describe('downloadEvidenceFile — provenance does not override the other guards', () => {
    it('still refuses an INFECTED file that has provenance', async () => {
        mockGetById.mockResolvedValue({ ...STORED_FILE, scanStatus: 'INFECTED' });
        mockFindFirst.mockResolvedValue({ ...NO_PROVENANCE, assetId: 'asset-9' });
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow(/infected/i);
    });

    it('still refuses soft-deleted evidence that has provenance', async () => {
        mockFindFirst.mockResolvedValue({
            ...NO_PROVENANCE,
            assetId: 'asset-9',
            deletedAt: new Date(),
        });
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow(/deleted/i);
    });

    it('still refuses a file that is not STORED', async () => {
        mockGetById.mockResolvedValue({ ...STORED_FILE, status: 'PENDING' });
        await expect(downloadEvidenceFile(readerCtx(), 'file-1')).rejects.toThrow(/not available/i);
    });
});
