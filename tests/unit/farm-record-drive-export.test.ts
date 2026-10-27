/**
 * `exportFarmRecordToDrive` — #2019.
 *
 * DB, encryption, audit, the gates and the PDF renderers are doubles. The
 * **Drive client runs for real** against an injected `fetch`, which is the
 * point: `deps.fetchImpl` threads into both `ensureDriveFolder` and
 * `uploadToDrive`, so these cases exercise the actual folder-reuse, stale-id
 * and multipart logic rather than a second implementation of it.
 *
 * ## Everything that can reach Prisma is mocked, including the indirect ones
 *
 * `farmRecordAbsence` is mocked even though this usecase barely uses it,
 * because it calls `treatmentKindOf`, which queries. A previous test in this
 * repo mocked four modules and missed exactly that one; the real function then
 * hit Prisma with no database and the suite failed as a 500-vs-404 on a
 * shard, nowhere near the file that caused it.
 *
 * ## What the ordering assertions are for
 *
 * Three cases assert that NOTHING was fetched and NO document was rendered.
 * That is the substance of "refuse early": a farmer whose connection lacks the
 * Drive scope should not wait for a 60-second PDF render to be told, and a
 * refusal that happens after the render still looks like a working export
 * until the last moment.
 */
const mockDb = {
    integrationConnection: {
        findFirst: jest.fn(),
        update: jest.fn(),
    },
};

const assertCanAdminMock = jest.fn();
const assertFlagMock = jest.fn();
const assertModuleMock = jest.fn();
const logEventMock = jest.fn();
const resolveTokenMock = jest.fn();
const scopedPdfMock = jest.fn();
const locationPdfMock = jest.fn();
const collectBufferMock = jest.fn();
const absenceMock = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: typeof mockDb) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/policies/common', () => ({
    __esModule: true,
    assertCanAdmin: (...a: unknown[]) => assertCanAdminMock(...a),
}));
jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    assertFeatureEnabled: (...a: unknown[]) => assertFlagMock(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    __esModule: true,
    assertModuleEnabled: (...a: unknown[]) => assertModuleMock(...a),
}));
jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));
jest.mock('@/app-layer/integrations/providers/google/service', () => {
    const actual = jest.requireActual(
        '@/app-layer/integrations/providers/google/service',
    ) as typeof import('@/app-layer/integrations/providers/google/service');
    return {
        ...actual,
        resolveGoogleConnectionToken: (...a: unknown[]) => resolveTokenMock(...a),
    };
});
jest.mock('@/app-layer/reports/pdf/farm-record-diary', () => ({
    __esModule: true,
    generateFarmRecordDiaryPdfScoped: (...a: unknown[]) => scopedPdfMock(...a),
    generateFarmRecordDiaryPdf: (...a: unknown[]) => locationPdfMock(...a),
}));
jest.mock('@/app-layer/reports/pdf/collect-buffer', () => ({
    __esModule: true,
    collectPdfBuffer: (...a: unknown[]) => collectBufferMock(...a),
}));
// Mocked because the real one queries through `treatmentKindOf`.
jest.mock('@/app-layer/reports/pdf/farm-record-absence', () => ({
    __esModule: true,
    farmRecordAbsence: (...a: unknown[]) => absenceMock(...a),
}));

import { exportFarmRecordToDrive } from '@/app-layer/usecases/farm-record-drive-export';
import type { RequestContext } from '@/app-layer/types';

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    permissions: { canAdmin: true, canWrite: true, canRead: true },
} as unknown as RequestContext;

const NOW = new Date('2026-10-27T09:30:00.000Z');
const TREATMENT = { kind: 'treatment' as const, treatmentGroupId: 'tg-1' };

/** A fetch double that answers each call in order and records the requests. */
function fetchSequence(steps: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const step = steps[i++];
        if (!step) throw new Error(`unexpected Drive call ${i} to ${String(url)}`);
        calls.push({ url: String(url), init });
        return {
            status: step.status,
            ok: step.status >= 200 && step.status < 300,
            json: async () => step.body,
            text: async () =>
                typeof step.body === 'string' ? step.body : JSON.stringify(step.body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const UPLOAD_OK = { status: 200, body: { id: 'file-1', webViewLink: 'https://drive/file-1' } };

beforeEach(() => {
    jest.clearAllMocks();
    assertCanAdminMock.mockImplementation(() => undefined);
    assertFlagMock.mockResolvedValue(undefined);
    assertModuleMock.mockResolvedValue(undefined);
    logEventMock.mockResolvedValue(undefined);
    resolveTokenMock.mockResolvedValue({
        accessToken: 'tok',
        grantedProducts: { drive: true, calendar: false },
    });
    scopedPdfMock.mockResolvedValue({ pdf: true });
    locationPdfMock.mockResolvedValue({ pdf: true });
    collectBufferMock.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        id: 'conn-1',
        configJson: { grantedProducts: { drive: true, calendar: false }, grantedScopes: [] },
    });
    mockDb.integrationConnection.update.mockResolvedValue({});
});

describe('exportFarmRecordToDrive gates (#2019)', () => {
    it('refuses a non-admin before touching Drive or rendering anything', async () => {
        // The owner's ruling, 2026-10-26: admin only, matching the token.
        assertCanAdminMock.mockImplementation(() => {
            throw new Error('forbidden');
        });
        const { impl, calls } = fetchSequence([]);

        await expect(
            exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl }),
        ).rejects.toThrow('forbidden');

        expect(calls).toHaveLength(0);
        expect(scopedPdfMock).not.toHaveBeenCalled();
        expect(mockDb.integrationConnection.findFirst).not.toHaveBeenCalled();
    });

    it('checks the flag here, because the token resolver does not', async () => {
        // `resolveGoogleConnectionToken` gates on admin only;
        // `completeGoogleConnect` is what checks the flag and is not on this
        // path. Without this call the export would work with the integration
        // switched off.
        assertFlagMock.mockRejectedValue(new Error('not found'));
        await expect(exportFarmRecordToDrive(ctx, TREATMENT)).rejects.toThrow('not found');
        expect(assertFlagMock).toHaveBeenCalledWith('integrations.google', 'u1');
        expect(scopedPdfMock).not.toHaveBeenCalled();
    });

    it('requires the JOURNAL module', async () => {
        assertModuleMock.mockRejectedValue(new Error('module off'));
        await expect(exportFarmRecordToDrive(ctx, TREATMENT)).rejects.toThrow('module off');
        expect(scopedPdfMock).not.toHaveBeenCalled();
    });

    it('refuses when no Google account is connected', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(exportFarmRecordToDrive(ctx, TREATMENT)).rejects.toMatchObject({
            code: 'GOOGLE_NOT_CONNECTED',
        });
        expect(resolveTokenMock).not.toHaveBeenCalled();
    });

    it('picks the OLDEST enabled connection, so the destination is stable', async () => {
        // Newest-wins would silently move where every later register lands the
        // moment someone connects a second Google account, and nobody would be
        // told. The row's name is customisable, so more than one can exist.
        await exportFarmRecordToDrive(ctx, TREATMENT, {
            fetchImpl: fetchSequence([{ status: 200, body: { id: 'fold-1' } }, UPLOAD_OK]).impl,
            now: NOW,
        });
        expect(mockDb.integrationConnection.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 't1', provider: 'google', isEnabled: true },
                orderBy: { createdAt: 'asc' },
            }),
        );
    });

    it('refuses a connection without the Drive scope BEFORE rendering the PDF', async () => {
        // The substance of "refuse early". Google's consent screen lets the
        // scopes be ticked individually, so `drive: false` on a connected row
        // is ordinary — and a farmer should not wait through a 60s render to
        // be told to reconnect.
        resolveTokenMock.mockResolvedValue({
            accessToken: 'tok',
            grantedProducts: { drive: false, calendar: true },
        });
        const { impl, calls } = fetchSequence([]);

        await expect(
            exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_NOT_GRANTED' });

        expect(scopedPdfMock).not.toHaveBeenCalled();
        expect(collectBufferMock).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });
});

describe('exportFarmRecordToDrive folder handling (#2019)', () => {
    it('creates the folder on the first export and remembers it', async () => {
        const { impl, calls } = fetchSequence([
            { status: 200, body: { id: 'fold-1' } },
            UPLOAD_OK,
        ]);

        const r = await exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl, now: NOW });

        expect(r).toEqual({
            fileId: 'file-1',
            fileName: 'dnevnik-tg-1-2026-10-27.pdf',
            webViewLink: 'https://drive/file-1',
            folderCreated: true,
        });
        // No lookup — nothing was stored, so there was nothing to look up.
        expect(calls).toHaveLength(2);
        expect(calls[1].url).toContain('uploadType=multipart');
        // The parent is named, so the file does not land in the Drive root.
        expect(String(new TextDecoder().decode(calls[1].init?.body as Uint8Array))).toContain(
            '"parents":["fold-1"]',
        );
        expect(mockDb.integrationConnection.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'conn-1' },
                data: expect.objectContaining({
                    configJson: expect.objectContaining({ driveFolderId: 'fold-1' }),
                }),
            }),
        );
    });

    it('does NOT write configJson when the stored folder is reused', async () => {
        // The write is inside a tenant transaction; doing it on every export to
        // say nothing changed is the thing `created` exists to avoid.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: { grantedProducts: { drive: true, calendar: false }, driveFolderId: 'kept' },
        });
        const { impl } = fetchSequence([
            { status: 200, body: { id: 'kept', trashed: false } },
            UPLOAD_OK,
        ]);

        const r = await exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl, now: NOW });

        expect(r.folderCreated).toBe(false);
        expect(mockDb.integrationConnection.update).not.toHaveBeenCalled();
    });

    it('a deleted folder is replaced and the new id persisted, preserving the rest of configJson', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: {
                grantedProducts: { drive: true, calendar: false },
                grantedScopes: ['drive.file'],
                driveFolderId: 'gone',
            },
        });
        const { impl } = fetchSequence([
            { status: 404, body: { error: { message: 'File not found: gone.' } } },
            { status: 200, body: { id: 'fold-2' } },
            UPLOAD_OK,
        ]);

        const r = await exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl, now: NOW });

        expect(r.folderCreated).toBe(true);
        // The spread matters: clobbering configJson with just the folder id
        // would discard `grantedProducts`, which is what the admin card reads
        // to say whether Drive works at all.
        expect(mockDb.integrationConnection.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    configJson: {
                        grantedProducts: { drive: true, calendar: false },
                        grantedScopes: ['drive.file'],
                        driveFolderId: 'fold-2',
                    },
                },
            }),
        );
    });
});

describe('exportFarmRecordToDrive documents and audit (#2019)', () => {
    it('uses the NON-NULL generator for a location, with the period', async () => {
        const { impl } = fetchSequence([{ status: 200, body: { id: 'f' } }, UPLOAD_OK]);

        const r = await exportFarmRecordToDrive(
            ctx,
            { kind: 'location', locationId: 'loc-9', from: '2026-01-01', to: '2026-12-31' },
            { fetchImpl: impl, now: NOW },
        );

        expect(locationPdfMock).toHaveBeenCalledWith(ctx, {
            locationId: 'loc-9',
            from: '2026-01-01',
            to: '2026-12-31',
        });
        // The scoped one is nullable and would force an error code for a branch
        // that cannot happen here — an empty period throws inside the gatherer.
        expect(scopedPdfMock).not.toHaveBeenCalled();
        expect(r.fileName).toBe('dnevnik-loc-9-2026-10-27.pdf');
    });

    it('a treatment with nothing in the register refuses, and uploads nothing', async () => {
        scopedPdfMock.mockResolvedValue(null);
        absenceMock.mockResolvedValue(
            Object.assign(new Error('not in register'), { code: 'NOT_IN_BABH_REGISTER' }),
        );
        const { impl, calls } = fetchSequence([]);

        await expect(
            exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl }),
        ).rejects.toMatchObject({ code: 'NOT_IN_BABH_REGISTER' });

        expect(absenceMock).toHaveBeenCalledWith(ctx, 'tg-1');
        expect(calls).toHaveLength(0);
    });

    it('audits the export with the file id and a structured payload', async () => {
        // `detailsJson` is required of every `logEvent` call by
        // `audit-structured-events`, and the file id is the only handle anyone
        // has for later asking Drive what was sent.
        const { impl } = fetchSequence([{ status: 200, body: { id: 'fold-1' } }, UPLOAD_OK]);

        await exportFarmRecordToDrive(ctx, TREATMENT, { fetchImpl: impl, now: NOW });

        expect(logEventMock).toHaveBeenCalledWith(
            mockDb,
            ctx,
            expect.objectContaining({
                action: 'FARM_RECORD_EXPORTED',
                entityType: 'FarmRecordDriveExport',
                entityId: 'file-1',
                detailsJson: expect.objectContaining({
                    category: 'data_lifecycle',
                    operation: 'exported',
                }),
                metadata: expect.objectContaining({
                    target: 'treatment',
                    reference: 'tg-1',
                    folderId: 'fold-1',
                    folderCreated: true,
                }),
            }),
        );
    });

    it('the Drive filename carries the export date, unlike the download name', async () => {
        // `drive.file` cannot overwrite and Drive permits duplicate names, so
        // without the date a re-export leaves two files called exactly the same
        // thing and no way to tell which is newer without opening both.
        const { impl } = fetchSequence([{ status: 200, body: { id: 'f' } }, UPLOAD_OK]);
        const r = await exportFarmRecordToDrive(ctx, TREATMENT, {
            fetchImpl: impl,
            now: new Date('2026-03-04T23:59:59.000Z'),
        });
        expect(r.fileName).toBe('dnevnik-tg-1-2026-03-04.pdf');
        expect(r.fileName).not.toBe('dnevnik-tg-1.pdf');
    });
});
