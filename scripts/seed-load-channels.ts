/**
 * A 2,000-member channel for the P9.10 load run (#2944).
 *
 * ## What the criterion needs, and what it does NOT
 *
 * «a 2,000-member channel at p95 ≤2s». The 2,000 is the channel's SIZE — it is
 * what makes `Channel.memberCount` large and what any membership-scoped query
 * has to cope with. It is NOT the number of readers: the readers are the k6
 * VUs, and they log in as the accounts `seed-load-streams.ts` already creates.
 *
 * That split is possible because **`ChannelMembership.userId` has no relation
 * to `User`** — P9.1 made every person column on these tenantless tables a
 * bare string, so a membership costs one row and no account. Seeding 2,000
 * real users to satisfy a size criterion would have been a day's work and
 * several thousand rows for a number nothing reads as a credential.
 *
 * ## Not production, and the guard is not a hostname check
 *
 * Identical to `seed-load-streams.ts`, for the reason that seeder gives: the
 * throwaway VM is restored FROM a production dump, so no property of the
 * connection string separates them. `LOAD_SEED_CONFIRM` must carry the exact
 * phrase, every row is addressable by a dedicated prefix, and `--teardown`
 * deletes exactly what the state file records.
 *
 * ## The flag is switched HERE, deliberately, and restored on teardown
 *
 * `social.channels` default-OFF means every feed read answers 404 through
 * `assertFeatureEnabled` — and #2944 names that trap directly: "a 404 from a
 * disabled flag is deliberate, not a cache problem; a load test against a
 * flagged surface must enable the flag or it measures the refusal." A run that
 * measured 2,000 refusals at 8ms would report a magnificent p95.
 *
 * The flag's prior state is recorded BEFORE the write so teardown restores it
 * rather than guessing, which matters because the throwaway VM may have been
 * restored from a dump where it was already on.
 *
 * Usage:
 *   LOAD_SEED_CONFIRM='yes-this-is-a-throwaway-vm' \
 *     npx tsx scripts/seed-load-channels.ts --members 2000 --posts 500 --enable-flag
 *   LOAD_SEED_CONFIRM='yes-this-is-a-throwaway-vm' \
 *     npx tsx scripts/seed-load-channels.ts --teardown
 */
import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const CONFIRM_PHRASE = 'yes-this-is-a-throwaway-vm';

/**
 * Spelled as a LITERAL because `social-routes-flag-gated` extracts literals,
 * and an operator holding the console has to be able to find the key by
 * reading the code that needs it.
 */
const FLAG_KEY = 'social.channels';

/** Every row this writes is addressable by this prefix. */
const PREFIX = 'load-p910';

const STATE_FILE = path.resolve(__dirname, '../.load-channels-seed.json');

interface SeedState {
    channelId: string;
    channelKey: string;
    members: number;
    posts: number;
    /** The flag's state BEFORE this run, so teardown restores it. */
    flagBefore: { present: boolean; enabled: boolean; cohorts: string[] } | null;
}

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

function arg(name: string): string | null {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function requireConfirmation(): void {
    if (process.env.LOAD_SEED_CONFIRM !== CONFIRM_PHRASE) {
        throw new Error(
            `Refusing to run. Set LOAD_SEED_CONFIRM='${CONFIRM_PHRASE}'.\n` +
                `This writes thousands of channel rows and (with --enable-flag) switches ` +
                `channels on for every user on this database. A VM restored from a ` +
                `production dump is indistinguishable from production by its connection ` +
                `string, so the confirmation is the only guard there is.`,
        );
    }
}

async function readFlag(): Promise<SeedState['flagBefore']> {
    const row = await prisma.featureFlag.findUnique({ where: { key: FLAG_KEY } });
    if (!row) return { present: false, enabled: false, cohorts: [] };
    return { present: true, enabled: row.enabled, cohorts: [...row.cohorts] };
}

async function seed(): Promise<void> {
    const members = Number(arg('members') ?? 2000);
    const posts = Number(arg('posts') ?? 500);
    if (!Number.isInteger(members) || members < 1) throw new Error('--members must be a positive integer');
    if (!Number.isInteger(posts) || posts < 0) throw new Error('--posts must be a non-negative integer');

    if (fs.existsSync(STATE_FILE)) {
        throw new Error(
            `${STATE_FILE} already exists. Tear the previous seed down first — ` +
                `two seeds would leave the first one's rows with nothing recording them.`,
        );
    }

    const flagBefore = await readFlag();

    const channelId = `ch-${PREFIX}-${Date.now()}`;
    const channelKey = `crop:${PREFIX}-${Date.now()}`;
    await prisma.channel.create({
        data: {
            id: channelId,
            key: channelKey,
            nameBg: 'Товарен тест',
            nameEn: 'Load test',
            kind: 'CROP',
            memberCount: members,
        },
    });

    // `createMany` in batches: one 2,000-row statement is fine for Postgres and
    // not for a pooled connection's statement size on some configurations, and
    // the batching costs nothing.
    const BATCH = 500;
    for (let start = 0; start < members; start += BATCH) {
        const rows = Array.from({ length: Math.min(BATCH, members - start) }, (_, k) => ({
            id: `cm-${PREFIX}-${start + k}`,
            channelId,
            userId: `u-${PREFIX}-${start + k}`,
        }));
        await prisma.channelMembership.createMany({ data: rows });
    }

    for (let start = 0; start < posts; start += BATCH) {
        const rows = Array.from({ length: Math.min(BATCH, posts - start) }, (_, k) => ({
            id: `cp-${PREFIX}-${start + k}`,
            channelId,
            // An author who IS a member, so the feed's author resolution has
            // something to resolve rather than measuring the null path.
            authorUserId: `u-${PREFIX}-${(start + k) % members}`,
            body: `Товарен тест ${start + k}`,
        }));
        await prisma.channelPost.createMany({ data: rows });
    }

    if (has('enable-flag')) {
        await prisma.featureFlag.upsert({
            where: { key: FLAG_KEY },
            create: { key: FLAG_KEY, enabled: true, cohorts: [] },
            update: { enabled: true, cohorts: [] },
        });
        console.log(`▸ ${FLAG_KEY} enabled (was ${JSON.stringify(flagBefore)})`);
    } else {
        console.log(
            `⚠ ${FLAG_KEY} NOT enabled. Without --enable-flag every feed read answers 404 ` +
                `and the run measures the refusal, not the feed.`,
        );
    }

    const state: SeedState = { channelId, channelKey, members, posts, flagBefore };
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

    // The DENOMINATOR, printed. #2944 asks for the round-trip count beside the
    // percentile for the run; the same rule applies to the fixture — "2,000
    // members" is a claim, and this is the read-back that supports it.
    const [memberCount, postCount] = await Promise.all([
        prisma.channelMembership.count({ where: { channelId } }),
        prisma.channelPost.count({ where: { channelId } }),
    ]);
    if (memberCount !== members) {
        throw new Error(
            `Seeded ${memberCount} memberships, expected ${members}. The run would have ` +
                `measured a channel that is not the size the criterion names.`,
        );
    }
    console.log(
        `✅ channel ${channelId} — ${memberCount} members, ${postCount} posts. State → ${STATE_FILE}`,
    );
    console.log(`CHANNEL_ID=${channelId}`);
}

async function teardown(): Promise<void> {
    if (!fs.existsSync(STATE_FILE)) {
        throw new Error(
            `No state file at ${STATE_FILE}. Teardown deletes only what a seed run ` +
                `recorded, so there is nothing safe to do here.`,
        );
    }
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SeedState;

    // BY ID, never by a participant-style query — #2944 names this: a channel
    // is tenantless, so deleting a load tenant cascades to nothing, and a
    // pattern query would match a real channel that happened to look like one
    // of ours.
    const deletedPosts = await prisma.channelPost.deleteMany({
        where: { channelId: state.channelId },
    });
    const deletedMembers = await prisma.channelMembership.deleteMany({
        where: { channelId: state.channelId },
    });
    await prisma.channel.deleteMany({ where: { id: state.channelId } });

    if (state.flagBefore) {
        if (state.flagBefore.present) {
            await prisma.featureFlag.update({
                where: { key: FLAG_KEY },
                data: { enabled: state.flagBefore.enabled, cohorts: state.flagBefore.cohorts },
            });
            console.log(`▸ ${FLAG_KEY} restored to ${JSON.stringify(state.flagBefore)}`);
        } else {
            await prisma.featureFlag.deleteMany({ where: { key: FLAG_KEY } });
            console.log(`▸ ${FLAG_KEY} removed — it did not exist before the seed`);
        }
    }

    fs.rmSync(STATE_FILE);
    console.log(
        `✅ torn down channel ${state.channelId} — ${deletedMembers.count} members, ` +
            `${deletedPosts.count} posts`,
    );
}

async function main(): Promise<void> {
    requireConfirmation();
    if (has('teardown')) await teardown();
    else await seed();
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
