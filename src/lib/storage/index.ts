/**
 * Storage Provider Factory
 *
 * Central entry point for all file storage operations.
 * Selects local or S3 provider based on STORAGE_PROVIDER env var.
 *
 * Usage:
 *   import { getStorageProvider, generatePathKey } from '@/lib/storage';
 *   const storage = getStorageProvider();
 *   const key = generatePathKey(tenantId, 'report.pdf');
 *   const result = await storage.write(key, buffer, { mimeType: 'application/pdf' });
 */
import crypto from 'crypto';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { badRequest, codedBadRequest, tenantIsolationViolation } from '@/lib/errors/types';
import type { StorageProvider, StorageProviderType } from './types';

// Re-export types for consumers
export type {
    StorageProvider,
    StorageProviderType,
    WriteResult,
    WriteOptions,
    HeadResult,
    DownloadUrlOptions,
    UploadUrlOptions,
    SignedUploadTarget,
} from './types';

// ─── Provider Singleton ───

let _provider: StorageProvider | null = null;

/**
 * Get the configured storage provider (singleton).
 * Default: 'local' if STORAGE_PROVIDER is not set.
 *
 * PRODUCTION GUARD: Logs a warning if local provider is used in production.
 * All production deployments should use cloud storage ('s3').
 */
export function getStorageProvider(): StorageProvider {
    if (_provider) return _provider;

    const providerType = (env.STORAGE_PROVIDER || 's3') as StorageProviderType;

    // Production guard: warn (not fail) if local is used in production.
    // This allows migration windows while ensuring visibility.
    if (providerType === 'local' && env.NODE_ENV === 'production') {
        logger.warn(
            'Using local filesystem storage in production — set STORAGE_PROVIDER=s3',
            { component: 'storage', providerType },
        );
    }

    switch (providerType) {
        case 's3': {
            // Lazy import to avoid loading AWS SDK when not needed

            const { S3StorageProvider } = require('./s3-provider');
            _provider = new S3StorageProvider();
            break;
        }
        case 'local':
        default: {

            const { LocalStorageProvider } = require('./local-provider');
            _provider = new LocalStorageProvider();
            break;
        }
    }

    return _provider!;
}

/**
 * Reset the provider singleton (for testing).
 */
export function resetStorageProvider(): void {
    _provider = null;
}

// ─── Provider Cache (by name) ───

const _providerCache = new Map<string, StorageProvider>();

/**
 * Get a provider instance by name, regardless of the configured default.
 * Used for dual-read during migration: reads from the backend that stored the file.
 *
 * @example
 *   const readProvider = getProviderByName(fileRecord.storageProvider);
 *   const stream = readProvider.readStream(fileRecord.pathKey);
 */
export function getProviderByName(name: StorageProviderType): StorageProvider {
    const cached = _providerCache.get(name);
    if (cached) return cached;

    let provider: StorageProvider;
    switch (name) {
        case 's3': {

            const { S3StorageProvider } = require('./s3-provider');
            provider = new S3StorageProvider();
            break;
        }
        case 'local':
        default: {

            const { LocalStorageProvider } = require('./local-provider');
            provider = new LocalStorageProvider();
            break;
        }
    }

    _providerCache.set(name, provider);
    return provider;
}

// ─── Path Generation ───

/**
 * Sanitize a filename: strip directory separators, unsafe chars, limit length.
 *
 * NOTE: as of #2497 this has no production caller. Its only one was
 * `buildTenantObjectKey`, which no longer puts a filename in the object key —
 * see that function. Kept exported because it is still the right tool for any
 * caller that needs a path-safe filename (a download name, a temp file), and
 * deleting a correct utility to make a grep come out empty would be the wrong
 * trade. If a second release passes with no caller, remove it rather than
 * leaving this note to rot.
 */
export function sanitizeFileName(name: string): string {
    // path.basename on Linux doesn't treat '\' as separator,
    // so explicitly strip directory components for both separators.
    const base = name.split(/[\\/]/).pop() || name;
    return base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, 200);
}

// ─── Storage Domains ───

/** Well-known storage domains for organizing tenant objects */
/**
 * The storage domains an object can be filed under. A CLOSED union, not a
 * free string: `buildTenantObjectKey` puts the domain into the object key,
 * so a typo would scatter files across a path nothing later looks in.
 *
 * `cost-invoice` — supplier invoices attached to a `CostEntry`. Its own
 * domain rather than `general` so an operator can find every invoice by
 * key prefix, and so a future retention rule can treat commercial
 * paperwork differently from a field photo.
 *
 * `farm-media` — images a farm may publish on its profile (P6.3, #1812). This
 * one is load-bearing rather than organisational, and the difference is worth
 * stating because the next person may be tempted to fold it into `general`.
 *
 * A farm publishes an image by putting its CONTENT HASH on `FarmBrand`, and
 * `/api/public/media/{hash}` serves any hash a published projection
 * references. Ownership alone is not a sufficient check there: every
 * `FileRecord` a tenant owns has a hash, so a tenant could publish the hash of
 * an evidence photo of something private, or of a supplier invoice PDF, and
 * the route would serve it on an indexable page with that file's own
 * `Content-Type`.
 *
 * So the writer requires the domain to be `farm-media` as well as the tenant
 * to match. That makes "uploaded in order to be published" a property of the
 * ROW rather than a promise about which UI was used, and it means an evidence
 * photo cannot be published by hash however the request is shaped.
 */
export const STORAGE_DOMAINS = [
    'evidence',
    'reports',
    'exports',
    'temp',
    'general',
    'spatial',
    'cost-invoice',
    'farm-media',
] as const;

export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

const VALID_DOMAINS: readonly StorageDomain[] = [...STORAGE_DOMAINS];

// ─── Tenant Object Key Builder ───

export interface BuildKeyOptions {
    /** Storage domain (default: 'general') */
    domain?: StorageDomain;
    /** Override date for the yyyy/mm partition (default: now) */
    date?: Date;
}

/**
 * Build a tenant-scoped object key with domain partitioning.
 *
 * Format: `tenants/<tenantId>/<domain>/<yyyy>/<mm>/<uuid>_<sanitizedName>`
 *
 * Rules:
 * - tenantId is mandatory and validated
 * - original filename is sanitized (no traversal, no special chars)
 * - UUID prefix ensures uniqueness
 * - domain groups related objects (evidence, reports, exports, temp)
 *
 * ## The filename is NOT in the key (#2497)
 *
 * It was, until 2026-10-30: the key ended `<uuid>_<sanitised filename>`. A
 * filename in this product routinely IS personal data — «Договор аренда
 * Иванов.pdf» names a third party — and that put a lessor's surname into
 * `FileRecord.pathKey` (plaintext, `@unique`) and, with
 * `STORAGE_PROVIDER=local`, into a real path under `/data/uploads` that rides
 * every daily boot-disk snapshot. `ParcelLease.lessorName` is encrypted
 * precisely because it names a third party; the filename of the contract it
 * came from was not.
 *
 * The extension is kept, because content-type sanity and a readable object in
 * a bucket listing are worth something and an extension names no one.
 *
 * `originalName` is still REQUIRED, and still validated, because it is where
 * the extension comes from — so every one of the nine call sites is unchanged.
 * The filename itself continues to live on `FileRecord.originalName`, which is
 * one column and CAN be encrypted; `pathKey` could not be, being `@unique` and
 * the address of the bytes.
 *
 * Safe to change in place because **nothing re-derives a key**: every caller
 * builds one at write time and stores it, so existing objects keep resolving
 * at their current paths and no data moves. Verified across all nine sites
 * before this landed.
 *
 * @example
 *   buildTenantObjectKey('cuid123', 'evidence', 'audit-report.pdf')
 *   // → 'tenants/cuid123/evidence/2026/03/a1b2c3d4-....pdf'
 */
export function buildTenantObjectKey(
    tenantId: string,
    domain: StorageDomain,
    originalName: string,
    opts?: Omit<BuildKeyOptions, 'domain'>,
): string {
    if (!tenantId || typeof tenantId !== 'string') {
        throw badRequest('tenantId is required for object key generation');
    }
    if (!VALID_DOMAINS.includes(domain)) {
        throw badRequest(`Invalid storage domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`);
    }
    if (!originalName || typeof originalName !== 'string') {
        throw badRequest('originalName is required for object key generation');
    }

    const now = opts?.date ?? new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const uuid = crypto.randomUUID();

    return `tenants/${tenantId}/${domain}/${yyyy}/${mm}/${uuid}${extensionOf(originalName)}`;
}

/**
 * The `.ext` of a filename, or `''` — never anything else.
 *
 * Deliberately strict rather than reusing `sanitizeFileName`, which is built
 * to make a whole filename path-safe and would happily return `_______.txt`
 * for junk. Here the only acceptable outputs are a short alphanumeric
 * extension or nothing at all, because this value goes into an object key:
 *
 *   - the last dot-segment only, so `archive.tar.gz` yields `.gz`
 *   - lowercased, so the same upload twice cannot differ by case alone
 *   - `[a-z0-9]{1,12}` or nothing, so `..`, a path separator, a NUL, a
 *     Cyrillic word or a 300-character tail can never reach a path
 *   - a leading dot is not an extension: `.gitignore` yields `''`
 */
function extensionOf(originalName: string): string {
    const base = originalName.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    const ext = base.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,12}$/.test(ext) ? `.${ext}` : '';
}

/**
 * Generate a tenant-partitioned pathKey (backward-compatible).
 * Uses domain 'general'. For new code, prefer buildTenantObjectKey with explicit domain.
 */
export function generatePathKey(tenantId: string, originalName: string): string {
    return buildTenantObjectKey(tenantId, 'general', originalName);
}

// ─── Key Validation & Parsing ───

/**
 * DERIVED from `STORAGE_DOMAINS`, not hand-listed.
 *
 * It used to spell the alternation out, and it had already drifted:
 * `cost-invoice` was added to the domain union and to
 * `buildTenantObjectKey`, but not here — so `parseTenantKey` returned
 * `null` for every invoice key this module itself had minted, and
 * `assertTenantKey` treated a perfectly valid key as malformed. A regex
 * that repeats a union is a copy of it, and copies drift silently because
 * nothing type-checks a string.
 */
const TENANT_KEY_REGEX = new RegExp(
    // The tail accepts BOTH key shapes, and that is not tidiness — it is the
    // reason #2497 could change the builder without moving data.
    //
    //   `<uuid>_<filename>`  minted before 2026-10-30, still addressing live
    //                        objects, and `parseTenantKey` must keep reading
    //                        them or every pre-change file becomes malformed
    //   `<uuid>.ext` / `<uuid>`  minted since
    //
    // This regex has drifted from the builder once before: `cost-invoice` was
    // added to the domain union and to `buildTenantObjectKey` and not here, so
    // `parseTenantKey` returned null for keys this module had itself minted.
    // Changing the key shape without changing this line would have been that
    // defect again, for EVERY new key rather than one domain.
    `^tenants/([^/]+)/(${STORAGE_DOMAINS.join('|')})/\\d{4}/\\d{2}/[a-f0-9-]+(?:_.+|\\.[a-z0-9]{1,12})?$`,
);

/**
 * Runtime guard: asserts a key belongs to the expected tenant.
 * Use this before any storage operation to prevent cross-tenant access.
 *
 * @throws Error if key doesn't match expected tenant prefix
 */
export function assertTenantKey(pathKey: string, expectedTenantId: string): void {
    if (!pathKey.startsWith(`tenants/${expectedTenantId}/`)) {
        throw tenantIsolationViolation(`Tenant isolation violation: key "${pathKey}" does not belong to tenant "${expectedTenantId}"`);
    }
}

/**
 * Parse a tenant ID from an object key.
 * Returns null if the key doesn't match the expected format.
 */
export function parseTenantKey(pathKey: string): { tenantId: string; domain: StorageDomain } | null {
    const match = pathKey.match(TENANT_KEY_REGEX);
    if (!match) return null;
    return { tenantId: match[1], domain: match[2] as StorageDomain };
}

// ─── Validation ───

const FILE_MAX_SIZE_BYTES = env.FILE_MAX_SIZE_BYTES || (50 * 1024 * 1024);

const FILE_ALLOWED_MIME = (env.FILE_ALLOWED_MIME || [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'text/csv',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/json',
    'application/zip',
].join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

export { FILE_MAX_SIZE_BYTES, FILE_ALLOWED_MIME };

export function isAllowedMime(mimeType: string): boolean {
    return FILE_ALLOWED_MIME.includes(mimeType);
}

export function isAllowedSize(sizeBytes: number): boolean {
    return sizeBytes > 0 && sizeBytes <= FILE_MAX_SIZE_BYTES;
}

/**
 * Validates a file's size and mime type (legacy API).
 */
export function validateFile(file: File, options?: { maxSizeMB?: number; allowedMimeTypes?: string[] }) {
    const maxSize = (options?.maxSizeMB || 10) * 1024 * 1024;
    const allowedTypes = options?.allowedMimeTypes || FILE_ALLOWED_MIME;

    if (file.size > maxSize) {
        // CODED (#2059). This used to be prose, and its only caller flattened
        // it into `FILE_VALIDATION_ERROR`'s message — which is why that code
        // could not be entried: the sentence WAS the validator's. The cap
        // travels as a param so the catalogue entry can name the number, the
        // same contract `FILE_TOO_LARGE` already had at the ingest path.
        throw codedBadRequest(
            'FILE_TOO_LARGE',
            `File size validation failed: max size is ${options?.maxSizeMB || 10}MB`,
            { maxBytes: String(maxSize) },
        );
    }

    if (!allowedTypes.includes(file.type)) {
        throw codedBadRequest(
            'FILE_TYPE_NOT_ALLOWED',
            `File type validation failed: ${file.type} is not allowed`,
            // The DECLARED type — the client's claim, not the bytes. The
            // type itself stays out of `params`: it is client-controlled
            // input and would reach logs through the error payload.
            { reason: 'declared' },
        );
    }

    return true;
}
