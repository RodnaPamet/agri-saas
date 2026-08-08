/**
 * Playwright global teardown — GAP-23.
 *
 * Reads `tests/e2e/.tenant-tracker.jsonl` (appended by every
 * `createIsolatedTenant()` invocation) and hard-deletes the rows so
 * a CI run leaves the test database exactly as it found it (modulo
 * the seeded fixture tenant).
 *
 * Cleanup order per tenant (FK-respecting, with the AuditLog
 * immutability trigger bypassed via
 * `SET LOCAL session_replication_role = 'replica'` — same pattern
 * as `tests/integration/audit-immutability.test.ts`):
 *
 *   1. AuditLog rows where tenantId = X
 *   2. Tenant-scoped child tables (the most common ones — see
 *      TENANT_CHILD_TABLES below). Best-effort, table by table; a
 *      missing/empty table is fine.
 *   3. Tenant row itself.
 *   4. Owner User row (User has no tenantId — we track the id from
 *      the factory's response).
 *
 * Failure handling:
 *   - We DO NOT abort the teardown on per-tenant errors. A single
 *     row that won't delete (e.g. cross-tenant FK to seeded data)
 *     gets logged and the loop continues so other tenants still
 *     clean up.
 *   - We DO NOT delete the tracker file if any tenant deletion
 *     failed — leaving the file lets the operator inspect the
 *     residue. The next run's teardown picks it up + retries.
 *   - DB unreachable → log + return cleanly. CI's per-job DB is
 *     ephemeral so the tenants vanish with it anyway; the only
 *     real cost is dev iteration on a shared local DB.
 *
 * Why not use Prisma's relation cascades / `tenant.delete()`:
 * the schema has selective `onDelete: Cascade` clauses (audit
 * checklist items, evidence-finding links, etc.) but Tenant itself
 * is the parent of dozens of tables, not all of which cascade.
 * Explicit per-table deletion is simpler than chasing the schema
 * graph at runtime.
 */
import type { FullConfig } from '@playwright/test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const TRACKER_PATH = resolvePath(__dirname, '.tenant-tracker.jsonl');

interface TenantTrackerEntry {
    tenantId: string;
    tenantSlug: string;
    ownerUserId: string;
    createdAt: string;
}

/**
 * Tables that carry `tenantId` and that we DELETE before the Tenant
 * row goes. List is hand-maintained; the order doesn't matter
 * because `session_replication_role = 'replica'` skips FK checks.
 *
 * Rows in tables NOT in this list will become orphans. That's
 * acceptable — orphan rows in the test DB never collide with
 * future test runs (each test tenant gets a fresh, unique id) and
 * the cost is just storage we ignore. Add a table here when a new
 * spec writes to it and you want truly clean teardown.
 *
 * A STALE name is not free, even though the per-statement SAVEPOINT
 * below swallows the error. Every dropped table costs a failed round
 * trip on EVERY isolated-tenant teardown, and the run's Postgres log
 * fills with `relation "X" does not exist`. Eleven names had gone
 * stale: the ten risk / control-exoskeleton tables removed by this
 * branch, plus `IntegrationEvent`, which had already been dropped
 * before it. `PolicyAcknowledgement` went too — it has no `tenantId`
 * (it hangs off `policyVersion`), so `WHERE "tenantId" = $1` could
 * never have matched a row; it falls under the orphan carve-out above.
 *
 * `tests/guards/e2e-teardown-tables.test.ts` holds the invariant now:
 * every name must resolve to a real Prisma model that actually has a
 * `tenantId` field.
 */
const TENANT_CHILD_TABLES: readonly string[] = [
    // Audit + identity
    'AuditLog',
    // Epic G-4 — children must come before TenantMembership (FK target).
    'AccessReviewDecision',
    'AccessReview',
    'TenantOnboarding',
    'TenantMembership',
    'TenantSecuritySettings',
    'TenantNotificationSettings',
    'TenantInvite',
    'TenantApiKey',
    'TenantCustomRole',
    'TenantIdentityProvider',
    'UserIdentityLink',
    // Compliance entities (and their tenant-scoped children)
    'TaskLink',
    'TaskComment',
    'TaskWatcher',
    'Task',
    'EvidenceReview',
    'Evidence',
    'FindingEvidence',
    'Finding',
    'PolicyApproval',
    'PolicyControlLink',
    'PolicyVersion',
    'Policy',
    'ControlAsset',
    'ControlEvidenceLink',
    'ControlTask',
    'Control',
    'Asset',
    'ClauseProgress',
    'AuditChecklistItem',
    'AuditPackItem',
    'AuditPackShare',
    'AuditPack',
    'AuditCycle',
    'AuditorPackAccess',
    'AuditorAccount',
    'Audit',
    // Vendor + assessments
    'VendorEvidenceBundleItem',
    'VendorEvidenceBundle',
    'VendorRelationship',
    'VendorLink',
    'VendorAssessmentAnswer',
    'VendorAssessment',
    'VendorDocument',
    'VendorContact',
    'Vendor',
    // Notifications + automations
    'NotificationOutbox',
    'ReminderHistory',
    'Notification',
    'AutomationExecution',
    'AutomationRule',
    'IntegrationSyncMapping',
    'IntegrationConnection',
    // Billing
    'BillingEvent',
    'BillingAccount',
    // RLS / observability
    'UserNotificationPreference',
    'UserSession',
    // File storage
    'FileRecord',
];

async function deleteTenant(
    prisma: PrismaClient,
    entry: TenantTrackerEntry,
): Promise<{ ok: boolean; reason?: string }> {
    try {
        await prisma.$transaction(async (tx) => {
            // SAVEPOINT-per-statement, otherwise Postgres poisons the
            // whole transaction on the first failed statement and every
            // subsequent DELETE returns `25P02 in_failed_sql_transaction`.
            // A bare `.catch(...)` suppresses the JS error but not the
            // server-side aborted-transaction state — we'd have observed
            // exactly that as the trailing 25P02 spam. Each statement now
            // runs inside its own savepoint and rolls back on failure,
            // leaving the outer tx free to keep deleting.
            const tryStmt = async (sql: string, ...params: unknown[]) => {
                await tx.$executeRawUnsafe(`SAVEPOINT s`);
                try {
                    await tx.$executeRawUnsafe(sql, ...params);
                    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT s`);
                } catch {
                    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s`);
                }
            };
            // The SET LOCAL needs superuser; on a non-superuser role it
            // fails and would poison the transaction without the savepoint.
            // If suppressed, the AuditLog immutability trigger still fires
            // and the AuditLog DELETE rolls back to its savepoint — the
            // remaining deletes still succeed, leaving AuditLog rows as
            // orphans (acceptable per the file-level docstring).
            await tryStmt(
                `SET LOCAL session_replication_role = 'replica'`,
            );
            for (const table of TENANT_CHILD_TABLES) {
                await tryStmt(
                    `DELETE FROM "${table}" WHERE "tenantId" = $1`,
                    entry.tenantId,
                );
            }
            // Tenant DELETE is intentionally NOT inside a savepoint —
            // a failure here means an unlisted child table still has
            // FK references. That's a real operational signal (the
            // TENANT_CHILD_TABLES list has drifted from the schema)
            // and should bubble up so the tracker file is kept and
            // the operator sees the failure.
            await tx.$executeRawUnsafe(
                `DELETE FROM "Tenant" WHERE id = $1`,
                entry.tenantId,
            );
        });

        // User cleanup — separate transaction. The user has memberships
        // in (potentially) multiple tenants if the same email was
        // re-used; the membership row was already deleted above.
        // Owner-user records created by createIsolatedTenant carry the
        // unique e2e.test domain so accidentally targeting a real
        // user is impossible.
        await prisma.user
            .delete({ where: { id: entry.ownerUserId } })
            .catch(() => undefined);

        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
        };
    }
}

export default async function globalTeardown(_config: FullConfig): Promise<void> {
    if (!existsSync(TRACKER_PATH)) {
        // Most CI runs that don't use the factory leave no file.
        // Nothing to do.
        return;
    }

    const raw = readFileSync(TRACKER_PATH, 'utf8');
    const entries: TenantTrackerEntry[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            entries.push(JSON.parse(trimmed) as TenantTrackerEntry);
        } catch {
            // Malformed line — log + skip.

            console.warn(
                `[global-teardown] skipping malformed tracker line: ${trimmed.slice(0, 120)}`,
            );
        }
    }

    if (entries.length === 0) {
        // Empty file — clean it up and exit.
        try {
            unlinkSync(TRACKER_PATH);
        } catch {
            /* best-effort */
        }
        return;
    }


    console.log(
        `[global-teardown] cleaning up ${entries.length} test tenant(s)…`,
    );

    // Prisma 7 — adapter is required for construction.
    const prisma = new PrismaClient({
        adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? '',
        }),
    });
    let deleted = 0;
    let failed = 0;
    const failures: string[] = [];

    try {
        await prisma.$connect();
        for (const entry of entries) {
            const r = await deleteTenant(prisma, entry);
            if (r.ok) {
                deleted++;
            } else {
                failed++;
                failures.push(`${entry.tenantSlug}: ${r.reason}`);
            }
        }
    } catch (err) {

        console.warn(
            `[global-teardown] DB connection failed (test DB is likely ephemeral): ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }


    console.log(
        `[global-teardown] cleanup complete: ${deleted} deleted, ${failed} failed`,
    );
    if (failures.length > 0) {

        console.warn('[global-teardown] failures:');
        for (const f of failures) {

            console.warn(`  - ${f}`);
        }
        // Leave the tracker file in place so the next run retries.
        return;
    }

    try {
        unlinkSync(TRACKER_PATH);
    } catch {
        /* best-effort */
    }
}
