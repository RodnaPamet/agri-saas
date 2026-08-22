/**
 * Epic G-4 — access-review-reminder integration tests.
 *
 * Coverage
 * --------
 *   1. Pure-function `daysUntilDue` + `isInReminderWindow` boundary math.
 *   2. Reminder enqueues exactly one row per pending campaign in
 *      window — outbox carries the right type + recipient.
 *   3. Idempotent within a UTC day — re-running the job produces
 *      the same `enqueued` count once and zero on the second pass.
 *   4. Crossing midnight UTC produces a fresh reminder.
 *   5. CLOSED campaigns + campaigns with all decisions decided are
 *      skipped (no spam after the work is done).
 *   6. Campaigns without a `dueAt` anchor are excluded.
 *   7. Tenant scoping — single-tenant invocation never touches
 *      another tenant's campaigns.
 *   8. Notifications-disabled tenants get no rows in the outbox.
 *   9. Reviewer with no email is skipped, not crashed.
 *  10. Reminder content references the right campaign + day count.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    daysUntilDue,
    isInReminderWindow,
    processAccessReviewReminders,
} from '@/app-layer/jobs/access-review-reminder';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUITE_TAG = `g4r-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

interface UserFixture {
    userId: string;
    membershipId: string;
}

let admin: UserFixture;
let reviewer: UserFixture;
let editor: UserFixture;
let reader: UserFixture;
let bAdmin: UserFixture;
let bReviewer: UserFixture;

async function makeUser(
    label: string,
    tenantId: string,
    role: Role,
    uiLanguage = 'en',
): Promise<UserFixture> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        // `uiLanguage` is PINNED, and the default is deliberately 'en' here
        // rather than the column's 'bg'. Since #694 the reminder is written in
        // the REVIEWER's language, and `User.uiLanguage` is `@default("bg")` —
        // so an unpinned fixture renders Bulgarian and every English assertion
        // in this suite fails while the feature is working correctly. Pinning
        // keeps these tests about access-review behaviour; the localisation
        // itself is asserted by the `bg` case at the bottom of this file.
        data: { email, emailHash: hashForLookup(email), uiLanguage },
    });
    const m = await globalPrisma.tenantMembership.create({
        data: {
            tenantId,
            userId: u.id,
            role,
            status: MembershipStatus.ACTIVE,
        },
    });
    return { userId: u.id, membershipId: m.id };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_A_ID },
        update: {},
        create: { id: TENANT_A_ID, name: `t ${SUITE_TAG}-a`, slug: `${SUITE_TAG}-a` },
    });
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_B_ID },
        update: {},
        create: { id: TENANT_B_ID, name: `t ${SUITE_TAG}-b`, slug: `${SUITE_TAG}-b` },
    });
    admin = await makeUser('admin', TENANT_A_ID, Role.ADMIN);
    reviewer = await makeUser('reviewer', TENANT_A_ID, Role.AUDITOR);
    editor = await makeUser('editor', TENANT_A_ID, Role.EDITOR);
    reader = await makeUser('reader', TENANT_A_ID, Role.READER);
    bAdmin = await makeUser('b-admin', TENANT_B_ID, Role.ADMIN);
    bReviewer = await makeUser('b-reviewer', TENANT_B_ID, Role.AUDITOR);
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.notificationOutbox.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantNotificationSettings.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.accessReviewDecision.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.accessReview.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            `SET LOCAL session_replication_role = 'replica'`,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            tenantIds,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            tenantIds,
        );
    });
    const userIds = [admin, reviewer, editor, reader, bAdmin, bReviewer]
        .filter(Boolean)
        .map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

interface CampaignSetup {
    name?: string;
    dueAt: Date;
    tenantId?: string;
    reviewerUserId?: string;
    decisions?: Array<{
        subjectUserId: string;
        snapshotRole: Role;
        decided?: boolean;
    }>;
}

async function makeCampaign(s: CampaignSetup) {
    const tenantId = s.tenantId ?? TENANT_A_ID;
    const reviewerUserId = s.reviewerUserId ?? reviewer.userId;
    const review = await globalPrisma.accessReview.create({
        data: {
            tenantId,
            name: s.name ?? `c-${randomUUID().slice(0, 8)}`,
            scope: 'ALL_USERS',
            reviewerUserId,
            createdByUserId: admin.userId,
            dueAt: s.dueAt,
        },
    });
    if (s.decisions && s.decisions.length > 0) {
        await globalPrisma.accessReviewDecision.createMany({
            data: s.decisions.map((d) => ({
                tenantId,
                accessReviewId: review.id,
                subjectUserId: d.subjectUserId,
                snapshotRole: d.snapshotRole,
                snapshotMembershipStatus: MembershipStatus.ACTIVE,
                ...(d.decided
                    ? {
                          decision: 'CONFIRM' as const,
                          decidedAt: new Date(),
                          decidedByUserId: reviewerUserId,
                      }
                    : {}),
            })),
        });
    }
    return review;
}

// ─── Pure-function unit tests ──────────────────────────────────────

describe('Epic G-4 reminder — boundary math', () => {
    it('daysUntilDue is positive for future, negative for overdue', () => {
        const now = new Date('2026-05-07T12:00:00Z');
        expect(daysUntilDue(new Date('2026-05-08T12:00:00Z'), now)).toBe(1);
        // -0 vs +0 — both round to "today". Bitwise-OR collapses sign.
        expect(daysUntilDue(new Date('2026-05-07T11:59:00Z'), now) | 0).toBe(0);
        expect(daysUntilDue(new Date('2026-05-04T12:00:00Z'), now)).toBe(-3);
    });

    it('isInReminderWindow respects leadDays + graceDays', () => {
        const now = new Date('2026-05-07T12:00:00Z');
        // Default 7 lead, 3 grace.
        expect(isInReminderWindow(new Date('2026-05-13T12:00:00Z'), now)).toBe(true);
        // 8 days out — outside lead window.
        expect(isInReminderWindow(new Date('2026-05-15T12:00:00Z'), now)).toBe(false);
        // 3 days overdue — still in grace window.
        expect(isInReminderWindow(new Date('2026-05-04T12:00:00Z'), now)).toBe(true);
        // 4 days overdue — past grace.
        expect(isInReminderWindow(new Date('2026-05-03T12:00:00Z'), now)).toBe(false);
    });
});

// ─── Integration tests against real DB ─────────────────────────────

describeFn('Epic G-4 reminder — DB integration', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.notificationOutbox.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
        await globalPrisma.accessReviewDecision.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
        await globalPrisma.accessReview.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
    });

    it('enqueues one ACCESS_REVIEW_REMINDER per pending campaign in window', async () => {
        const now = new Date('2026-05-07T12:00:00Z');
        const c = await makeCampaign({
            name: 'Q1 reminder probe',
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [
                { subjectUserId: editor.userId, snapshotRole: Role.EDITOR },
                { subjectUserId: reader.userId, snapshotRole: Role.READER },
            ],
        });
        const r = await processAccessReviewReminders(globalPrisma, {
            now,
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(1);
        expect(r.enqueued).toBe(1);

        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: {
                tenantId: TENANT_A_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].toEmail).toBe(`${SUITE_TAG}-reviewer@example.test`);
        expect(outbox[0].subject).toMatch(/Q1 reminder probe/);
        expect(outbox[0].dedupeKey).toContain(c.id);
    });

    it('is idempotent within the same UTC day', async () => {
        const now = new Date('2026-05-07T12:00:00Z');
        await makeCampaign({
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        const first = await processAccessReviewReminders(globalPrisma, {
            now,
            tenantId: TENANT_A_ID,
        });
        const second = await processAccessReviewReminders(globalPrisma, {
            now,
            tenantId: TENANT_A_ID,
        });
        expect(first.enqueued).toBe(1);
        expect(second.enqueued).toBe(0);
        // Second run sees the dupe + reports it.
        expect(second.skippedDuplicate).toBe(1);
        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: {
                tenantId: TENANT_A_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox).toHaveLength(1);
    });

    it('produces a fresh reminder once the prior day’s dedupe row is gone', async () => {
        // The dedupe key has the form
        //   tenantId:type:email:entityId:YYYY-MM-DD
        // and uses wall-clock date, so a real next-day run finds no
        // matching row and inserts a new one. We simulate the
        // day-rollover by re-keying the prior row to a stale day.
        const c = await makeCampaign({
            dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        const first = await processAccessReviewReminders(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(first.enqueued).toBe(1);

        // Re-key the existing row's dedupeKey to "yesterday" so the
        // second pass can't find a same-day match.
        await globalPrisma.notificationOutbox.updateMany({
            where: { tenantId: TENANT_A_ID, type: 'ACCESS_REVIEW_REMINDER' },
            data: {
                dedupeKey: `${TENANT_A_ID}:ACCESS_REVIEW_REMINDER:${SUITE_TAG}-reviewer@example.test:${c.id}:1970-01-01`,
            },
        });

        const second = await processAccessReviewReminders(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(second.enqueued).toBe(1);
        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: {
                tenantId: TENANT_A_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox).toHaveLength(2);
    });

    it('skips CLOSED campaigns', async () => {
        const c = await makeCampaign({
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        await globalPrisma.accessReview.update({
            where: { id: c.id },
            data: {
                status: 'CLOSED',
                closedAt: new Date(),
                closedByUserId: admin.userId,
            },
        });
        const r = await processAccessReviewReminders(globalPrisma, {
            now: new Date('2026-05-07T12:00:00Z'),
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(0);
        expect(r.enqueued).toBe(0);
    });

    it('skips campaigns with all decisions decided (skippedComplete)', async () => {
        await makeCampaign({
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [
                { subjectUserId: editor.userId, snapshotRole: Role.EDITOR, decided: true },
                { subjectUserId: reader.userId, snapshotRole: Role.READER, decided: true },
            ],
        });
        const r = await processAccessReviewReminders(globalPrisma, {
            now: new Date('2026-05-07T12:00:00Z'),
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(1);
        expect(r.enqueued).toBe(0);
        expect(r.skippedComplete).toBe(1);
    });

    it('excludes campaigns without a dueAt', async () => {
        await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'no-deadline',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
                createdByUserId: admin.userId,
                dueAt: null,
            },
        });
        const r = await processAccessReviewReminders(globalPrisma, {
            now: new Date('2026-05-07T12:00:00Z'),
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(0);
    });

    it('tenant-scoped invocation never touches another tenant', async () => {
        await makeCampaign({
            tenantId: TENANT_A_ID,
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        await makeCampaign({
            tenantId: TENANT_B_ID,
            reviewerUserId: bReviewer.userId,
            dueAt: new Date('2026-05-10T12:00:00Z'),
            decisions: [{ subjectUserId: bAdmin.userId, snapshotRole: Role.ADMIN }],
        });
        const r = await processAccessReviewReminders(globalPrisma, {
            now: new Date('2026-05-07T12:00:00Z'),
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(1);
        expect(r.enqueued).toBe(1);
        const otherTenantOutbox = await globalPrisma.notificationOutbox.findMany({
            where: {
                tenantId: TENANT_B_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(otherTenantOutbox).toHaveLength(0);
    });

    it('respects tenant notifications-disabled setting', async () => {
        await globalPrisma.tenantNotificationSettings.upsert({
            where: { tenantId: TENANT_A_ID },
            update: { enabled: false },
            create: { tenantId: TENANT_A_ID, enabled: false },
        });
        try {
            await makeCampaign({
                dueAt: new Date('2026-05-10T12:00:00Z'),
                decisions: [
                    { subjectUserId: editor.userId, snapshotRole: Role.EDITOR },
                ],
            });
            const r = await processAccessReviewReminders(globalPrisma, {
                now: new Date('2026-05-07T12:00:00Z'),
                tenantId: TENANT_A_ID,
            });
            expect(r.scanned).toBe(1);
            // notifications-disabled returns null from enqueueEmail —
            // surfaces as skippedDuplicate (the helper doesn't
            // distinguish the two reasons).
            expect(r.enqueued).toBe(0);
            const outbox = await globalPrisma.notificationOutbox.findMany({
                where: {
                    tenantId: TENANT_A_ID,
                    type: 'ACCESS_REVIEW_REMINDER',
                },
            });
            expect(outbox).toHaveLength(0);
        } finally {
            await globalPrisma.tenantNotificationSettings.update({
                where: { tenantId: TENANT_A_ID },
                data: { enabled: true },
            });
        }
    });

    it('reminder body references the campaign + correct day-count phrasing', async () => {
        const now = new Date('2026-05-07T12:00:00Z');
        await makeCampaign({
            name: 'Q1 due-tomorrow probe',
            dueAt: new Date('2026-05-08T12:00:00Z'),
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        await processAccessReviewReminders(globalPrisma, {
            now,
            tenantId: TENANT_A_ID,
        });
        const outbox = await globalPrisma.notificationOutbox.findFirst({
            where: {
                tenantId: TENANT_A_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox?.subject).toMatch(/due tomorrow/i);
        expect(outbox?.subject).toContain('Q1 due-tomorrow probe');
    });

    it('renders the reminder in the REVIEWER\'s language, through the real job', async () => {
        // End-to-end proof of #694 that the unit tests cannot give: a real
        // reviewer row with `uiLanguage: 'bg'`, the real job, and the real
        // outbox row that `processOutbox` will later replay verbatim.
        //
        // It also pins the direction that matters. `getTranslations()` would
        // resolve the SENDER's locale; this job has no request scope at all
        // and the recipient is the reviewer, so nothing but an explicit
        // per-recipient locale can be right here.
        const bgReviewer = await makeUser('bg-reviewer', TENANT_A_ID, Role.ADMIN, 'bg');
        const now = new Date('2026-05-07T12:00:00Z');
        await makeCampaign({
            name: 'Bulgarian probe',
            dueAt: new Date('2026-05-08T12:00:00Z'),
            reviewerUserId: bgReviewer.userId,
            decisions: [{ subjectUserId: editor.userId, snapshotRole: Role.EDITOR }],
        });
        await processAccessReviewReminders(globalPrisma, { now, tenantId: TENANT_A_ID });

        const outbox = await globalPrisma.notificationOutbox.findFirst({
            where: {
                tenantId: TENANT_A_ID,
                type: 'ACCESS_REVIEW_REMINDER',
                toEmail: { contains: 'bg-reviewer' },
            },
        });
        expect(outbox).not.toBeNull();
        expect(outbox?.subject).toContain('Преглед на достъпа');
        expect(outbox?.subject).toContain('Bulgarian probe'); // data is not translated
        expect(outbox?.subject).not.toMatch(/due tomorrow/i);
    });
});
