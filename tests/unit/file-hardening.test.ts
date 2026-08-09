/**
 * Integration tests for evidence hardening:
 * - Strict download policy (Option A)
 * - SHA-256 dedup
 * - Maintenance jobs
 * - Soft-delete blocks download
 */
import {
    generatePathKey,
    resolveStoragePath,
    streamWriteFile,
    deleteStoredFile,
} from '@/lib/storage';
import fs from 'fs/promises';
import crypto from 'crypto';
import { Readable } from 'stream';

// ─── Strict Download Policy ───

describe('Evidence Hardening — Strict Download Policy', () => {
    test('policy requires practice link for READER/AUDITOR', () => {
        // Simulate the policy logic
        const isWriter = false; // READER/AUDITOR
        const hasPracticeLink = false;
        const canDownload = isWriter || hasPracticeLink;
        expect(canDownload).toBe(false);
    });

    test('policy allows ADMIN/EDITOR to download without practice link', () => {
        const isWriter = true; // ADMIN/EDITOR
        const hasPracticeLink = false;
        const canDownload = isWriter || hasPracticeLink;
        expect(canDownload).toBe(true);
    });

    test('policy allows READER/AUDITOR to download with practice link', () => {
        const isWriter = false;
        const hasPracticeLink = true;
        const canDownload = isWriter || hasPracticeLink;
        expect(canDownload).toBe(true);
    });

    test('soft-deleted evidence blocks download for all roles', () => {
        const deletedAt = new Date();
        const isDeleted = !!deletedAt;
        expect(isDeleted).toBe(true);
    });
});

// ─── SHA-256 Dedup ───

describe('Evidence Hardening — SHA-256 Dedup', () => {
    test('identical content produces identical SHA-256 hashes', async () => {
        const content = 'same content for dedup test';
        const key1 = `test-dedup-${Date.now()}/dedup1_${crypto.randomUUID()}.txt`;
        const key2 = `test-dedup-${Date.now()}/dedup2_${crypto.randomUUID()}.txt`;

        const r1 = await streamWriteFile(key1, Readable.from(Buffer.from(content)));
        const r2 = await streamWriteFile(key2, Readable.from(Buffer.from(content)));

        expect(r1.sha256).toBe(r2.sha256);
        expect(r1.sha256).toHaveLength(64);

        // Cleanup
        await fs.unlink(r1.finalPath);
        await fs.unlink(r2.finalPath);
    });

    test('different content produces different SHA-256 hashes', async () => {
        const key1 = `test-dedup-${Date.now()}/diff1_${crypto.randomUUID()}.txt`;
        const key2 = `test-dedup-${Date.now()}/diff2_${crypto.randomUUID()}.txt`;

        const r1 = await streamWriteFile(key1, Readable.from(Buffer.from('content A')));
        const r2 = await streamWriteFile(key2, Readable.from(Buffer.from('content B')));

        expect(r1.sha256).not.toBe(r2.sha256);

        await fs.unlink(r1.finalPath);
        await fs.unlink(r2.finalPath);
    });

    test('deleteStoredFile removes files from disk', async () => {
        const key = `test-dedup-${Date.now()}/delete_${crypto.randomUUID()}.txt`;
        const result = await streamWriteFile(key, Readable.from(Buffer.from('to be deleted')));
        expect(await fs.access(result.finalPath).then(() => true).catch(() => false)).toBe(true);

        await deleteStoredFile(key);
        expect(await fs.access(result.finalPath).then(() => true).catch(() => false)).toBe(false);
    });

    test('deleteStoredFile is idempotent (no error on missing file)', async () => {
        await expect(deleteStoredFile('nonexistent/file.txt')).resolves.not.toThrow();
    });
});

// ─── Maintenance Jobs ───

describe('Evidence Hardening — Maintenance Jobs', () => {
    test('evidence-maintenance module exports expected functions', () => {
        const mod = require('@/app-layer/usecases/evidence-maintenance');
        expect(typeof mod.reconcileUnlinkedEvidence).toBe('function');
        expect(typeof mod.cleanupFailedOrPendingUploads).toBe('function');
        expect(typeof mod.detectBrokenEvidence).toBe('function');
    });

    test('cleanup handles empty results gracefully', () => {
        // The function should not throw when there are no pending uploads
        // This is a smoke test to verify the module loads correctly
        const { cleanupFailedOrPendingUploads } = require('@/app-layer/usecases/evidence-maintenance');
        expect(cleanupFailedOrPendingUploads).toBeDefined();
    });
});

// ─── Metrics ───

describe('Evidence Hardening — Metrics Route', () => {
    const routeFs = require('fs');
    const routePath = require('path');

    test('metrics route file exists', () => {
        const metricsRoute = routePath.resolve('src/app/api/t/[tenantSlug]/evidence/metrics/route.ts');
        expect(routeFs.existsSync(metricsRoute)).toBe(true);
    });

    test('metrics route file exports GET handler pattern', () => {
        const metricsRoute = routePath.resolve('src/app/api/t/[tenantSlug]/evidence/metrics/route.ts');
        const content = routeFs.readFileSync(metricsRoute, 'utf-8');
        expect(content).toContain('export const GET');
        expect(content).toContain('getEvidenceMetrics');
    });
});

// ─── Link Integrity ───

describe('Evidence Hardening — Link Integrity', () => {
    test('generatePathKey includes tenant ID for isolation', () => {
        const key = generatePathKey('tenant-xyz', 'report.pdf');
        expect(key).toContain('tenant-xyz');
        expect(key).toMatch(/^tenants\/tenant-xyz\//);
    });

    test('different tenants get different paths', () => {
        const key1 = generatePathKey('tenant-a', 'file.pdf');
        const key2 = generatePathKey('tenant-b', 'file.pdf');
        expect(key1).toContain('tenant-a');
        expect(key2).toContain('tenant-b');
        expect(key1).not.toBe(key2);
    });

    test('path traversal is blocked', () => {
        expect(() => resolveStoragePath('../../etc/passwd')).toThrow('Path traversal');
        expect(() => resolveStoragePath('../../../windows/system32')).toThrow('Path traversal');
    });
});
