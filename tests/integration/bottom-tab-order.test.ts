/**
 * `null` and `[]` survive a round-trip as DIFFERENT states.
 *
 * This is the assertion that needs a real database. The column is `Json?`, and
 * Prisma distinguishes `Prisma.DbNull` (the SQL NULL) from `Prisma.JsonNull`
 * (a JSON `null` value stored IN the column) — pick the wrong one and "never
 * chosen" comes back as a stored JSON null, which is neither an array nor
 * absent, and every consumer then has a third state nobody designed for.
 *
 * A unit test over the Zod schema cannot see any of that: it validates the
 * payload and never touches Postgres.
 *
 * Why the distinction matters at all: `null` means "never chosen, use the
 * default order" and `[]` means "deliberately cleared". A new user and a user
 * who emptied their bar want opposite behaviour, and collapsing them is
 * unrecoverable.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { updateOwnBottomTabOrder, parseBottomTabOrder } from '@/lib/account/bottom-tabs';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `bto-${randomUUID().slice(0, 8)}`;
let userId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userId = u.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', userId).catch(() => {});
    await prisma.$disconnect();
});

async function storedRaw(): Promise<unknown> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { bottomTabOrder: true },
    });
    return row?.bottomTabOrder;
}

describeFn('bottom tab order round-trips (DB)', () => {
    it('a fresh user has never chosen — SQL NULL, reads as null', () => {
        // Positive control for the states below: the default really is absent,
        // not an empty array, so "null means default" has something to mean.
        return expect(storedRaw()).resolves.toBeNull();
    });

    it('an arrangement round-trips IN ORDER', async () => {
        const order = ['/journal', '/dashboard', '/grain/contracts', '/exchange'];
        const res = await updateOwnBottomTabOrder(userId, order);
        expect(res.bottomTabOrder).toEqual(order);
        // Read back independently — the helper's own return value could be
        // echoing the input rather than the stored row.
        expect(parseBottomTabOrder(await storedRaw())).toEqual(order);
    });

    it('[] stores as an empty ARRAY, not as absent', async () => {
        await updateOwnBottomTabOrder(userId, []);
        const raw = await storedRaw();
        expect(Array.isArray(raw)).toBe(true);
        expect(raw).toEqual([]);
        expect(parseBottomTabOrder(raw)).toEqual([]);
    });

    it('null clears back to absent — and NOT to a JSON null', async () => {
        await updateOwnBottomTabOrder(userId, ['/dashboard']);
        await updateOwnBottomTabOrder(userId, null);
        const raw = await storedRaw();
        // `Prisma.JsonNull` would also read as `null` here through the client,
        // so assert the column is SQL NULL at the database.
        const [row] = await prisma.$queryRawUnsafe<Array<{ is_sql_null: boolean }>>(
            `SELECT "bottomTabOrder" IS NULL AS is_sql_null FROM "User" WHERE id = $1`,
            userId,
        );
        expect(row.is_sql_null).toBe(true);
        expect(parseBottomTabOrder(raw)).toBeNull();
    });

    it('the two states stay distinguishable across a full cycle', async () => {
        await updateOwnBottomTabOrder(userId, []);
        expect(parseBottomTabOrder(await storedRaw())).toEqual([]);
        await updateOwnBottomTabOrder(userId, null);
        expect(parseBottomTabOrder(await storedRaw())).toBeNull();
        await updateOwnBottomTabOrder(userId, []);
        expect(parseBottomTabOrder(await storedRaw())).toEqual([]);
    });
});
