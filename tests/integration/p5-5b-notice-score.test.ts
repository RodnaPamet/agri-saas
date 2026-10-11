/**
 * P5.5b — the notice-score job against a real database (#1596).
 *
 * What needs a real database rather than a mock:
 *
 *   - **idempotence is a UNIQUE index, not a flag.** The queue is "notices with
 *     no score row", so a second run must score nothing. Only Postgres can
 *     show that the constraint is what enforces it.
 *   - **the anti-join is bounded and correctly aimed.** It is raw SQL, so a
 *     typo in a column name or a reversed NOT EXISTS would select the wrong
 *     set — and selecting the EMPTY set looks exactly like "nothing to do".
 *   - **`detail` reaches the scorer decrypted.** The anti-join is raw and the
 *     row read is not, precisely so the encryption extension runs. If that
 *     split were ever collapsed into one raw query, the model would score
 *     ciphertext and return a confident number about nothing, with nothing
 *     failing.
 *
 * The scorer itself is mocked — what is under test is the queue, the write and
 * the idempotence, not the model.
 */
const scoreNotice = jest.fn();
const isNoticeScoringConfigured = jest.fn();
jest.mock('@/app-layer/ai/notice-scorer', () => ({
    scoreNotice: (...a: unknown[]) => scoreNotice(...a),
    isNoticeScoringConfigured: () => isNoticeScoringConfigured(),
    NOTICE_SCORE_MODEL: 'claude-haiku-4-5',
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runNoticeScore } from '@/app-layer/jobs/notice-score';
import { encryptField } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const reports: string[] = [];

/**
 * `ContentReport` is tenantless and denies `app_user`, so this writes through
 * the privileged connection — the same path the real intake uses.
 */
async function makeNotice(detail: string, opts: { anonymous?: boolean } = {}): Promise<string> {
    const id = `cr-p55b-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,'MISLEADING_LISTING'::"ReportReasonCode",'RECEIVED',$3,$4)`,
        id,
        `listing-${randomUUID()}`,
        encryptField(detail),
        opts.anonymous ? null : `usr-p55b-${randomUUID()}`,
    );
    reports.push(id);
    return id;
}

async function scoreRowsFor(ids: string[]) {
    return globalPrisma.$queryRawUnsafe<Array<{ reportId: string; score: number; model: string }>>(
        `SELECT "reportId", "score", "model" FROM "NoticeScore" WHERE "reportId" = ANY($1::text[])`,
        ids,
    );
}

describeFn('P5.5b — the notice-score job (#1596)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    beforeEach(() => {
        jest.clearAllMocks();
        scoreNotice.mockReset();
        isNoticeScoringConfigured.mockReset();
        isNoticeScoringConfigured.mockReturnValue(true);
        scoreNotice.mockResolvedValue({
            score: 42, rationale: 'a stated reason', model: 'claude-haiku-4-5',
        });
    });

    afterAll(async () => {
        if (reports.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "NoticeScore" WHERE "reportId" = ANY($1::text[])`, reports);
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ContentReport" WHERE "id" = ANY($1::text[])`, reports);
        }
        await globalPrisma.$disconnect();
    });

    it('scores an unscored notice and stores the model with it', async () => {
        const id = await makeNotice('The grade claimed is not what was delivered.');

        await runNoticeScore({ limit: 50 });

        const rows = await scoreRowsFor([id]);
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(42);
        // Provenance: a score is not comparable against one from a later model
        // without it, which is the whole point of a shadow period.
        expect(rows[0].model).toBe('claude-haiku-4-5');
    });

    it('passes the DECRYPTED detail to the scorer', async () => {
        const plaintext = `unique-plaintext-${randomUUID()}`;
        await makeNotice(plaintext);

        await runNoticeScore({ limit: 50 });

        const seen = scoreNotice.mock.calls.map((c) => c[0]?.detail).filter(Boolean);
        // The load-bearing assertion for the two-query split. If the row read
        // were ever folded into the raw anti-join, this would be ciphertext —
        // and the job would still "work", scoring nonsense confidently.
        expect(seen).toContain(plaintext);
        expect(seen.join('\n')).not.toContain('v1:');
        expect(seen.join('\n')).not.toContain('v2:');
    });

    it('derives anonymity from the ABSENCE of a reporter, and sends no id', async () => {
        await makeNotice('filed with no account', { anonymous: true });

        await runNoticeScore({ limit: 50 });

        const anonCalls = scoreNotice.mock.calls.filter((c) => c[0]?.anonymous === true);
        expect(anonCalls.length).toBeGreaterThan(0);
        // The scorer's input has no field for an id; this pins that the job
        // does not add one.
        for (const call of scoreNotice.mock.calls) {
            expect(Object.keys(call[0] ?? {}).sort())
                .toEqual(['anonymous', 'detail', 'reasonCode', 'subjectKind']);
        }
    });

    it('does NOT re-score on a second run', async () => {
        const id = await makeNotice('score me once');

        await runNoticeScore({ limit: 50 });
        const callsAfterFirst = scoreNotice.mock.calls.length;

        await runNoticeScore({ limit: 50 });

        // Idempotence by QUERY: the second run does not select the row at all,
        // so no second model call and no second charge against the budget.
        const laterCalls = scoreNotice.mock.calls
            .slice(callsAfterFirst)
            .filter((c) => c[0]?.detail === 'score me once');
        expect(laterCalls).toHaveLength(0);

        const rows = await scoreRowsFor([id]);
        expect(rows).toHaveLength(1);
    });

    it('leaves a notice UNSCORED when the scorer declines', async () => {
        const id = await makeNotice('the scorer will decline this');
        scoreNotice.mockResolvedValue(null);

        const { result } = await runNoticeScore({ limit: 50 });

        // No row, and the run still succeeded: an unscored notice costs
        // nothing because nothing reads a score.
        expect(await scoreRowsFor([id])).toHaveLength(0);
        expect(result.success).toBe(true);
        expect(result.itemsSkipped).toBeGreaterThan(0);
    });

    it('a declined notice is picked up again on the NEXT run', async () => {
        const marker = 'declined once, then scored';
        const id = await makeNotice(marker);

        // Aimed at THIS notice by content, and flipped between runs — not
        // `mockResolvedValueOnce`, which lands on whichever row the run
        // reaches first. The queue is global and oldest-first, so that is
        // routinely a row some earlier test left unscored. (I wrote this test
        // with `Once` first and it failed for exactly that reason.)
        let decline = true;
        scoreNotice.mockImplementation((n: { detail: string | null }) =>
            Promise.resolve(
                decline && n.detail === marker
                    ? null
                    : { score: 42, rationale: 'a stated reason', model: 'claude-haiku-4-5' },
            ));

        await runNoticeScore({ limit: 50 });
        expect(await scoreRowsFor([id])).toHaveLength(0);

        // The retry granularity: the queue is "no score row", so a declined
        // notice is simply still in it.
        decline = false;
        await runNoticeScore({ limit: 50 });
        expect(await scoreRowsFor([id])).toHaveLength(1);
    });

    it('does no work at all when AI is not configured', async () => {
        await makeNotice('nobody will score this');
        isNoticeScoringConfigured.mockReturnValue(false);

        const { result } = await runNoticeScore({ limit: 50 });

        expect(scoreNotice).not.toHaveBeenCalled();
        expect(result.itemsScanned).toBe(0);
        expect(result.details).toMatchObject({ skippedReason: 'ai_not_configured' });
    });

    it('honours the batch limit', async () => {
        await makeNotice('batch a');
        await makeNotice('batch b');
        await makeNotice('batch c');

        const { result } = await runNoticeScore({ limit: 2 });

        // The limit is what makes the platform ceiling spendable at a rate
        // somebody chose, so it has to actually bound the query.
        expect(result.itemsScanned).toBeLessThanOrEqual(2);
    });

    it('stores a score for EVERY notice in the batch, not just the first', async () => {
        const a = await makeNotice('batch member A');
        const b = await makeNotice('batch member B');

        await runNoticeScore({ limit: 50 });

        // A loop that stored the first and returned would pass every other
        // test in this file.
        expect(await scoreRowsFor([a, b])).toHaveLength(2);
    });

    it('one DECLINED notice does not stop its neighbours', async () => {
        const declined = await makeNotice('this one is declined');
        const ok = await makeNotice('this one is scored');
        // Aimed at a notice by its CONTENT rather than at a call index: the
        // queue is global and oldest-first, so `mockResolvedValueOnce` would
        // land on whichever row the run reached first — which may be one
        // another test left unscored. (The same trap as P5.4b's dispatch test.)
        scoreNotice.mockImplementation((n: { detail: string | null }) =>
            Promise.resolve(
                n.detail === 'this one is declined'
                    ? null
                    : { score: 5, rationale: 'fine', model: 'claude-haiku-4-5' },
            ));

        await runNoticeScore({ limit: 50 });

        expect(await scoreRowsFor([declined])).toHaveLength(0);
        expect(await scoreRowsFor([ok])).toHaveLength(1);
    });
});
