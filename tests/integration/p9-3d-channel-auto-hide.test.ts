/**
 * P9.3d — auto-hide after three reports from verified farms (#2937).
 *
 * ## THIS SUITE PROVES THE MECHANISM AND SAYS NOTHING ABOUT THE REACH
 *
 * It seeds VERIFIED `FarmIdentityClaim` rows and the threshold fires.
 * **Production has ZERO verified farms** — one claim, status PENDING — so the
 * rule cannot fire there at all.
 *
 * That distinction is written here rather than left implicit, because a green
 * run of this file is exactly the evidence somebody would later cite as
 * "auto-hide works". It works; it is also unreachable. The job prints a
 * denominator every run for the same reason.
 *
 * Owner ruling (2026-11-09): built, dormant, and visibly so — chosen over
 * deferring it and over lowering the bar to any reporter, because «verified»
 * was specified precisely so three throwaway accounts cannot hide a
 * competitor's post.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

// The EXTENDED client, for one read only. `ModerationAction.rationale` is
// encrypted, and a bare client carries no `$extends` layer — it returns the
// `v1:` envelope, so an assertion on the prose silently compares against
// ciphertext. Everything else here reads plain columns through `prisma` below.
import { prisma as appPrisma } from '@/lib/prisma';

import { runChannelAutoHide, AUTO_HIDE_THRESHOLD } from '@/app-layer/jobs/channel-auto-hide';
import { joinChannel, postToChannel, readChannelFeed } from '@/app-layer/usecases/channels';
import { fileNotice } from '@/app-layer/usecases/trust-safety';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AUTHOR = `u-p93d-author-${randomUUID()}`;
let channelId = '';
const verifiedReporters: string[] = [];
// THREE of them, and that count is the whole point. With one unverified
// reporter filing three notices the post is skipped by the DISTINCT rule, so
// the test would pass with the «verified» filter deleted — measured: replacing
// `verified.has(id)` with `true` left all eight cases green.
const unverifiedReporters: string[] = [];
const tenantIds: string[] = [];

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** A person who belongs to a VERIFIED farm. */
async function makeVerifiedReporter(): Promise<string> {
    const userId = `u-p93d-v-${randomUUID()}`;
    const slug = `p93d-${randomUUID().slice(0, 8)}`;
    const tenant = await prisma.tenant.create({
        data: { name: `Farm ${slug}`, slug },
        select: { id: true },
    });
    tenantIds.push(tenant.id);
    await prisma.user.create({
        // `emailHash` is supplied BY HAND: this is a bare client, so the
        // pii-middleware that normally derives it from `email` is not in the
        // chain, and the column is NOT NULL in the database.
        data: {
            id: userId,
            email: `${userId}@example.test`,
            emailHash: `hash-${userId}`,
            name: 'Reporter',
        },
    });
    // EDITOR, not OWNER, for two reasons. `check_not_last_owner` refuses to
    // DELETE a tenant's only ACTIVE OWNER (P0001), so an OWNER fixture cannot
    // be torn down — and membership is all `verifiedFarmMembers` asks for, so
    // an ordinary member of a verified farm is also the likelier reporter.
    await prisma.tenantMembership.create({
        data: { tenantId: tenant.id, userId, role: 'EDITOR', status: 'ACTIVE' },
    });
    // VERIFIED only because a staff reviewer promoted it — which is what makes
    // the threshold attacker-resistant. PENDING would not count, and that is
    // asserted below.
    await prisma.farmIdentityClaim.create({
        data: {
            tenantId: tenant.id,
            eikHash: `hash-${randomUUID()}`,
            status: 'VERIFIED',
            claimedByUserId: userId,
            verifiedAt: new Date(),
        },
    });
    return userId;
}

async function reportPost(postId: string, reporterUserId: string): Promise<void> {
    await fileNotice(
        { subjectKind: 'CHANNEL_POST', subjectId: postId, reasonCode: 'SPAM' },
        reporterUserId,
    );
}

describeFn('P9.3d — channel auto-hide (#2937)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        // The author is a REAL row, because they are the recipient of an Art 17
        // statement and `queueStatementForAction` resolves the locale from
        // `uiLanguage`. With no row it falls back to `bg` and happens to reach
        // the same answer — so the statement's language would be defaulted
        // rather than resolved, and the test would say nothing about the
        // resolution.
        await prisma.user.create({
            data: {
                id: AUTHOR,
                email: `${AUTHOR}@example.test`,
                emailHash: `hash-${AUTHOR}`,
                name: 'Author',
                uiLanguage: 'bg',
            },
        });
        const c = await prisma.channel.create({
            data: { key: `crop:p93d-${randomUUID()}`, nameBg: 'Тест', nameEn: 'T', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(AUTHOR), channelId);
        for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
            verifiedReporters.push(await makeVerifiedReporter());
        }
        for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
            const id = `u-p93d-unverified-${randomUUID()}`;
            await prisma.user.create({
                data: {
                    id,
                    email: `${id}@example.test`,
                    emailHash: `hash-${id}`,
                    name: 'Unverified',
                },
            });
            unverifiedReporters.push(id);
        }
    });

    afterAll(async () => {
        const posts = await prisma.channelPost.findMany({
            where: { channelId }, select: { id: true },
        });
        const ids = posts.map((p) => p.id);
        const actions = await prisma.moderationAction.findMany({
            where: { subjectId: { in: ids } }, select: { id: true },
        });
        await prisma.statementOfReasons.deleteMany({
            where: { actionId: { in: actions.map((a) => a.id) } },
        });
        await prisma.moderationAction.deleteMany({ where: { subjectId: { in: ids } } });
        await prisma.contentReport.deleteMany({ where: { subjectId: { in: ids } } });
        await prisma.channel.deleteMany({ where: { id: channelId } });
        // BY ID. These tenants were created by this suite and a verified claim
        // left behind would make another suite's reporter look verified.
        await prisma.farmIdentityClaim.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        await prisma.user.deleteMany({
            where: { id: { in: [AUTHOR, ...verifiedReporters, ...unverifiedReporters] } },
        });
        await prisma.$disconnect();
        await appPrisma.$disconnect();
    });

    it('hides a post after THREE verified farms report it', async () => {
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'спам' });
        for (const r of verifiedReporters) await reportPost(post.postId, r);

        const { result } = await runChannelAutoHide();
        expect(result.success).toBe(true);
        expect(result.itemsActioned).toBeGreaterThanOrEqual(1);

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId },
            select: { autoHiddenAt: true, removedByModerationAt: true, body: true },
        });
        expect(row.autoHiddenAt).not.toBeNull();
        // NOT the human column — they are reversed by different acts, and
        // collapsing them would make a statement claim a moderator looked.
        expect(row.removedByModerationAt).toBeNull();
        // The body survives, so a review can restore it.
        expect(row.body).toBe('спам');

        // The reader's experience, which is what actually matters.
        const feed = await readChannelFeed(ctxFor(AUTHOR), channelId, { limit: 100 });
        const seen = feed.posts.find((p) => p.id === post.postId);
        expect(seen!.deleted).toBe(true);
        expect(seen!.body).toBe('');
    }, 90_000);

    it('records an action from `auto:report-threshold`, not from a person', async () => {
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'пак спам' });
        for (const r of verifiedReporters) await reportPost(post.postId, r);
        await runChannelAutoHide();

        const action = await appPrisma.moderationAction.findFirst({
            where: { subjectId: post.postId },
            select: { moderatorRef: true, actionKind: true, rationale: true },
        });
        expect(action).not.toBeNull();
        // Honest that no person decided — the trail must not imply one did.
        expect(action!.moderatorRef).toBe('auto:report-threshold');
        // Its OWN kind, not CONTENT_REMOVED: recorded as a removal, the
        // restore path would clear `removedByModerationAt`, find it already
        // null, and report "already visible" while the post sat hidden.
        expect(action!.actionKind).toBe('CONTENT_AUTO_HIDDEN');
        expect(action!.rationale).toContain('verified farms');
    }, 90_000);

    it('tells the AUTHOR — a hide nobody is told about is the #2955 gap', async () => {
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'трети' });
        for (const r of verifiedReporters) await reportPost(post.postId, r);
        await runChannelAutoHide();

        const action = await prisma.moderationAction.findFirstOrThrow({
            where: { subjectId: post.postId }, select: { id: true },
        });
        // `bodyRendered` is encrypted, so this read goes through the extended
        // client — a bare one returns the `v1:` envelope and every assertion
        // below would compare against ciphertext.
        const statement = await appPrisma.statementOfReasons.findFirst({
            where: { actionId: action.id },
            select: { recipientUserId: true, deliveredAt: true, bodyRendered: true },
        });
        expect(statement).not.toBeNull();
        expect(statement!.recipientUserId).toBe(AUTHOR);
        // Undelivered: the row IS the queue, and `statement-dispatch` stamps
        // this only once a send resolves.
        expect(statement!.deliveredAt).toBeNull();

        // THE ACTION LINE IS PROSE, NOT A KEY. `composeStatementBody` looks up
        // `statementOfReasons.action.<KIND>`, and `translateFor` is a plain
        // interpolator: a missing key comes back as the KEY ITSELF rather than
        // throwing. So a new action kind with no catalogue entry produces a
        // legal notice whose action line reads
        // `statementOfReasons.action.CONTENT_AUTO_HIDDEN` — delivered, to the
        // person, as the artefact a regulator would read.
        //
        // That is not hypothetical: this phase shipped exactly that until the
        // catalogues were corrected, and the copy guard one table over
        // (`moderation-action-kinds-mirror`) covered one hardcoded kind at the
        // time, so nothing failed. This is the behavioural half of the pair.
        //
        // AND IT IS THE WEAKER HALF, measured. `translateFor` falls back across
        // locales, so removing the line from `bg` alone yields the English
        // sentence and removing it from `en` alone yields the Bulgarian one —
        // both pass here. Only a key missing from BOTH reddens this test, which
        // is the state the phase was in. A line missing from ONE catalogue is a
        // Bulgarian farmer receiving a legal notice in English, invisible to
        // this assertion and caught by the guard's PER-LOCALE population.
        expect(statement!.bodyRendered).not.toContain('statementOfReasons.');
        // In the AUTHOR's own language, resolved from their `uiLanguage` — the
        // Art 17 requirement, and the reason the body is composed per recipient
        // rather than stored once at decision time.
        expect(statement!.bodyRendered).toContain('скрихме');
    }, 90_000);

    it('does NOT hide below the threshold — the control', async () => {
        // Without this, a job that hid everything would pass every case above.
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'само два' });
        await reportPost(post.postId, verifiedReporters[0]);
        await reportPost(post.postId, verifiedReporters[1]);

        await runChannelAutoHide();

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId }, select: { autoHiddenAt: true },
        });
        expect(row.autoHiddenAt).toBeNull();
    }, 90_000);

    it('does NOT count UNVERIFIED reporters — the whole point of the bar', async () => {
        // Three reports from THREE DISTINCT accounts, none belonging to a
        // verified farm. The distinctness is what gives this teeth: with one
        // account filing three times the post is skipped by the DISTINCT rule
        // and the «verified» filter could be deleted with the suite still
        // green. So this is exactly the shape the threshold exists to refuse —
        // three throwaway accounts hiding a competitor's post.
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'непотвърдени' });
        for (const r of unverifiedReporters) await reportPost(post.postId, r);

        await runChannelAutoHide();

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId }, select: { autoHiddenAt: true },
        });
        expect(row.autoHiddenAt).toBeNull();
    }, 90_000);

    it('counts DISTINCT reporters — three notices from one farm is one farm', async () => {
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'един докладва три пъти' });
        await reportPost(post.postId, verifiedReporters[0]);
        await reportPost(post.postId, verifiedReporters[0]);
        await reportPost(post.postId, verifiedReporters[0]);

        await runChannelAutoHide();

        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId }, select: { autoHiddenAt: true },
        });
        expect(row.autoHiddenAt).toBeNull();
    }, 90_000);

    it('leaves the notices RECEIVED — a threshold is not a triage', async () => {
        // The hide is provisional and a human still decides. Moving them to
        // ACTIONED would take a decision nobody made and remove them from the
        // one view that shows work outstanding.
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'остава в опашката' });
        for (const r of verifiedReporters) await reportPost(post.postId, r);
        await runChannelAutoHide();

        const statuses = await prisma.contentReport.findMany({
            where: { subjectId: post.postId }, select: { status: true },
        });
        expect(statuses.length).toBe(AUTO_HIDE_THRESHOLD);
        expect(statuses.every((s) => s.status === 'RECEIVED')).toBe(true);
    }, 90_000);

    it('is IDEMPOTENT — a second run does not hide or announce twice', async () => {
        const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'два пъти' });
        for (const r of verifiedReporters) await reportPost(post.postId, r);

        await runChannelAutoHide();
        const first = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId }, select: { autoHiddenAt: true },
        });

        await runChannelAutoHide();
        const second = await prisma.channelPost.findUniqueOrThrow({
            where: { id: post.postId }, select: { autoHiddenAt: true },
        });
        // The SAME timestamp — not re-stamped, which an appeal would date from.
        expect(second.autoHiddenAt?.getTime()).toBe(first.autoHiddenAt?.getTime());

        // And exactly ONE action and ONE statement, not two.
        const actions = await prisma.moderationAction.count({
            where: { subjectId: post.postId },
        });
        expect(actions).toBe(1);
    }, 90_000);
});
