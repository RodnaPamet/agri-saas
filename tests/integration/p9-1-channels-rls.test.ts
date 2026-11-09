/**
 * P9.1 — channel RLS (#2935).
 *
 * Five tenantless tables, which is exactly the blind spot `rls-coverage` was
 * extended for: that inventory keys off a `tenantId` COLUMN, so a full sweep
 * passes over a tenantless table that is completely unprotected. These five
 * cannot have one — a crop channel spans every farm growing that crop — so the
 * policies are asserted here, against the live database, under the real
 * `runInUserContext`.
 *
 * It matters more than usual that this exists now. P9's rule ships these tables
 * one release BEFORE any code writes them, so there is no route to catch a
 * mistake and no traffic to reveal one. `ALTER DEFAULT PRIVILEGES` (migration
 * 20260323180000) already grants `app_user` SELECT/INSERT/UPDATE/DELETE on
 * every new table in `public`, so these are reachable by a session the moment
 * they exist, and the RLS is the only thing between the first writer and a leak.
 *
 * ── the shape of the negatives ──
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE. When
 * SELECT hides it, a DELETE or UPDATE affects ZERO rows and returns normally.
 * So every negative asserts a row COUNT or a raised code, never that a call
 * returned — and the reaction-delete case is where the difference bites,
 * because SELECT deliberately admits reactions the caller did not write.
 *
 * ── and why every negative is PAIRED with a positive ──
 *
 * P8.1 is the reason this is a rule and not a preference. All three of its
 * `REFUSES …` cases passed while the request rule enforced nothing, because a
 * recursive policy meant NOTHING could insert at all. A suite of only
 * negatives would have shipped that green.
 *
 * So each refusal here is followed by the same operation by somebody entitled
 * to it, in the same test where possible.
 *
 * ── what is PUBLIC here, which is the real departure from the DM family ──
 *
 * `conversation_select` admits participants only. `channel_select` and
 * `channel_post_select` admit any authenticated caller, because P9.2 cannot
 * suggest a channel nobody can read and nobody joins one they cannot look
 * into. That is asserted as a POSITIVE below — a non-member reading a channel
 * and its posts is the feature, not a leak — and it is why the gate is on
 * posting.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInUserContext } from '@/lib/db-context';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Synthetic person ids. None of these tables has an FK to `User` — every
// person column is a plain string, following `DirectMessage.senderUserId` —
// so no user fixture is needed and inventing one would test a constraint that
// does not exist.
const MEMBER = `u-p91-member-${randomUUID()}`;
const OTHER_MEMBER = `u-p91-other-${randomUUID()}`;
const BANNED = `u-p91-banned-${randomUUID()}`;
const OUTSIDER = `u-p91-outsider-${randomUUID()}`;

const CHANNEL = `ch-${randomUUID()}`;
const M_MEMBER = `cm-member-${randomUUID()}`;
const M_OTHER = `cm-other-${randomUUID()}`;
const M_BANNED = `cm-banned-${randomUUID()}`;
const POST = `cp-${randomUUID()}`;
const REACTION_OTHER = `cr-other-${randomUUID()}`;
const MENTION = `cmn-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Count rows VISIBLE to this person, via raw SQL so the ORM cannot filter. */
async function visibleCount(userId: string, table: string): Promise<number> {
    return runInUserContext(ctxFor(userId), async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "${table}"`,
        );
        return Number(rows[0].n);
    });
}

/**
 * Attempt an insert as this person; return the error MESSAGE, or null on
 * success.
 *
 * The message rather than a structured code, because Prisma wraps a raw-query
 * failure as `P2010` and the Postgres SQLSTATE survives only in the text. I
 * read `meta.code` first and all seven refusal cases failed reporting `P2010`
 * — the RLS was working and the INSTRUMENT was reading the wrong field.
 * `p5-1-trust-safety-rls` already matched on the message for this reason; this
 * follows it.
 *
 * The pattern below is specific enough not to pass on an unrelated failure: a
 * NOT NULL violation, a bad column name or a syntax error produce neither
 * token, so a broken statement fails the test rather than accidentally
 * satisfying it.
 */
const RLS_REFUSAL = /row-level security|insufficient privilege|permission denied/i;

async function insertAs(userId: string, sql: string, ...params: unknown[]): Promise<string | null> {
    try {
        await runInUserContext(ctxFor(userId), (tx) => tx.$executeRawUnsafe(sql, ...params));
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

describeFn('P9.1 — channel RLS (#2935)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        // Seeded as the OWNER role, so `superuser_bypass` applies — which is
        // also the production write path for `Channel` and `ChannelMembership`,
        // both of which deliberately have no `app_user` INSERT arm.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Channel"("id","key","nameBg","nameEn","kind","updatedAt")
             VALUES ($1,$2,'Пшеница','Wheat','CROP',NOW())`,
            CHANNEL, `crop:test-${randomUUID()}`,
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ChannelMembership"("id","channelId","userId","bannedAt")
             VALUES ($1,$2,$3,NULL),($4,$2,$5,NULL),($6,$2,$7,NOW())`,
            M_MEMBER, CHANNEL, MEMBER, M_OTHER, OTHER_MEMBER, M_BANNED, BANNED,
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
             VALUES ($1,$2,$3,'сеитбата започна',NOW())`,
            POST, CHANNEL, OTHER_MEMBER,
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ChannelPostReaction"("id","postId","userId","emoji")
             VALUES ($1,$2,$3,'👍')`,
            REACTION_OTHER, POST, OTHER_MEMBER,
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ChannelPostMention"("id","postId","userId") VALUES ($1,$2,$3)`,
            MENTION, POST, MEMBER,
        );
    });

    afterAll(async () => {
        // By ID. These tables are tenantless, so there is no tenant to delete
        // and cascade from — the P8 teardown lesson. `Channel` cascades to the
        // rest, so one delete is enough, but it must name the row.
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Channel" WHERE "id" = $1`, CHANNEL);
        await globalPrisma.$disconnect();
    });

    it('control: the fixture exists and the harness can see it privileged', async () => {
        // Without this, every assertion below could be passing over an empty
        // table — which is what a failed seed looks like from inside a policy
        // test.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "ChannelMembership" WHERE "channelId" = $1`,
            CHANNEL,
        );
        expect(Number(rows[0].n)).toBe(3);
    });

    describe('a channel is PUBLIC, which is the departure from a conversation', () => {
        it('an OUTSIDER who joined nothing still sees the channel and its posts', async () => {
            // The feature, not a leak: P9.2 suggests channels a person has not
            // joined, and nobody joins one they cannot look into first.
            expect(await visibleCount(OUTSIDER, 'Channel')).toBeGreaterThan(0);
            expect(await visibleCount(OUTSIDER, 'ChannelPost')).toBeGreaterThan(0);
        });

        it('and a member sees them too — so the public arm did not replace the member case', async () => {
            expect(await visibleCount(MEMBER, 'Channel')).toBeGreaterThan(0);
            expect(await visibleCount(MEMBER, 'ChannelPost')).toBeGreaterThan(0);
        });
    });

    describe('ChannelMembership admits the caller OWN ROW ONLY', () => {
        it('a member sees their own row and NOT a fellow member’s', async () => {
            // The narrowness is forced: a policy admitting "every member of a
            // channel I am in" must ask this table whether I am in it, which
            // Postgres refuses outright. `Channel.memberCount` is denormalised
            // because of this.
            const mine = await runInUserContext(ctxFor(MEMBER), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT "id" FROM "ChannelMembership" WHERE "channelId" = $1`, CHANNEL,
                );
                return rows.map((r) => r.id);
            });
            // POSITIVE: non-empty, so the arm is not simply hiding everything.
            expect(mine).toEqual([M_MEMBER]);
            expect(mine).not.toContain(M_OTHER);
            expect(mine).not.toContain(M_BANNED);
        });

        it('an outsider sees NO membership rows at all', async () => {
            const seen = await runInUserContext(ctxFor(OUTSIDER), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "ChannelMembership" WHERE "channelId" = $1`,
                    CHANNEL,
                );
                return Number(rows[0].n);
            });
            expect(seen).toBe(0);
        });
    });

    describe('posting: the three access rules P9.10 hardens, enforced in SQL', () => {
        it('a MEMBER can post — the positive that makes the three refusals mean something', async () => {
            const id = `cp-ok-${randomUUID()}`;
            const code = await insertAs(
                MEMBER,
                `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
                 VALUES ($1,$2,$3,'добра реколта',NOW())`,
                id, CHANNEL, MEMBER,
            );
            expect(code).toBeNull();
            // And it is really there, not merely unrefused.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "ChannelPost" WHERE "id" = $1`, id,
            );
            expect(Number(rows[0].n)).toBe(1);
        });

        it('a NON-MEMBER cannot post', async () => {
            const code = await insertAs(
                OUTSIDER,
                `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
                 VALUES ($1,$2,$3,'spam',NOW())`,
                `cp-no-${randomUUID()}`, CHANNEL, OUTSIDER,
            );
            expect(code).toMatch(RLS_REFUSAL);
        });

        it('a BANNED member cannot post, and the row surviving the ban is what enforces it', async () => {
            // The membership row is kept on a ban deliberately: deleting it
            // would let the person rejoin and post again.
            const code = await insertAs(
                BANNED,
                `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
                 VALUES ($1,$2,$3,'again',NOW())`,
                `cp-ban-${randomUUID()}`, CHANNEL, BANNED,
            );
            expect(code).toMatch(RLS_REFUSAL);
        });

        it('a FORGED AUTHOR cannot post, even from a real member’s session', async () => {
            // MEMBER is entitled to post — the previous case proves it — so the
            // only thing refused here is the author id, which is the property.
            const code = await insertAs(
                MEMBER,
                `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
                 VALUES ($1,$2,$3,'not mine',NOW())`,
                `cp-forge-${randomUUID()}`, CHANNEL, OTHER_MEMBER,
            );
            expect(code).toMatch(RLS_REFUSAL);
        });
    });

    describe('reactions are SPLIT per command, so seeing is not deleting', () => {
        it('a member may react, and may delete their OWN reaction', async () => {
            const id = `cr-mine-${randomUUID()}`;
            expect(await insertAs(
                MEMBER,
                `INSERT INTO "ChannelPostReaction"("id","postId","userId","emoji") VALUES ($1,$2,$3,'🌾')`,
                id, POST, MEMBER,
            )).toBeNull();

            const deleted = await runInUserContext(ctxFor(MEMBER), (tx) =>
                tx.$executeRawUnsafe(`DELETE FROM "ChannelPostReaction" WHERE "id" = $1`, id));
            expect(deleted).toBe(1);
        });

        it('a member SEES another’s reaction and CANNOT delete it — zero rows, no error', async () => {
            // This is the case where the negative shape matters: SELECT admits
            // the row, so a DELETE is not refused with a code — it simply
            // affects nothing. Asserting "it did not throw" would pass either
            // way.
            const visible = await runInUserContext(ctxFor(MEMBER), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "ChannelPostReaction" WHERE "id" = $1`,
                    REACTION_OTHER,
                );
                return Number(rows[0].n);
            });
            expect(visible).toBe(1);

            const deleted = await runInUserContext(ctxFor(MEMBER), (tx) =>
                tx.$executeRawUnsafe(`DELETE FROM "ChannelPostReaction" WHERE "id" = $1`, REACTION_OTHER));
            expect(deleted).toBe(0);

            // Still there, read privileged — the row survived, which is the
            // claim. A zero from the line above would also be produced by the
            // row having been hidden.
            const after = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "ChannelPostReaction" WHERE "id" = $1`,
                REACTION_OTHER,
            );
            expect(Number(after[0].n)).toBe(1);
        });

        it('an OUTSIDER cannot react — membership gates it, as it gates posting', async () => {
            expect(await insertAs(
                OUTSIDER,
                `INSERT INTO "ChannelPostReaction"("id","postId","userId","emoji") VALUES ($1,$2,$3,'👎')`,
                `cr-no-${randomUUID()}`, POST, OUTSIDER,
            )).toMatch(RLS_REFUSAL);
        });
    });

    describe('mentions are READ-ONLY to a session, because a mention is a push trigger', () => {
        it('a mentioned person can SEE the mention', async () => {
            const seen = await runInUserContext(ctxFor(MEMBER), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "ChannelPostMention" WHERE "id" = $1`, MENTION,
                );
                return Number(rows[0].n);
            });
            expect(seen).toBe(1);
        });

        it('and NOBODY can insert one from a session, not even a member who may post', async () => {
            // A caller able to insert a mention could push to any person on the
            // platform without posting anything they would read. MEMBER's
            // entitlement to post is established above, so the refusal here is
            // about the table and not about the person.
            expect(await insertAs(
                MEMBER,
                `INSERT INTO "ChannelPostMention"("id","postId","userId") VALUES ($1,$2,$3)`,
                `cmn-no-${randomUUID()}`, POST, OUTSIDER,
            )).toMatch(RLS_REFUSAL);
        });
    });

    describe('the writes that are PRIVILEGED by design', () => {
        it('a session cannot mint a Channel — it could impersonate a crop or an oblast', async () => {
            expect(await insertAs(
                MEMBER,
                `INSERT INTO "Channel"("id","key","nameBg","nameEn","kind","updatedAt")
                 VALUES ($1,$2,'Фалшив','Fake','CROP',NOW())`,
                `ch-no-${randomUUID()}`, `crop:fake-${randomUUID()}`,
            )).toMatch(RLS_REFUSAL);
        });

        it('a session cannot add itself to a channel — joining maintains memberCount', async () => {
            // A direct insert would leave `Channel.memberCount` wrong with
            // nothing detecting it, which is why the join is privileged.
            expect(await insertAs(
                OUTSIDER,
                `INSERT INTO "ChannelMembership"("id","channelId","userId") VALUES ($1,$2,$3)`,
                `cm-no-${randomUUID()}`, CHANNEL, OUTSIDER,
            )).toMatch(RLS_REFUSAL);
        });
    });
});
