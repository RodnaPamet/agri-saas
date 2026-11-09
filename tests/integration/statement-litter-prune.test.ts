/**
 * The base-DB prune of undrainable `StatementOfReasons` rows — #2574.
 *
 * ## Why this needs a behavioural test and not a guard
 *
 * The prune is a `DELETE` with two conditions, and getting either wrong is
 * silent in opposite directions: drop `deliveredAt IS NULL` and it starts
 * destroying DELIVERED statements, which are the record that an Art 17
 * obligation was met; drop the `NOT EXISTS` and it destroys live, drainable
 * rows — a real compliance gap tidied away, which is the one outcome the
 * dispatch's own skip-and-leave behaviour exists to prevent.
 *
 * So the three cases below are a partition, not a happy path plus edges, and
 * each is mutation-proved against the clause it covers:
 *
 *     orphan + undelivered  -> DELETED   (the litter)
 *     live   + undelivered  -> KEPT      (a real queue entry)
 *     orphan + DELIVERED    -> KEPT      (history; not the queue at all)
 *
 * A test of only the first case passes just as happily against
 * `DELETE FROM "StatementOfReasons"`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { encryptField, hashForLookup } from '@/lib/security/encryption';

import { pruneUndrainableStatements } from '../setup/globalSetup';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** Everything this suite mints, so cleanup is by id and never by shape. */
const statements: string[] = [];
const users: string[] = [];

const tag = `litter-${randomUUID().slice(0, 8)}`;

describeFn('undrainable statement litter is pruned from the base DB (#2574)', () => {
    let liveUserId: string;
    let orphanUndelivered: string;
    let orphanDelivered: string;
    let liveUndelivered: string;

    beforeAll(async () => {
        await globalPrisma.$connect();

        liveUserId = `u-${tag}`;
        users.push(liveUserId);
        // `emailEncrypted`, not `email` — the column is encrypted at rest and
        // this raw insert bypasses the client extension that would do it, so
        // the value is encrypted explicitly. Same shape as p5-4b's seeder.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "User" ("id", "emailEncrypted", "emailHash", "updatedAt")
             VALUES ($1, $2, $3, NOW())`,
            liveUserId, encryptField(`${tag}@example.test`), hashForLookup(`${tag}@example.test`),
        );

        const mint = async (recipientUserId: string, delivered: boolean) => {
            const id = `sor-${tag}-${randomUUID().slice(0, 8)}`;
            statements.push(id);
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "StatementOfReasons"
                   (id, "createdAt", "actionId", "recipientUserId", locale, "bodyRendered", "deliveredAt")
                 VALUES ($1, now(), $2, $3, 'bg', $4, ${delivered ? 'now()' : 'NULL'})`,
                id, `ma-${tag}`, recipientUserId, 'v1:fixture',
            );
            return id;
        };

        // A recipient that does not exist, and deliberately never will.
        const ghost = `u-${tag}-ghost`;
        orphanUndelivered = await mint(ghost, false);
        orphanDelivered = await mint(ghost, true);
        liveUndelivered = await mint(liveUserId, false);
    });

    afterAll(async () => {
        if (statements.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "StatementOfReasons" WHERE id = ANY($1::text[])`, statements);
        }
        if (users.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "User" WHERE id = ANY($1::text[])`, users);
        }
        await globalPrisma.$disconnect();
    });

    it('deletes the orphaned undelivered row, and spares the other two', async () => {
        // CONTROL FIRST: all three exist, so the absences below are the prune
        // working rather than a fixture that never inserted.
        const before = await globalPrisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "StatementOfReasons" WHERE id = ANY($1::text[])`, statements);
        expect(before.map((r) => r.id).sort()).toEqual([...statements].sort());

        await pruneUndrainableStatements(DB_URL);

        const after = await globalPrisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "StatementOfReasons" WHERE id = ANY($1::text[])`, statements);
        const left = new Set(after.map((r) => r.id));

        // The litter: no recipient, never delivered, can never drain.
        expect(left.has(orphanUndelivered)).toBe(false);
        // A real queue entry — deleting this would tidy away a compliance gap.
        expect(left.has(liveUndelivered)).toBe(true);
        // Already delivered: history, and not in the queue the dispatch reads.
        expect(left.has(orphanDelivered)).toBe(true);
    });

    it('is idempotent — a second run deletes nothing more', async () => {
        // The prune runs on EVERY jest invocation, so a second pass must be a
        // no-op rather than progressively eating the rows it spared.
        await pruneUndrainableStatements(DB_URL);
        const after = await globalPrisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "StatementOfReasons" WHERE id = ANY($1::text[])`, statements);
        expect(after.map((r) => r.id).sort()).toEqual([liveUndelivered, orphanDelivered].sort());
    });
});
