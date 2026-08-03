/**
 * Epic B.2 — Tenant key manager (runtime layer).
 *
 * Sits above the primitives in `tenant-keys.ts` (which only know how
 * to generate / wrap / unwrap DEKs, in-memory) and provides the
 * tenant-lifecycle surface the rest of the app talks to:
 *
 *   - `createTenantWithDek(data)` — atomic "create a tenant with
 *     its wrapped DEK already populated" against the singleton
 *     client. The call every tenant-creation path should use UNLESS
 *     the tenant row must be created inside a caller-owned
 *     transaction (it cannot join one — see the function's doc
 *     comment for the two call sites that replicate its body against
 *     a `tx` client instead).
 *
 *   - `ensureTenantDek(tenantId)` — idempotent backfill for a single
 *     tenant. Writes a DEK iff the column is currently NULL. Used
 *     by `scripts/generate-tenant-deks.ts` and (as a defensive
 *     fallback) by `getTenantDek` on first access.
 *
 *   - `getTenantDek(tenantId)` — the runtime hot path. Resolves a
 *     tenant's raw DEK (Buffer), hitting an in-memory cache in the
 *     common case. Unwraps on cold miss; lazily generates +
 *     persists + primes cache if the column is NULL.
 *
 *   - `clearTenantDekCache(tenantId?)` / `getTenantDekCacheSize()`
 *     — observability + invalidation hooks for rotation.
 *
 *   - `rotateTenantDek(options)` — per-tenant DEK rotation. Atomic
 *     swap of `Tenant.encryptedDek` ⇒ `Tenant.previousEncryptedDek`,
 *     primes both caches, enqueues a `tenant-dek-rotation` BullMQ
 *     sweep job that re-encrypts every v2 ciphertext under the new
 *     DEK and clears `previousEncryptedDek` on completion. Mid-flight
 *     reads remain correct via `decryptWithKeyOrPrevious` in the
 *     middleware.
 *
 *   - `getTenantPreviousDek(tenantId)` — runtime fallback for the
 *     middleware's v2-read path. Returns null in steady state (the
 *     column is null and the function caches that fact). Returns the
 *     unwrapped previous DEK during the brief window between a
 *     rotation and the sweep job's completion.
 *
 * ## Cache semantics
 *
 * The cache is an in-process `Map` of `tenantId → Buffer`, bounded
 * at `MAX_CACHE_SIZE`. It uses insertion-order LRU eviction (the
 * first key added gets evicted when the cap is hit). Lifetime is
 * process-lifetime with no TTL — the DEK bytes are the same for a
 * given tenant until a rotation, and holding the raw key in memory
 * avoids a DB read + unwrap on every request.
 *
 * This is a deliberate trade-off:
 *   + No per-request unwrap cost (otherwise every field access pays
 *     an AES-GCM decrypt of the wrapped DEK).
 *   + Recovery is automatic — cache miss re-reads + re-unwraps.
 *   – Raw key material lives in process memory until eviction or
 *     restart. A hostile read of process memory (coredump,
 *     debugger) could lift it out. The same threat applies to the
 *     derived KEK cached in `encryption.ts`; we accept the same
 *     posture here. Hardening (e.g. `sodium_memzero`, KMS-backed
 *     unwrap) is a future prompt's concern.
 *
 * ## Concurrency
 *
 * `ensureTenantDek` and `getTenantDek`'s lazy-init branch both
 * issue `UPDATE tenant SET encryptedDek = … WHERE id = … AND
 * encryptedDek IS NULL`. Two concurrent requests for the same
 * fresh tenant will BOTH try to write; one wins, one is a no-op
 * (affected rows = 0). Neither produces a corrupted state — the
 * losing request refetches and uses the winner's DEK.
 *
 * A process-level race where two processes unwrap the same wrapped
 * DEK and cache independent copies is fine: both Buffers carry the
 * same bytes by construction (AES-GCM decrypts deterministically
 * given the same key + ciphertext).
 */

import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
    generateAndWrapDek,
    generateDek,
    unwrapDek,
    wrapDek,
    type TenantDek,
} from './tenant-keys';
import { enqueue } from '@/app-layer/jobs/queue';
import { logger } from '@/lib/observability/logger';

// ─── Cache ──────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 1000;
const dekCache = new Map<string, TenantDek>();

/**
 * Parallel cache for `Tenant.previousEncryptedDek` — populated only
 * while a per-tenant rotation is mid-flight (job hasn't finished
 * re-encrypting every v2 row under the new DEK). Empty in steady
 * state.
 *
 * Same shape + LRU eviction as `dekCache`. The two are independent —
 * a tenant can have a primary cache hit and a previous cache miss
 * (or vice versa) without inconsistency, because the primary and
 * previous DEKs unwrap from independent columns.
 */
const previousDekCache = new Map<string, TenantDek>();

/**
 * Negative cache for `Tenant.previousEncryptedDek IS NULL`. Without
 * this, every encryption-middleware operation in steady state would
 * issue a fresh `findUnique` to confirm the column is still NULL —
 * doubling DB load on every read/write.
 *
 * The map stores the absolute expiry timestamp (ms since epoch) of
 * each cached negative result. After the TTL elapses the entry is
 * treated as expired and the next call re-queries.
 *
 * Staleness bound: a sibling-process rotation (worker rotates while
 * web tier serves reads) takes up to `NO_PREVIOUS_TTL_MS` to be
 * visible to this process. During that window, v2 reads of rows
 * still under the old DEK fail in this process. The middleware's
 * `decryptWithKeyOrPrevious` retry path WILL find the freshly
 * available previous DEK once this cache expires; the impact is a
 * brief read-failure window (≤ TTL) on rows the sweep job hasn't
 * rewritten yet, not data loss.
 *
 * `rotateTenantDek` proactively `.delete()`s the entry for the
 * tenant it rotates so the in-process flow has zero lag. Cross-
 * process is bounded by the TTL.
 */
const noPreviousDekCache = new Map<string, number>();

/** 30 s — see `noPreviousDekCache` doc for the staleness rationale. */
const NO_PREVIOUS_TTL_MS = 30_000;

/**
 * Insert or refresh the cache entry, evicting the oldest key when
 * the cap is exceeded. Map's iteration order is insertion-order, so
 * `keys().next().value` is the least-recently-inserted entry —
 * equivalent to a simple LRU when combined with delete-before-set
 * on cache-hit refresh.
 */
function setCached(tenantId: string, dek: TenantDek): void {
    if (dekCache.size >= MAX_CACHE_SIZE && !dekCache.has(tenantId)) {
        const oldest = dekCache.keys().next().value;
        if (oldest !== undefined) dekCache.delete(oldest);
    }
    dekCache.set(tenantId, dek);
}

function getCached(tenantId: string): TenantDek | undefined {
    const cached = dekCache.get(tenantId);
    if (!cached) return undefined;
    // LRU refresh — delete + re-insert moves the key to the end of
    // insertion order so it's the last to be evicted.
    dekCache.delete(tenantId);
    dekCache.set(tenantId, cached);
    return cached;
}

function setCachedPrevious(tenantId: string, dek: TenantDek): void {
    if (
        previousDekCache.size >= MAX_CACHE_SIZE &&
        !previousDekCache.has(tenantId)
    ) {
        const oldest = previousDekCache.keys().next().value;
        if (oldest !== undefined) previousDekCache.delete(oldest);
    }
    previousDekCache.set(tenantId, dek);
}

function getCachedPrevious(tenantId: string): TenantDek | undefined {
    const cached = previousDekCache.get(tenantId);
    if (!cached) return undefined;
    previousDekCache.delete(tenantId);
    previousDekCache.set(tenantId, cached);
    return cached;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Create a tenant with its wrapped DEK populated atomically. The
 * DEK is generated, wrapped under the global KEK, and saved in a
 * single `tenant.create` call; the raw DEK is primed into the
 * cache so the first request against the new tenant doesn't pay
 * an unwrap round-trip.
 *
 * Use this whenever a new tenant is created OUTSIDE a transaction:
 *   - SSO auto-onboarding (when it lands)
 *   - seed scripts
 *   - test fixtures that need a DEK from the start
 *
 * This function cannot join a caller's transaction — it always runs
 * against the singleton `prisma` client. Callers that need the tenant
 * row created atomically alongside other writes (the self-service
 * register route at `src/app/api/auth/register/route.ts`, and
 * `createTenantWithOwner` in `src/app-layer/usecases/tenant-lifecycle.ts`)
 * replicate this function's body — `generateAndWrapDek()` + `tx.tenant.create`
 * — directly against the transaction client instead. The DEK cache is
 * not primed on that path; it unwraps on first use.
 *
 * Direct `prisma.tenant.create` still works (nullable column) but
 * leaves the tenant dependent on backfill to get a DEK.
 */
export async function createTenantWithDek(
    data: Omit<Prisma.TenantCreateInput, 'encryptedDek'>,
): Promise<Prisma.TenantGetPayload<Record<string, never>>> {
    const { dek, wrapped } = generateAndWrapDek();
    const tenant = await prisma.tenant.create({
        data: { ...data, encryptedDek: wrapped },
    });
    setCached(tenant.id, dek);
    logger.info('tenant-key-manager.tenant_created_with_dek', {
        component: 'tenant-key-manager',
        tenantId: tenant.id,
    });
    return tenant;
}

/**
 * Guarantee that this tenant has a wrapped DEK. Idempotent:
 *   - If encryptedDek is already set → no-op, return.
 *   - If NULL → generate + wrap + save + prime cache.
 *
 * Use this from backfill scripts and from safety-net paths that
 * want to ensure a tenant is ready for encryption before hitting
 * a hot read path. `getTenantDek` internally calls this on demand,
 * so usecase code rarely needs to call it directly.
 */
export async function ensureTenantDek(tenantId: string): Promise<void> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { encryptedDek: true },
    });
    if (!tenant) {
        throw new Error(
            `ensureTenantDek: tenant ${tenantId} not found`,
        );
    }
    if (tenant.encryptedDek !== null) return;

    const dek = generateDek();
    const wrapped = wrapDek(dek);

    // Race-safe write: if another process beat us to it, the
    // `encryptedDek IS NULL` predicate makes our UPDATE a no-op and
    // no row is mutated. Either way the tenant ends up with a DEK;
    // callers that need to use it can re-fetch.
    const result = await prisma.tenant.updateMany({
        where: { id: tenantId, encryptedDek: null },
        data: { encryptedDek: wrapped },
    });

    if (result.count === 1) {
        setCached(tenantId, dek);
        logger.info('tenant-key-manager.dek_backfilled', {
            component: 'tenant-key-manager',
            tenantId,
        });
    } else {
        // Someone else won the race — clear our local DEK and let
        // the next getTenantDek unwrap the winner's value.
        logger.debug('tenant-key-manager.dek_backfill_raced', {
            component: 'tenant-key-manager',
            tenantId,
        });
    }
}

/**
 * Resolve a tenant's raw DEK for use as an AES-256-GCM key. Hot
 * path — most calls hit the in-memory cache.
 *
 * Behaviour:
 *   1. Cache hit → return (touches LRU).
 *   2. Cache miss + encryptedDek present → unwrap, cache, return.
 *   3. Cache miss + encryptedDek NULL → lazy init via
 *      `ensureTenantDek`, re-read, return.
 *
 * Throws if the tenant doesn't exist.
 */
export async function getTenantDek(tenantId: string): Promise<TenantDek> {
    const cached = getCached(tenantId);
    if (cached) return cached;

    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { encryptedDek: true },
    });
    if (!tenant) {
        throw new Error(`getTenantDek: tenant ${tenantId} not found`);
    }

    if (tenant.encryptedDek === null) {
        // Lazy init + read-after-write to handle the race where
        // another process concurrently populated encryptedDek. After
        // ensureTenantDek returns, one of us wrote; re-read to get
        // the canonical value.
        await ensureTenantDek(tenantId);
        const reloaded = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { encryptedDek: true },
        });
        if (!reloaded || !reloaded.encryptedDek) {
            throw new Error(
                `getTenantDek: tenant ${tenantId} has no encryptedDek after ensure`,
            );
        }
        const dek = unwrapDek(reloaded.encryptedDek);
        setCached(tenantId, dek);
        return dek;
    }

    const dek = unwrapDek(tenant.encryptedDek);
    setCached(tenantId, dek);
    return dek;
}

/**
 * Resolve the previous-generation DEK for this tenant, or `null` if
 * no rotation is in flight (i.e. `Tenant.previousEncryptedDek` is
 * NULL). Mirrors `getTenantDek`'s cache shape but with three
 * essential differences:
 *
 *   - Returns null instead of lazy-initialising. There's no concept
 *     of "ensure a previous DEK exists" — the column is populated
 *     only by `rotateTenantDek` and cleared by the re-encrypt job.
 *   - Cache miss + NULL column → no work, no error. Steady state.
 *   - Tenant-not-found IS still an error (mirrors `getTenantDek`).
 *
 * Used by the encryption middleware on every v2 read to provide the
 * fallback key for `decryptWithKeyOrPrevious`. In steady state every
 * tenant's column is NULL and this function returns null in O(1)
 * after the first DB miss is cached. While a rotation is in flight,
 * the previous DEK is in cache and reads pay the same per-call cost
 * as the primary path.
 *
 * Throws if the tenant doesn't exist.
 */
export async function getTenantPreviousDek(
    tenantId: string,
): Promise<TenantDek | null> {
    const cached = getCachedPrevious(tenantId);
    if (cached) return cached;

    // Negative cache — short-circuit the DB lookup for tenants we
    // recently observed to have no previous DEK. See
    // `noPreviousDekCache` docstring for staleness bounds.
    const expiresAt = noPreviousDekCache.get(tenantId);
    if (expiresAt !== undefined && expiresAt > Date.now()) {
        return null;
    }

    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { previousEncryptedDek: true },
    });
    if (!tenant) {
        throw new Error(`getTenantPreviousDek: tenant ${tenantId} not found`);
    }

    if (tenant.previousEncryptedDek === null) {
        noPreviousDekCache.set(tenantId, Date.now() + NO_PREVIOUS_TTL_MS);
        return null;
    }

    // Tenant entered a rotation since we last looked — drop any
    // stale negative entry so subsequent calls take the cache-hit
    // path.
    noPreviousDekCache.delete(tenantId);
    const dek = unwrapDek(tenant.previousEncryptedDek);
    setCachedPrevious(tenantId, dek);
    return dek;
}

/**
 * Invalidate the primary-DEK cache for a tenant (rotation) or
 * globally (restart / test cleanup). The previous-DEK cache is left
 * untouched — call `clearTenantPreviousDekCache` separately for
 * that. Splitting the two avoids forcing every cache invalidation
 * (e.g. master-KEK rewrap) to also drop the in-flight previous DEK.
 */
export function clearTenantDekCache(tenantId?: string): void {
    if (tenantId) {
        dekCache.delete(tenantId);
    } else {
        dekCache.clear();
    }
}

/**
 * Invalidate the previous-DEK cache for a tenant (rotation completion)
 * or globally (test cleanup). Called by the re-encrypt job on
 * completion so that subsequent reads stop attempting the previous-DEK
 * fallback. Idempotent.
 */
export function clearTenantPreviousDekCache(tenantId?: string): void {
    if (tenantId) {
        previousDekCache.delete(tenantId);
        noPreviousDekCache.delete(tenantId);
    } else {
        previousDekCache.clear();
        noPreviousDekCache.clear();
    }
}

/** Observability — current cache size. Useful for metrics. */
export function getTenantDekCacheSize(): number {
    return dekCache.size;
}

/** Observability — current previous-DEK cache size. */
export function getTenantPreviousDekCacheSize(): number {
    return previousDekCache.size;
}

// ─── Per-tenant DEK rotation ────────────────────────────────────────

export interface RotateTenantDekOptions {
    tenantId: string;
    /** User who initiated the rotation — for audit attribution. */
    initiatedByUserId: string;
    /** Optional upstream request id for log correlation. */
    requestId?: string;
}

export interface RotateTenantDekResult {
    tenantId: string;
    /** BullMQ job id of the re-encrypt sweep. */
    jobId: string;
}

/**
 * Rotate a tenant's Data Encryption Key. Three steps:
 *
 *   1. Atomic DEK swap. A fresh 32-byte DEK is generated, wrapped
 *      under the master KEK, and written to `Tenant.encryptedDek`.
 *      The PRIOR wrapped DEK is moved into `Tenant.previousEncryptedDek`
 *      in the same `UPDATE` so the two columns transition together.
 *      Guarded by `WHERE id = $1 AND previousEncryptedDek IS NULL`
 *      — concurrent rotation attempts collapse to one winner; the
 *      losers see `count === 0` and throw `RotationInProgressError`
 *      so the operator can let the in-flight sweep finish first.
 *
 *   2. Cache invalidation. The primary cache entry is dropped (next
 *      read unwraps the new DEK); the previous cache is primed with
 *      the now-old DEK so the middleware can fall back to it on
 *      mid-rotation v2 reads without paying an unwrap.
 *
 *   3. Re-encrypt sweep enqueued. A `tenant-dek-rotation` BullMQ job
 *      walks every model+field in the encrypted-fields manifest,
 *      decrypts each row's v2 ciphertexts under the previous DEK and
 *      re-encrypts under the new primary, then clears
 *      `Tenant.previousEncryptedDek` + the previous cache when done.
 *
 * Mid-rotation reads remain correct because:
 *   - New writes use the new primary DEK (cache hit; no preference for
 *     the previous column).
 *   - Reads of rows still under the previous DEK fail AES-GCM on the
 *     primary; the middleware's `decryptWithKeyOrPrevious` retries
 *     under the previous DEK transparently.
 *
 * Failure modes:
 *   - DB swap failure → throws; no state change visible to readers.
 *   - Enqueue failure AFTER swap → throws; the previous-DEK fallback
 *     keeps reads working but no automatic re-encrypt happens. The
 *     operator follows the runbook to re-enqueue manually (the
 *     rotation is half-finished, not broken).
 *
 * @throws if the tenant doesn't exist, is already mid-rotation
 *         (`previousEncryptedDek` is non-null), or has no current
 *         `encryptedDek` to rotate.
 */
export async function rotateTenantDek(
    options: RotateTenantDekOptions,
): Promise<RotateTenantDekResult> {
    const { tenantId, initiatedByUserId, requestId } = options;

    // Read current state. We need both the existing wrapped DEK (to
    // become the previous) and the previousEncryptedDek (to refuse
    // double-rotation cleanly with a useful error vs. a generic
    // "0 rows updated" failure).
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
            id: true,
            encryptedDek: true,
            previousEncryptedDek: true,
        },
    });
    if (!tenant) {
        throw new Error(`rotateTenantDek: tenant ${tenantId} not found`);
    }
    if (!tenant.encryptedDek) {
        // No DEK to rotate — surface as an explicit error rather than
        // generating one out of nowhere (which would obscure a
        // misconfigured tenant). Operator should call
        // `ensureTenantDek` first.
        throw new Error(
            `rotateTenantDek: tenant ${tenantId} has no encryptedDek to ` +
                'rotate. Call ensureTenantDek first.',
        );
    }
    if (tenant.previousEncryptedDek !== null) {
        throw new Error(
            `rotateTenantDek: tenant ${tenantId} is already mid-rotation ` +
                '(previousEncryptedDek is set). Wait for the re-encrypt ' +
                'job to complete before initiating another rotation.',
        );
    }

    // Generate the new DEK + wrap under the master KEK.
    const newDek = generateDek();
    const newWrapped = wrapDek(newDek);
    const oldWrapped = tenant.encryptedDek;

    // Atomic swap — predicated on previousEncryptedDek being NULL so
    // a concurrent caller that beat us to the read sees count=0 and
    // can be told "already rotating" without inventing a generic
    // failure mode. The CHECK constraint on the column also enforces
    // newWrapped !== oldWrapped (silent-key-mixing guard) — a fresh
    // crypto.randomBytes(32) collision is astronomically unlikely but
    // the constraint catches the operator-injected mistake too.
    const swap = await prisma.tenant.updateMany({
        where: { id: tenantId, previousEncryptedDek: null },
        data: {
            encryptedDek: newWrapped,
            previousEncryptedDek: oldWrapped,
        },
    });
    if (swap.count !== 1) {
        // Another caller swapped between our read and our update.
        // Refuse — the in-flight rotation needs to finish first.
        throw new Error(
            `rotateTenantDek: tenant ${tenantId} concurrent rotation ` +
                'detected; previousEncryptedDek became non-null between ' +
                'read and swap. Retry once the in-flight sweep completes.',
        );
    }

    // Cache discipline:
    //   - Drop the primary cache so the next read unwraps the new
    //     DEK (cached value is now the OLD DEK).
    //   - Prime the previous cache with the same value we just
    //     dropped — it's correct as a fallback for v2 reads of rows
    //     still under the old DEK.
    //   - Drop the "no previous DEK" negative-cache entry — the
    //     tenant now HAS a previous DEK and stale negative entries
    //     would mask it.
    const oldCachedDek = getCached(tenantId);
    if (oldCachedDek) {
        setCachedPrevious(tenantId, oldCachedDek);
    }
    dekCache.delete(tenantId);
    noPreviousDekCache.delete(tenantId);

    // Prime the new primary cache too so the first read after
    // rotation doesn't pay an unwrap. (Both newDek and oldCachedDek
    // are owned in-process; nothing escapes outside this function.)
    setCached(tenantId, newDek);

    logger.info('tenant-key-manager.dek_rotated', {
        component: 'tenant-key-manager',
        tenantId,
        initiatedByUserId,
    });

    // Enqueue the re-encrypt sweep. Done AFTER the swap (and not
    // wrapped in a transaction) because:
    //   1. The swap must be visible before the job starts; otherwise
    //      the job races the swap and may see no previousEncryptedDek.
    //   2. BullMQ enqueue talks to Redis; mixing with a Postgres
    //      transaction would cross-couple two failure domains.
    //   3. If enqueue fails, the previous-DEK fallback keeps reads
    //      correct — a stuck mid-rotation state, not a broken one.
    //      The operator's runbook covers manual re-enqueue.
    let jobId: string;
    try {
        const job = await enqueue('tenant-dek-rotation', {
            tenantId,
            initiatedByUserId,
            requestId,
        });
        jobId = job.id ?? '';
    } catch (err) {
        // Enqueue failed AFTER successful swap — the rotation is
        // half-done. Surface loudly; reads still work (previous-DEK
        // fallback is in place).
        logger.error('tenant-key-manager.dek_rotated_but_enqueue_failed', {
            component: 'tenant-key-manager',
            tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
            `rotateTenantDek: tenant ${tenantId} DEK was swapped but the ` +
                're-encrypt job could not be enqueued. Reads still work ' +
                'via the previous-DEK fallback. Manually re-enqueue ' +
                "'tenant-dek-rotation' with the same payload to complete. " +
                'Underlying error: ' +
                (err instanceof Error ? err.message : String(err)),
        );
    }

    return { tenantId, jobId };
}

// ─── Test-only helpers ──────────────────────────────────────────────

/** @internal — visible to tests only. Peek without touching LRU order. */
export function _peekCachedDek(tenantId: string): TenantDek | undefined {
    return dekCache.get(tenantId);
}

/** @internal — reset all caches AND reclaim capacity. */
export function _resetTenantDekCache(): void {
    dekCache.clear();
    previousDekCache.clear();
    noPreviousDekCache.clear();
}

/** @internal — expose the size cap so tests can craft eviction scenarios. */
export const _MAX_CACHE_SIZE = MAX_CACHE_SIZE;
