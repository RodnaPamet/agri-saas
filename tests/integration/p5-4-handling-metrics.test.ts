/**
 * P5.4's third exit criterion, which was the one nothing computed (#1595).
 *
 *   > *Median notice handling is **measured** from `createdAt` to
 *   > `deliveredAt`, not estimated.*
 *
 * The statements route's docblock said the figure "is measurable" — true, and
 * not the same claim. Nothing computed it, so P5's exit ("median notice
 * handling under 24h") could only have been asserted. This suite drives the
 * computation against real rows and real Postgres, because the median is
 * `percentile_cont` and a hand-rolled JS median would be testing different
 * arithmetic than production runs.
 *
 * ## The case that matters most is the EMPTY one
 *
 * On this deployment today the honest answer is n=0: nothing has been answered.
 * A median of 0 seconds would be the most flattering possible reading of no
 * data, and it is the reading a `COALESCE(..., 0)` produces. So the first case
 * pins `null`, and `n` travels beside every figure.
 *
 * ## Two of the counters are deliberately NOT window-scoped
 *
 * `undelivered` and `unalerted` count every row, not just recent ones. An Art
 * 17 statement queued eleven months ago and never sent is the WORST case, not
 * an irrelevant one — windowing it would hide the breaches that matter most.
 * The cost is that both are global, so other suites' rows land in them, and
 * these cases assert a DELTA rather than an absolute. An absolute would pass
 * alone and fail in a full run, which is the flake this repo has paid for
 * before.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { moderationHandlingStats, HANDLING_TARGET_SECONDS } from '@/app-layer/usecases/moderation';
import { encryptField } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;

const reports: string[] = [];
const actions: string[] = [];
const statements: string[] = [];

/** A notice received at a chosen instant, so a lag is a fact rather than a race. */
async function makeNotice(createdAt: Date, alertedAt: Date | null = new Date()): Promise<string> {
    const id = `cr-p54m-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","createdAt","subjectKind","subjectId","reasonCode","status","alertedAt")
         VALUES ($1,$2,'LISTING',$3,'MISLEADING_LISTING'::"ReportReasonCode",'ACTIONED',$4)`,
        id, createdAt, `listing-${randomUUID()}`, alertedAt,
    );
    reports.push(id);
    return id;
}

/**
 * An action at an EXPLICIT time.
 *
 * My first version let `createdAt` default to now(). Every fixture here
 * back-dates its notice, so the decision lag came out as days for all of them
 * and the decision median exceeded the answer median — which inverted the one
 * assertion that distinguishes the two clocks. A default that is wrong for
 * every caller is worse than a required argument.
 */
async function makeAction(reportId: string | null, createdAt: Date): Promise<string> {
    const id = `ma-p54m-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ModerationAction"
           ("id","createdAt","reportId","moderatorRef","actionKind","subjectKind","subjectId","rationale")
         VALUES ($1,$2,$3,'key:test','CONTENT_REMOVED'::"ModerationActionKind",
                 'LISTING',$4,$5)`,
        id, createdAt, reportId, `listing-${randomUUID()}`, encryptField('because'),
    );
    actions.push(id);
    return id;
}

async function makeStatement(actionId: string, deliveredAt: Date | null, createdAt?: Date): Promise<string> {
    const id = `sor-p54m-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "StatementOfReasons"
           ("id","createdAt","actionId","recipientUserId","locale","bodyRendered","deliveredAt")
         VALUES ($1,$2,$3,$4,'bg',$5,$6)`,
        id, createdAt ?? new Date(), actionId, `u-${randomUUID()}`,
        encryptField('body'), deliveredAt,
    );
    statements.push(id);
    return id;
}

/**
 * A notice decided at HALF the lag and answered at the full lag.
 *
 * Every fixture in this file keeps decision < answer, deliberately: it is true
 * of the real world (an answer requires a decision) and it makes the
 * "two clocks disagree" assertion hold over the whole seeded population
 * rather than over one row that a window cannot isolate. The medians share a
 * window with every other case here, so an assertion that depended on one
 * notice being alone in it was never going to be stable.
 */
async function answeredNotice(receivedAt: Date, lagMs: number): Promise<void> {
    const reportId = await makeNotice(receivedAt);
    const actionId = await makeAction(reportId, new Date(receivedAt.getTime() + lagMs / 2));
    await makeStatement(actionId, new Date(receivedAt.getTime() + lagMs));
}

afterAll(async () => {
    if (DB_AVAILABLE) {
        for (const id of statements) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "StatementOfReasons" WHERE "id"=$1`, id);
        }
        for (const id of actions) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "ModerationAction" WHERE "id"=$1`, id);
        }
        for (const id of reports) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "ContentReport" WHERE "id"=$1`, id);
        }
    }
    await globalPrisma.$disconnect();
});

describeFn('moderationHandlingStats', () => {
    it('reports NULL, not 0, when nothing has been answered', async () => {
        // THE case. `percentile_cont` over an empty set is NULL and must stay
        // NULL: "median 0 seconds" for a deployment that has answered nothing
        // reads as perfect performance. A 1-day window is empty because every
        // fixture below is seeded further back.
        const stats = await moderationHandlingStats(1, new Date(Date.now() - 400 * 24 * HOUR));

        for (const c of [stats.decision, stats.answer]) {
            expect(c.n).toBe(0);
            expect(c.medianSeconds).toBeNull();
            expect(c.p90Seconds).toBeNull();
            // Asserted explicitly: `toBeNull()` and `toBe(0)` are both
            // satisfied by a loose falsy reading, and a COALESCE(..., 0) is
            // exactly the change this case exists to catch.
            expect(c.medianSeconds).not.toBe(0);
        }
    });

    it('measures the median from the notice to the first answer', async () => {
        const now = new Date();
        const base = new Date(now.getTime() - 5 * 24 * HOUR);
        // Lags of 1h, 2h and 30h → median 2h, and one outside the 24h target.
        await answeredNotice(new Date(base.getTime()), 1 * HOUR);
        await answeredNotice(new Date(base.getTime() + 60_000), 2 * HOUR);
        await answeredNotice(new Date(base.getTime() + 120_000), 30 * HOUR);

        const stats = await moderationHandlingStats(30, now);

        expect(stats.answer.n).toBeGreaterThanOrEqual(3);
        // Exact on the 3-row set seeded here; `toBeCloseTo` because
        // `percentile_cont` interpolates in floating point.
        expect(stats.answer.medianSeconds).toBeCloseTo(2 * 3600, 0);
        expect(stats.answer.withinTarget).toBeGreaterThanOrEqual(2);
        expect(stats.targetSeconds).toBe(HANDLING_TARGET_SECONDS);
    });

    it('the FIRST delivered statement stops the clock, not the last', async () => {
        const now = new Date();
        const receivedAt = new Date(now.getTime() - 10 * 24 * HOUR);
        const reportId = await makeNotice(receivedAt);
        const actionId = await makeAction(reportId, new Date(receivedAt.getTime() + 1 * HOUR));
        // Two recipients, answered 3h and 40h after the notice. The notifier
        // was answered at 3h; a later statement to a second recipient is a
        // different obligation and must not inflate the handling time.
        await makeStatement(actionId, new Date(receivedAt.getTime() + 3 * HOUR));
        await makeStatement(actionId, new Date(receivedAt.getTime() + 40 * HOUR));

        const stats = await moderationHandlingStats(30, now);

        expect(stats.answer.n).toBeGreaterThanOrEqual(1);

        // ISOLATED, and that is the whole point of this case. The window is
        // `[asOf - 1 day, asOf)`, ending an hour after this notice arrived, so
        // every other fixture in this file — all newer, or 200 days older —
        // falls outside it and the median IS this notice's own lag.
        //
        // Asserted that way because the first version was not: it took the
        // median over an 11-day window and checked it was under 40h, which a
        // population of 1h/2h/30h notices satisfies whether this notice
        // contributes 3h or 40h. Swapping MIN for MAX left all ten cases
        // green. An aggregate cannot testify about one row.
        const asOf = new Date(receivedAt.getTime() + 1 * HOUR);
        const isolated = await moderationHandlingStats(1, asOf);

        expect(isolated.answer.n).toBe(1);
        // 3h, the FIRST delivery. 40h is what MAX would report.
        expect(isolated.answer.medianSeconds).toBeCloseTo(3 * 3600, 0);
    });

    it('an action with NO delivered statement is not counted as answered', async () => {
        const now = new Date();
        const before = await moderationHandlingStats(30, now);
        const receivedAt = new Date(now.getTime() - 2 * 24 * HOUR);
        const reportId = await makeNotice(receivedAt);
        const actionId = await makeAction(reportId, new Date(receivedAt.getTime() + 1 * HOUR));
        await makeStatement(actionId, null); // queued, never sent

        const after = await moderationHandlingStats(30, now);

        // The whole hazard this metric exists for: the action is recorded, the
        // notice reads ACTIONED, and the recipient never heard. Counting it as
        // answered would make an Art 17 breach improve the headline figure.
        expect(after.answer.n).toBe(before.answer.n);
        // But it IS a decision, and it must appear as one — a notice that
        // vanishes from both clocks would hide the unexplained set entirely.
        // This is why the statement join is LEFT.
        expect(after.decision.n).toBe(before.decision.n + 1);
        expect(after.undelivered.count).toBe(before.undelivered.count + 1);
    });

    it('surfaces the AGE of the oldest undelivered statement, not just a count', async () => {
        const now = new Date();
        const before = await moderationHandlingStats(30, now);
        const queuedAt = new Date(now.getTime() - 9 * 24 * HOUR);
        const actionId = await makeAction(null, queuedAt);
        await makeStatement(actionId, null, queuedAt);

        const after = await moderationHandlingStats(30, now);

        // A count of 3 says nothing about whether it is 3 minutes or 3 weeks
        // of breach. Delta-asserted: these counters are global by design.
        expect(after.undelivered.count).toBe(before.undelivered.count + 1);
        expect(after.undelivered.oldestAgeSeconds).not.toBeNull();
        expect(after.undelivered.oldestAgeSeconds!).toBeGreaterThanOrEqual(9 * 24 * 3600 - 5);
    });

    it('counts a notice no human has been told about (#1599 alert queue)', async () => {
        const now = new Date();
        const before = await moderationHandlingStats(30, now);
        await makeNotice(new Date(now.getTime() - 3 * HOUR), null); // alertedAt NULL

        const after = await moderationHandlingStats(30, now);

        expect(after.unalerted.count).toBe(before.unalerted.count + 1);
        expect(after.unalerted.oldestCreatedAt).not.toBeNull();
    });

    it('the window is OPEN above, so a past `now` describes that past period', async () => {
        // The upper bound, which a surviving mutation exposed as missing.
        // Everything this file seeds is older than `now`, so a window ending
        // a year ago must contain none of it — while the same width ending
        // today contains plenty.
        const now = new Date();
        const yearAgo = new Date(now.getTime() - 365 * 24 * HOUR);

        const longAgo = await moderationHandlingStats(30, yearAgo);
        const today = await moderationHandlingStats(30, now);

        expect(longAgo.answer.n).toBe(0);
        expect(longAgo.answer.medianSeconds).toBeNull();
        expect(today.answer.n).toBeGreaterThan(0);
    });

    it('the window EXCLUDES older notices — a lifetime median hides a regression', async () => {
        const now = new Date();
        await answeredNotice(new Date(now.getTime() - 200 * 24 * HOUR), 50 * HOUR);

        const narrow = await moderationHandlingStats(7, now);
        const wide = await moderationHandlingStats(365, now);

        // The 200-day-old 50h answer is outside the 7-day window and inside
        // the 365-day one, so the two must disagree. If they agreed, the
        // window parameter would be decoration.
        expect(wide.answer.n).toBeGreaterThan(narrow.answer.n);
        expect(wide.windowDays).toBe(365);
        expect(narrow.windowDays).toBe(7);
    });

    it('reports notices by status, so the medians have context', async () => {
        const stats = await moderationHandlingStats(365, new Date());

        // The medians are over notices that reached a stage; without the
        // status breakdown a reader cannot see how many are still waiting.
        expect(typeof stats.noticesByStatus).toBe('object');
        expect(Object.values(stats.noticesByStatus).every((v) => typeof v === 'number')).toBe(true);
    });

    it('an ANSWER can never outnumber a DECISION', async () => {
        // The structural invariant between the two clocks, and the reason both
        // are reported: an answer requires a decision, so `answer.n` is bounded
        // by `decision.n` and the GAP between them is the set of notices
        // decided and never explained. If this ever inverted, the two figures
        // would be measuring populations that are not nested and the gap would
        // mean nothing.
        for (const days of [7, 30, 365]) {
            const s = await moderationHandlingStats(days, new Date());
            expect(s.answer.n).toBeLessThanOrEqual(s.decision.n);
        }
    });

    it('the two clocks DISAGREE when a decision is not an answer', async () => {
        // The control for reporting both. If they always agreed, one of them
        // would be decoration — so this seeds a notice decided quickly and
        // answered slowly and asserts the medians differ.
        const now = new Date();
        const receivedAt = new Date(now.getTime() - 4 * 24 * HOUR);
        const reportId = await makeNotice(receivedAt);
        const actionId = await makeAction(reportId, new Date(receivedAt.getTime() + 1 * HOUR));
        await makeStatement(actionId, new Date(receivedAt.getTime() + 36 * HOUR));

        const s = await moderationHandlingStats(5, now);

        expect(s.decision.n).toBeGreaterThanOrEqual(1);
        expect(s.answer.n).toBeGreaterThanOrEqual(1);
        expect(s.decision.medianSeconds).not.toBeNull();
        expect(s.answer.medianSeconds).not.toBeNull();
        // Decided in an hour, answered a day and a half later.
        expect(s.answer.medianSeconds!).toBeGreaterThan(s.decision.medianSeconds!);
    });
});
