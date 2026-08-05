/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Evidence free text is sanitised, and the stored MIME type comes from the
 * bytes rather than from the uploader.
 *
 * Two defects with one shape: the evidence write path trusted its input.
 *
 * **Sanitisation.** Epic C.5 puts sanitisation at the USECASE layer, before
 * the row is persisted, because a row is read verbatim by the PDF export, the
 * audit-pack share link, and any SDK consumer — render-time escaping in one UI
 * does not protect any of those. Eight usecases were covered by the D.2
 * ratchet; `evidence.ts` was not one of them, and wrote title, content,
 * category, folder and owner raw. It slipped through because that ratchet's
 * population is *encrypted* models, and `Evidence.content` is deliberately
 * excluded from the encryption manifest so the repository can search it with
 * `contains`. Not encrypted, therefore not enumerated, therefore never asked
 * whether it sanitises — a gap in the population, not in the rule.
 *
 * **MIME.** `file.type` is the client's claim. The upload gated
 * `isAllowedMime` on it, persisted it, and the download replays it as the
 * response `Content-Type` — so the uploader chose what a future browser would
 * treat the bytes as.
 */

const mockDb = {
    control: { findFirst: jest.fn().mockResolvedValue({ id: 'ctrl-1' }) },
    task: { findFirst: jest.fn() },
    risk: { findFirst: jest.fn() },
    asset: { findFirst: jest.fn() },
    evidence: { create: jest.fn(), update: jest.fn() },
    controlEvidenceLink: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

const repoCreate = jest.fn();
const repoUpdate = jest.fn();
jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: (...a: any[]) => repoCreate(...a),
        update: (...a: any[]) => repoUpdate(...a),
        getById: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createEvidence, updateEvidence } from '@/app-layer/usecases/evidence';
import { reconcileMimeType, sniffMimeType } from '@/lib/storage/mime-sniff';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR');
const XSS = '<script>alert(1)</script>Spray log';

beforeEach(() => {
    jest.clearAllMocks();
    repoCreate.mockResolvedValue({ id: 'ev-1', title: 'x', fileRecordId: null });
    repoUpdate.mockResolvedValue({ id: 'ev-1', title: 'x' });
});

describe('createEvidence sanitises every free-text column', () => {
    it('strips script tags from title, content, category, folder and owner', async () => {
        await createEvidence(ctx, {
            title: XSS,
            type: 'TEXT',
            content: XSS,
            category: XSS,
            folder: `  ${XSS}  `,
            owner: XSS,
        } as never);

        const data = repoCreate.mock.calls[0][2];
        for (const field of ['title', 'content', 'category', 'folder', 'owner'] as const) {
            expect(String(data[field])).not.toContain('<script>');
        }
        expect(String(data.title)).toContain('Spray log');
    });

    it('still null-coerces an empty folder rather than storing a blank', async () => {
        await createEvidence(ctx, { title: 'T', type: 'TEXT', folder: '   ' } as never);
        expect(repoCreate.mock.calls[0][2].folder).toBeNull();
    });
});

describe('updateEvidence preserves the three-state contract while sanitising', () => {
    it('sanitises fields that are provided', async () => {
        await updateEvidence(ctx, 'ev-1', { title: XSS, content: XSS } as never);
        const data = repoUpdate.mock.calls[0][3];
        expect(String(data.title)).not.toContain('<script>');
        expect(String(data.content)).not.toContain('<script>');
    });

    it('leaves an omitted field undefined — sanitising must not blank it', async () => {
        // Coercing undefined into '' would turn "leave this alone" into
        // "clear this" on every partial update.
        await updateEvidence(ctx, 'ev-1', { title: 'Only the title' } as never);
        const data = repoUpdate.mock.calls[0][3];
        expect(data.content).toBeUndefined();
        expect(data.owner).toBeUndefined();
    });

    it('keeps an explicit null as null — clearing still clears', async () => {
        await updateEvidence(ctx, 'ev-1', { owner: null } as never);
        expect(repoUpdate.mock.calls[0][3].owner).toBeNull();
    });
});

// ─── MIME: the bytes, not the claim ─────────────────────────────────

const PDF = Buffer.from('%PDF-1.7\n...', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const GIF = Buffer.from('GIF89a....', 'latin1');
const TEXT = Buffer.from('just,some,csv\n1,2,3\n');

describe('sniffMimeType', () => {
    it.each([
        ['PDF', PDF, 'application/pdf'],
        ['PNG', PNG, 'image/png'],
        ['GIF', GIF, 'image/gif'],
    ])('recognises %s', (_label, buf, expected) => {
        expect(sniffMimeType(buf)).toBe(expected);
    });

    it('recognises WEBP, whose magic is split across two ranges', () => {
        const webp = Buffer.concat([
            Buffer.from('RIFF', 'latin1'),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from('WEBP', 'latin1'),
        ]);
        expect(sniffMimeType(webp)).toBe('image/webp');
    });

    it('distinguishes docx and xlsx from a plain zip', () => {
        const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        const docx = Buffer.concat([zipHeader, Buffer.from('...word/document.xml', 'latin1')]);
        const xlsx = Buffer.concat([zipHeader, Buffer.from('...xl/workbook.xml', 'latin1')]);
        const zip = Buffer.concat([zipHeader, Buffer.from('...readme.txt', 'latin1')]);

        expect(sniffMimeType(docx)).toContain('wordprocessingml');
        expect(sniffMimeType(xlsx)).toContain('spreadsheetml');
        expect(sniffMimeType(zip)).toBe('application/zip');
    });

    it('answers null for text-shaped formats, which have no signature', () => {
        // null means "no opinion", NOT "safe" — which is why the reconciler
        // treats it as a pass rather than a rejection.
        expect(sniffMimeType(TEXT)).toBeNull();
        expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    });
});

describe('reconcileMimeType — the bytes win', () => {
    it('overrides a claim its bytes contradict', () => {
        // The attack: declare text/plain to pass the allowlist, upload
        // something else, have it served back under the declared type.
        const r = reconcileMimeType('text/plain', PDF);
        expect(r.resolved).toBe('application/pdf');
        expect(r.corrected).toBe(true);
    });

    it('leaves an honest claim alone', () => {
        const r = reconcileMimeType('application/pdf', PDF);
        expect(r.resolved).toBe('application/pdf');
        expect(r.corrected).toBe(false);
    });

    it('accepts the claim when the bytes carry no signature', () => {
        // A CSV really is indistinguishable from prose at the byte level.
        // Rejecting here would block every text upload.
        const r = reconcileMimeType('text/csv', TEXT);
        expect(r.resolved).toBe('text/csv');
        expect(r.detected).toBeNull();
        expect(r.corrected).toBe(false);
    });

    it('treats docx-declared-as-zip as compatible, not as a lie', () => {
        // A .docx genuinely IS a zip; a client saying so is not lying in any
        // way that matters.
        const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        const docx = Buffer.concat([zipHeader, Buffer.from('...word/document.xml', 'latin1')]);
        const r = reconcileMimeType('application/zip', docx);
        expect(r.corrected).toBe(false);
    });
});
