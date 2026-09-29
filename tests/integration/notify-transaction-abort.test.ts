/**
 * A caught P2002 does NOT un-abort a Postgres transaction.
 *
 * `notifyOtherParty` (exchange-messaging.ts) writes the bell rows and then
 * enqueues the email INSIDE ONE `withTenantDb`, which is
 * `prisma.$transaction`. `enqueueEmail` catches Prisma's P2002 on the unique
 * `dedupeKey` and returns null — which reads, in JavaScript, as "duplicate
 * skipped, carry on".
 *
 * Postgres disagrees. A statement error puts the transaction in an ABORTED
 * state: every later statement fails with 25P02 and the COMMIT becomes a
 * ROLLBACK. Catching the error in the client does not clear that; only a
 * SAVEPOINT taken BEFORE the failing statement can, and there is no SAVEPOINT
 * anywhere in `src/` or `prisma/`.
 *
 * The consequence is specific and bad: `buildDedupeKey` ends in the UTC DAY,
 * so from the SECOND message of a thread to a given address on a given day
 * the outbox INSERT collides — and the bell rows written earlier in the same
 * transaction are rolled back with it. #1102 made the bell deliberately
 * NOT deduped so that a live negotiation keeps notifying; this silently
 * undoes exactly that, on exactly the messages it was built for.
 *
 * Reported as INFERRED by the iOS side. This file EXECUTES it, because
 * "probably aborts" and "aborts" are different claims and only one of them
 * justifies a fix.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('a caught unique-violation aborts the whole transaction', () => {
    let prisma: PrismaClient;
    let tenantId: string;

    beforeAll(async () => {
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
        const t = await prisma.tenant.create({
            data: { name: `tx-abort-${randomUUID().slice(0, 8)}`, slug: `tx-abort-${randomUUID().slice(0, 8)}` },
        });
        tenantId = t.id;
    });

    afterAll(async () => {
        await prisma.notificationOutbox.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
        await prisma.$disconnect();
    });

    it('rolls back a row written BEFORE the caught duplicate', async () => {
        const dupKey = `dup-${randomUUID()}`;
        const survivorKey = `survivor-${randomUUID()}`;

        // Seed the row whose key the transaction will collide with.
        await prisma.notificationOutbox.create({
            data: {
                tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'a@example.test',
                subject: 's', bodyText: 'b', dedupeKey: dupKey,
            },
        });

        // Now: one transaction that writes a row, then hits the duplicate and
        // CATCHES it — exactly the shape `notifyOtherParty` has.
        let caught = false;
        let txThrew: string | null = null;
        try {
            await withTenantDb(tenantId, async (db) => {
                // (1) the "bell row" — written first, must survive if the
                //     catch really means "carry on"
                await db.notificationOutbox.create({
                    data: {
                        tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'b@example.test',
                        subject: 'survivor', bodyText: 'b', dedupeKey: survivorKey,
                    },
                });

                // (2) the duplicate, caught exactly as `enqueueEmail` catches it
                try {
                    await db.notificationOutbox.create({
                        data: {
                            tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'a@example.test',
                            subject: 's', bodyText: 'b', dedupeKey: dupKey,
                        },
                    });
                } catch {
                    caught = true; // "duplicate — skip silently"
                }
            }, prisma);
        } catch (e) {
            txThrew = e instanceof Error ? e.message.slice(0, 120) : String(e);
        }

        // The catch ran, so in JS terms this looked like a clean skip.
        expect(caught).toBe(true);

        const survivor = await prisma.notificationOutbox.findUnique({
            where: { dedupeKey: survivorKey },
        });

        // THE PLATFORM FACT, pinned so nobody folds these back together.
        //
        // The row is GONE, and note `txThrew` is 'no': the transaction did not
        // even raise. In JavaScript this is indistinguishable from a clean
        // "duplicate skipped, carry on", which is exactly why the bug survived
        // review — the code reads correctly and Postgres disagrees silently.
        // eslint-disable-next-line no-console
        console.log(
            `[measured] caught=${caught} txThrew=${txThrew ?? 'no'} survivorRow=${survivor ? 'KEPT' : 'ROLLED BACK'}`,
        );
        expect(survivor).toBeNull();
    });

    it('SEPARATE transactions: the first write survives the second duplicate', () => {
        // The shape `notifyOtherParty` uses now. Same two writes, same caught
        // duplicate, different transactions — and the first row lives.
        //
        // This is the assertion that would fail if someone moved the email
        // enqueue back inside the bell's transaction to "save a round trip".
        return (async () => {
            const dupKey = `dup2-${randomUUID()}`;
            const survivorKey = `survivor2-${randomUUID()}`;

            await prisma.notificationOutbox.create({
                data: {
                    tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'c@example.test',
                    subject: 's', bodyText: 'b', dedupeKey: dupKey,
                },
            });

            // tx1 — the durable one.
            await withTenantDb(tenantId, async (db) => {
                await db.notificationOutbox.create({
                    data: {
                        tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'd@example.test',
                        subject: 'survivor2', bodyText: 'b', dedupeKey: survivorKey,
                    },
                });
            }, prisma);

            // tx2 — may abort, and takes nothing with it.
            let caught = false;
            try {
                await withTenantDb(tenantId, async (db) => {
                    await db.notificationOutbox.create({
                        data: {
                            tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'c@example.test',
                            subject: 's', bodyText: 'b', dedupeKey: dupKey,
                        },
                    });
                }, prisma);
            } catch {
                caught = true;
            }

            expect(caught).toBe(true);
            expect(
                await prisma.notificationOutbox.findUnique({ where: { dedupeKey: survivorKey } }),
            ).not.toBeNull();
        })();
    });
});
