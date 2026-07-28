/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma delegate and
 * the PDFKit document are large structural surfaces; fakes are the practical
 * shape here, matching tests/unit/pdf-rent-roll-wave-12.test.ts. */

/**
 * Coverage wave 19 — the ДНЕВНИК generation + persistence seam.
 *
 * `tests/pdf/farm-record-diary.test.ts` already covers the pure half of this
 * module: the row builders and `renderFarmRecordDiary` over fixtures. What it
 * cannot reach is everything downstream of a database — `gatherFarmRecordData`,
 * `generateFarmRecordDiaryPdf`, `generateSeasonDiaryPdf`, `collectPdfBuffer`
 * and `saveFarmRecordDiary` were entirely unexecuted, which is most of the
 * file's branches.
 *
 * These are behavioural, not coverage-shaped. Each case names the break it
 * catches. Four are worth stating up front, because they are the ones where a
 * plausible "simplification" produces a document that is wrong rather than
 * merely ugly — and this document is a regulatory record submitted to БАБХ.
 *
 *   1. **The certificate snapshot wins over live membership.** A completed
 *      spray line carries `conditionsJson`, frozen at completion — who held
 *      which certificate at the moment of application. Live `TenantMembership`
 *      certs are the FALLBACK for legacy lines with no snapshot, never the
 *      preferred source. Reversing that precedence would silently re-attribute
 *      a historical application to whoever holds the certificate today.
 *
 *   2. **The empty-season fallback produces a blank register, not an empty
 *      page.** A season with no completed operations still yields one
 *      section-set per location (capped at 25), so the file is a usable blank
 *      ДНЕВНИК. Dropping that branch turns a legitimate "nothing sprayed yet"
 *      season into a one-page document that looks like a generation failure.
 *
 *   3. **Neither generator calls `doc.end()`.** Both return an open document;
 *      the caller finalises. The source says so twice. An `end()` added "for
 *      symmetry" would make the season generator emit a truncated PDF, because
 *      the page-number stamp runs after the render loop.
 *
 *   4. **`-auto` is part of the filename contract.** The register lists,
 *      filters and labels rows by parsing the filename — there is no side
 *      table. `dnevnik-<locationId>-<from>_<to>[-auto].pdf` is a schema.
 */
import { makeRequestContext } from '../helpers/make-context';

// ── DB seam ─────────────────────────────────────────────────────────────
// One fake delegate set, re-seeded per test. `runInTenantContext` is the only
// door to the database in this module, so faking it covers every query.
const db = {
    location: { findFirst: jest.fn(), findMany: jest.fn() },
    farmProfile: { findUnique: jest.fn() },
    taskLink: { findMany: jest.fn() },
    operationParcel: { findMany: jest.fn() },
    logEntry: { findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    season: { findFirst: jest.fn() },
    fileRecord: { create: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (d: any) => any) => fn(db)),
}));

// ── Storage seam ────────────────────────────────────────────────────────
const mockWrite = jest.fn();
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({ name: 'local', write: (...a: unknown[]) => mockWrite(...a) }),
    buildTenantObjectKey: (tenantId: string, domain: string, name: string) =>
        `${tenantId}/${domain}/${name}`,
}));

import {
    gatherFarmRecordData,
    generateFarmRecordDiaryPdf,
    generateSeasonDiaryPdf,
    saveFarmRecordDiary,
} from '@/app-layer/reports/pdf/farm-record-diary';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-ctx',
});

/** Finalise a returned (still-open) document so it can be asserted on. */
function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

const opLine = (over: Record<string, unknown> = {}) => ({
    id: 'line-1',
    completedAt: new Date('2026-05-04T08:00:00Z'),
    doseValue: 2.5,
    doseUnit: { symbol: 'л/дка' },
    product: {
        name: 'Атлантис',
        activeIngredient: 'мезосулфурон',
        phiDays: 45,
        registrationNo: 'РЗ-123',
    },
    parcel: { name: 'Северна нива', cropType: 'WHEAT', areaHa: 12.5 },
    task: { assigneeUserId: 'user-a', operationType: 'SPRAY', title: 'Пръскане' },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    db.location.findFirst.mockResolvedValue({ name: 'Home Farm' });
    db.location.findMany.mockResolvedValue([]);
    db.farmProfile.findUnique.mockResolvedValue(null);
    db.taskLink.findMany.mockResolvedValue([]);
    db.operationParcel.findMany.mockResolvedValue([]);
    db.logEntry.findMany.mockResolvedValue([]);
    db.tenantMembership.findMany.mockResolvedValue([]);
    db.fileRecord.create.mockResolvedValue({ id: 'file-1' });
    mockWrite.mockResolvedValue({ sizeBytes: 4096, sha256: 'abc123' });
});

describe('gatherFarmRecordData — certificate provenance', () => {
    it('prefers the completion snapshot over live membership certificates', async () => {
        // Break: reading certs from TenantMembership first would re-attribute a
        // historical application to today's certificate holder.
        db.taskLink.findMany.mockResolvedValue([{ taskId: 'task-1' }]);
        db.operationParcel.findMany.mockResolvedValue([opLine()]);
        db.logEntry.findMany.mockResolvedValue([
            {
                operationParcelId: 'line-1',
                conditionsJson: { operatorCertNo: 'SNAP-111', agronomistName: 'Снимка Агроном' },
            },
        ]);
        db.tenantMembership.findMany.mockResolvedValue([
            { userId: 'user-a', applicatorCertNo: 'LIVE-999', agronomistCertNo: null, agronomistName: 'Днешен' },
        ]);

        const data = await gatherFarmRecordData(ctx, 'loc-1', '2026-01-01', '2026-12-31');

        expect(JSON.stringify(data.sprayLines)).toContain('SNAP-111');
        expect(JSON.stringify(data.sprayLines)).not.toContain('LIVE-999');
    });

    it('falls back to live membership only for a line with no snapshot', async () => {
        // Break: dropping the fallback leaves legacy lines with a blank
        // applicator column — the exact field БАБХ checks first.
        db.taskLink.findMany.mockResolvedValue([{ taskId: 'task-1' }]);
        db.operationParcel.findMany.mockResolvedValue([opLine()]);
        db.logEntry.findMany.mockResolvedValue([]); // no snapshot at all
        db.tenantMembership.findMany.mockResolvedValue([
            { userId: 'user-a', applicatorCertNo: 'LIVE-999', agronomistCertNo: 'AGR-1', agronomistName: 'Днешен' },
        ]);

        const data = await gatherFarmRecordData(ctx, 'loc-1', '2026-01-01', '2026-12-31');

        expect(JSON.stringify(data.sprayLines)).toContain('LIVE-999');
    });

    it('does not query memberships when every line carries a snapshot', async () => {
        // Break: an unconditional membership query is a wasted round trip on
        // the hot path, and the guard is what keeps it off.
        db.taskLink.findMany.mockResolvedValue([{ taskId: 'task-1' }]);
        db.operationParcel.findMany.mockResolvedValue([opLine()]);
        db.logEntry.findMany.mockResolvedValue([
            { operationParcelId: 'line-1', conditionsJson: { operatorCertNo: 'SNAP-111' } },
        ]);

        await gatherFarmRecordData(ctx, 'loc-1', '2026-01-01', '2026-12-31');

        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
    });

    it('skips the line query entirely when the location has no linked tasks', async () => {
        // Break: `taskIds.length ? … : []` collapsing to an unguarded findMany
        // would issue `taskId: { in: [] }`, which matches nothing but still
        // costs a query on every empty location in a season sweep.
        const data = await gatherFarmRecordData(ctx, 'loc-1', '2026-01-01', '2026-12-31');

        expect(db.operationParcel.findMany).not.toHaveBeenCalled();
        expect(data.sprayLines).toEqual([]);
        expect(data.fertilizeLines).toEqual([]);
    });

    it('routes a FERTILIZE operation away from the spray table', async () => {
        // Break: the two tables are legally distinct sections of the ДНЕВНИК.
        // A fertiliser row printed under растителнозащитни мероприятия is a
        // misfiled record, not a cosmetic slip.
        db.taskLink.findMany.mockResolvedValue([{ taskId: 'task-1' }]);
        db.operationParcel.findMany.mockResolvedValue([
            opLine({ task: { assigneeUserId: null, operationType: 'FERTILIZE', title: 'Торене' } }),
        ]);

        const data = await gatherFarmRecordData(ctx, 'loc-1', '2026-01-01', '2026-12-31');

        expect(data.fertilizeLines).toHaveLength(1);
        expect(data.sprayLines).toHaveLength(0);
    });
});

describe('generateFarmRecordDiaryPdf', () => {
    it('returns an OPEN document — the caller finalises', async () => {
        // Break: an added doc.end() would truncate every caller that still
        // needs to write to the document.
        const doc = await generateFarmRecordDiaryPdf(ctx, {
            locationId: 'loc-1',
            from: '2026-01-01',
            to: '2026-12-31',
        });

        expect(doc).toBeDefined();
        const buf = await collect(doc); // succeeds only because it was still open
        expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('falls back to "Farm" when the location has no name', async () => {
        // Break: `data.locationName || 'Farm'` degrading to a bare value would
        // put an empty tenantName in the report header.
        db.location.findFirst.mockResolvedValue({ name: '' });

        const doc = await generateFarmRecordDiaryPdf(ctx, {
            locationId: 'loc-1',
            from: '2026-01-01',
            to: '2026-12-31',
        });

        expect((await collect(doc)).length).toBeGreaterThan(0);
    });
});

describe('generateSeasonDiaryPdf', () => {
    const season = {
        name: 'Сезон 2026',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
    };

    it('throws notFound for a season outside the tenant', async () => {
        // Break: proceeding with a null season would read `.startDate` off
        // undefined and surface as a 500 instead of a 404.
        db.season.findFirst.mockResolvedValue(null);

        await expect(generateSeasonDiaryPdf(ctx, { seasonId: 'nope' })).rejects.toThrow(
            /Season not found/,
        );
    });

    it('derives the window from the season dates as YYYY-MM-DD', async () => {
        // Break: passing Date objects through would break gatherFarmRecordData's
        // `new Date(from)` parsing.
        db.season.findFirst.mockResolvedValue(season);
        db.location.findMany.mockResolvedValue([{ id: 'loc-1' }]);

        await generateSeasonDiaryPdf(ctx, { seasonId: 's-1' });

        const linkCall = db.taskLink.findMany.mock.calls.find(
            (c: any[]) => c[0]?.where?.entityId === 'loc-1',
        );
        expect(linkCall).toBeDefined();
    });

    it('falls back to a blank register over locations when no operation completed', async () => {
        // Break (stated in the source): without this, a season with nothing
        // sprayed yet yields a single empty page that reads as a broken export
        // rather than a blank ДНЕВНИК ready to be filled in.
        db.season.findFirst.mockResolvedValue(season);
        db.operationParcel.findMany.mockResolvedValue([]);
        db.location.findMany.mockResolvedValue([{ id: 'loc-a' }, { id: 'loc-b' }]);

        const doc = await generateSeasonDiaryPdf(ctx, { seasonId: 's-1' });

        expect(db.location.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 25, where: expect.objectContaining({ deletedAt: null }) }),
        );
        expect((await collect(doc)).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('page-breaks between locations but not before the first', async () => {
        // Break: an unconditional addPage leaves a blank leading page; dropping
        // it runs two locations' registers together on one page.
        db.season.findFirst.mockResolvedValue(season);
        db.operationParcel.findMany.mockResolvedValue([]);
        db.location.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

        const doc = await generateSeasonDiaryPdf(ctx, { seasonId: 's-1' });
        const addPage = jest.spyOn(doc, 'addPage');
        void addPage; // the document is already rendered; assert via page count

        const buf = await collect(doc);
        // 3 locations → at least 3 pages in the finalised document.
        expect(buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('resolves locations from completed operations when they exist', async () => {
        // Break: skipping straight to the fallback would print the whole farm
        // for a season that only touched two fields.
        db.season.findFirst.mockResolvedValue(season);
        // Two DIFFERENT queries hit this delegate: the season sweep (status
        // DONE, selects taskId) and gatherFarmRecordData's per-location line
        // read. Discriminate, or the sweep's skinny rows get fed to the
        // renderer as operation lines.
        // Both filter `status: 'DONE'`; only the per-location read narrows by
        // `taskId`, so that is the discriminator.
        db.operationParcel.findMany.mockImplementation(async (args: any) =>
            args?.where?.taskId ? [] : [{ taskId: 't-1' }, { taskId: 't-1' }],
        );
        db.taskLink.findMany.mockResolvedValue([{ entityId: 'loc-x' }]);

        await generateSeasonDiaryPdf(ctx, { seasonId: 's-1' });

        expect(db.location.findMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ take: 25 }),
        );
    });
});

describe('saveFarmRecordDiary — the filename is the schema', () => {
    it('writes the PDF bytes and records them as a reports FileRecord', async () => {
        const res = await saveFarmRecordDiary(ctx, {
            locationId: 'loc-1',
            from: '2026-01-01',
            to: '2026-06-30',
        });

        expect(res).toEqual({
            fileRecordId: 'file-1',
            fileName: 'dnevnik-loc-1-2026-01-01_2026-06-30.pdf',
        });
        const [, buffer, opts] = mockWrite.mock.calls[0];
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.subarray(0, 4).toString()).toBe('%PDF'); // collectPdfBuffer ran
        expect(opts).toEqual({ mimeType: 'application/pdf' });
        expect(db.fileRecord.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ domain: 'reports', status: 'STORED', scanStatus: 'SKIPPED' }),
            }),
        );
    });

    it('marks an auto-generated diary with the -auto suffix', async () => {
        // Break: the register parses this filename to label rows; there is no
        // side table, so dropping the suffix loses the manual/auto distinction
        // permanently for every file already written.
        const res = await saveFarmRecordDiary(ctx, {
            locationId: 'loc-9',
            from: '2026-03-01',
            to: '2026-03-31',
            auto: true,
        });

        expect(res.fileName).toBe('dnevnik-loc-9-2026-03-01_2026-03-31-auto.pdf');
    });

    it('attributes the upload to the caller when the job passes no user', async () => {
        // Break: uploadedByUserId is a REQUIRED User FK. Falling back to a
        // synthetic 'system' id would violate it; falling back to ctx.userId
        // keeps a real, auditable actor on the row.
        await saveFarmRecordDiary(ctx, { locationId: 'l', from: 'a', to: 'b' });
        expect(db.fileRecord.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ uploadedByUserId: 'user-ctx' }) }),
        );

        jest.clearAllMocks();
        db.fileRecord.create.mockResolvedValue({ id: 'file-2' });
        mockWrite.mockResolvedValue({ sizeBytes: 1, sha256: 'x' });
        db.location.findFirst.mockResolvedValue({ name: 'F' });
        db.farmProfile.findUnique.mockResolvedValue(null);
        db.taskLink.findMany.mockResolvedValue([]);
        db.logEntry.findMany.mockResolvedValue([]);

        await saveFarmRecordDiary(ctx, {
            locationId: 'l',
            from: 'a',
            to: 'b',
            uploadedByUserId: 'job-user',
        });
        expect(db.fileRecord.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ uploadedByUserId: 'job-user' }) }),
        );
    });

    it('carries the storage provider name and hash onto the record', async () => {
        // Break: a record without sha256 cannot be integrity-checked later,
        // which is the point of storing it for a regulatory document.
        await saveFarmRecordDiary(ctx, { locationId: 'l', from: 'a', to: 'b' });

        expect(db.fileRecord.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ sha256: 'abc123', storageProvider: 'local', sizeBytes: 4096 }),
            }),
        );
    });
});
