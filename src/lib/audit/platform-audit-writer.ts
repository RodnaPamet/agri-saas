/**
 * Append-only, hash-chained writer for `PlatformAuditLog`. P1.9.
 *
 * Generalised from `org-audit-writer.ts`: same five-step flow, same
 * advisory-lock-then-timestamp ordering, same raw INSERT. The chain key is
 * `scope` rather than `organizationId`.
 *
 * Flow:
 *   1. Open a transaction
 *   2. Acquire the per-SCOPE advisory lock (namespaced `platform:<scope>`)
 *   3. Timestamp AFTER the lock, so concurrent appends to one scope serialise
 *      with strictly-monotonic `occurredAt`
 *   4. Read the latest `entryHash` for that scope
 *   5. Compute `entryHash` over the canonical payload INCLUDING `previousHash`,
 *      and INSERT
 *
 * Step 3 is the subtle one and is inherited deliberately. Timestamping before
 * the lock lets two appends take the same `occurredAt`, and the
 * "latest entry" query orders by `occurredAt DESC, id DESC` — so a tie is
 * broken by cuid, which is not insertion order. Two writers would then chain
 * off the same parent and produce a fork that verifies as two valid chains.
 */
import { createHash } from 'crypto';
import { PrismaClient, PlatformAuditAction } from '@prisma/client';
import * as prismaModule from '../prisma';
import { computePlatformEntryHash } from './platform-canonical-hash';
import { toCanonicalTimestamp } from './canonical-hash';

/**
 * Lazy getter for the default PrismaClient singleton.
 *
 * `import * as prismaModule` gives a live namespace binding, and reading
 * `prismaModule.prisma` inside the function defers the dereference to
 * call-time. Same reason as `org-audit-writer.ts` and `audit-writer.ts`: it
 * dodges Turbopack's unreliable production-build resolution of a dynamic
 * TS-module `require()`.
 */
function getDefaultPrisma(): PrismaClient {
    return prismaModule.prisma as unknown as PrismaClient;
}

/**
 * The scopes a platform entry may belong to.
 *
 * A closed set because `scope` is the CHAIN KEY. A typo would not fail — it
 * would silently start a second chain whose first entry has `previousHash:
 * null`, and that chain verifies perfectly while the history a reader meant to
 * inspect appears to have a gap. Adding a scope is a deliberate act; getting
 * one wrong should not be possible.
 */
export const PLATFORM_AUDIT_SCOPES = ['feature-flags', 'key-rotation'] as const;
export type PlatformAuditScope = (typeof PLATFORM_AUDIT_SCOPES)[number];

export interface AppendPlatformAuditInput {
    scope: PlatformAuditScope;
    action: PlatformAuditAction;
    /** Usually null: these surfaces authenticate with a key, not a session. */
    actorUserId?: string | null;
    /** Defaults to PLATFORM_ADMIN. */
    actorType?: string;
    detailsJson?: unknown;
    requestId?: string | null;
    version?: number;
}

export interface AppendPlatformAuditResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
    occurredAt: string;
}

function generateCuid(): string {
    const uuid = createHash('md5')
        .update(Date.now().toString() + Math.random().toString())
        .digest('hex');
    return 'c' + uuid.substring(0, 24);
}

/**
 * Append one entry to a scope's chain.
 *
 * Throws on an unknown scope rather than writing — see
 * `PLATFORM_AUDIT_SCOPES`. The throw is at the write boundary and not a
 * compile-time check alone, because a caller reaching this through an
 * `any`-shaped seam (a route body, a test double) would otherwise bypass the
 * type.
 */
export async function appendPlatformAuditEntry(
    input: AppendPlatformAuditInput,
    client?: PrismaClient,
): Promise<AppendPlatformAuditResult> {
    if (!(PLATFORM_AUDIT_SCOPES as readonly string[]).includes(input.scope)) {
        throw new Error(
            `appendPlatformAuditEntry: unknown scope '${input.scope}'. ` +
                `Add it to PLATFORM_AUDIT_SCOPES — an unlisted scope starts a ` +
                `SECOND chain that verifies cleanly while the history you meant ` +
                `to append to looks untouched.`,
        );
    }

    const id = generateCuid();
    const actorType = input.actorType || 'PLATFORM_ADMIN';
    const version = input.version ?? 1;
    const actorUserId = input.actorUserId ?? null;
    const detailsForHash: unknown = input.detailsJson ?? null;

    const db = client || getDefaultPrisma();

    return db.$transaction(async (tx) => {
        // 2. Per-SCOPE advisory lock. The `platform:` prefix namespaces against
        //    the `org:` locks and the bare tenant locks, so a scope named the
        //    same as a tenant id cannot collide with it.
        await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            'platform:' + input.scope,
        );

        // 3. Timestamp AFTER the lock — see the module docblock.
        const occurredAt = toCanonicalTimestamp(new Date());

        // 4. Latest entry in THIS scope's chain.
        const lastRows: Array<{ entryHash: string }> = await tx.$queryRawUnsafe(
            `SELECT "entryHash" FROM "PlatformAuditLog"
             WHERE "scope" = $1
             ORDER BY "occurredAt" DESC, "id" DESC
             LIMIT 1`,
            input.scope,
        );
        const previousHash: string | null = lastRows.length > 0 ? lastRows[0].entryHash : null;

        // 5. Hash over the canonical payload, previousHash included.
        const entryHash = computePlatformEntryHash({
            scope: input.scope,
            actorType,
            actorUserId,
            action: input.action,
            occurredAt,
            detailsJson: detailsForHash,
            previousHash,
            version,
        });

        await tx.$executeRawUnsafe(
            `INSERT INTO "PlatformAuditLog" (
                "id", "scope", "actorUserId", "actorType",
                "action", "detailsJson", "requestId",
                "occurredAt", "entryHash", "previousHash", "version"
            ) VALUES (
                $1, $2, $3, $4,
                $5::"PlatformAuditAction", $6::jsonb, $7,
                $8::timestamp, $9, $10, $11
            )`,
            id,
            input.scope,
            actorUserId,
            actorType,
            input.action,
            JSON.stringify(detailsForHash),
            input.requestId ?? null,
            occurredAt,
            entryHash,
            previousHash,
            version,
        );

        return { id, entryHash, previousHash, occurredAt };
    });
}

export interface PlatformChainVerdict {
    scope: string;
    entries: number;
    intact: boolean;
    /** The first entry whose stored hash disagrees with a recomputation. */
    brokenAt: { id: string; occurredAt: string; reason: string } | null;
}

/**
 * Recompute a scope's chain and report whether it is intact.
 *
 * Checks BOTH properties, because either alone is satisfiable by a forgery:
 *   - every entry's `entryHash` matches a recomputation of its own payload, and
 *   - every entry's `previousHash` equals the preceding entry's `entryHash`.
 *
 * Hash-only would pass a chain whose rows were reordered; link-only would pass
 * a chain whose contents were rewritten with consistent links.
 */
export async function verifyPlatformChain(
    scope: string,
    client?: PrismaClient,
): Promise<PlatformChainVerdict> {
    const db = client || getDefaultPrisma();
    const rows = await db.$queryRawUnsafe<
        Array<{
            id: string;
            scope: string;
            actorType: string;
            actorUserId: string | null;
            action: string;
            detailsJson: unknown;
            occurredAt: Date;
            entryHash: string;
            previousHash: string | null;
            version: number;
        }>
    >(
        `SELECT "id", "scope", "actorType", "actorUserId", "action"::text AS action,
                "detailsJson", "occurredAt", "entryHash", "previousHash", "version"
           FROM "PlatformAuditLog"
          WHERE "scope" = $1
          ORDER BY "occurredAt" ASC, "id" ASC`,
        scope,
    );

    let expectedPrevious: string | null = null;
    for (const row of rows) {
        const occurredAt = toCanonicalTimestamp(row.occurredAt);
        if (row.previousHash !== expectedPrevious) {
            return {
                scope,
                entries: rows.length,
                intact: false,
                brokenAt: {
                    id: row.id,
                    occurredAt,
                    reason: `previousHash is ${row.previousHash ?? 'null'}, expected ${expectedPrevious ?? 'null'}`,
                },
            };
        }
        const recomputed = computePlatformEntryHash({
            scope: row.scope,
            actorType: row.actorType,
            actorUserId: row.actorUserId,
            action: row.action,
            occurredAt,
            detailsJson: row.detailsJson ?? null,
            previousHash: row.previousHash,
            version: row.version,
        });
        if (recomputed !== row.entryHash) {
            return {
                scope,
                entries: rows.length,
                intact: false,
                brokenAt: {
                    id: row.id,
                    occurredAt,
                    reason: `entryHash does not match a recomputation of its own payload`,
                },
            };
        }
        expectedPrevious = row.entryHash;
    }

    return { scope, entries: rows.length, intact: true, brokenAt: null };
}
