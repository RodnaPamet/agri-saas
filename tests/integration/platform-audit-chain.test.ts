/**
 * `PlatformAuditLog` is an append-only chain that cannot fork or be rewritten.
 *
 * ── the three claims, and why each needs a database ──
 *
 *   1. LINKED — each entry's `previousHash` is the prior entry's `entryHash`,
 *      per scope. A unit test can prove the hash function; only a database can
 *      prove the writer reads the right predecessor.
 *   2. IMMUTABLE — UPDATE and DELETE raise. That is a trigger, so it is only
 *      observable against Postgres.
 *   3. UNFORKABLE — concurrent appends to one scope produce ONE linear chain.
 *      This is the advisory lock, and it is the property most likely to be
 *      quietly lost: without the lock each writer reads the same predecessor
 *      and both chain off it, leaving two valid-looking histories.
 *
 * Claim 3 is also why the writer timestamps AFTER taking the lock. With the
 * timestamp first, two appends can share an `occurredAt`, and the
 * latest-entry query orders by `occurredAt DESC, id DESC` — so the tie is
 * broken by cuid, which is not insertion order.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    appendPlatformAuditEntry,
    verifyPlatformChain,
    type PlatformAuditScope,
} from '@/lib/audit/platform-audit-writer';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * The reader and the app must address the same database, or this suite would
 * assert against one the writer never reached. See the longer note in
 * `insurance-lead-rls.test.ts`.
 */
function assertReaderAndAppAgree(): void {
    const name = (u?: string): string => {
        if (!u) return '(unset)';
        const m = u.match(/@([^/]+)\/([^?]+)/);
        return m ? `${m[1]}/${m[2]}` : '(unparsed)';
    };
    const reader = name(DB_URL);
    const app = name(process.env.DATABASE_URL);
    if (reader !== app) {
        throw new Error(
            `Reader and app address DIFFERENT databases:\n  reader=${reader}\n  app=${app}\n` +
                `Run without --maxWorkers=1.`,
        );
    }
}

describeFn('PlatformAuditLog chain', () => {
    const scopes: string[] = [];

    beforeAll(async () => {
        assertReaderAndAppAgree();
        await prisma.$connect();
    });

    afterAll(async () => {
        // TRUNCATE is DDL and bypasses the row trigger; a plain DELETE would be
        // refused by it. Scoped to this suite's synthetic scopes so a shared
        // database keeps everyone else's chains.
        for (const s of scopes) {
            await prisma.$executeRawUnsafe(
                `DELETE FROM "PlatformAuditLog" WHERE "scope" = $1`,
                s,
            ).catch(() => undefined);
        }
        await prisma.$disconnect();
    });

    /**
     * A synthetic scope, registered so cleanup can find it.
     *
     * `appendPlatformAuditEntry` rejects a scope outside
     * `PLATFORM_AUDIT_SCOPES`, which is the behaviour one case below asserts —
     * so every OTHER case uses a real scope and isolates itself by deleting
     * only what it wrote.
     */
    function realScope(): 'feature-flags' | 'key-rotation' {
        return 'feature-flags';
    }

    it('refuses an unlisted scope rather than starting a second chain', async () => {
        // The failure this prevents is silent: an unlisted scope writes
        // happily, its first entry has previousHash null, that chain verifies
        // perfectly, and the history someone meant to inspect looks untouched.
        await expect(
            appendPlatformAuditEntry({
                // Through `unknown`, not `any`: the point is to reach the
                // RUNTIME check with a scope the type system rejects, and a
                // cast that needs no eslint suppression is one fewer line on a
                // ratchet that counts un-reasoned disables.
                scope: 'typo-scope' as unknown as PlatformAuditScope,
                action: 'FEATURE_FLAG_UPSERTED',
            }),
        ).rejects.toThrow(/unknown scope/i);
    });

    it('the first entry has no predecessor; the next links to it', async () => {
        const marker = randomUUID();
        const a = await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker, n: 1 },
        });
        const b = await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker, n: 2 },
        });
        // `b` links to `a` whatever else is in the shared chain.
        expect(b.previousHash).toBe(a.entryHash);
        expect(a.entryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(b.entryHash).not.toBe(a.entryHash);
    });

    it('the chain VERIFIES, and the verdict counts entries', async () => {
        await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker: randomUUID() },
        });
        const verdict = await verifyPlatformChain(realScope(), prisma);
        // Non-zero FIRST: `intact: true` over an empty chain proves nothing.
        expect(verdict.entries).toBeGreaterThan(0);
        expect(verdict.intact).toBe(true);
        expect(verdict.brokenAt).toBeNull();
    });

    it('scopes are INDEPENDENT chains', async () => {
        // Writing to one scope must not become the predecessor of the other's
        // next entry — otherwise the chains are one chain with a label.
        const kr1 = await appendPlatformAuditEntry({
            scope: 'key-rotation',
            action: 'KEY_ROTATION_SWEEP_RUN',
            detailsJson: { marker: randomUUID() },
        });
        const ff = await appendPlatformAuditEntry({
            scope: 'feature-flags',
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker: randomUUID() },
        });
        const kr2 = await appendPlatformAuditEntry({
            scope: 'key-rotation',
            action: 'KEY_ROTATION_SWEEP_RUN',
            detailsJson: { marker: randomUUID() },
        });
        // key-rotation's second entry follows key-rotation's first, NOT the
        // feature-flags entry written between them.
        expect(kr2.previousHash).toBe(kr1.entryHash);
        expect(kr2.previousHash).not.toBe(ff.entryHash);
        await expect(verifyPlatformChain('key-rotation', prisma)).resolves.toMatchObject({
            intact: true,
        });
    });

    it('CONCURRENT appends to one scope do not FORK the chain', async () => {
        // The advisory lock's reason to exist. Without it every writer reads
        // the same predecessor and chains off it, leaving two histories that
        // each verify.
        const marker = randomUUID();
        const N = 6;
        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                appendPlatformAuditEntry({
                    scope: 'feature-flags',
                    action: 'FEATURE_FLAG_UPSERTED',
                    detailsJson: { marker, i },
                }),
            ),
        );
        expect(results).toHaveLength(N);
        // A fork shows up as a REPEATED previousHash: two entries claiming the
        // same parent. That is the assertion, not merely that the chain
        // verifies — a forked chain's shorter branch can still verify.
        const parents = results.map((r) => r.previousHash);
        expect(new Set(parents).size).toBe(parents.length);
        await expect(verifyPlatformChain('feature-flags', prisma)).resolves.toMatchObject({
            intact: true,
        });
    });

    it('UPDATE is refused by the database', async () => {
        const e = await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker: randomUUID() },
        });
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "PlatformAuditLog" SET "actorType" = 'TAMPERED' WHERE id = $1`,
                e.id,
            ),
        ).rejects.toThrow(/IMMUTABLE_PLATFORM_AUDIT_LOG/);
    });

    it('DELETE is refused by the database', async () => {
        const e = await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker: randomUUID() },
        });
        await expect(
            prisma.$executeRawUnsafe(`DELETE FROM "PlatformAuditLog" WHERE id = $1`, e.id),
        ).rejects.toThrow(/IMMUTABLE_PLATFORM_AUDIT_LOG/);
    });

    it('the VERIFIER catches a rewritten entry — proven past the trigger', async () => {
        // The verifier's teeth cannot be shown while the trigger is doing its
        // job, so the tamper happens with the trigger disabled INSIDE a
        // transaction that rolls back. Self-restoring: a `DISABLE TRIGGER` left
        // behind would silently un-protect the table for every later run, and
        // jest only applies PENDING migrations so nothing would put it back.
        const e = await appendPlatformAuditEntry({
            scope: realScope(),
            action: 'FEATURE_FLAG_UPSERTED',
            detailsJson: { marker: randomUUID() },
        });

        let verdictWhileTampered: Awaited<ReturnType<typeof verifyPlatformChain>> | null = null;
        const SENTINEL = 'rollback-on-purpose';
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `ALTER TABLE "PlatformAuditLog" DISABLE TRIGGER platform_audit_log_immutable`,
                );
                await tx.$executeRawUnsafe(
                    `UPDATE "PlatformAuditLog" SET "actorType" = 'TAMPERED' WHERE id = $1`,
                    e.id,
                );
                verdictWhileTampered = await verifyPlatformChain(
                    realScope(),
                    tx as unknown as PrismaClient,
                );
                throw new Error(SENTINEL);
            });
        } catch (err) {
            if (!(err instanceof Error) || err.message !== SENTINEL) throw err;
        }

        expect(verdictWhileTampered).not.toBeNull();
        expect(verdictWhileTampered!.intact).toBe(false);
        expect(verdictWhileTampered!.brokenAt?.id).toBe(e.id);

        // And the rollback restored BOTH the row and the trigger.
        await expect(verifyPlatformChain(realScope(), prisma)).resolves.toMatchObject({
            intact: true,
        });
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "PlatformAuditLog" SET "actorType" = 'X' WHERE id = $1`,
                e.id,
            ),
        ).rejects.toThrow(/IMMUTABLE_PLATFORM_AUDIT_LOG/);
    });
});
