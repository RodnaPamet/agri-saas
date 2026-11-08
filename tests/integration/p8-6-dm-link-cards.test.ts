/**
 * P8.6 (#2800) — link cards, the code stage.
 *
 * `tests/unit/social/dm-link-cards.test.ts` owns the FETCH: the per-hop
 * refusal, the byte cap, the content-type check, the extraction. This suite
 * owns everything that happens to a card once it exists, and specifically the
 * four properties that fail SILENTLY:
 *
 *   1. the card comes BACK. `readConversation`'s select is what a client
 *      reads, and a card stored but not returned is a write-only feature that
 *      every other test in the phase would still pass — which is exactly what
 *      shipped for the photo half (#2852) and is fixed in the same diff.
 *   2. the text is SANITISED, asserted on the stored row rather than on the
 *      card the fetcher returned. Sanitising at the boundary and then writing
 *      a different value is a two-line mistake no boundary test can see.
 *   3. `linkTitle` / `linkDescription` are CIPHERTEXT at rest, with the row
 *      count beside the assertion — "zero plaintext rows" over an empty set
 *      is zero, and passes vacuously.
 *   4. a RETRACTED message serves no card. The columns are cleared AND the
 *      payload re-checks `deletedAt`, so this asserts the payload.
 *
 * The fetcher is MOCKED here, which is the right split rather than a
 * shortcut: driving a real server through this path would re-test the unit
 * suite's subject and tell us nothing about storage, and the thing worth
 * pinning here is that the usecase does not trust what the fetcher hands it.
 */
import { randomUUID } from 'crypto';

jest.mock('@/app-layer/usecases/direct-message-link-cards', () => ({
    ...jest.requireActual('@/app-layer/usecases/direct-message-link-cards'),
    fetchLinkCard: jest.fn(),
}));

import { prisma } from '@/lib/prisma';
import { runInUserContext } from '@/lib/db-context';
import {
    sendDirectMessage,
    readConversation,
    deleteDirectMessage,
} from '@/app-layer/usecases/direct-messages';
import { fetchLinkCard } from '@/app-layer/usecases/direct-message-link-cards';
import type { UserContext } from '@/app-layer/types';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const mockedFetch = fetchLinkCard as jest.MockedFunction<typeof fetchLinkCard>;

const SFX = randomUUID().slice(0, 8);
const ALICE = `u-p86l-alice-${SFX}`;
const BORIS = `u-p86l-boris-${SFX}`;
const CONV = `cv-p86l-${SFX}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

const FETCHED_AT = new Date('2026-11-08T09:00:00.000Z');

describeFn('P8.6 — link cards, the code stage (#2800)', () => {
    beforeAll(async () => {
        await prisma.conversation.create({
            data: {
                id: CONV,
                state: 'ACCEPTED',
                initiatedByUserId: ALICE,
                lastMessageAt: new Date(),
                participants: {
                    create: [
                        { id: `cp-la-${SFX}`, userId: ALICE },
                        { id: `cp-lb-${SFX}`, userId: BORIS },
                    ],
                },
            },
        });
    }, 60_000);

    afterAll(async () => {
        await prisma.directMessage.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversationParticipant.deleteMany({ where: { conversationId: CONV } });
        await prisma.conversation.deleteMany({ where: { id: CONV } });
    }, 60_000);

    beforeEach(() => {
        mockedFetch.mockReset();
    });

    it('stores a card and RETURNS it in the conversation payload', async () => {
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/wheat',
            title: 'Цени на пшеница',
            description: 'Седмичен обзор',
            fetchedAt: FETCHED_AT,
        });

        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'виж това',
            linkUrl: 'https://agri.example.test/wheat',
        });

        // The COUNTERPARTY reads it, not the sender: the whole point of a card
        // is the other person seeing what was shared, and the policy that
        // admits them is row-level, so every column of the row comes with it.
        const seen = await readConversation(ctxFor(BORIS), CONV, {});
        const row = seen.messages.find((m) => m.id === sent.messageId);
        expect(row).toBeDefined();
        expect(row!.linkCard).toEqual({
            url: 'https://agri.example.test/wheat',
            title: 'Цени на пшеница',
            description: 'Седмичен обзор',
            fetchedAt: FETCHED_AT,
        });
    }, 60_000);

    it('a message with NO card returns linkCard null — the control', async () => {
        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'без връзка',
        });
        // Without this, "the card came back" is satisfied by a payload that
        // invents one, and the fetcher is never consulted at all.
        expect(mockedFetch).not.toHaveBeenCalled();

        const seen = await readConversation(ctxFor(BORIS), CONV, {});
        expect(seen.messages.find((m) => m.id === sent.messageId)!.linkCard).toBeNull();
    }, 60_000);

    it('SANITISES the card text, asserted on the STORED row', async () => {
        // A fetcher handing back markup is the case that matters: the usecase
        // must not trust its own boundary. `sanitizePlainText` is idempotent,
        // so sanitising in both places costs nothing and this assertion holds
        // whichever one is doing the work — remove BOTH and it fails.
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/hostile',
            title: '<img src=x onerror=alert(1)>Заглавие',
            description: '<b>Описание</b>',
            fetchedAt: FETCHED_AT,
        });

        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'подозрително',
            linkUrl: 'https://agri.example.test/hostile',
        });

        const stored = await prisma.directMessage.findUniqueOrThrow({
            where: { id: sent.messageId },
            select: { linkTitle: true, linkDescription: true },
        });
        expect(stored.linkTitle).toBe('Заглавие');
        expect(stored.linkDescription).toBe('Описание');
    }, 60_000);

    it('keeps linkTitle and linkDescription as CIPHERTEXT at rest', async () => {
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/secret',
            title: 'Поверително заглавие',
            description: 'Поверително описание',
            fetchedAt: FETCHED_AT,
        });

        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'шифровано',
            linkUrl: 'https://agri.example.test/secret',
        });

        const raw = await prisma.$queryRawUnsafe<
            Array<{ linkTitle: string | null; linkDescription: string | null }>
        >(
            'SELECT "linkTitle", "linkDescription" FROM "DirectMessage" WHERE "id" = $1',
            sent.messageId,
        );
        // THE DENOMINATOR, beside the assertion. A `WHERE` that matched
        // nothing would make every envelope check below pass over an empty
        // set, which is the shape P8.9's ciphertext criterion calls out.
        expect(raw).toHaveLength(1);
        expect(raw[0].linkTitle).toMatch(/^v[12]:/);
        expect(raw[0].linkDescription).toMatch(/^v[12]:/);
        // And the ORM decrypts it, so the ciphertext is an envelope rather
        // than a value somebody stored as text that happens to start with v2.
        const seen = await readConversation(ctxFor(BORIS), CONV, {});
        expect(seen.messages.find((m) => m.id === sent.messageId)!.linkCard!.title).toBe(
            'Поверително заглавие',
        );
    }, 60_000);

    it('RETRACTING clears the card, and the payload serves none', async () => {
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/retracted',
            title: 'Ще бъде оттеглено',
            description: null,
            fetchedAt: FETCHED_AT,
        });

        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'оттегляне',
            linkUrl: 'https://agri.example.test/retracted',
        });
        // Control: the card was there to lose.
        const before = await readConversation(ctxFor(BORIS), CONV, {});
        expect(before.messages.find((m) => m.id === sent.messageId)!.linkCard).not.toBeNull();

        await deleteDirectMessage(ctxFor(ALICE), sent.messageId);

        const stored = await prisma.directMessage.findUniqueOrThrow({
            where: { id: sent.messageId },
            select: { linkUrl: true, linkTitle: true, linkDescription: true, linkFetchedAt: true },
        });
        expect(stored).toEqual({
            linkUrl: null,
            linkTitle: null,
            linkDescription: null,
            linkFetchedAt: null,
        });

        // Asserted on the PAYLOAD and not only on the columns: the mapping
        // re-checks `deletedAt`, so a row that somehow kept its card still
        // serves none. A retraction is about what the other party can see.
        const after = await readConversation(ctxFor(BORIS), CONV, {});
        expect(after.messages.find((m) => m.id === sent.messageId)!.linkCard).toBeNull();
    }, 60_000);

    it('serves NO card for a deleted row that still carries one — the arm the delete makes redundant', async () => {
        // MUTATION-PROVED INTO EXISTENCE. Removing `m.deletedAt ||` from the
        // mapping reddened nothing, because `deleteDirectMessage` clears the
        // columns and `!m.linkUrl` then answers first. So the arm's only
        // reason to exist is the state the delete is supposed to prevent — and
        // the CHECK permits that row (`deletedAt IS NOT NULL` is its first
        // arm), so the test can produce it directly instead of trusting the
        // writer it is a backstop for.
        //
        // The same argument covers `attachment`, in the suite that owns it.
        const stale = await prisma.directMessage.create({
            data: {
                conversationId: CONV,
                senderUserId: ALICE,
                body: '',
                deletedAt: new Date(),
                linkUrl: 'https://agri.example.test/stale',
                linkTitle: 'Не трябва да се вижда',
                linkFetchedAt: FETCHED_AT,
            },
            select: { id: true },
        });

        // Control: the column really does hold a URL, so a null payload is the
        // mapping's decision rather than an empty row.
        const stored = await prisma.directMessage.findUniqueOrThrow({
            where: { id: stale.id },
            select: { linkUrl: true },
        });
        expect(stored.linkUrl).toBe('https://agri.example.test/stale');

        const seen = await readConversation(ctxFor(BORIS), CONV, {});
        expect(seen.messages.find((m) => m.id === stale.id)!.linkCard).toBeNull();
    }, 60_000);

    it('a REFUSED fetch sends the message with the URL and a null fetchedAt', async () => {
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/blocked',
            title: null,
            description: null,
            fetchedAt: null,
        });

        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'отказан хост',
            linkUrl: 'https://agri.example.test/blocked',
        });

        // Best-effort: the SEND succeeds. A refused host costs a preview, not
        // a message — and `fetchedAt` null is what tells a client the card was
        // refused rather than that the page carried no metadata.
        const seen = await readConversation(ctxFor(BORIS), CONV, {});
        expect(seen.messages.find((m) => m.id === sent.messageId)!.linkCard).toEqual({
            url: 'https://agri.example.test/blocked',
            title: null,
            description: null,
            fetchedAt: null,
        });
    }, 60_000);

    it('the counterparty reads the card through RLS, not through a privileged client', async () => {
        mockedFetch.mockResolvedValue({
            url: 'https://agri.example.test/rls',
            title: 'През политиката',
            description: null,
            fetchedAt: FETCHED_AT,
        });
        const sent = await sendDirectMessage(ctxFor(ALICE), {
            conversationId: CONV,
            body: 'rls',
            linkUrl: 'https://agri.example.test/rls',
        });

        const visible = await runInUserContext(ctxFor(BORIS), async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                'SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" = $1 AND "linkUrl" IS NOT NULL',
                sent.messageId,
            );
            return Number(rows[0].n);
        });
        expect(visible).toBe(1);

        // The control that makes the 1 mean something: a stranger sees ZERO
        // through the same policy, so the row is admitted by participation
        // rather than by the query being unfiltered.
        const stranger = await runInUserContext(
            ctxFor(`u-p86l-stranger-${SFX}`),
            async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    'SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" = $1',
                    sent.messageId,
                );
                return Number(rows[0].n);
            },
        );
        expect(stranger).toBe(0);
    }, 60_000);
});
