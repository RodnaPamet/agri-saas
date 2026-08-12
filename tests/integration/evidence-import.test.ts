/**
 * Integration tests for evidence-import (Epic 43.3).
 *
 * Proves the end-to-end path: a real ZIP staged to local storage,
 * `runEvidenceImport` called directly, individual Evidence rows
 * created in the DB.
 *
 * BullMQ is bypassed — we exercise `runEvidenceImport` (the worker's
 * inner function) directly so the test runs without a Redis/BullMQ
 * connection. The executor-registry registration is locked by a
 * separate structural assertion.
 */

// Force the local storage provider BEFORE any storage module imports.
// `STORAGE_PROVIDER` defaults to "s3" in env.ts; CI doesn't set
// STORAGE_PROVIDER (or S3_BUCKET) — without this guard the storage
// layer initialises in s3 mode and `getStorageProvider()` throws
// `S3_BUCKET environment variable is required when STORAGE_PROVIDER=s3`.
// Local devs typically have STORAGE_PROVIDER=local in their `.env`
// so the test passes there; CI has no `.env`. Setting it inside the
// test file works in both environments.
process.env.STORAGE_PROVIDER = 'local';

// Load .env.test FIRST so REDIS_URL points at the test redis
// container before any module that lazily reads
// `process.env.REDIS_URL` (the evidence usecase's cache layer)
// initialises.
import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({
    path: path.resolve(__dirname, '../../.env.test'),
});

import { Readable } from 'node:stream';
import JSZip from 'jszip';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import {
    createTenantWithDek,
} from '@/lib/security/tenant-key-manager';
import { registerEncryptionMiddleware } from '@/lib/db/encryption-middleware';
import { prisma } from '@/lib/prisma';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { runEvidenceImport } from '@/app-layer/jobs/evidence-import';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

interface BuiltZip {
    buffer: Buffer;
    pathKey: string;
    fileRecordId: string;
}

interface ZipEntry {
    name: string;
    body: string | Buffer;
}

function ctxFor(
    tenantId: string,
    userId: string,
    role: 'ADMIN' | 'EDITOR' | 'READER' = 'ADMIN',
): RequestContext {
    const appPermissions = getPermissionsForRole(role);
    return {
        requestId: `evidence-import-test-${Date.now()}`,
        userId,
        tenantId,
        role,
        permissions: {
            canRead: appPermissions.evidence.view,
            canWrite: appPermissions.evidence.upload,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

async function stageZip(
    tenantId: string,
    userId: string,
    entries: ZipEntry[],
    fileNamePrefix = 'evidence-import-test',
): Promise<BuiltZip> {
    const zip = new JSZip();
    for (const e of entries) {
        zip.file(e.name, e.body);
    }
    const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
    });

    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(
        tenantId,
        'temp',
        `${fileNamePrefix}-${Date.now()}.zip`,
    );
    const writeResult = await storage.write(
        pathKey,
        Readable.from(buffer),
        { mimeType: 'application/zip' },
    );

    // Register a FileRecord for the staged ZIP — mirrors what the HTTP
    // layer does so the worker's cleanup path runs correctly.
    const ctx = ctxFor(tenantId, userId);
    const fileRecord = await runInTenantContext(ctx, async (db) => {
        const fr = await FileRepository.createPending(db, ctx, {
            pathKey,
            originalName: `${fileNamePrefix}.zip`,
            mimeType: 'application/zip',
            sizeBytes: writeResult.sizeBytes,
            sha256: writeResult.sha256,
            domain: 'temp',
        });
        await FileRepository.markStored(db, ctx, fr.id, 'SKIPPED');
        return fr;
    });

    return { buffer, pathKey, fileRecordId: fileRecord.id };
}

// Generous per-test timeout — staging + extraction touches storage,
// prisma, and the evidence cache for every entry, which adds up fast
// when a happy-path archive carries 3+ files.
jest.setTimeout(30_000);

describeFn('evidence-import — integration', () => {
    let testPrisma: PrismaClient;
    let tenantA: string;
    let tenantB: string;
    let adminUserId: string;
    let readerUserId: string;
    let foreignUserId: string;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);

        const suffix = `eimport-${Date.now()}`;
        const aSlug = `${suffix}-a`;
        const bSlug = `${suffix}-b`;
        slugs.push(aSlug, bSlug);
        const a = await createTenantWithDek({ name: 'A', slug: aSlug });
        const b = await createTenantWithDek({ name: 'B', slug: bSlug });
        tenantA = a.id;
        tenantB = b.id;

        const adminEmail = `${suffix}-admin@example.com`;
        const readerEmail = `${suffix}-reader@example.com`;
        const foreignEmail = `${suffix}-foreign@example.com`;
        emails.push(adminEmail, readerEmail, foreignEmail);

        const admin = await testPrisma.user.create({
            data: { email: adminEmail, name: 'Admin' },
        });
        const reader = await testPrisma.user.create({
            data: { email: readerEmail, name: 'Reader' },
        });
        const foreign = await testPrisma.user.create({
            data: { email: foreignEmail, name: 'Foreign' },
        });
        adminUserId = admin.id;
        readerUserId = reader.id;
        foreignUserId = foreign.id;

        await testPrisma.tenantMembership.createMany({
            data: [
                {
                    userId: adminUserId,
                    tenantId: tenantA,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
                {
                    userId: readerUserId,
                    tenantId: tenantA,
                    role: 'READER',
                    status: 'ACTIVE',
                },
                // foreignUserId — NO membership in tenantA on purpose
                {
                    userId: foreignUserId,
                    tenantId: tenantB,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
            ],
        });
    });

    afterAll(async () => {
        try {
            await testPrisma.evidence.deleteMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
            });
            await testPrisma.fileRecord.deleteMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
            });
            await testPrisma.tenantMembership.deleteMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
            });
            await testPrisma.tenant.deleteMany({
                where: { slug: { in: slugs } },
            });
            await testPrisma.user.deleteMany({
                where: { email: { in: emails } },
            });
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('happy path: ZIP with 3 evidence files expands into 3 Evidence rows', async () => {
        const staged = await stageZip(tenantA, adminUserId, [
            { name: 'q4-soc2-report.pdf', body: '%PDF-1.5\nfake-pdf-bytes-1' },
            { name: 'access-review.csv', body: 'user,role\nalice,admin' },
            {
                name: 'screenshot.png',
                body: Buffer.from([
                    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]),
            },
        ]);

        const result = await runEvidenceImport({
            tenantId: tenantA,
            initiatedByUserId: adminUserId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
        });

        expect(result.totalEntries).toBe(3);
        expect(result.extracted).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.errored).toBe(0);
        expect(result.evidenceIds).toHaveLength(3);

        const rows = await testPrisma.evidence.findMany({
            where: { tenantId: tenantA, id: { in: result.evidenceIds } },
            select: { tenantId: true, fileName: true, type: true },
        });
        expect(rows.map((r) => r.fileName).sort()).toEqual([
            'access-review.csv',
            'q4-soc2-report.pdf',
            'screenshot.png',
        ]);
        for (const row of rows) {
            expect(row.tenantId).toBe(tenantA);
            expect(row.type).toBe('FILE');
        }

        // Staging FileRecord cleaned up — either hard-deleted (no
        // soft-delete middleware) or soft-deleted (`deletedAt` set
        // by an intercept middleware in tests). Either is correct;
        // what matters is no live file row lingers under that id.
        const lingering = await testPrisma.fileRecord.findUnique({
            where: { id: staged.fileRecordId },
        });
        if (lingering) {
            expect(lingering.deletedAt).not.toBeNull();
        }
    });

    test('rejects path-traversal entries silently and continues with safe ones', async () => {
        // JSZip normalises some traversal forms in its central
        // directory (e.g. strips leading "../"), so the security
        // guarantee we verify here is *behavioural*, not "what reason
        // string surfaced": the safe entry must land, the malicious
        // entry must NOT result in a `passwd` evidence row, period.
        // The exact rejection path (unsafe-path vs extension-not-allowed
        // for the basename `passwd` with no extension) is exercised
        // directly by `evidence-import-safety.test.ts`.
        const staged = await stageZip(tenantA, adminUserId, [
            { name: 'safe.pdf', body: '%PDF-1.5\nfake' },
            { name: '../etc/passwd', body: 'should never land' },
        ]);

        const result = await runEvidenceImport({
            tenantId: tenantA,
            initiatedByUserId: adminUserId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
        });

        expect(result.extracted).toBe(1);
        expect(result.skipped).toBe(1);
        const escapeRow = await testPrisma.evidence.findFirst({
            where: { tenantId: tenantA, fileName: 'passwd' },
        });
        expect(escapeRow).toBeNull();
    });

    test('skips non-allowed extensions but extracts the rest', async () => {
        const staged = await stageZip(tenantA, adminUserId, [
            { name: 'good.pdf', body: '%PDF-1.5\nfake' },
            { name: 'evil.exe', body: 'MZ\x00\x00' },
            { name: 'random.bin', body: 'binary' },
        ]);

        const result = await runEvidenceImport({
            tenantId: tenantA,
            initiatedByUserId: adminUserId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
        });

        expect(result.extracted).toBe(1);
        expect(result.skipped).toBe(2);
        expect(
            result.skipReasons.every(
                (s) => s.reason === 'extension-not-allowed',
            ),
        ).toBe(true);
    });

    test('throws on permission denied (READER user)', async () => {
        const staged = await stageZip(tenantA, readerUserId, [
            { name: 'a.pdf', body: '%PDF-1.5\nfake' },
        ]);

        await expect(
            runEvidenceImport({
                tenantId: tenantA,
                initiatedByUserId: readerUserId,
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
            }),
        ).rejects.toThrow(/lacks evidence\.upload permission/);
    });

    test('throws on user with no active membership in the target tenant', async () => {
        const staged = await stageZip(tenantA, adminUserId, [
            { name: 'a.pdf', body: '%PDF-1.5\nfake' },
        ]);

        await expect(
            runEvidenceImport({
                tenantId: tenantA,
                initiatedByUserId: foreignUserId,
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
            }),
        ).rejects.toThrow(/not an active member/);
    });

    test('macOS metadata entries are silently dropped (no skip noise)', async () => {
        const staged = await stageZip(tenantA, adminUserId, [
            { name: 'real.pdf', body: '%PDF-1.5\nfake' },
            { name: '__MACOSX/._real.pdf', body: 'mac fork' },
            { name: '.DS_Store', body: 'mac metadata' },
        ]);

        const result = await runEvidenceImport({
            tenantId: tenantA,
            initiatedByUserId: adminUserId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
        });

        // Only `real.pdf` should count — the macOS forks aren't even
        // surfaced as skips; they're filtered before the safety pass.
        expect(result.totalEntries).toBe(1);
        expect(result.extracted).toBe(1);
        expect(result.skipped).toBe(0);
    });
});
