/**
 * File integrity — SHA-256 verification of a stored file.
 *
 * Extracted from `usecases/audit-hardening.ts` in GRC teardown phase 2.
 * The rest of that file (export artifacts, pack cloning, auditor pack
 * assignment) went with AuditPack; these two functions did not — they are
 * addressed by FileRecord id and back the live
 * `/api/t/:slug/files/[fileName]/verify` route.
 *
 * The permission gate moved to `policies/common.ts` with its role list
 * unchanged. Read the docblock on `verifyFileIntegrity` below before
 * touching either — the narrow gate is the fix for a real cross-tenant
 * hash oracle, not an incidental choice.
 */
import { RequestContext } from '../types';
import { assertCanVerifyIntegrity } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { getStorageProvider, assertTenantKey } from '@/lib/storage';
import { FileRepository } from '../repositories/FileRepository';
import crypto from 'crypto';

// ─── Evidence Integrity ───

export function computeFileHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a stored file's SHA-256 and size against an expected hash.
 *
 * ## What this used to be
 *
 * A cross-tenant hash-and-size oracle. It took the filename RAW from the URL,
 * gated on `assertCanViewPack` — which admits OWNER, ADMIN, EDITOR, READER
 * AND AUDITOR, i.e. every role including an external auditor invited to one
 * pack — and passed the string straight to `storage.readStream` with no
 * FileRecord lookup and no `assertTenantKey`. It then returned
 * `computedHash`, `fileSize` and `matches` for whatever it found.
 *
 * Three things made that reachable rather than theoretical: Next decodes
 * `%2F` inside dynamic segments, so a caller can express a full path in the
 * `[fileName]` slot; production runs `STORAGE_PROVIDER: local` on one shared
 * volume; and `matches` turns the endpoint into an oracle you can ask
 * yes/no questions of about another tenant's bytes.
 *
 * ## What it is now
 *
 * Addressed by FileRecord **id**, not by path. The id is resolved
 * tenant-filtered, the resolved `pathKey` is asserted, and the read uses that
 * key — never anything the caller wrote. Integrity verification is also an
 * OWNER/ADMIN/AUDITOR action now: it is an audit function, and READER/EDITOR
 * had no business being able to enumerate hashes.
 */
export async function verifyFileIntegrity(
    ctx: RequestContext,
    fileId: string,
    expectedHash?: string,
): Promise<{ fileId: string; fileName: string; computedHash: string; matches: boolean | null; fileSize: number }> {
    assertCanVerifyIntegrity(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await FileRepository.getById(db, ctx, fileId);
        if (!fileRecord) throw notFound('File not found');

        assertTenantKey(fileRecord.pathKey, ctx.tenantId);

        const storage = getStorageProvider();
        const stream = storage.readStream(fileRecord.pathKey);

        // Hash incrementally. Size is accumulated as we go rather than by
        // buffering the whole object — an integrity check must not be a way
        // to pull an arbitrarily large file into memory.
        const hash = crypto.createHash('sha256');
        let totalSize = 0;
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            totalSize += buf.length;
        }
        const computedHash = hash.digest('hex');

        return {
            fileId,
            fileName: fileRecord.originalName,
            computedHash,
            matches: expectedHash ? computedHash === expectedHash : null,
            fileSize: totalSize,
        };
    });
}
