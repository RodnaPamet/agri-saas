/**
 * Does a Prisma 7 `$extends({ query })` handler run inside the
 * AsyncLocalStorage chain, or detached from it?
 *
 * ## Why this test exists, and why it is not a guard
 *
 * Two design decisions in this repo rest on the answer, and both cite a
 * statement about Prisma **5**:
 *
 *   - `src/lib/audit-context.ts` keeps a MODULE-LEVEL context stack instead of
 *     ALS, under the reason "Prisma's $use middleware runs in a detached async
 *     context that loses ALS state". `$use` was removed in Prisma 7; the audit
 *     trail now runs as a `$extends({ query })` extension.
 *   - `src/lib/prisma.ts`'s audit extension captures the context before
 *     `query()` because "Prisma's underlying execution may detach from the
 *     AsyncLocalStorage chain".
 *
 * Whether that is still true decides whether the remaining half of #1223 (the
 * `appendAuditEntry` second connection) can be moved onto the `afterCommit`
 * collector, which is addressed through ALS — and it bears on the audit
 * MISATTRIBUTION the module-level stack causes under concurrency (#1259),
 * because if ALS reaches an extension then the stack has no remaining excuse.
 *
 * **Measured 2026-10-02: a Prisma 7 query extension DOES see the ALS store.**
 * The documented detachment does not hold for the `$extends` API. That is a
 * statement about an installed DEPENDENCY, so a guard asserting source text
 * could not make it and this is the right shape — and per the repo's own rule,
 * a dependency whose behaviour a design rests on needs a path that runs the
 * real thing, or a major bump can silently invert it.
 *
 * ## The observable
 *
 * `afterCommit` is a perfect detector because its two branches are visible
 * from outside: with an ALS scope it QUEUES the effect until the outermost
 * transaction has committed, and with no scope it fires the effect INLINE
 * (documented in `src/lib/db/after-commit.ts`). So the position of the effect
 * in the timeline is the answer — no need to reach inside the module.
 *
 * Detached would put `effect:from-extension` immediately after
 * `extension:enter`. Attached puts it after `callback:done`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { withTenantDb } from '@/lib/db-context';
import { afterCommit } from '@/lib/db/after-commit';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { DB_URL, DB_AVAILABLE } from './db-helper';

/** Bare client for fixtures — no audit extension, so setup writes no AuditLog. */
const fixturePrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const TENANT = `t-als-${suffix}`;

/** Ordered record of what happened, so "before" and "after" are readable. */
let timeline: string[] = [];

/**
 * A client whose query extension calls `afterCommit` from the same position
 * the audit extension occupies: inside a `$allModels` handler, during a
 * `tx.<model>.<op>()` issued from a transaction callback.
 */
function clientWithProbeExtension(): PrismaClient {
    const base = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DB_URL }),
    });
    return base.$extends({
        name: 'als-reachability-probe',
        query: {
            $allModels: {
                async findFirst({
                    args,
                    query,
                }: {
                    args: unknown;
                    query: (a: unknown) => Promise<unknown>;
                }) {
                    timeline.push('extension:enter');
                    afterCommit('probe-from-extension', () => {
                        timeline.push('effect:from-extension');
                    });
                    const result = await query(args);
                    timeline.push('extension:exit');
                    return result;
                },
            },
        },
    }) as unknown as PrismaClient;
}

describeFn('ALS reachability from a Prisma 7 query extension', () => {
    beforeAll(async () => {
        await fixturePrisma.tenant.create({
            data: {
                id: TENANT,
                name: TENANT,
                slug: TENANT,
                encryptedDek: generateAndWrapDek().wrapped,
            },
        });
    }, 60_000);

    afterAll(async () => {
        await fixturePrisma.tenant.deleteMany({ where: { id: TENANT } });
        await fixturePrisma.$disconnect();
    }, 60_000);

    test(
        'positive control — afterCommit from the transaction CALLBACK defers',
        async () => {
            timeline = [];
            await withTenantDb(TENANT, async (tx) => {
                afterCommit('probe-from-callback', () => {
                    timeline.push('effect:from-callback');
                });
                timeline.push('callback:done');
                await tx.$queryRaw`SELECT 1`;
            });
            // Without this control, the extension result below is unreadable:
            // an `afterCommit` that deferred for everyone would look like
            // evidence about extensions specifically.
            expect(timeline).toEqual(['callback:done', 'effect:from-callback']);
        },
        120_000,
    );

    test(
        'a query extension sees the ALS store — the effect DEFERS, it does not fire inline',
        async () => {
            timeline = [];
            const client = clientWithProbeExtension();
            try {
                await withTenantDb(
                    TENANT,
                    async (tx) => {
                        await tx.task.findFirst({ where: { status: 'OPEN' } });
                        timeline.push('callback:done');
                    },
                    client,
                );
            } finally {
                await client.$disconnect();
            }

            // The whole assertion in one line, so a regression prints the
            // actual ordering rather than a bare boolean. A DETACHED extension
            // would put `effect:from-extension` at index 1.
            expect(timeline).toEqual([
                'extension:enter',
                'extension:exit',
                'callback:done',
                'effect:from-extension',
            ]);
        },
        120_000,
    );
});
