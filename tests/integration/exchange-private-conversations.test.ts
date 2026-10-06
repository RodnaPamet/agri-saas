/**
 * An exchange conversation is private to PEOPLE, not shared by the farm. (#1298)
 *
 * ## What this proves, and why the proof has to be behavioural
 *
 * Found by the P0.9 two-phone test: a second user invited to a farm could read
 * and use that farm's conversation with another farm, including what the first
 * user had written. That was BY DESIGN — a thread's parties were TENANTS, and
 * `app.tenant_id` cannot tell two members of one farm apart.
 *
 * The enforcement is RLS keyed on a new `app.actor_user_id`, so the only honest
 * test is one that drives the real usecase as DIFFERENT PEOPLE at the same farm
 * and checks what each of them can see. A source-text guard could assert the
 * policy exists and say nothing about whether a colleague is refused.
 *
 * ## The audience, per the owner's rulings
 *
 *   - buyer side:  the person who OPENED the thread, plus that farm's OWNER/ADMIN
 *   - seller side: the person who CREATED the listing, plus that farm's OWNER/ADMIN
 *
 * The admins are in it so a farm can still answer when the principal is away or
 * has left. Anyone else gets a 404 rather than a 403: the row is invisible at
 * the database level, and the distinction would leak that a colleague is in a
 * conversation.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    openExchangeThread,
    getExchangeThread,
    sendExchangeMessage,
    markExchangeThreadRead,
    listExchangeThreads,
} from '@/app-layer/usecases/exchange-messaging';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SELLER_T = `t-pc-seller-${randomUUID()}`;
const BUYER_T = `t-pc-buyer-${randomUUID()}`;

// Four people. The two principals, one admin who is NOT a principal, and the
// one this issue is about: a colleague with a working membership who is in
// neither role.
const U_CREATOR = `u-pc-creator-${randomUUID()}`;
const U_SELLER_ADMIN = `u-pc-sadmin-${randomUUID()}`;
const U_OPENER = `u-pc-opener-${randomUUID()}`;
const U_BUYER_COLLEAGUE = `u-pc-colleague-${randomUUID()}`;
const U_BUYER_ADMIN = `u-pc-badmin-${randomUUID()}`;

/**
 * Real `User` rows, because `AuditLog.userId` is a foreign key to them.
 * Attributing a write to an id with no user makes every audit append fail with
 * `23503` — the suite still passes, and then cannot assert anything about audit
 * output. That is #1286, and it is cheap not to repeat.
 */
async function makeUser(id: string, tenantId: string, role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    await globalPrisma.user.create({
        data: {
            id,
            email: `${id}@example.test`,
            // NOT NULL in the schema while Prisma types it optional.
            emailHash: `hash-${id}`,
            name: id,
        },
    });
    await globalPrisma.tenantMembership.create({
        data: { id: `tm-${id}`, tenantId, userId: id, role, status: 'ACTIVE' },
    });
}

function ctxFor(userId: string, tenantId: string, role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    return makeRequestContext(role, { userId, tenantId, requestId: `req-${userId}` });
}

let listingId = '';

describeFn('exchange conversations are private to people (#1298)', () => {
    beforeAll(async () => {
        for (const t of [SELLER_T, BUYER_T]) {
            await globalPrisma.tenant.create({
                data: { id: t, name: t, slug: t },
            });
        }
        await makeUser(U_CREATOR, SELLER_T, 'EDITOR');
        await makeUser(U_SELLER_ADMIN, SELLER_T, 'ADMIN');
        await makeUser(U_OPENER, BUYER_T, 'EDITOR');
        await makeUser(U_BUYER_COLLEAGUE, BUYER_T, 'EDITOR');
        await makeUser(U_BUYER_ADMIN, BUYER_T, 'OWNER');

        listingId = `exl-pc-${randomUUID()}`;
        await globalPrisma.exchangeListing.create({
            data: {
                id: listingId,
                sellerTenantId: SELLER_T,
                // The listing's CREATOR is the seller-side principal.
                sellerUserId: U_CREATOR,
                side: 'SELL',
                commodity: 'Wheat',
                quantityTonnes: 25,
                regionCode: 'BG-16',
                regionName: 'Plovdiv',
                lat: 42.15,
                lon: 24.75,
            },
        });
    }, 120_000);

    afterAll(async () => {
        await globalPrisma.$disconnect();
    });

    it('control: the opener can open a thread, send, and read it back', async () => {
        // Without this the 404s below could be a broken fixture rather than a
        // working policy — every later assertion is about someone NOT seeing
        // what this test proves is there.
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const { id: threadId, created } = await openExchangeThread(opener, listingId);
        expect(created).toBe(true);

        await sendExchangeMessage(opener, threadId, 'is it still available');

        const seen = await getExchangeThread(opener, threadId, {});
        expect(seen.messages).toHaveLength(1);
        expect(seen.messages[0].mine).toBe(true);
        expect(seen.messages[0].fromMyFarm).toBe(false);
    }, 60_000);

    it('THE REGRESSION: a colleague at the buyer farm cannot see the thread at all', async () => {
        // The two-phone finding, as an assertion. `U_BUYER_COLLEAGUE` has an
        // ACTIVE membership at the same farm as the opener and is neither the
        // principal nor an admin.
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const { id: threadId } = await openExchangeThread(opener, listingId);

        const colleague = ctxFor(U_BUYER_COLLEAGUE, BUYER_T, 'EDITOR');
        await expect(getExchangeThread(colleague, threadId, {})).rejects.toThrow(
            /not found/i,
        );

        // ...and it is absent from their inbox, not merely unopenable. A 404 on
        // the detail route with the row still listed would leak its existence.
        const inbox = await listExchangeThreads(colleague, {});
        expect(inbox.threads.map((t) => t.id)).not.toContain(threadId);
    }, 60_000);

    it('an OWNER/ADMIN of the buyer farm CAN see it — the farm can still answer', async () => {
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const { id: threadId } = await openExchangeThread(opener, listingId);

        const admin = ctxFor(U_BUYER_ADMIN, BUYER_T, 'OWNER');
        const seen = await getExchangeThread(admin, threadId, {});
        expect(seen.id).toBe(threadId);
        // The opener's message is NOT the admin's own, and the admin needs to
        // know it came from their own farm so the bubble can name the speaker.
        const first = seen.messages[0];
        expect(first.mine).toBe(false);
        expect(first.fromMyFarm).toBe(true);
    }, 60_000);

    it('the seller-side principal is the listing CREATOR, and their admin sees it too', async () => {
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const { id: threadId } = await openExchangeThread(opener, listingId);

        const creator = ctxFor(U_CREATOR, SELLER_T, 'EDITOR');
        expect((await getExchangeThread(creator, threadId, {})).id).toBe(threadId);

        const sellerAdmin = ctxFor(U_SELLER_ADMIN, SELLER_T, 'ADMIN');
        expect((await getExchangeThread(sellerAdmin, threadId, {})).id).toBe(threadId);
    }, 60_000);

    it('read state is PER PERSON — an admin reading does not clear the opener badge', async () => {
        // The other half of the two-phone finding: the pointers used to be one
        // column per SIDE, so any member reading marked it read for all of them.
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const { id: threadId } = await openExchangeThread(opener, listingId);

        // The seller answers, so both buyer-side people have something unread.
        const creator = ctxFor(U_CREATOR, SELLER_T, 'EDITOR');
        await sendExchangeMessage(creator, threadId, 'yes, still available');

        const admin = ctxFor(U_BUYER_ADMIN, BUYER_T, 'OWNER');
        expect((await getExchangeThread(admin, threadId, {})).unreadCount).toBeGreaterThan(0);
        await markExchangeThreadRead(admin, threadId);
        expect((await getExchangeThread(admin, threadId, {})).unreadCount).toBe(0);

        // THE ASSERTION. The opener never read it, so their count must stand.
        expect((await getExchangeThread(opener, threadId, {})).unreadCount).toBeGreaterThan(0);
    }, 90_000);

    it('identity is per PERSON: two colleagues on one listing get TWO threads', async () => {
        // `@@unique([listingId, inquirerUserId])`. Under the old key the second
        // colleague was handed the first one's thread — which, with per-person
        // visibility, is a thread they are not in the audience for.
        const opener = ctxFor(U_OPENER, BUYER_T, 'EDITOR');
        const first = await openExchangeThread(opener, listingId);

        // The admin is in the opener's audience, but opening their OWN thread
        // must give them a different conversation, not join that one.
        const admin = ctxFor(U_BUYER_ADMIN, BUYER_T, 'OWNER');
        const second = await openExchangeThread(admin, listingId);

        expect(second.id).not.toBe(first.id);
        expect(second.created).toBe(true);

        // ...and re-opening is still idempotent PER PERSON.
        const again = await openExchangeThread(admin, listingId);
        expect(again.id).toBe(second.id);
        expect(again.created).toBe(false);
    }, 90_000);
});
