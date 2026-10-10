/**
 * P5.4a — the moderation console's usecases (#1595).
 *
 * Drives the real usecases against a live database, because the claims worth
 * checking are about what reaches the row and what does NOT reach the caller:
 *
 *   - `moderatorRef` records the KEY GENERATION and nothing a caller supplied;
 *   - the triage queue never returns `reporterUserId`, only whether the notice
 *     was anonymous;
 *   - acting is ONE transaction — a notice is never ACTIONED without an action
 *     row, and an action never exists beside a notice still RECEIVED;
 *   - `NONE` is a decision (→ REJECTED), not a no-op;
 *   - a queued statement has `deliveredAt` NULL and appears in the undelivered
 *     view, which is the drain queue P5.4b will consume.
 *
 * The console runs on the PRIVILEGED client by necessity — every table it
 * touches denies `app_user` — so unlike P5.1's suite there is no RLS arm to
 * exercise here. What this checks instead is that the privileged path writes
 * the right things, which is the only control left once RLS is out of the way.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    listNotices,
    actOnNotice,
    queueStatement,
    listUndeliveredStatements,
    moderatorRefFor,
} from '@/app-layer/usecases/moderation';
import { fileNotice } from '@/app-layer/usecases/trust-safety';
import { decryptField } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const REPORTER = `u-p54-reporter-${randomUUID()}`;
const RECIPIENT = `u-p54-recipient-${randomUUID()}`;
const reports: string[] = [];
const actions: string[] = [];
const statements: string[] = [];

async function fileOne(reporter: string | null = REPORTER) {
    const filed = await fileNotice(
        {
            subjectKind: 'LISTING',
            subjectId: `listing-${randomUUID()}`,
            reasonCode: 'MISLEADING_LISTING',
            detail: 'the grade is not as stated',
        },
        reporter,
    );
    reports.push(filed.id);
    return filed.id;
}

describeFn('P5.4a — the moderation console (#1595)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        if (statements.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "StatementOfReasons" WHERE "id" = ANY($1::text[])`, statements,
            );
        }
        if (actions.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ModerationAction" WHERE "id" = ANY($1::text[])`, actions,
            );
        }
        if (reports.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ReportSnapshot" WHERE "reportId" = ANY($1::text[])`, reports,
            );
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ContentReport" WHERE "id" = ANY($1::text[])`, reports,
            );
        }
        await globalPrisma.$disconnect();
    });

    describe('the triage queue', () => {
        it('shows a filed notice, with its snapshot outcome', async () => {
            const id = await fileOne();
            const queue = await listNotices({ status: 'RECEIVED', limit: 200 });
            const mine = queue.find((n) => n.id === id);
            expect(mine).toBeDefined();
            // The snapshot exists and says the subject was not found — the
            // listing id is random. That IS the expected shape: a notice about
            // content that is already gone still has to be answerable.
            expect(mine!.snapshot).not.toBeNull();
            expect(mine!.snapshot!.captureError).toBe('SUBJECT_NOT_FOUND');
        });

        it('NEVER returns reporterUserId — only whether it was anonymous', async () => {
            const mine = await fileOne(REPORTER);
            const anon = await fileOne(null);
            const queue = await listNotices({ limit: 200 });

            const a = queue.find((n) => n.id === mine)!;
            const b = queue.find((n) => n.id === anon)!;
            expect(a.anonymous).toBe(false);
            expect(b.anonymous).toBe(true);

            // The identity is absent from the SHAPE, not merely unused. A
            // moderator decides on the content; knowing who reported it
            // invites deciding on the reporter.
            for (const n of queue) {
                expect(Object.keys(n)).not.toContain('reporterUserId');
            }
            expect(JSON.stringify(queue)).not.toContain(REPORTER);
        });

        it('is oldest-first, because the question is what has waited longest', async () => {
            const queue = await listNotices({ limit: 200 });
            const times = queue.map((n) => n.createdAt.getTime());
            expect([...times].sort((x, y) => x - y)).toEqual(times);
        });
    });

    describe('acting on a notice', () => {
        it('records the KEY GENERATION as the moderator, not anything supplied', async () => {
            const id = await fileOne();
            const { actionId } = await actOnNotice({
                reportId: id,
                actionKind: 'CONTENT_REMOVED',
                rationale: 'grade claim unsubstantiated',
                generation: 'current',
            });
            actions.push(actionId);

            const row = await globalPrisma.$queryRawUnsafe<Array<{ r: string }>>(
                `SELECT "moderatorRef" AS r FROM "ModerationAction" WHERE "id" = $1`, actionId,
            );
            expect(row[0].r).toBe(moderatorRefFor('current'));
            expect(row[0].r).toBe('platform-key:current');
            // Prefixed, so a reader cannot mistake it for a person's handle.
            expect(row[0].r).toMatch(/^platform-key:/);
        });

        it('distinguishes the two generations, which is the whole point of recording it', async () => {
            // A bare constant would make every action look identical; the
            // generation narrows a compromise window to one side of a rotation.
            const id = await fileOne();
            const { actionId } = await actOnNotice({
                reportId: id, actionKind: 'CONTENT_DEMOTED',
                rationale: 'demoted pending evidence', generation: 'previous',
            });
            actions.push(actionId);
            const row = await globalPrisma.$queryRawUnsafe<Array<{ r: string }>>(
                `SELECT "moderatorRef" AS r FROM "ModerationAction" WHERE "id" = $1`, actionId,
            );
            expect(row[0].r).toBe('platform-key:previous');
            expect(row[0].r).not.toBe('platform-key:current');
        });

        it('moves the notice and writes the action TOGETHER', async () => {
            const id = await fileOne();
            const { actionId, status } = await actOnNotice({
                reportId: id, actionKind: 'ACCOUNT_SUSPENDED',
                rationale: 'repeat offender', generation: 'current',
            });
            actions.push(actionId);
            expect(status).toBe('ACTIONED');

            // Both halves, read back on the privileged path. Either alone is a
            // state the queue cannot tell from a crash.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ s: string; n: bigint }>>(
                `SELECT r."status" AS s, COUNT(a."id")::bigint AS n
                 FROM "ContentReport" r
                 LEFT JOIN "ModerationAction" a ON a."reportId" = r."id"
                 WHERE r."id" = $1 GROUP BY r."status"`, id,
            );
            expect(rows[0].s).toBe('ACTIONED');
            expect(Number(rows[0].n)).toBe(1);
        });

        it('treats NONE as a DECISION — rejected, not left received', async () => {
            const id = await fileOne();
            const { actionId, status } = await actOnNotice({
                reportId: id, actionKind: 'NONE',
                rationale: 'looked; the listing is accurate', generation: 'current',
            });
            actions.push(actionId);
            // "Looked and did nothing" must be distinguishable from "never
            // looked", which an absent row cannot express.
            expect(status).toBe('REJECTED');
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ k: string }>>(
                `SELECT "actionKind"::text AS k FROM "ModerationAction" WHERE "id" = $1`, actionId,
            );
            expect(rows[0].k).toBe('NONE');
        });

        it('sanitises the rationale, which becomes the Art 17 text', async () => {
            const id = await fileOne();
            const { actionId } = await actOnNotice({
                reportId: id, actionKind: 'CONTENT_REMOVED',
                rationale: '<script>alert(1)</script>unsubstantiated', generation: 'current',
            });
            actions.push(actionId);
            const raw = await globalPrisma.$queryRawUnsafe<Array<{ r: string }>>(
                `SELECT "rationale" AS r FROM "ModerationAction" WHERE "id" = $1`, actionId,
            );

            // ENCRYPTED AT REST, asserted first — and this is why the test
            // decrypts explicitly rather than reading through `globalPrisma`'s
            // models. That client is a bare `PrismaClient` with only the pg
            // adapter: it carries none of the app's extensions, so it neither
            // encrypts on write nor decrypts on read. Reading the model
            // returned `v1:…` exactly as the raw query does, which is how
            // this assertion failed twice.
            expect(raw[0].r).toMatch(/^v\d+:/);
            expect(raw[0].r).not.toContain('unsubstantiated');

            // And the plaintext underneath is sanitised. Both halves matter:
            // an envelope alone would pass on text that was never cleaned, and
            // clean text alone would pass on a column stored in the open.
            const plain = decryptField(raw[0].r);
            expect(plain).not.toContain('<script');
            expect(plain).toContain('unsubstantiated');
        });

        it('reports a missing notice rather than inventing an action', async () => {
            const result = await actOnNotice({
                reportId: `cr-nope-${randomUUID()}`, actionKind: 'NONE',
                rationale: 'x', generation: 'current',
            });
            expect(result.actionId).toBe('');
        });
    });

    describe('statements of reasons', () => {
        it('queues with deliveredAt NULL — the row IS the outbox', async () => {
            const id = await fileOne();
            const { actionId } = await actOnNotice({
                reportId: id, actionKind: 'CONTENT_REMOVED',
                rationale: 'removed', generation: 'current',
            });
            actions.push(actionId);

            const { statementId } = await queueStatement({
                actionId,
                recipientUserId: RECIPIENT,
                locale: 'bg',
                bodyRendered: 'Вашата обява беше премахната.',
            });
            statements.push(statementId);

            const rows = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
                `SELECT "deliveredAt" AS d FROM "StatementOfReasons" WHERE "id" = $1`, statementId,
            );
            expect(rows[0].d).toBeNull();
        });

        it('appears in the undelivered view, which is the compliance surface', async () => {
            const undelivered = await listUndeliveredStatements(200);
            expect(undelivered.length).toBeGreaterThan(0);
            expect(undelivered.map((s) => s.id)).toEqual(
                expect.arrayContaining([statements[statements.length - 1]]),
            );
            // `bodyRendered` is NOT in the view: it is the delivered text,
            // encrypted at rest, and this surface needs to know THAT something
            // is stuck rather than to re-read what it says.
            for (const s of undelivered) {
                expect(Object.keys(s)).not.toContain('bodyRendered');
            }
        });

        it('is oldest-first, because the LAG is what is being measured', async () => {
            const undelivered = await listUndeliveredStatements(200);
            const times = undelivered.map((s) => s.createdAt.getTime());
            expect([...times].sort((x, y) => x - y)).toEqual(times);
        });
    });
});
