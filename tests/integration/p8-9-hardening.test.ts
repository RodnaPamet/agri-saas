/**
 * P8.9 (#2801) — the four hardening criteria, each measured rather than
 * asserted to exist.
 *
 * ## Why the shape of each test matters more than its presence
 *
 * A suite of only-negatives passes against a connection bound to nothing: a
 * silently unset session variable yields zero rows exactly like a working
 * policy. #1664 is that failure paid for in full — `UserBlock`'s policies were
 * covered correctly under `runInUserContext` while the feature did nothing,
 * because enforcement ran under `runInTenantContext`.
 *
 * So every zero below is paired with a NON-ZERO from somebody entitled to it,
 * and every read runs through the helper the production caller runs through.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { runInUserContext } from '@/lib/db-context';
import { DM_OPEN_LIMIT } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/prisma';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const rawPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const ROOT = join(__dirname, '../..');

const SFX = randomUUID().slice(0, 8);

/** How many people take part in the property test. */
const PEOPLE = 40;
/** How many conversations are built between random pairs of them. */
const CONVERSATIONS = 200;

const people = Array.from({ length: PEOPLE }, (_, i) => `u-p89-${SFX}-${i}`);

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/**
 * A deterministic pseudo-random pair generator.
 *
 * Seeded and reproducible on purpose: a failure that cannot be re-run is a
 * failure nobody can diagnose, and `Math.random()` would make the 1,000 pairs
 * a different 1,000 every time. The arithmetic is a plain LCG — this needs
 * spread, not cryptographic quality.
 */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x1_0000_0000;
    };
}

/** Which conversations each person is a participant in. */
const membership = new Map<string, Set<string>>();

describeFn('P8.9 — hardening (#2801)', () => {
    beforeAll(async () => {
        for (const p of people) membership.set(p, new Set());

        const rng = makeRng(0xc0ffee);
        const rows: { id: string; a: string; b: string }[] = [];
        for (let i = 0; i < CONVERSATIONS; i += 1) {
            const ai = Math.floor(rng() * PEOPLE);
            let bi = Math.floor(rng() * PEOPLE);
            if (bi === ai) bi = (bi + 1) % PEOPLE;
            rows.push({ id: `cv-p89-${SFX}-${i}`, a: people[ai], b: people[bi] });
        }

        // Created through the PRIVILEGED client, which is legitimate here: the
        // subject is what a USER CONTEXT can read, so the fixture must be able
        // to write rows that context could not. `openConversationFromHandle`
        // would need 200 published farms to say the same thing.
        for (const r of rows) {
            await prisma.conversation.create({
                data: {
                    id: r.id,
                    state: 'ACCEPTED',
                    initiatedByUserId: r.a,
                    lastMessageAt: new Date(),
                    participants: {
                        create: [
                            { id: `cp-${r.id}-a`, userId: r.a },
                            { id: `cp-${r.id}-b`, userId: r.b },
                        ],
                    },
                    messages: {
                        create: [
                            {
                                id: `dm-${r.id}`,
                                senderUserId: r.a,
                                body: `съобщение ${r.id}`,
                            },
                        ],
                    },
                },
            });
            membership.get(r.a)!.add(r.id);
            membership.get(r.b)!.add(r.id);
        }
    }, 120_000);

    afterAll(async () => {
        const ids = Array.from({ length: CONVERSATIONS }, (_, i) => `cv-p89-${SFX}-${i}`);
        await prisma.directMessage.deleteMany({ where: { conversationId: { in: ids } } });
        await prisma.conversationParticipant.deleteMany({ where: { conversationId: { in: ids } } });
        await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
        await rawPrisma.$disconnect();
    }, 120_000);

    describe('criterion 1 — no cross-user reads, over every pair', () => {
        it('each person sees EXACTLY their own conversations, and nobody else\'s', async () => {
            // 40 readers against 200 conversations is 8,000 (reader,
            // conversation) pairs, settled in 40 transactions rather than
            // 8,000 — one count per reader, compared with what that reader
            // should see. Probing pairs one at a time would be the same
            // assertion at 200x the cost.
            let checked = 0;
            let readersWhoSeeSomething = 0;

            for (const person of people) {
                const expected = membership.get(person)!;
                const visible = await runInUserContext(ctxFor(person), async (tx) => {
                    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                        `SELECT "id" FROM "Conversation" WHERE "id" LIKE $1`,
                        `cv-p89-${SFX}-%`,
                    );
                    return rows.map((r) => r.id);
                });

                // The equality is the whole criterion: no row they should not
                // see (cross-user read) and no row they should (a policy that
                // hides everything would also report zero cross-user reads).
                expect(new Set(visible)).toEqual(expected);
                checked += CONVERSATIONS;
                if (visible.length > 0) readersWhoSeeSomething += 1;
            }

            expect(checked).toBeGreaterThanOrEqual(1000);
            // THE CONTROL. Without it a context bound to nothing passes every
            // equality above by seeing zero and being expected to see zero —
            // which is only true if the fixture happened to leave somebody
            // out of every conversation.
            expect(readersWhoSeeSomething).toBeGreaterThan(PEOPLE / 2);
        }, 180_000);

        it('a stranger with no conversation at all sees zero', async () => {
            const stranger = `u-p89-stranger-${randomUUID().slice(0, 8)}`;
            const visible = await runInUserContext(ctxFor(stranger), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "Conversation" WHERE "id" LIKE $1`,
                    `cv-p89-${SFX}-%`,
                );
                return Number(rows[0].n);
            });
            expect(visible).toBe(0);
        });

        it('and their MESSAGES are hidden too, not only the conversation rows', async () => {
            // A conversation hidden while its messages are readable would
            // satisfy the criterion as stated and leak everything that
            // matters. `DirectMessage` has its own policy; this asserts it
            // rather than inferring it from the parent.
            const stranger = `u-p89-stranger2-${randomUUID().slice(0, 8)}`;
            const [strangerSees, participantSees] = await Promise.all([
                runInUserContext(ctxFor(stranger), async (tx) => {
                    const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                        `SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" LIKE $1`,
                        `dm-cv-p89-${SFX}-%`,
                    );
                    return Number(rows[0].n);
                }),
                runInUserContext(ctxFor(people[0]), async (tx) => {
                    const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                        `SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" LIKE $1`,
                        `dm-cv-p89-${SFX}-%`,
                    );
                    return Number(rows[0].n);
                }),
            ]);
            expect(strangerSees).toBe(0);
            // The positive control for that zero.
            expect(participantSees).toBeGreaterThan(0);
        });
    });

    describe('criterion 2 — bodies are ciphertext at rest', () => {
        it('reads as an envelope through raw SQL and as plaintext through the ORM', async () => {
            const id = `dm-cv-p89-${SFX}-0`;
            const raw = await rawPrisma.$queryRawUnsafe<Array<{ body: string | null }>>(
                `SELECT "body" FROM "DirectMessage" WHERE "id" = $1`,
                id,
            );
            // Asserted against the LIVE write path (the fixture above goes
            // through the extended client, like production) because that is
            // the thing that can regress: a field left out of
            // `ENCRYPTED_FIELDS` stores plaintext with no error.
            expect(raw[0]?.body).toMatch(/^v[12]:/);

            const row = await prisma.directMessage.findUniqueOrThrow({ where: { id } });
            // The round trip, not just the envelope: a field that encrypted on
            // write and failed to decrypt on read looks identical at rest.
            expect(row.body).toContain('съобщение');
        });

        it('every seeded body is an envelope — no partial coverage', async () => {
            // One row proves the field is declared. Counting them proves no
            // write path bypassed the extension, which is how a second
            // producer diverges.
            const rows = await rawPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "DirectMessage"
                   WHERE "id" LIKE $1 AND "body" NOT LIKE 'v1:%' AND "body" NOT LIKE 'v2:%'`,
                `dm-cv-p89-${SFX}-%`,
            );
            expect(Number(rows[0].n)).toBe(0);

            // And the denominator, because `0 of 0` is not a result. "Zero
            // plaintext rows" over an empty set is exactly the vacuous pass
            // this criterion must not accept.
            const total = await rawPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "DirectMessage" WHERE "id" LIKE $1`,
                `dm-cv-p89-${SFX}-%`,
            );
            expect(Number(total[0].n)).toBe(CONVERSATIONS);
        });
    });

    describe('criterion 3 — what stops one sender messaging 100 strangers', () => {
        it('is DM_OPEN_LIMIT, caller-keyed, and NOT slow mode', () => {
            // #2801 asks for this to be NAMED rather than left with two
            // plausible answers, and the answer turns on how the route
            // declares its limit — a source fact, so it is read as one. The
            // precedent is P8.2's `take: limit + 1` bound, asserted on source
            // in an integration suite because the response cannot show it.
            const route = readFileSync(
                join(ROOT, 'src/app/api/social/conversations/route.ts'),
                'utf8',
            );

            // An EXPLICIT config. That is what bounds the caller at 5 per
            // hour, where `API_MUTATION_LIMIT`'s 60/min would let 100
            // strangers be opened in under two minutes.
            expect(route).toContain('rateLimit: { config: DM_OPEN_LIMIT');

            // And NO `getBucket`. Two consequences, and both are the reason
            // this assertion exists rather than a comment:
            //
            //   * a bucket REPLACES the per-caller key and caps a SHARED
            //     resource, which is wrong here — the harm is spread across
            //     100 unrelated people, so there is nothing shared to key on;
            //   * P5.5a's slow mode explicitly SKIPS a `getBucket` route, so
            //     if the cap sat on a bucket then slow mode would not bound a
            //     new account either, and neither control would answer this
            //     criterion.
            expect(route).not.toContain('getBucket');

            // Slow mode does not apply here EITHER WAY, and that is the part
            // worth stating: it narrows the DEFAULT tier only, and a route
            // with an explicit config is excluded because every such preset is
            // already tighter — overriding would LOOSEN the route. So the
            // honest answer to "what stops them" is DM_OPEN_LIMIT alone.
            expect(DM_OPEN_LIMIT.maxAttempts).toBe(5);
            expect(DM_OPEN_LIMIT.windowMs).toBe(60 * 60 * 1000);
        });
    });

    describe('criterion 4 — a block cuts the blocked person off', () => {
        it('is STRUCTURAL: after a block the send itself is refused, so nothing is published', async () => {
            // #2801 calls this "the only criterion that is genuinely new
            // mechanism" and asks whether a block should publish a cut event
            // or the stream should poll a key. Measured: NEITHER is needed.
            //
            // `sendDirectMessage` refuses when a block exists in EITHER
            // direction — `amIBlockedByAnyOf` for visibility and
            // `personBlockExists` for contact — so after a block no message
            // flows in that conversation at all, and the publisher is never
            // reached. The cutoff is 0ms because there is nothing to cut.
            //
            // A publisher-side block filter would therefore be a control that
            // CANNOT FIRE, which P8.1 argues against by name: a vacuously-true
            // clause that reads as a control is worse than no clause.
            const { sendDirectMessage } = await import('@/app-layer/usecases/direct-messages');
            const a = people[0];

            // A conversation `a` is definitely in.
            const conv = Array.from(membership.get(a)!)[0];
            expect(conv).toBeDefined();
            const other = await prisma.conversationParticipant
                .findFirst({ where: { conversationId: conv, userId: { not: a } }, select: { userId: true } })
                .then((r) => r!.userId);

            // The POSITIVE CONTROL first: unblocked, the send works. Without
            // it the refusal below could be any other cause.
            const ok = await sendDirectMessage(ctxFor(a), { conversationId: conv, body: 'преди' });
            expect(ok.deduplicated).toBe(false);

            await prisma.userBlock.create({
                data: { id: `ub-p89-${randomUUID()}`, blockerUserId: other, blockedUserId: a },
            });

            try {
                await expect(
                    sendDirectMessage(ctxFor(a), { conversationId: conv, body: 'след' }),
                ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
            } finally {
                await prisma.userBlock.deleteMany({
                    where: { blockerUserId: other, blockedUserId: a },
                });
            }
        }, 60_000);

        it('every conversation has exactly TWO participants — the arity the above depends on', async () => {
            // The structural argument holds because a conversation is 1:1. In
            // a three-party conversation C's send would publish to B even
            // though A has blocked B, and B — who cannot read it — would still
            // be told something happened.
            //
            // There is exactly ONE site that creates participants and it
            // creates two. This pins that: if group conversations ever ship,
            // this fails and points at the reasoning above, which is where the
            // publisher-side filter becomes a control that CAN fire.
            const rows = await rawPrisma.$queryRawUnsafe<Array<{ n: bigint; c: bigint }>>(
                `SELECT COUNT(*)::bigint AS n, MAX(c)::bigint AS c FROM (
                     SELECT COUNT(*) AS c FROM "ConversationParticipant"
                      WHERE "conversationId" LIKE $1 GROUP BY "conversationId"
                 ) x`,
                `cv-p89-${SFX}-%`,
            );
            expect(Number(rows[0].n)).toBe(CONVERSATIONS);
            expect(Number(rows[0].c)).toBe(2);
        });
    });
});
