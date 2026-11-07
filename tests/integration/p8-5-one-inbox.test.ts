/**
 * P8.5 (#2799) — one inbox, DMs and Борса deals in a single ordered list.
 *
 * ## What this suite has to be able to catch
 *
 * Two bugs were in the first draft of `listInbox` and were found by reading it
 * back, not by running it. This file exists so the next two are found by
 * running it:
 *
 *   1. **`none: { userId: { notIn: blockers } }`** instead of `{ in: … }`.
 *      That excludes every conversation having any participant who is not a
 *      blocker — which includes the caller — so the DM half went EMPTY the
 *      moment one block existed. An empty list is indistinguishable from
 *      having no conversations, which is why the blocking cases below assert a
 *      non-blocked row is PRESENT in the same breath.
 *
 *   2. **`...before` and a sibling `OR` in one object literal.**
 *      `keysetBefore` returns `{ OR: [...] }`, so the party clause silently
 *      replaced the cursor and every page returned page one. Only a test that
 *      pages across a MERGE catches it: a single-source page-two test passes,
 *      because each source's own order is intact.
 *
 * ## Privileged read, so the `where` IS the control
 *
 * `listInbox` runs on the privileged client — the exchange audience keys on
 * `app.actor_user_id`, the DM policies on `app.user_id`, and no single context
 * satisfies both. P5.6a's warning applies verbatim: here a dropped clause
 * exports the database rather than being caught by RLS. So every read below
 * asserts a SECOND person's rows are ABSENT.
 */
import { randomUUID } from 'crypto';

import prisma from '@/lib/prisma';
import type { UserContext } from '@/app-layer/types';
import { listInbox } from '@/app-layer/usecases/inbox';

import { DB_AVAILABLE } from './db-helper';
import { hardDeleteTenants } from '../helpers/db';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);
const TENANT = `t-inbox-${SFX}`;
const TENANT_B = `t-inbox-b-${SFX}`;
const ME = `u-inbox-me-${SFX}`;
const PEER = `u-inbox-peer-${SFX}`;
const STRANGER = `u-inbox-stranger-${SFX}`;
const BLOCKER = `u-inbox-blocker-${SFX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** A DM conversation with one message, at a chosen instant. */
async function makeDm(
    a: string,
    b: string,
    at: Date,
    state: 'REQUEST' | 'ACCEPTED' = 'ACCEPTED',
    initiatedBy = a,
): Promise<string> {
    const c = await prisma.conversation.create({
        data: {
            state,
            initiatedByUserId: initiatedBy,
            lastMessageAt: at,
            participants: { create: [{ userId: a }, { userId: b }] },
        },
        select: { id: true },
    });
    await prisma.directMessage.create({
        data: { conversationId: c.id, senderUserId: initiatedBy, body: `тест ${SFX}`, createdAt: at },
    });
    return c.id;
}

/**
 * An exchange thread with the caller as a party, at a chosen instant.
 *
 * Without these the suite tests ONE source and asserts things about the other
 * over an empty array — `an exchange row reports NULL` would pass vacuously,
 * and the merge itself, which is the whole point of P8.5, would never run.
 * A second farm is needed because a thread's inquirer and its listing's seller
 * are different farms.
 */
async function makeExchangeThread(
    opts: { sellerUserId: string; sellerTenantId: string; inquirerUserId: string; inquirerTenantId: string; at: Date },
): Promise<string> {
    const listing = await prisma.exchangeListing.create({
        data: {
            sellerTenantId: opts.sellerTenantId,
            sellerUserId: opts.sellerUserId,
            side: 'SELL',
            commodity: 'Пшеница',
            quantityTonnes: '25.5',
            regionCode: 'BG-21',
            regionName: 'Велико Търново',
            lat: 43.08,
            lon: 25.63,
        },
        select: { id: true },
    });
    const thread = await prisma.exchangeThread.create({
        data: {
            listingId: listing.id,
            inquirerTenantId: opts.inquirerTenantId,
            inquirerUserId: opts.inquirerUserId,
            lastMessageAt: opts.at,
        },
        select: { id: true },
    });
    return thread.id;
}

describeFn('P8.5 — one inbox (#2799)', () => {
    const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

    beforeAll(async () => {
        await prisma.tenant.create({
            data: { id: TENANT, name: `Inbox ${SFX}`, slug: `inbox-${SFX}` },
        });
        await prisma.tenant.create({
            data: { id: TENANT_B, name: `Inbox B ${SFX}`, slug: `inbox-b-${SFX}` },
        });
        for (const id of [ME, PEER, STRANGER, BLOCKER]) {
            await prisma.user.create({ data: { id, email: `${id}@example.test`, name: id } });
        }
        await prisma.tenantMembership.create({
            data: { id: `tm-${SFX}`, tenantId: TENANT, userId: ME, role: 'OWNER', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { id: `tmb-${SFX}`, tenantId: TENANT_B, userId: PEER, role: 'OWNER', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        const convs = await prisma.conversation.findMany({
            where: { participants: { some: { userId: { in: [ME, PEER, STRANGER, BLOCKER] } } } },
            select: { id: true },
        });
        if (convs.length > 0) {
            await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } });
        }
        await prisma.userBlock.deleteMany({
            where: { OR: [{ blockerUserId: { in: [ME, PEER, STRANGER, BLOCKER] } }, { blockedUserId: { in: [ME, PEER, STRANGER, BLOCKER] } }] },
        });
        await prisma.exchangeThread.deleteMany({
            where: { OR: [{ inquirerUserId: { in: [ME, PEER, STRANGER, BLOCKER] } }, { listing: { sellerUserId: { in: [ME, PEER, STRANGER, BLOCKER] } } }] },
        });
        await prisma.exchangeListing.deleteMany({
            where: { sellerUserId: { in: [ME, PEER, STRANGER, BLOCKER] } },
        });
        await hardDeleteTenants(prisma as never, [TENANT, TENANT_B]);
        await prisma.user.deleteMany({ where: { id: { in: [ME, PEER, STRANGER, BLOCKER] } } });
    });

    describe('what the caller sees, and what they must not', () => {
        it('shows a DM the caller is in — the positive control every ZERO below needs', async () => {
            const id = await makeDm(ME, PEER, t(5));
            const page = await listInbox(ctxFor(ME));
            expect(page.items.map((i) => i.id)).toContain(id);
            expect(page.items.find((i) => i.id === id)?.source).toBe('dm');
        });

        it('does NOT show a conversation between two other people', async () => {
            // The privileged-read control. This function sees every row in the
            // table; the `where` is the only thing withholding it.
            const theirs = await makeDm(PEER, STRANGER, t(4));
            const page = await listInbox(ctxFor(ME));
            expect(page.items.map((i) => i.id)).not.toContain(theirs);
        });

        it('hides a conversation whose counterparty blocked the caller, and KEEPS the others', async () => {
            // Both halves in one test on purpose. The first draft's `notIn`
            // emptied the entire list, which would satisfy "the blocked row is
            // absent" perfectly — so the assertion that an innocent row
            // survives is what gives this teeth.
            const innocent = await makeDm(ME, PEER, t(3));
            const blocked = await makeDm(ME, BLOCKER, t(2));
            await prisma.userBlock.create({
                data: { blockerUserId: BLOCKER, blockedUserId: ME },
            });

            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            const ids = page.items.map((i) => i.id);
            expect(ids).not.toContain(blocked);
            expect(ids).toContain(innocent);
        });

        it('the BLOCKER still sees it — the block is one-directional', async () => {
            // P5.2b: the blocked party loses sight, the blocker keeps history.
            const page = await listInbox(ctxFor(BLOCKER), { limit: INBOX_LIMIT });
            expect(page.items.length).toBeGreaterThan(0);
        });
    });

    describe('request state', () => {
        it('marks a request awaiting MY answer, and not one awaiting theirs', async () => {
            const iOpened = await makeDm(ME, PEER, t(9), 'REQUEST', ME);
            const theyOpened = await makeDm(ME, STRANGER, t(8), 'REQUEST', STRANGER);
            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });

            const mine = page.items.find((i) => i.id === iOpened);
            const theirs = page.items.find((i) => i.id === theyOpened);
            // The opener is WAITING for an answer, which is a different thing
            // from owing one, and must not light the same badge.
            expect(mine?.awaitingMyAnswer).toBe(false);
            expect(theirs?.awaitingMyAnswer).toBe(true);
        });

        it('an exchange row reports NULL rather than false', async () => {
            // The exchange has no request state. `false` would read as
            // "already answered".
            //
            // The population is asserted NON-EMPTY first. Without that this
            // test passed over zero exchange rows — a negated assertion over
            // an empty window, which is satisfied by the thing it is meant to
            // catch.
            const id = await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(7),
            });
            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            const exchange = page.items.filter((i) => i.source === 'exchange');
            expect(exchange.length).toBeGreaterThan(0);
            expect(exchange.map((i) => i.id)).toContain(id);
            for (const item of exchange) expect(item.awaitingMyAnswer).toBeNull();
        });
    });

    describe('pagination ACROSS the merge — the bug a single-source test cannot see', () => {
        it('page two does not repeat page one, and the union is complete', async () => {
            // Five conversations at known, distinct instants. Paged two at a
            // time, the three pages must partition them in order: with the
            // cursor silently dropped — `...before` beside a sibling `OR` —
            // every page returns the newest two for ever.
            const ids: string[] = [];
            for (let i = 0; i < 5; i++) ids.push(await makeDm(ME, PEER, t(100 + i)));

            // Paged to EXHAUSTION, not for a fixed number of pages. The
            // first version stopped after four and saw four of the five —
            // these are the OLDEST conversations in the fixture, so earlier
            // tests' rows come first. It reported a missing id and no
            // duplicates, which is a test that cannot tell "the cursor is
            // broken" from "I stopped reading too early".
            const seen: string[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 40; page++) {
                const r = await listInbox(ctxFor(ME), { limit: 2, cursor });
                seen.push(...r.items.map((x) => x.id));
                cursor = r.nextCursor;
                if (!cursor) break;
            }
            // The bound is a runaway guard, not the stop condition: reaching
            // it would mean `nextCursor` never cleared, which is its own bug.
            expect(cursor).toBeNull();

            // NO id repeats across pages — EVERY id, not just the five this
            // test created. That distinction is the whole value of the
            // assertion: the first version filtered to its own five DM ids,
            // and a mutation restoring the exchange half's cursor collision
            // passed 12/12, because the rows that repeated were exchange rows
            // the filter threw away. A merge is only paginated correctly if
            // NEITHER source repeats.
            expect(new Set(seen).size).toBe(seen.length);
            // And the five are all present, in one page or another.
            const mine = seen.filter((id) => ids.includes(id));
            expect(new Set(mine)).toEqual(new Set(ids));
            // Both sources took part, so "across the merge" is not a claim
            // about one of them.
            const first = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            expect(new Set(first.items.map((i) => i.source))).toEqual(new Set(['dm', 'exchange']));
        });

        it('INTERLEAVES the two sources by time, not source', async () => {
            // The assertion P8.5 is actually about. A list that returned all
            // DMs then all exchange rows would satisfy "newest first" within
            // each block and be wrong — so this pins a DM strictly between two
            // exchange rows.
            const olderEx = await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(52),
            });
            const middleDm = await makeDm(ME, PEER, t(51));
            const newerEx = await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(50),
            });

            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            const ids = page.items.map((i) => i.id);
            const [a, b, c] = [ids.indexOf(newerEx), ids.indexOf(middleDm), ids.indexOf(olderEx)];
            expect(a).toBeGreaterThanOrEqual(0);
            expect(b).toBeGreaterThan(a);
            expect(c).toBeGreaterThan(b);
        });

        it('orders strictly newest-first across BOTH sources', async () => {
            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            const times = page.items.map((i) => i.lastMessageAt.getTime());
            expect([...times].sort((a, b) => b - a)).toEqual(times);
            // Both sources present, so "across both" is not a claim about one.
            expect(new Set(page.items.map((i) => i.source))).toEqual(new Set(['dm', 'exchange']));
        });

        it('refuses an unreadable cursor rather than silently restarting', async () => {
            // Treating it as "start again" would duplicate rows in a client's
            // scroll and look like a render bug.
            await expect(listInbox(ctxFor(ME), { cursor: 'not-a-cursor' })).rejects.toMatchObject({
                code: 'INVALID_CURSOR',
            });
        });
    });

    describe('unread', () => {
        it('is true with no read cursor and false once caught up', async () => {
            const at = t(20);
            const id = await makeDm(ME, PEER, at);
            let page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            expect(page.items.find((i) => i.id === id)?.unread).toBe(true);

            await prisma.conversationParticipant.updateMany({
                where: { conversationId: id, userId: ME },
                data: { lastReadAt: new Date(at.getTime() + 1000) },
            });
            page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            expect(page.items.find((i) => i.id === id)?.unread).toBe(false);
        });
    });

    describe('the `sources` filter — a DISCLOSURE lever, not an optimisation (P8.4)', () => {
        it('returns only DM rows for ["dm"], and the exchange row is ABSENT', async () => {
            const dm = await makeDm(ME, PEER, t(5));
            const ex = await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(4),
            });

            const both = await listInbox(ctxFor(ME));
            // The positive control: unfiltered, BOTH are there. Without it an
            // empty exchange half would satisfy the assertion below for the
            // wrong reason — the fixture never having created one.
            expect(both.items.map((i) => i.id)).toContain(dm);
            expect(both.items.map((i) => i.id)).toContain(ex);

            const dmOnly = await listInbox(ctxFor(ME), { sources: ['dm'] });
            expect(dmOnly.items.map((i) => i.id)).toContain(dm);
            expect(dmOnly.items.map((i) => i.id)).not.toContain(ex);
            expect(dmOnly.items.every((i) => i.source === 'dm')).toBe(true);
        });

        it('returns only exchange rows for ["exchange"]', async () => {
            const dm = await makeDm(ME, PEER, t(5));
            const ex = await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(4),
            });

            const exOnly = await listInbox(ctxFor(ME), { sources: ['exchange'] });
            expect(exOnly.items.map((i) => i.id)).toContain(ex);
            expect(exOnly.items.map((i) => i.id)).not.toContain(dm);
            expect(exOnly.items.every((i) => i.source === 'exchange')).toBe(true);
        });

        it('is the same as both when every source is named, and when none is', async () => {
            await makeDm(ME, PEER, t(5));
            await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(4),
            });

            const omitted = await listInbox(ctxFor(ME));
            const named = await listInbox(ctxFor(ME), { sources: ['dm', 'exchange'] });
            // P8.5's shape is unchanged for every existing caller — the filter
            // is additive, and naming both must not reorder the merge either.
            expect(named.items.map((i) => `${i.source}:${i.id}`)).toEqual(
                omitted.items.map((i) => `${i.source}:${i.id}`),
            );
        });

        it('still pages correctly with one half excluded', async () => {
            // The cursor encodes `(lastMessageAt, id)` over the MERGE. With a
            // half excluded the merge is narrower, so a cursor that assumed
            // both halves would skip or repeat rows.
            const ids = [
                await makeDm(ME, PEER, t(9)),
                await makeDm(ME, PEER, t(8)),
                await makeDm(ME, PEER, t(7)),
            ];
            await makeExchangeThread({
                sellerUserId: PEER, sellerTenantId: TENANT_B,
                inquirerUserId: ME, inquirerTenantId: TENANT, at: t(6),
            });

            // Paged to EXHAUSTION rather than two pages deep. This describe
            // block shares a database with its siblings and nothing cleans up
            // between cases, so the rows are not only mine — the first draft
            // asserted "every id seen is one of mine" and failed on a DM a
            // neighbouring test had created.
            const seen: string[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 20; page += 1) {
                const got: Awaited<ReturnType<typeof listInbox>> = await listInbox(ctxFor(ME), {
                    sources: ['dm'],
                    limit: 2,
                    cursor,
                });
                // The filter must hold on EVERY page, not just the first —
                // a cursor is where a merge over two sources goes wrong.
                expect(got.items.every((i) => i.source === 'dm')).toBe(true);
                seen.push(...got.items.map((i) => i.id));
                if (!got.hasMore || !got.nextCursor) break;
                cursor = got.nextCursor;
            }

            // No repeats, and every DM this case created was reached — two
            // properties a single-page assertion cannot separate.
            expect(new Set(seen).size).toBe(seen.length);
            for (const id of ids) expect(seen).toContain(id);
        });
    });

    describe('the preview is DECRYPTED, which is why this is not raw SQL', () => {
        it('reads as plaintext, not as an envelope', async () => {
            const id = await makeDm(ME, PEER, t(1));
            const page = await listInbox(ctxFor(ME), { limit: INBOX_LIMIT });
            const item = page.items.find((i) => i.id === id);
            expect(item?.title).toBe(`тест ${SFX}`);
            expect(item?.title).not.toMatch(/^v[12]:/);
        });
    });
});

/** Big enough that no assertion above depends on the default page size. */
const INBOX_LIMIT = 20;
