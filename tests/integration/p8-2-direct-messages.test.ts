/**
 * P8.2 (#2796) — the direct-message usecase against a real database.
 *
 * ## What this suite is FOR, beyond "the feature works"
 *
 * Three properties that no unit test with a mocked Prisma can express, because
 * each is a statement about what the DATABASE does:
 *
 *   1. **The request rule holds end to end.** A stranger gets one message. The
 *      usecase enforces it and `direct_message_insert`'s WITH CHECK enforces it
 *      again; this exercises the path production takes.
 *   2. **A non-participant and a blocked caller get the SAME not-found a
 *      missing conversation gets.** Asserted as a COMPARISON rather than as
 *      "it was refused" — the shape `person-block-is-silent` uses, because
 *      "refused" is not the property.
 *   3. **Edit and delete refuse somebody else's message through RLS**, where a
 *      refused UPDATE affects zero rows and returns NORMALLY. The usecase
 *      turns that count into a not-found; without it, editing another person's
 *      message would answer 204.
 *
 * ## The contexts are the production ones
 *
 * #1664 is the reason this matters more than it looks: a policy keyed on
 * `app.user_id` while the caller ran under `app.actor_user_id` selected from an
 * empty view and returned `false` for every pair, always, with two green
 * suites either side of the seam. So every call here goes through the real
 * usecase, which chooses its own runner.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';

import prisma from '@/lib/prisma';

import type { UserContext } from '@/app-layer/types';
import {
    openConversationFromHandle,
    sendDirectMessage,
    respondToConversation,
    readConversation,
    DM_MESSAGE_PAGE_SIZE,
    editDirectMessage,
    deleteDirectMessage,
    markConversationRead,
    addReaction,
    removeReaction,
} from '@/app-layer/usecases/direct-messages';

import { DB_AVAILABLE } from './db-helper';
import { hardDeleteTenants } from '../helpers/db';

/**
 * The EXTENDED client, not a bare `PrismaClient`.
 *
 * Fixtures go through it because `User.emailHash` is derived by
 * `pii-middleware` on an ORM write — a raw client violates that NOT NULL, and
 * a hand-supplied hash would store a user whose lookup derivation does not
 * match their address, which is a different database from the one production
 * has. `$queryRawUnsafe` still returns the STORED bytes either way, because
 * the encryption extension intercepts model operations and not raw queries,
 * which is what makes the ciphertext assertion at the bottom meaningful.
 */
const globalPrisma = prisma;
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUFFIX = randomUUID().slice(0, 8);
const HANDLE = `pobeda-${SUFFIX}`;
const TENANT = `t-dm-${SUFFIX}`;

/** The farm's owner — the recipient, per the owner ruling of 2026-11-06. */
const OWNER = `u-dm-owner-${SUFFIX}`;
/** A stranger writing to the farm. */
const VISITOR = `u-dm-visitor-${SUFFIX}`;
/** Nobody's counterparty. Used for the not-a-participant arm. */
const OUTSIDER = `u-dm-outsider-${SUFFIX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Everything observable about a thrown refusal, for the comparison arms. */
function shapeOf(err: unknown): Record<string, unknown> {
    const e = err as { code?: string; status?: number; message?: string; name?: string };
    return { name: e.name, code: e.code, status: e.status, message: e.message };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
        await fn();
        return { threw: false };
    } catch (err) {
        return shapeOf(err);
    }
}

describeFn('P8.2 — direct messages (#2796)', () => {
    beforeAll(async () => {
        // Through the ORM, not raw SQL: `Tenant.updatedAt` and `User.updatedAt`
        // are `@updatedAt`, which Prisma fills and a raw INSERT does not — and
        // `User.email` is PII, so the ORM path is what derives `emailHash`
        // through `pii-middleware`. A raw fixture would store a user whose
        // lookup hash does not match their address, which is a different
        // database from the one production has.
        await globalPrisma.tenant.create({
            data: { id: TENANT, name: `DM fixture ${SUFFIX}`, slug: `dm-fixture-${SUFFIX}` },
        });
        for (const id of [OWNER, VISITOR, OUTSIDER]) {
            await globalPrisma.user.create({
                data: { id, email: `${id}@example.test`, name: id },
            });
        }
        await globalPrisma.tenantMembership.create({
            data: {
                id: `tm-${SUFFIX}`,
                tenantId: TENANT,
                userId: OWNER,
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });
        // The handle resolution reads the PUBLISHED projection FIRST and the
        // brand second — that order is what bounds `dm-recipient-resolution`,
        // so both rows have to exist for a resolution to succeed at all.
        await globalPrisma.farmBrand.create({
            data: { id: `fb-${SUFFIX}`, tenantId: TENANT, handle: HANDLE },
        });
        await globalPrisma.publicFarmProfile.create({
            data: { handle: HANDLE, displayName: `Победа ${SUFFIX}`, projectedAt: new Date() },
        });
    });

    afterAll(async () => {
        // Conversations cascade to participants, messages and reactions.
        const convs = await globalPrisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT DISTINCT c."id" FROM "Conversation" c
             JOIN "ConversationParticipant" p ON p."conversationId" = c."id"
             WHERE p."userId" = ANY($1::text[])`,
            [OWNER, VISITOR, OUTSIDER],
        );
        if (convs.length > 0) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "Conversation" WHERE "id" = ANY($1::text[])`,
                convs.map((c) => c.id),
            );
        }
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "UserBlock" WHERE "blockerUserId" = ANY($1::text[]) OR "blockedUserId" = ANY($1::text[])`,
            [OWNER, VISITOR, OUTSIDER],
        );
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "PublicFarmProfile" WHERE "handle" = $1`, HANDLE);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "FarmBrand" WHERE "tenantId" = $1`, TENANT);
        // Through `hardDeleteTenants`, not a DELETE of my own. A tenant with an
        // active OWNER cannot be hard-deleted — `tenant_membership_last_owner_guard`
        // is BEFORE UPDATE OR DELETE, so the row can be neither demoted,
        // deactivated nor removed, and `TenantMembership.tenantId` is not
        // ON DELETE CASCADE so the tenant delete then fails on the FK too.
        // That is the trigger working as Epic 1 designed; the helper takes the
        // documented fixture escape (`SET LOCAL session_replication_role` inside
        // a transaction, which cannot leak the way DISABLE TRIGGER would).
        await hardDeleteTenants(globalPrisma as never, [TENANT]);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "User" WHERE "id" = ANY($1::text[])`,
            [OWNER, VISITOR, OUTSIDER],
        );
    });

    describe('opening from a farm handle', () => {
        it('resolves the handle to the farm’s ACTIVE OWNER and opens a REQUEST', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            expect(opened.state).toBe('REQUEST');

            // The recipient is the owner — asserted through the participant
            // rows, because that is the only place the resolution's answer is
            // recorded.
            const members = await globalPrisma.conversationParticipant.findMany({
                where: { conversationId: opened.conversationId },
                select: { userId: true },
            });
            expect(members.map((m) => m.userId).sort()).toEqual([OWNER, VISITOR].sort());
        });

        it('is idempotent — pressing it twice is ONE conversation', async () => {
            const a = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            const b = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            expect(b.conversationId).toBe(a.conversationId);
            // This is also what makes a REQUEST unrepeatable: a stranger
            // cannot escape the one-message rule by opening a second thread,
            // because there is no second thread to open.
        });

        it('normalises the handle, so a pasted trailing space still resolves', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), ` ${HANDLE.toUpperCase()} `);
            const first = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            expect(opened.conversationId).toBe(first.conversationId);
        });

        it('refuses a handle nobody published, with the not-found', async () => {
            const refusal = await refusalOf(() =>
                openConversationFromHandle(ctxFor(VISITOR), `no-such-farm-${SUFFIX}`),
            );
            expect(refusal.code).toBe('CONVERSATION_NOT_FOUND');
        });

        it('refuses the caller messaging themselves', async () => {
            const refusal = await refusalOf(() => openConversationFromHandle(ctxFor(OWNER), HANDLE));
            expect(refusal.code).toBe('DM_SELF');
        });
    });

    describe('the request rule, end to end', () => {
        let conversationId: string;

        beforeAll(async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            conversationId = opened.conversationId;
        });

        it('admits the first message — the positive control', async () => {
            const sent = await sendDirectMessage(ctxFor(VISITOR), {
                conversationId,
                body: 'Имате ли свободен комбайн?',
            });
            expect(sent.deduplicated).toBe(false);
            expect(sent.messageId).toBeTruthy();
        });

        it('stamps lastMessageAt, which is what the WITH CHECK reads', async () => {
            const row = await globalPrisma.conversation.findUniqueOrThrow({
                where: { id: conversationId },
                select: { lastMessageAt: true },
            });
            // The column carries a security property, not just the inbox sort:
            // the one-message rule tests it, because a policy on a table may
            // not query that table.
            expect(row.lastMessageAt).not.toBeNull();
        });

        it('REFUSES a second message while the request is unanswered', async () => {
            const refusal = await refusalOf(() =>
                sendDirectMessage(ctxFor(VISITOR), { conversationId, body: 'И още нещо…' }),
            );
            expect(refusal.code).toBe('DM_REQUEST_AWAITING_REPLY');
        });

        it('lets the OTHER party answer, and only them', async () => {
            // The opener cannot accept their own request — the whole point.
            const refusal = await refusalOf(() =>
                respondToConversation(ctxFor(VISITOR), conversationId, 'ACCEPT'),
            );
            expect(refusal.code).toBe('CONVERSATION_NOT_FOUND');

            const answered = await respondToConversation(ctxFor(OWNER), conversationId, 'ACCEPT');
            expect(answered.state).toBe('ACCEPTED');
        });

        it('admits a second message once ACCEPTED — the control for the refusal above', async () => {
            const sent = await sendDirectMessage(ctxFor(VISITOR), {
                conversationId,
                body: 'Благодаря!',
            });
            expect(sent.deduplicated).toBe(false);
        });

        it('answers an already-answered request with a coded refusal', async () => {
            const refusal = await refusalOf(() =>
                respondToConversation(ctxFor(OWNER), conversationId, 'DECLINE'),
            );
            expect(refusal.code).toBe('DM_REQUEST_ALREADY_ANSWERED');
        });
    });

    describe('idempotency', () => {
        it('a replayed send is ONE message and reports itself as a replay', async () => {
            const opened = await openConversationFromHandle(ctxFor(OUTSIDER), HANDLE);
            await respondToConversation(ctxFor(OWNER), opened.conversationId, 'ACCEPT');

            const key = `idem-${randomUUID()}`;
            const first = await sendDirectMessage(ctxFor(OUTSIDER), {
                conversationId: opened.conversationId,
                body: 'Здравейте',
                idempotencyKey: key,
            });
            const replay = await sendDirectMessage(ctxFor(OUTSIDER), {
                conversationId: opened.conversationId,
                body: 'Здравейте',
                idempotencyKey: key,
            });

            expect(first.deduplicated).toBe(false);
            expect(replay.deduplicated).toBe(true);
            expect(replay.messageId).toBe(first.messageId);

            const count = await globalPrisma.directMessage.count({
                where: { conversationId: opened.conversationId, senderUserId: OUTSIDER },
            });
            expect(count).toBe(1);
        });
    });

    describe('silence — the property, asserted as a COMPARISON', () => {
        it('a non-participant and a missing conversation are INDISTINGUISHABLE', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);

            const asOutsider = await refusalOf(() =>
                readConversation(ctxFor(OUTSIDER), opened.conversationId),
            );
            const asNothing = await refusalOf(() =>
                readConversation(ctxFor(OUTSIDER), `cv-does-not-exist-${randomUUID()}`),
            );

            // Every observable, not just the code. "It was refused" is not the
            // property — a 403 would also refuse, and would confirm the
            // conversation exists.
            expect(asOutsider).toEqual(asNothing);
            expect(asOutsider.code).toBe('CONVERSATION_NOT_FOUND');
        });

        it('a BLOCKED caller is indistinguishable from a stranger with no handle', async () => {
            const blocker = `u-dm-blocker-${randomUUID().slice(0, 8)}`;
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId") VALUES ($1,$2,$3)`,
                `ub-${randomUUID()}`, OWNER, blocker,
            );

            const blocked = await refusalOf(() =>
                openConversationFromHandle(ctxFor(blocker), HANDLE),
            );
            const noSuchFarm = await refusalOf(() =>
                openConversationFromHandle(ctxFor(blocker), `absent-${randomUUID().slice(0, 8)}`),
            );

            expect(blocked).toEqual(noSuchFarm);
        });
    });

    describe('editing and deleting go through RLS, where a refusal is SILENT', () => {
        let conversationId: string;
        let visitorMessageId: string;

        beforeAll(async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            conversationId = opened.conversationId;
            if ((await globalPrisma.conversation.findUniqueOrThrow({
                where: { id: conversationId }, select: { state: true },
            })).state === 'REQUEST') {
                await respondToConversation(ctxFor(OWNER), conversationId, 'ACCEPT');
            }
            const sent = await sendDirectMessage(ctxFor(VISITOR), {
                conversationId,
                body: 'оригинален текст',
            });
            visitorMessageId = sent.messageId;
        });

        it('the sender edits their own — the positive control', async () => {
            await editDirectMessage(ctxFor(VISITOR), visitorMessageId, 'поправен текст');
            const view = await readConversation(ctxFor(VISITOR), conversationId);
            const edited = view.messages.find((m) => m.id === visitorMessageId);
            expect(edited?.body).toBe('поправен текст');
            expect(edited?.editedAt).not.toBeNull();
        });

        it('somebody ELSE editing it is a not-found, not a silent success', async () => {
            // The UPDATE policy is unsatisfied, so the statement affects zero
            // rows and returns normally. The count is the answer.
            const refusal = await refusalOf(() =>
                editDirectMessage(ctxFor(OWNER), visitorMessageId, 'подменен'),
            );
            expect(refusal.code).toBe('MESSAGE_NOT_FOUND');

            const row = await globalPrisma.directMessage.findUniqueOrThrow({
                where: { id: visitorMessageId },
                select: { body: true },
            });
            expect(row.body).toBe('поправен текст');
        });

        it('a blank body is refused, because the sanitiser TRIMS', async () => {
            const refusal = await refusalOf(() =>
                editDirectMessage(ctxFor(VISITOR), visitorMessageId, '   '),
            );
            expect(refusal.code).toBe('DM_BODY_REQUIRED');
        });

        it('delete is SOFT and clears the text, and the row keeps its place', async () => {
            await deleteDirectMessage(ctxFor(VISITOR), visitorMessageId);
            const view = await readConversation(ctxFor(VISITOR), conversationId);
            const gone = view.messages.find((m) => m.id === visitorMessageId);
            expect(gone).toBeDefined();
            expect(gone?.body).toBeNull();
            expect(gone?.deletedAt).not.toBeNull();

            // Read RAW, because the extension would decrypt — and the point is
            // that the original words are no longer in the column at all,
            // rather than merely hidden behind `deletedAt`.
            const raw = await globalPrisma.$queryRawUnsafe<Array<{ body: string }>>(
                `SELECT "body" FROM "DirectMessage" WHERE "id" = $1`, visitorMessageId,
            );
            expect(raw[0].body).not.toContain('поправен');
        });

        it('a deleted message cannot be edited back into existence', async () => {
            const refusal = await refusalOf(() =>
                editDirectMessage(ctxFor(VISITOR), visitorMessageId, 'възкресен'),
            );
            expect(refusal.code).toBe('MESSAGE_NOT_FOUND');
        });
    });

    describe('the read cursor', () => {
        it('moves forward and refuses to move backwards', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            const later = new Date();
            const earlier = new Date(later.getTime() - 60_000);

            await markConversationRead(ctxFor(VISITOR), opened.conversationId, later);
            await markConversationRead(ctxFor(VISITOR), opened.conversationId, earlier);

            const row = await globalPrisma.conversationParticipant.findFirstOrThrow({
                where: { conversationId: opened.conversationId, userId: VISITOR },
                select: { lastReadAt: true },
            });
            expect(row.lastReadAt?.getTime()).toBe(later.getTime());
        });

        it('moves only the CALLER’s cursor', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            await markConversationRead(ctxFor(VISITOR), opened.conversationId, new Date());

            const theirs = await globalPrisma.conversationParticipant.findFirstOrThrow({
                where: { conversationId: opened.conversationId, userId: OWNER },
                select: { lastReadAt: true },
            });
            expect(theirs.lastReadAt).toBeNull();
        });
    });

    describe('reactions', () => {
        let messageId: string;
        let conversationId: string;

        beforeAll(async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            conversationId = opened.conversationId;
            if ((await globalPrisma.conversation.findUniqueOrThrow({
                where: { id: conversationId }, select: { state: true },
            })).state === 'REQUEST') {
                await respondToConversation(ctxFor(OWNER), conversationId, 'ACCEPT');
            }
            messageId = (await sendDirectMessage(ctxFor(VISITOR), {
                conversationId,
                body: 'за реакция',
            })).messageId;
        });

        it('the counterparty may react, and twice is one row', async () => {
            await addReaction(ctxFor(OWNER), messageId, '👍');
            await addReaction(ctxFor(OWNER), messageId, '👍');
            const count = await globalPrisma.messageReaction.count({ where: { messageId } });
            expect(count).toBe(1);
        });

        it('is visible to the other participant', async () => {
            const view = await readConversation(ctxFor(VISITOR), conversationId);
            const m = view.messages.find((x) => x.id === messageId);
            expect(m?.reactions).toEqual([{ userId: OWNER, emoji: '👍' }]);
        });

        it('cannot be removed by somebody who did not write it', async () => {
            const refusal = await refusalOf(() => removeReaction(ctxFor(VISITOR), messageId, '👍'));
            expect(refusal.code).toBe('MESSAGE_NOT_FOUND');
            expect(await globalPrisma.messageReaction.count({ where: { messageId } })).toBe(1);
        });

        it('is removed by its author — the control', async () => {
            await removeReaction(ctxFor(OWNER), messageId, '👍');
            expect(await globalPrisma.messageReaction.count({ where: { messageId } })).toBe(0);
        });

        it('refuses anything long enough to be prose', async () => {
            const refusal = await refusalOf(() =>
                addReaction(ctxFor(OWNER), messageId, 'това не е реакция, а изречение'),
            );
            expect(refusal.code).toBe('DM_REACTION_TOO_LONG');
        });
    });

    describe('the message read is PAGED (#2820)', () => {
        let convId: string;

        beforeAll(async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            convId = opened.conversationId;
            if ((await globalPrisma.conversation.findUniqueOrThrow({
                where: { id: convId }, select: { state: true },
            })).state === 'REQUEST') {
                await respondToConversation(ctxFor(OWNER), convId, 'ACCEPT');
            }
            // Seven messages, so a limit of 3 gives three pages and a
            // boundary that is not also the end.
            for (let i = 0; i < 7; i++) {
                await sendDirectMessage(ctxFor(VISITOR), { conversationId: convId, body: `съобщение ${i}` });
            }
        });

        it('returns at most `limit`, newest page first, in display order', async () => {
            const view = await readConversation(ctxFor(VISITOR), convId, { limit: 3 });
            expect(view.messages.length).toBe(3);
            // Oldest-first WITHIN the page, even though the page is the newest
            // three — a chat opens at the bottom and renders upward.
            const times = view.messages.map((m) => m.createdAt.getTime());
            expect([...times].sort((a, b) => a - b)).toEqual(times);
            expect(view.hasOlder).toBe(true);
            expect(view.olderCursor).toBeTruthy();
        });

        it('pages BACKWARDS to the start, with no repeats and nothing missed', async () => {
            // The assertion that would have failed against the unbounded
            // version: it returned everything on page one, so `hasOlder` was
            // false and there was no second page to disagree with.
            const seen: string[] = [];
            let before: string | null = null;
            for (let page = 0; page < 20; page++) {
                const v = await readConversation(ctxFor(VISITOR), convId, { limit: 3, before });
                // Prepended: each page is OLDER than the last.
                seen.unshift(...v.messages.map((m) => m.id));
                before = v.olderCursor;
                if (!before) break;
            }
            expect(before).toBeNull();
            expect(new Set(seen).size).toBe(seen.length);

            const all = await globalPrisma.directMessage.findMany({
                where: { conversationId: convId },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true },
            });
            expect(seen).toEqual(all.map((m) => m.id));
        });

        it('clamps a limit above the page size rather than honouring it', async () => {
            const view = await readConversation(ctxFor(VISITOR), convId, { limit: 10_000 });
            expect(view.messages.length).toBeLessThanOrEqual(DM_MESSAGE_PAGE_SIZE);
        });

        it('the QUERY is bounded — asserted on the source, because the output cannot say', () => {
            // This one is structural on purpose, and the reason is the whole
            // point of #2820.
            //
            // Removing `take: limit + 1` changes NOTHING observable: `hasOlder`
            // is `rows.length > limit` and the page is `slice(0, limit)`, so an
            // unbounded fetch returns an identical response. Measured — the
            // mutation that deletes the `take` leaves all 31 cases green. The
            // defect is the cost of the query and the per-row decrypt, and no
            // assertion over the result can see it.
            //
            // So this reads the source, the way `stream-slots`' "uses SCAN,
            // never KEYS" does and for the same stated reason: the observable
            // would answer either way.
            //
            // It is NOT the general control. D2's unbounded-read budget scans
            // `src/app-layer/repositories` only, and extending it to usecases
            // means triaging 120 of 262 `findMany` calls — measured, and
            // recorded on #2820 as its own decision rather than smuggled in
            // here.
            // Anchored on `const rows =`, not on `db.directMessage.findMany`.
            // `readConversation` holds TWO reads of that table and the bare
            // anchor hit the FIRST — the `distinct: ['senderUserId']` lookup
            // for the block check, which legitimately has no `take` and never
            // will. The first version of this test therefore failed against
            // correct code while reporting the right-sounding thing, which is
            // `positional-replace-hits-the-twin` aimed at an extraction.
            const src = readFileSync('src/app-layer/usecases/direct-messages.ts', 'utf8');
            const read = src.slice(src.indexOf('export async function readConversation'));
            const anchor = 'const rows = await db.directMessage.findMany';
            expect(read).toContain(anchor);
            const block = read.slice(read.indexOf(anchor));
            const query = block.slice(0, block.indexOf('});') + 3);

            expect(query).toContain('take: limit + 1');
            // The extraction selected the PAGED query and not its sibling, so
            // a rename cannot make this pass over the wrong block — which is
            // exactly how the first version failed.
            expect(query).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
            expect(query).not.toContain("distinct: ['senderUserId']");
            expect(query.length).toBeGreaterThan(120);
        });

        it('refuses an unreadable cursor rather than silently starting over', async () => {
            const refusal = await refusalOf(() =>
                readConversation(ctxFor(VISITOR), convId, { before: 'not-a-cursor' }),
            );
            expect(refusal.code).toBe('INVALID_CURSOR');
        });
    });

    describe('the body at rest', () => {
        it('is ciphertext, so the global-KEK declaration took effect', async () => {
            const opened = await openConversationFromHandle(ctxFor(VISITOR), HANDLE);
            if ((await globalPrisma.conversation.findUniqueOrThrow({
                where: { id: opened.conversationId }, select: { state: true },
            })).state === 'REQUEST') {
                await respondToConversation(ctxFor(OWNER), opened.conversationId, 'ACCEPT');
            }
            const sent = await sendDirectMessage(ctxFor(VISITOR), {
                conversationId: opened.conversationId,
                body: 'тайно съобщение за комбайна',
            });

            const rows = await globalPrisma.$queryRawUnsafe<Array<{ body: string }>>(
                `SELECT "body" FROM "DirectMessage" WHERE "id" = $1`, sent.messageId,
            );
            expect(rows[0].body).not.toContain('комбайна');
            expect(rows[0].body).toMatch(/^v[12]:/);
        });
    });
});
