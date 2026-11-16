/**
 * A thread whose other party cannot answer says so, neutrally — #2755.
 *
 * ## The gap, and why nothing failed
 *
 * #1655 built the deletion-grace freeze: `isDeletionPending` refuses the
 * LEAVING person at the mutation choke point, and their ACTIVE listings are
 * hidden. That delivers what the privacy notice promises — "stops being
 * visible to other farms straight away" — for NEW conversations.
 *
 * It did nothing for a thread already open. The counterparty kept sending and
 * the leaving person could not reply, so a negotiation became a one-way wall
 * for up to thirty days with no explanation. CLAUDE.md named the harm and then
 * tracked it at #1655, which is CLOSED — so the only thing tracking it was a
 * pointer at finished work.
 *
 * Owner ruling 2026-11-16: tell the counterparty NEUTRALLY and stop taking
 * messages into the thread. Not "hide it" (which destroys a live negotiation's
 * visibility for a paying counterparty — the harm #1325 declined to cause) and
 * not "say the account is closing" (which discloses a pending erasure to a
 * third party who was never party to it).
 *
 * ## What this suite is for
 *
 * The flag is COMPUTED from `deletionRequestedAt` per request, so the property
 * that matters is not "a flag can be set" but that **cancelling restores the
 * thread with nothing to put back**. A stored suppression column would need a
 * restore path; this needs none, and only a test that cancels can show it.
 *
 * It is DB-backed because the read runs on the caller's transaction against a
 * table with no RLS, and a mocked Prisma cannot express either fact.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { getExchangeThread, sendExchangeMessage } from '@/app-layer/usecases/exchange-messaging';
import { prisma } from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `cu-${randomUUID().slice(0, 8)}`;
let sellerTenant = '';
let buyerTenant = '';
let threadId = '';
let listingId = '';
const BUYER_USER = `u-cu-buyer-${randomUUID()}`;
const SELLER_USER = `u-cu-seller-${randomUUID()}`;
/** A seller-side principal with NO `User` row — the fail-direction control. */
const GHOST_SELLER = `u-cu-ghost-${randomUUID()}`;
let ghostThreadId = '';
let ghostListingId = '';

const ctxFor = (tenantId: string, userId: string) =>
    makeRequestContext('ADMIN', { tenantId, userId, requestId: `req-${userId}` });

/**
 * Set or clear the erasure request on one person.
 *
 * Through the EXTENDED client, like the creation below: `emailHash` is NOT NULL
 * in the database while the Prisma schema declares it optional, because the
 * pii-middleware derives it on every write that sets `email`. A bare client
 * carries no middleware, so it writes null and the insert is refused — the
 * divergence is deliberate and is why the sibling suites use `prisma` here.
 */
async function setDeletionPending(userId: string, at: Date | null): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: at } });
}

async function makeListingAndThread(
    sellerUserId: string,
): Promise<{ listingId: string; threadId: string }> {
    const lid = `xl-${randomUUID()}`;
    await raw.$executeRawUnsafe(
        `INSERT INTO "ExchangeListing"
           ("id","sellerTenantId","sellerUserId","side","kind","commodity","quantityTonnes",
            "priceCurrency","regionCode","regionName","lat","lon","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,'SELL','CULTURE','WHEAT',40,'BGN','BG-23','Sofia',42.70,23.32,'ACTIVE',NOW(),NOW())`,
        lid,
        sellerTenant,
        sellerUserId,
    );
    const tid = `xt-${randomUUID()}`;
    await raw.$executeRawUnsafe(
        `INSERT INTO "ExchangeThread"
           ("id","listingId","inquirerTenantId","inquirerUserId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,NOW(),NOW())`,
        tid,
        lid,
        buyerTenant,
        BUYER_USER,
    );
    return { listingId: lid, threadId: tid };
}

describeFn('#2755 — a counterparty who cannot answer', () => {
    beforeAll(async () => {
        await raw.$connect();
        const s = await raw.tenant.create({ data: { name: `${TAG}-seller`, slug: `${TAG}-s` } });
        const b = await raw.tenant.create({ data: { name: `${TAG}-buyer`, slug: `${TAG}-b` } });
        sellerTenant = s.id;
        buyerTenant = b.id;

        // REAL `User` rows, unlike the sibling exchange suites which use bare
        // id strings. `requireParty` reads `deletionRequestedAt` off this row,
        // so with no row the flag is always false and every assertion below
        // would pass for the wrong reason.
        for (const [id, email] of [
            [BUYER_USER, `${TAG}-buyer@example.test`],
            [SELLER_USER, `${TAG}-seller@example.test`],
        ] as const) {
            await prisma.user.create({
                data: { id, email, emailHash: hashForLookup(email), name: `${TAG} person` },
            });
        }

        ({ listingId, threadId } = await makeListingAndThread(SELLER_USER));
        ({ listingId: ghostListingId, threadId: ghostThreadId } =
            await makeListingAndThread(GHOST_SELLER));
    }, 120_000);

    afterAll(async () => {
        await raw.$executeRawUnsafe(`DELETE FROM "ExchangeMessage" WHERE "threadId" = ANY($1)`, [
            threadId,
            ghostThreadId,
        ]);
        await raw.$executeRawUnsafe(`DELETE FROM "ExchangeThread" WHERE id = ANY($1)`, [
            threadId,
            ghostThreadId,
        ]);
        await raw.$executeRawUnsafe(`DELETE FROM "ExchangeListing" WHERE id = ANY($1)`, [
            listingId,
            ghostListingId,
        ]);
        /*
         * The `User` and `Tenant` rows are LEFT, deliberately.
         *
         * 55 tables carry a foreign key to `User`, and a thread read writes a
         * pointer while a send writes a notification, so deleting the people
         * means finding every dependent first — and the first two attempts at
         * that failed, because the rows live in this worker's CLONE database
         * while an `information_schema` probe from outside jest reads the
         * BASE. The probe reported "no rows" for ids the suite had certainly
         * written, which is the reader/writer split, not an empty table.
         *
         * Leaving them costs nothing: `globalSetup` template-copies each
         * worker clone from the base per RUN, so nothing written here survives
         * into the next one. What is cleaned up below is only what would
         * otherwise be ambiguous while the run is still going.
         */
        await raw.$disconnect();
    }, 120_000);

    beforeEach(async () => {
        // Both available — every case sets what it needs, so a leaked flag
        // from a previous test cannot make a later one pass.
        await setDeletionPending(BUYER_USER, null);
        await setDeletionPending(SELLER_USER, null);
    });

    it('CONTROL — reports AVAILABLE and accepts a message when nobody is leaving', async () => {
        const view = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {});
        expect(view.counterpartyUnavailable).toBe(false);

        const sent = await sendExchangeMessage(ctxFor(buyerTenant, BUYER_USER), threadId, 'Имате ли налична пшеница?', randomUUID());
        expect(sent.id).toBeTruthy();
    }, 120_000);

    it('tells the WAITING party, and refuses the message', async () => {
        // The seller is leaving; the BUYER is the one mid-negotiation.
        await setDeletionPending(SELLER_USER, new Date());

        const view = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {});
        expect(view.counterpartyUnavailable).toBe(true);
        // The history is still READABLE — that is the whole difference between
        // this and the thread disappearing, which the owner declined.
        expect(Array.isArray(view.messages)).toBe(true);

        await expect(
            sendExchangeMessage(ctxFor(buyerTenant, BUYER_USER), threadId, 'Още сте ли там?', randomUUID()),
        ).rejects.toMatchObject({ code: 'THREAD_COUNTERPARTY_UNAVAILABLE' });
    }, 120_000);

    it('discloses NOTHING about the cause', async () => {
        // The disclosure rule, asserted on the observable rather than trusted
        // to the copy: a pending erasure is the leaving person's business, and
        // a moderation TERMINATION sets the same column, so naming either
        // would tell a third party something they are not party to.
        await setDeletionPending(SELLER_USER, new Date());

        const err = await sendExchangeMessage(
            ctxFor(buyerTenant, BUYER_USER),
            threadId,
            'Ало?',
            randomUUID(),
        ).catch((e: unknown) => e);
        // PIN THE CODE FIRST. Without it this test passes on ANY error, and it
        // did: with the arguments wrongly shaped as an options object the send
        // failed MESSAGE_EMPTY, that message names no cause either, and the
        // leak assertions below were green about a refusal that was not the
        // one under test. `a-probe-with-no-discriminating-power`.
        expect(err).toMatchObject({ code: 'THREAD_COUNTERPARTY_UNAVAILABLE' });

        const CAUSE_WORDS = [/delet/i, /eras/i, /suspend/i, /terminat/i, /изтрив/i, /закрив/i];

        // The REFUSAL is what the sender reads, so it carries no cause.
        const shown = JSON.stringify(err instanceof Error ? { m: err.message, ...err } : err);
        for (const leak of CAUSE_WORDS) expect(shown).not.toMatch(leak);

        // The PAYLOAD carries no lifecycle column and no cause word in any
        // string it returns.
        //
        // Scoped to keys and string VALUES rather than the whole JSON, because
        // a blanket scan is a false alarm here: every message carries
        // `deleted: false`, the per-message retraction flag, which predates
        // this and matches /delet/i. My first version asserted on the whole
        // document and failed on exactly that — a leak test that cries wolf on
        // an unrelated field is one somebody later deletes.
        const view = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {});
        const keys = new Set<string>();
        const strings: string[] = [];
        (function walk(node: unknown): void {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (node && typeof node === 'object') {
                for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
                return;
            }
            if (typeof node === 'string') strings.push(node);
        })(view);

        for (const col of [
            'deletionRequestedAt',
            'suspendedAt',
            'terminatedAt',
            'pseudonymisedAt',
        ]) {
            expect([...keys]).not.toContain(col);
        }
        for (const value of strings) {
            for (const leak of CAUSE_WORDS) expect(value).not.toMatch(leak);
        }
        // Control on the walker: it really did look at something. An empty
        // crawl satisfies every negation above.
        expect(keys.size).toBeGreaterThan(8);
        expect(strings.length).toBeGreaterThan(2);
    }, 120_000);

    it('RESTORES on cancel, with nothing to put back', async () => {
        // The property the computed design exists for. A stored suppression
        // column would need a restore path and a test that it fires; this
        // needs neither, and only cancelling can show that.
        await setDeletionPending(SELLER_USER, new Date());
        expect(
            (await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {}))
                .counterpartyUnavailable,
        ).toBe(true);

        await setDeletionPending(SELLER_USER, null);

        const after = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {});
        expect(after.counterpartyUnavailable).toBe(false);
        // And the thread takes messages again on the very next request — no
        // sweep, no restore job, no window.
        const sent = await sendExchangeMessage(ctxFor(buyerTenant, BUYER_USER), threadId, 'Добре, продължаваме.', randomUUID());
        expect(sent.id).toBeTruthy();
    }, 120_000);

    it('is about the OTHER party — the leaving person sees their counterparty as available', async () => {
        // Asymmetric on purpose. The person who asked to be erased is refused
        // by the grace-period mutation gate (#1655), a different refusal with
        // a different code. Reporting their own state back to them here would
        // make the two gates look like one.
        await setDeletionPending(BUYER_USER, new Date());

        const sellerView = await getExchangeThread(ctxFor(sellerTenant, SELLER_USER), threadId, {});
        expect(sellerView.counterpartyUnavailable).toBe(true);

        const buyerView = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), threadId, {});
        expect(buyerView.counterpartyUnavailable).toBe(false);
    }, 120_000);

    it('CONTROL — a missing User row reads as AVAILABLE, never as frozen', async () => {
        // The fail direction, stated and pinned. `isDeletionPending` takes the
        // same reading for an absent user: an erased account meets the
        // refusals its caller already handles, and freezing a live negotiation
        // because a lookup found nothing is the one direction that costs
        // somebody a deal.
        const view = await getExchangeThread(ctxFor(buyerTenant, BUYER_USER), ghostThreadId, {});
        expect(view.counterpartyUnavailable).toBe(false);
    }, 120_000);
});
