/**
 * `capabilities.documentStorage` on `/api/readyz` (#2495 step 3).
 *
 * WATCHED, not gated — the #781 treatment every sibling in `capabilities`
 * gets. This endpoint is the GCP uptime check's target, so a storage figure
 * must never be able to page anybody: it sits OUTSIDE `checks`/`failed`.
 *
 * ## It reports a BAND, not the figure
 *
 * `/api/readyz` is probed unauthenticated from six regions, so anything here
 * is effectively public — including roughly how much data the business
 * stores. A threshold crossing is what would prompt an operator to act, and
 * bucketing preserves that. The exact total stays on the tenant-scoped
 * settings GET, which is authenticated and scoped to the farm that owns the
 * bytes.
 *
 * ## `unknown` exists so a database blip is not a storage alarm
 *
 * The fourth state is the same reasoning as `platformConsole`'s: during an
 * incident every probe would otherwise report a capacity problem that does
 * not exist. A read that could not run says so.
 *
 * The client is PASSED IN rather than imported, for the reason that
 * capability's docblock records: `@/lib/prisma` reads `Prisma.dmmf` at module
 * load, and three readyz suites mock `@prisma/client` with `PrismaClient`
 * alone — importing it here would break them before they ran. `readyz`
 * already builds a raw client for its database check, and that is also the
 * correct client: `FileRecord.sizeBytes` is not encrypted, so the extension's
 * per-tenant DEK resolution would be work for nothing.
 */
import { documentStorageLimitBytes } from '@/app-layer/documents/budget';
import { documentStorageBand, type DocumentStorageBand } from './storage-band';

/** The narrow surface this needs — not `PrismaClient`, so a double needs no cast. */
export interface DocumentStorageReader {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface DocumentStorageCapability {
    /** Bucketed total across every tenant, or `unknown` if the read failed. */
    band: DocumentStorageBand | 'unknown';
    /** The configured per-tenant ceiling, in bytes. */
    perTenantLimitBytes: number;
}

export async function documentStorageCapability(
    db: DocumentStorageReader | null,
): Promise<DocumentStorageCapability> {
    const perTenantLimitBytes = documentStorageLimitBytes();
    if (!db) return { band: 'unknown', perTenantLimitBytes };

    try {
        // Deployment-wide, across tenants, so it runs unscoped by design —
        // this is an operator signal about the DISK, not about a farm.
        const rows = await db.$queryRawUnsafe<Array<{ total: bigint | number | null }>>(
            `SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
               FROM "FileRecord"
              WHERE "domain" = 'documents' AND "status" = 'STORED'`,
        );
        const raw = rows?.[0]?.total ?? 0;
        return { band: documentStorageBand(Number(raw)), perTenantLimitBytes };
    } catch {
        // `unknown`, never a band. Defaulting to the smallest would read as
        // "plenty of room" on a failed read, which is the alarming direction
        // being wrong in the reassuring way.
        return { band: 'unknown', perTenantLimitBytes };
    }
}
