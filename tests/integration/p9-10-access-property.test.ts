/**
 * P9.10 (#2944) — the channel access rules as a SET COMPARISON.
 *
 * ## Why this exists beside `p9-1-channels-rls.test.ts`
 *
 * That suite asserts each of the three access rules as one case: a member can
 * post, a non-member cannot, a banned member cannot, a forged author cannot.
 * All four are necessary and none of them is the PROPERTY. P8.9 (#2801) is the
 * template and its reasoning transfers verbatim:
 *
 * > "no row they should not see" is satisfied perfectly by a policy that hides
 * > everything.
 *
 * Here: *"a non-member cannot post"* is satisfied perfectly by a policy under
 * which **nobody** can post — which is not a hypothetical, it is P8.1's actual
 * failure. A recursive policy made every `DirectMessage` insert impossible and
 * all three of its `REFUSES …` cases passed, green, enforcing nothing.
 *
 * So this asserts the biconditional over every (person, channel) pair: a
 * person can post into a channel **if and only if** they hold an unbanned
 * membership there. A policy that refused everyone fails the equality on the
 * entitled side; a policy that admitted everyone fails it on the other.
 *
 * ## The four controls #2944 requires, and what each one rules out
 *
 * 1. **A majority of people post somewhere** — otherwise an equality over
 *    empty sets is satisfied by a connection bound to nothing, which is #1664
 *    paid for in full: a silently unset session variable yields zero rows
 *    exactly like a working policy.
 * 2. **A stranger posts nowhere** — the cross-cutting negative, with the
 *    majority above as its positive control.
 * 3. **`ChannelPost` is asserted SEPARATELY from `Channel`.** P8.9's form was
 *    "a conversation hidden while its messages were readable"; a channel is
 *    PUBLIC, so the analogue inverts — the outsider must **read** the channel
 *    and its posts and still be unable to **write**. A suite that only checked
 *    the write would pass against a policy that had also broken the public
 *    read, which is the feature P9.2's suggestion depends on.
 * 4. **Proved against RLS, not the ORM.** Every attempt is a raw
 *    `INSERT` through `runInUserContext`, so the only thing that can refuse it
 *    is `channel_post_insert`'s WITH CHECK. A Prisma `create` would be graded
 *    partly by the client extension and a usecase check, which is the layer a
 *    refactor removes.
 *
 * And a fifth that is about the INSTRUMENT rather than the subject: every
 * refusal must carry an RLS token. A typo'd column or a NOT NULL violation
 * refuses all 240 pairs, and "nobody can post" is a coherent-looking result —
 * control 1 would catch it, and the message check is what NAMES it instead of
 * leaving a reader to guess why the set was empty.
 *
 * ## The refusal shape
 *
 * A refused INSERT raises `42501`; a refused UPDATE or DELETE does NOT — with
 * no permissive policy the rows are selected by a USING clause that is
 * effectively false, so the statement affects zero rows and returns normally.
 * This suite only inserts, so every negative is a raised code. The code is
 * read from the MESSAGE and not from `err.meta.code`: Prisma wraps a failed
 * raw query as `P2010` and the SQLSTATE survives only in the text. P9.1 lost
 * seven cases to that and `p5-1-trust-safety-rls` had already found it.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInUserContext } from '@/lib/db-context';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SFX = randomUUID().slice(0, 8);

/** How many people take part. */
const PEOPLE = 20;
/** How many channels they may or may not belong to. */
const CHANNELS = 12;
/** Roughly what share of the memberships created are banned ones. */
const BAN_RATE = 0.2;

const people = Array.from({ length: PEOPLE }, (_, i) => `u-p910-${SFX}-${i}`);
const channels = Array.from({ length: CHANNELS }, (_, i) => `ch-p910-${SFX}-${i}`);

/**
 * Nobody at all: no membership row, banned or otherwise.
 *
 * Separate from the matrix because "a person with no memberships" can arise
 * inside it by chance and cannot be RELIED on to — the RNG decides. A named
 * stranger makes control 2 unconditional.
 */
const STRANGER = `u-p910-${SFX}-stranger`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/**
 * A deterministic LCG, for P8.9's reason: a failure that cannot be re-run is a
 * failure nobody can diagnose, and `Math.random()` would make this a different
 * matrix every run. Spread is all this needs.
 */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x1_0000_0000;
    };
}

/** Only these tokens mean "the policy refused it". */
const RLS_REFUSAL = /row-level security|insufficient privilege|permission denied/i;

/** `null` on success, the error message otherwise. */
async function postAs(
    sessionUserId: string,
    channelId: string,
    authorUserId: string,
): Promise<string | null> {
    try {
        await runInUserContext(ctxFor(sessionUserId), (tx) =>
            tx.$executeRawUnsafe(
                `INSERT INTO "ChannelPost"("id","channelId","authorUserId","body","updatedAt")
                 VALUES ($1,$2,$3,'добра реколта',NOW())`,
                `cp-p910-${SFX}-${randomUUID().slice(0, 12)}`,
                channelId,
                authorUserId,
            ),
        );
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

/** person -> the channels where they hold an UNBANNED membership. */
const entitled = new Map<string, Set<string>>();
let bannedPairs = 0;
let membershipRows = 0;

describeFn('P9.10 — the access property over every (person, channel) pair (#2944)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();

        // Seeded as the OWNER role, so `superuser_bypass` applies — which is
        // also the production write path: neither `Channel` nor
        // `ChannelMembership` has an `app_user` INSERT arm, deliberately. A
        // session that could mint a channel could impersonate a crop or an
        // oblast, and one that could add itself would bypass the `memberCount`
        // the join usecase maintains in the same transaction.
        for (const [i, id] of channels.entries()) {
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "Channel"("id","key","nameBg","nameEn","kind","updatedAt")
                 VALUES ($1,$2,'Пшеница','Wheat','CROP',NOW())`,
                id,
                `crop:p910-${SFX}-${i}`,
            );
        }

        const rng = makeRng(0x9d10);
        for (const person of people) {
            const mine = new Set<string>();
            for (const channel of channels) {
                // Roughly half the matrix gets a membership, so both sides of
                // the biconditional are populated. A matrix where everybody
                // belongs everywhere tests only the positive.
                if (rng() > 0.5) continue;
                const banned = rng() < BAN_RATE;
                await globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "ChannelMembership"("id","channelId","userId","bannedAt")
                     VALUES ($1,$2,$3,${banned ? 'NOW()' : 'NULL'})`,
                    `cm-p910-${SFX}-${randomUUID().slice(0, 12)}`,
                    channel,
                    person,
                );
                membershipRows += 1;
                if (banned) bannedPairs += 1;
                else mine.add(channel);
            }
            entitled.set(person, mine);
        }
    }, 180_000);

    afterAll(async () => {
        // By PREFIX, and in FK order. These tables are tenantless, so there is
        // no tenant row whose deletion would cascade — P8.9's teardown note.
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "ChannelPost" WHERE "id" LIKE $1`, `cp-p910-${SFX}-%`);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "ChannelMembership" WHERE "id" LIKE $1`, `cm-p910-${SFX}-%`);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "Channel" WHERE "id" LIKE $1`, `ch-p910-${SFX}-%`);
        await globalPrisma.$disconnect();
    }, 60_000);

    it('the fixture exists — the control for every count below', () => {
        // An empty matrix makes every set equality trivially true. P9.4's
        // `dormant` flag is the same idea one level up: a zero needs its
        // denominator beside it or "the rule found nothing" and "the rule
        // cannot fire" are the same reading.
        expect(channels).toHaveLength(CHANNELS);
        expect(membershipRows).toBeGreaterThan(PEOPLE);
        // Both arms of the ban rule have to be reachable, or the banned half
        // of the property is asserted over nothing.
        expect(bannedPairs).toBeGreaterThan(0);
        expect(membershipRows - bannedPairs).toBeGreaterThan(0);
    });

    it('a person can post EXACTLY where they hold an unbanned membership', async () => {
        const actual = new Map<string, Set<string>>();
        const refusals: string[] = [];
        let attempts = 0;
        let peopleWhoPosted = 0;

        for (const person of people) {
            const posted = new Set<string>();
            for (const channel of channels) {
                attempts += 1;
                const err = await postAs(person, channel, person);
                if (err === null) posted.add(channel);
                else refusals.push(err);
            }
            actual.set(person, posted);
            if (posted.size > 0) peopleWhoPosted += 1;
        }

        // THE PROPERTY. Per person, so a failure names who rather than
        // reporting a count nobody can act on.
        for (const person of people) {
            expect(actual.get(person)).toEqual(entitled.get(person));
        }

        expect(attempts).toBe(PEOPLE * CHANNELS);

        // CONTROL 1. Without it, a session bound to nothing refuses all 240
        // attempts and every equality above holds over empty sets — which is
        // only true if the fixture happened to entitle nobody.
        expect(peopleWhoPosted).toBeGreaterThan(PEOPLE / 2);

        // CONTROL 5 — the INSTRUMENT. A typo'd column refuses all 240 the same
        // way the policy refuses some, and a reader cannot tell the two apart
        // from a set comparison alone.
        expect(refusals.length).toBeGreaterThan(0);
        for (const message of refusals) expect(message).toMatch(RLS_REFUSAL);

        const allowed = [...actual.values()].reduce((n, s) => n + s.size, 0);
        console.log(
            `[p9-10-access] ${attempts} (person, channel) pairs · ${allowed} admitted · ` +
                `${refusals.length} refused · ${membershipRows} memberships of which ` +
                `${bannedPairs} banned · ${peopleWhoPosted}/${PEOPLE} posted somewhere`,
        );
    }, 300_000);

    it('CONTROL 2 — a stranger with no membership anywhere posts NOWHERE', async () => {
        let admitted = 0;
        for (const channel of channels) {
            if ((await postAs(STRANGER, channel, STRANGER)) === null) admitted += 1;
        }
        expect(admitted).toBe(0);
    }, 120_000);

    it('CONTROL 3 — and that stranger still READS the channel and its posts', async () => {
        // A channel is PUBLIC: `channel_select` and `channel_post_select` admit
        // any authenticated caller, because P9.2 cannot suggest a channel
        // nobody can read. So the zero above must be a zero about WRITING.
        // Checking the write alone would pass against a policy that had also
        // broken the public read — and the previous test would look stronger
        // for it, which is the trap.
        const [visibleChannels, visiblePosts] = await runInUserContext(
            ctxFor(STRANGER),
            async (tx) => {
                const c = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "Channel" WHERE "id" LIKE $1`,
                    `ch-p910-${SFX}-%`,
                );
                const p = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "ChannelPost" WHERE "id" LIKE $1`,
                    `cp-p910-${SFX}-%`,
                );
                return [Number(c[0].n), Number(p[0].n)];
            },
        );
        expect(visibleChannels).toBe(CHANNELS);
        // Non-zero because the property test above wrote them. If that test is
        // ever reordered or skipped this fails loudly rather than passing over
        // an empty table.
        expect(visiblePosts).toBeGreaterThan(0);
    }, 60_000);

    it('CONTROL 4 — a FORGED author is refused from an entitled session', async () => {
        // The set comparison cannot see this rule at all: every attempt above
        // used the session's own id as the author, so the author clause of the
        // WITH CHECK was satisfied in all 240 and is asserted by none of them.
        const [author] = [...entitled.entries()].find(([, s]) => s.size > 0) ?? [];
        expect(author).toBeDefined();
        const channel = [...entitled.get(author!)!][0];
        const victim = people.find((p) => p !== author)!;

        // The positive FIRST: this session, this channel, its own id — admitted.
        // Without it the refusal below could be any other cause.
        expect(await postAs(author!, channel, author!)).toBeNull();

        const forged = await postAs(author!, channel, victim);
        expect(forged).toMatch(RLS_REFUSAL);
    }, 60_000);

    it('and a BANNED member is refused in a channel they could otherwise post in', async () => {
        // Also invisible to the set comparison in one direction: a banned pair
        // and a no-membership pair are both "not entitled", so the equality
        // holds whether the ban arm works or the membership EXISTS check is
        // doing all the work. This separates them — same person, same channel,
        // membership present, refused.
        const victim = `u-p910-${SFX}-ban-probe`;
        const channel = channels[0];
        const row = `cm-p910-${SFX}-banprobe`;

        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ChannelMembership"("id","channelId","userId","bannedAt")
             VALUES ($1,$2,$3,NULL)`,
            row, channel, victim,
        );
        // Unbanned: admitted. This is the half that proves the refusal below
        // is about the ban and not about the membership.
        expect(await postAs(victim, channel, victim)).toBeNull();

        await globalPrisma.$executeRawUnsafe(
            `UPDATE "ChannelMembership" SET "bannedAt" = NOW() WHERE "id" = $1`, row);
        expect(await postAs(victim, channel, victim)).toMatch(RLS_REFUSAL);

        // The row SURVIVES the ban, which is what stops a rejoin from minting a
        // fresh unbanned row — `@@unique([channelId, userId])` plus this.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "ChannelMembership" WHERE "id" = $1`, row);
        expect(Number(rows[0].n)).toBe(1);
    }, 60_000);
});
