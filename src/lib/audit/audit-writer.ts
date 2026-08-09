/**
 * Audit Trail — Hash-Chained Writer
 *
 * Central function for appending audit entries with per-tenant hash chaining.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHAIN MODEL: Per-Tenant
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each tenant has an independent hash chain:
 *   - First entry: previousHash = null
 *   - Subsequent:  previousHash = entryHash of the prior row (same tenant)
 *
 * CONCURRENCY: PostgreSQL advisory locks (per-tenant)
 *   - pg_advisory_xact_lock(hashtext(tenantId)) serializes appends per tenant
 *   - Automatically releases when the transaction commits/rolls back
 *   - Does NOT block inserts for other tenants
 *
 * HASH COMPUTATION: Application-side (Node.js)
 *   - Uses canonical-hash.ts: SHA-256 of deterministic JSON serialization
 *   - Computed INSIDE the advisory-locked transaction for consistency
 *
 * @module audit/audit-writer
 */
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as prismaModule from '../prisma';
import { computeEntryHash, toCanonicalTimestamp } from './canonical-hash';

/**
 * Lazy getter for the default PrismaClient singleton.
 *
 * ARCHITECTURE NOTE: audit-writer.ts and prisma.ts form a cyclic
 * graph at runtime:
 *
 *   prisma.ts → require('./audit/audit-writer') (inside the audit
 *               extension's handler — only runs at request time)
 *   audit-writer.ts → import * as prismaModule from '../prisma'
 *
 * The cycle is resolved by deferring the dereference of
 * `prismaModule.prisma` to function-call time. The static
 * `import * as` form gives us a live namespace binding; reading
 * `prismaModule.prisma` inside `getDefaultPrisma()` happens after
 * both modules have finished evaluating, so we always observe the
 * fully-constructed extended client.
 *
 * Why this changed: the previous form was
 * `require('../prisma').prisma` inside the function. That worked
 * under Webpack but Turbopack's production bundle resolves dynamic
 * TS-module `require()` unreliably — it returned `undefined`,
 * surfacing as "Cannot read properties of undefined (reading
 * '$transaction')" on the first audit write under prod. Static
 * import + deferred read fixes it without re-introducing the cycle
 * at module-init time.
 */
function getDefaultPrisma(): PrismaClient {
    return prismaModule.prisma as unknown as PrismaClient;
}

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Input for appending a hash-chained audit entry.
 *
 * This covers both structured (new-style) and legacy audit write paths.
 * For structured entries, provide `detailsJson` with a valid category.
 * For legacy/middleware entries, provide `details` as free-form text.
 */
export interface AppendAuditInput {
    tenantId: string;
    userId: string | null;
    actorType?: string;           // defaults to 'USER'
    entity: string;               // e.g., 'Practice', 'Asset'
    entityId: string;             // e.g., 'ctrl-123' or 'batch'
    action: string;               // e.g., 'CONTROL_CREATED', 'UPDATE'

    // Content — at least one should be provided
    details?: string | null;      // Legacy free-text
    detailsJson?: unknown;        // Structured payload (AuditDetails)

    // Optional metadata
    requestId?: string | null;
    recordIds?: unknown;          // For *Many operations
    metadataJson?: unknown;       // Middleware context
    diffJson?: unknown;           // Update diffs

    // Hash chain version (default 1)
    version?: number;
}

/**
 * Result of a hash-chained audit append.
 */
export interface AppendAuditResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
}

// ─── ID Generator ───────────────────────────────────────────────────

function generateCuid(): string {
    const uuid = createHash('md5').update(
        Date.now().toString() + Math.random().toString()
    ).digest('hex');
    return 'c' + uuid.substring(0, 24);
}

// ─── Core Writer ────────────────────────────────────────────────────

/**
 * Append a hash-chained audit entry within an advisory-locked transaction.
 *
 * This is the ONLY function that should insert into AuditLog. All other
 * audit write paths (logEvent, Prisma middleware, retention-purge,
 * evidence-maintenance) must route through this function.
 *
 * Flow:
 *   1. Open transaction
 *   2. Acquire per-tenant advisory lock (blocks other appends for same tenant)
 *   3. Fetch the latest entryHash for this tenant
 *   4. Compute entryHash = SHA-256(canonical(fields + previousHash))
 *   5. INSERT the row with previousHash + entryHash
 *   6. Commit (auto-releases advisory lock)
 *
 * @param input - Audit entry data
 * @returns The appended entry's id, entryHash, and previousHash
 */
export async function appendAuditEntry(input: AppendAuditInput, client?: PrismaClient): Promise<AppendAuditResult> {
    const id = generateCuid();
    const actorType = input.actorType || 'USER';
    const version = input.version ?? 1;
    // Capture the wall-clock timestamp here for the streamer payload.
    // The actual hash-chain `occurredAt` is recomputed inside the
    // transaction (after the advisory lock) — using a slightly earlier
    // timestamp for the streamed copy is acceptable; it only changes
    // the SIEM-visible "sent at" by milliseconds.
    const streamOccurredAt = new Date().toISOString();

    // Build the structured detailsJson for hashing.
    // If caller provides detailsJson, use it directly.
    // If only legacy details text is provided, wrap it in a custom payload.
    const detailsForHash: unknown = input.detailsJson ?? {
        category: 'custom',
        legacyText: input.details || null,
    };

    const db = client || getDefaultPrisma();

    const result = await db.$transaction(async (tx) => {
        // 1. Acquire per-tenant advisory lock
        //    hashtext() returns a 32-bit int from a string — perfect for advisory locks
        await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            input.tenantId,
        );

        // Create timestamp AFTER lock acquisition so concurrent inserts
        // get distinct, ordered timestamps (lock serializes them).
        const now = new Date();
        const occurredAt = toCanonicalTimestamp(now);

        // 2. Fetch the latest entryHash for this tenant's chain
        const lastRows: Array<{ entryHash: string | null }> = await tx.$queryRawUnsafe(
            `SELECT "entryHash" FROM "AuditLog"
             WHERE "tenantId" = $1 AND "entryHash" IS NOT NULL
             ORDER BY "createdAt" DESC
             LIMIT 1`,
            input.tenantId,
        );

        const previousHash: string | null = lastRows.length > 0
            ? lastRows[0].entryHash
            : null;

        // 3. Compute entry hash
        const entryHash = computeEntryHash({
            tenantId: input.tenantId,
            actorType,
            actorUserId: input.userId,
            eventType: input.action,
            entityType: input.entity,
            entityId: input.entityId,
            occurredAt,
            detailsJson: detailsForHash,
            previousHash,
            version,
        });

        // 4. INSERT with all fields including hash chain
        //    Uses the same canonical timestamp for createdAt as was used for hashing.
        //    We pass the ISO string directly (not a Date object) to avoid timezone
        //    conversion issues when the PG server timezone differs from UTC.
        await tx.$executeRawUnsafe(
            `INSERT INTO "AuditLog" (
                "id", "tenantId", "userId", "actorType",
                "entity", "entityId", "action",
                "details", "detailsJson",
                "requestId", "recordIds", "metadataJson", "diffJson",
                "previousHash", "entryHash", "version",
                "createdAt"
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7,
                $8, $9::jsonb,
                $10, $11::jsonb, $12::jsonb, $13::jsonb,
                $14, $15, $16,
                $17::timestamp
            )`,
            id,
            input.tenantId,
            input.userId,
            actorType,
            input.entity,
            input.entityId,
            input.action,
            input.details ?? null,
            JSON.stringify(detailsForHash),
            input.requestId ?? null,
            input.recordIds ? JSON.stringify(input.recordIds) : null,
            input.metadataJson ? JSON.stringify(input.metadataJson) : null,
            input.diffJson ? JSON.stringify(input.diffJson) : null,
            previousHash,
            entryHash,
            version,
            occurredAt,
        );

        return { id, entryHash, previousHash };
    });

    // Epic C.4 — best-effort outbound streaming. The audit row is
    // already committed at this point, so a thrown error in the
    // streamer must not propagate. The streamer enqueues into a
    // per-tenant in-memory buffer and returns synchronously; HTTP
    // POSTs happen out-of-band on a 5s / 100-event flush.
    try {
        // Lazy import: the streamer pulls in node:crypto + a logger
        // chain; loading it here keeps the cold-start cost off the
        // happy path for tenants that don't use streaming.
        const { streamAuditEvent } = await import(
            '@/app-layer/events/audit-stream'
        );
        streamAuditEvent({
            id: result.id,
            entryHash: result.entryHash,
            previousHash: result.previousHash,
            tenantId: input.tenantId,
            userId: input.userId,
            actorType,
            entity: input.entity,
            entityId: input.entityId,
            action: input.action,
            // `details` is intentionally NOT forwarded — it can carry
            // human-readable PII. SIEMs consume `detailsJson`.
            detailsJson: input.detailsJson ?? null,
            metadataJson: input.metadataJson ?? null,
            requestId: input.requestId ?? null,
            occurredAt: streamOccurredAt,
        });
    } catch {
        // Streamer is fail-safe; this catch is belt-and-braces.
    }

    return result;
}

// ─── Chain Verification ─────────────────────────────────────────────

export interface ChainVerificationResult {
    tenantId: string;
    totalEntries: number;
    hashedEntries: number;
    unhashedEntries: number;
    valid: boolean;
    firstBreakAt?: number; // 0-indexed position of first chain break
    firstBreakId?: string;
}

/**
 * Verify the hash chain integrity for a given tenant.
 *
 * Reads all hashed audit entries in chronological order, recomputes
 * each entryHash, and checks that previousHash links match.
 *
 * @param tenantId - The tenant to verify
 * @returns Verification result with chain validity
 */
export async function verifyAuditChain(tenantId: string, client?: PrismaClient): Promise<ChainVerificationResult> {
    const db = client || getDefaultPrisma();

    const rows: Array<{
        id: string;
        tenantId: string;
        userId: string | null;
        actorType: string;
        entity: string;
        entityId: string;
        action: string;
        detailsJson: unknown;
        previousHash: string | null;
        entryHash: string | null;
        version: number;
        createdAtIso: string;
    }> = await db.$queryRawUnsafe(
        `SELECT "id", "tenantId", "userId", "actorType", "entity", "entityId",
                "action", "detailsJson", "previousHash", "entryHash", "version",
                to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
         FROM "AuditLog"
         WHERE "tenantId" = $1
         ORDER BY "createdAt" ASC`,
        tenantId,
    );

    const totalEntries = rows.length;
    const hashedRows = rows.filter(r => r.entryHash !== null);
    const hashedEntries = hashedRows.length;
    const unhashedEntries = totalEntries - hashedEntries;

    // Verify the hashed subset
    let valid = true;
    let firstBreakAt: number | undefined;
    let firstBreakId: string | undefined;
    let expectedPreviousHash: string | null = null;

    for (let i = 0; i < hashedRows.length; i++) {
        const row = hashedRows[i];

        // Check previousHash linkage
        if (i === 0) {
            // First hashed entry: previousHash should be null (or the chain just started)
            // We accept whatever previousHash the first entry has
            expectedPreviousHash = null;
        }

        if (row.previousHash !== expectedPreviousHash) {
            // Check if this is the absolute first in the chain (previousHash = null is OK)
            if (!(i === 0 && row.previousHash === null)) {
                valid = false;
                firstBreakAt = i;
                firstBreakId = row.id;
                break;
            }
        }

        // Recompute entry hash and verify
        const detailsForHash = row.detailsJson;
        const recomputed = computeEntryHash({
            tenantId: row.tenantId,
            actorType: row.actorType,
            actorUserId: row.userId,
            eventType: row.action,
            entityType: row.entity,
            entityId: row.entityId,
            occurredAt: row.createdAtIso,
            detailsJson: detailsForHash,
            previousHash: row.previousHash,
            version: row.version,
        });

        if (recomputed !== row.entryHash) {
            valid = false;
            firstBreakAt = i;
            firstBreakId = row.id;
            break;
        }

        expectedPreviousHash = row.entryHash;
    }

    return {
        tenantId,
        totalEntries,
        hashedEntries,
        unhashedEntries,
        valid,
        firstBreakAt,
        firstBreakId,
    };
}
