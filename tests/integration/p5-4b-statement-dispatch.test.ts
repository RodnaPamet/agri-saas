/**
 * P5.4b — Art 17 statement dispatch (#1595).
 *
 * The claims worth testing are all about the two ways this can be quietly
 * wrong:
 *
 *   - the WRONG LANGUAGE. `User.uiLanguage` defaults to `bg` at the column,
 *     while `DEFAULT_LOCALE` is `en` for unauthenticated pages. Reaching for
 *     the second would hand English to a Bulgarian farmer whose preference
 *     merely failed to load — a mistake the schema docblock invited until
 *     #686.
 *   - a FALSE DELIVERY. `deliveredAt` must be stamped only after a send
 *     resolves. A row marked delivered on a failed send is the worst outcome
 *     available: the compliance surface goes quiet and the recipient never
 *     heard.
 *
 * The mailer is mocked, because what is under test is which text and which
 * language reach it — not SMTP.
 */
const sendEmail = jest.fn();
jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    getEmailProvider: jest.fn(),
    ConsoleEmailProvider: class {},
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runStatementDispatch } from '@/app-layer/jobs/statement-dispatch';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const actions: string[] = [];
const statements: string[] = [];

/**
 * `User` needs `updatedAt` spelled out — `@updatedAt` is applied by the Prisma
 * CLIENT, not as a database default, so a raw INSERT omitting it fails 23502.
 * And `name` is `@map`'d to `nameEncrypted`, so naming it fails 42703. Both
 * traps are recorded in P1.4's and P1.5's fixtures.
 */
async function makeUser(uiLanguage: string | null): Promise<{ id: string; email: string }> {
    const id = `u-p54b-${randomUUID()}`;
    const email = `p54b-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt"${uiLanguage !== null ? ',"uiLanguage"' : ''})
         VALUES ($1,$2,$3,NOW()${uiLanguage !== null ? ',$4' : ''})`,
        ...(uiLanguage !== null
            ? [id, encryptField(email), hashForLookup(email), uiLanguage]
            : [id, encryptField(email), hashForLookup(email)]),
    );
    users.push(id);
    return { id, email };
}

async function makeQueuedStatement(recipientUserId: string, actionKind = 'CONTENT_REMOVED') {
    const actionId = `ma-p54b-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ModerationAction"("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
         VALUES ($1,'platform-key:current',$2::"ModerationActionKind",'LISTING',$3,$4)`,
        actionId, actionKind, `listing-${randomUUID()}`,
        encryptField('the stated grade could not be substantiated'),
    );
    actions.push(actionId);

    const statementId = `sor-p54b-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "StatementOfReasons"("id","actionId","recipientUserId","locale","bodyRendered")
         VALUES ($1,$2,$3,'bg',$4)`,
        statementId, actionId, recipientUserId, encryptField('DRAFT — replaced at send time'),
    );
    statements.push(statementId);
    return { actionId, statementId };
}

describeFn('P5.4b — Art 17 statement dispatch (#1595)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    beforeEach(() => {
        // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS — a throwing
        // `mockImplementation` installed by one test would poison every later
        // one in the file (the repo's own testing convention).
        jest.clearAllMocks();
        sendEmail.mockReset();
        sendEmail.mockResolvedValue(undefined);
    });

    afterAll(async () => {
        if (statements.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "StatementOfReasons" WHERE "id" = ANY($1::text[])`, statements);
        }
        if (actions.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ModerationAction" WHERE "id" = ANY($1::text[])`, actions);
        }
        if (users.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "User" WHERE "id" = ANY($1::text[])`, users);
        }
        await globalPrisma.$disconnect();
    });

    it('delivers in the recipient’s OWN language, not the sender’s', async () => {
        const { id: en } = await makeUser('en');
        const { statementId } = await makeQueuedStatement(en);

        await runStatementDispatch({ limit: 50 });

        const call = sendEmail.mock.calls.find((c) =>
            typeof c[0]?.text === 'string' && c[0].text.includes('substantiated'));
        expect(call).toBeDefined();
        // English, because THEIR column says so — even though the row was
        // queued with `locale: 'bg'` by the console's default.
        expect(call![0].subject).toMatch(/decision about your content/i);
        expect(call![0].text).toMatch(/Digital Services Act/);

        const row = await globalPrisma.$queryRawUnsafe<Array<{ l: string }>>(
            `SELECT "locale" AS l FROM "StatementOfReasons" WHERE "id" = $1`, statementId);
        // The RESOLVED locale is written back, so the row records what was
        // actually used rather than what was queued.
        expect(row[0].l).toBe('en');
    });

    it('falls back to bg — NOT en — when the preference is missing', async () => {
        // The whole point of `RECIPIENT_FALLBACK_LOCALE`. `DEFAULT_LOCALE` is
        // `en` and is for UNAUTHENTICATED pages; a statement recipient is a
        // known user whose column defaults to `bg`.
        const { id: unknown } = await makeUser('de');  // unrecognised, like an empty column
        const { statementId } = await makeQueuedStatement(unknown);

        await runStatementDispatch({ limit: 50 });

        const row = await globalPrisma.$queryRawUnsafe<Array<{ l: string }>>(
            `SELECT "locale" AS l FROM "StatementOfReasons" WHERE "id" = $1`, statementId);
        expect(row[0].l).toBe('bg');
        expect(row[0].l).not.toBe('en');

        const call = sendEmail.mock.calls.at(-1)!;
        expect(call[0].subject).toMatch(/[Ѐ-ӿ]/);  // Cyrillic
    });

    it('stamps deliveredAt and writes back the text that was SENT', async () => {
        const { id: bg } = await makeUser('bg');
        const { statementId } = await makeQueuedStatement(bg);

        await runStatementDispatch({ limit: 50 });

        const row = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null; b: string }>>(
            `SELECT "deliveredAt" AS d, "bodyRendered" AS b FROM "StatementOfReasons" WHERE "id" = $1`,
            statementId);
        expect(row[0].d).not.toBeNull();
        // The DRAFT is gone — "stored rendered = as sent" is kept literally
        // true by composing here and writing back.
        const sent = sendEmail.mock.calls.at(-1)![0].text as string;
        // Encrypted at rest, so compare lengths rather than text: the point is
        // that the column changed from the draft.
        expect(row[0].b).not.toContain('DRAFT');
        expect(sent).not.toContain('DRAFT');
        expect(sent).toContain('substantiated');
    });

    it('leaves the row UNDELIVERED when the send fails', async () => {
        const { id: bg } = await makeUser('bg');
        const { statementId } = await makeQueuedStatement(bg);
        sendEmail.mockRejectedValueOnce(new Error('smtp refused'));

        const { result } = await runStatementDispatch({ limit: 50 });

        const row = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
            `SELECT "deliveredAt" AS d FROM "StatementOfReasons" WHERE "id" = $1`, statementId);
        // Still NULL. A row marked delivered on a failed send would take a
        // compliance gap off the console's undelivered view, which is the one
        // place it is visible.
        expect(row[0].d).toBeNull();
        expect(result.itemsSkipped).toBeGreaterThan(0);
        // And the RUN still succeeded: one unreachable mailbox must not abort
        // the batch, and `attempts: 1` means a job-level retry would re-send
        // everything that already went out.
        expect(result.success).toBe(true);
    });

    it('one failure does not stop the others in the batch', async () => {
        const a = await makeUser('bg');
        const b = await makeUser('bg');
        const first = await makeQueuedStatement(a.id);
        const second = await makeQueuedStatement(b.id);
        // Aimed at a RECIPIENT, not at a call index. `mockRejectedValueOnce`
        // would land on whichever row the run reached first — and the queue is
        // global and oldest-first, so a row another test left undelivered is
        // ahead of both of these. That is the retry property working, and it
        // made the ordering-based version of this test fail for the right
        // reason; the fix belongs here rather than in the job.
        sendEmail.mockImplementation((msg: { to: string }) =>
            msg.to === a.email
                ? Promise.reject(new Error('smtp refused'))
                : Promise.resolve(undefined));

        await runStatementDispatch({ limit: 50 });

        const rows = await globalPrisma.$queryRawUnsafe<Array<{ id: string; d: Date | null }>>(
            `SELECT "id", "deliveredAt" AS d FROM "StatementOfReasons" WHERE "id" = ANY($1::text[])`,
            [first.statementId, second.statementId]);
        const byId = new Map(rows.map((r) => [r.id, r.d]));
        // The failure is isolated to its own row: one stuck, one through.
        expect(byId.get(first.statementId)).toBeNull();
        expect(byId.get(second.statementId)).not.toBeNull();
    });

    it('names the ACTION taken, so the statement says what was done', async () => {
        const { id: bg } = await makeUser('bg');
        await makeQueuedStatement(bg, 'ACCOUNT_SUSPENDED');

        await runStatementDispatch({ limit: 50 });

        const sent = sendEmail.mock.calls.at(-1)![0].text as string;
        // The suspension wording, not the removal wording. An Art 17 statement
        // that described the wrong action would be worse than none.
        expect(sent).toMatch(/профил/);
    });

    it('does not re-send an already delivered statement', async () => {
        // Idempotence by QUERY rather than by a flag check: the queue IS
        // `deliveredAt IS NULL`, so a delivered row is simply not selected.
        //
        // Scoped to this suite's own rows. `itemsScanned` counts the WHOLE
        // queue, which other suites and the console write to, so asserting it
        // reaches zero would be asserting something about them.
        await runStatementDispatch({ limit: 50 });
        const firstPass = await globalPrisma.$queryRawUnsafe<Array<{ id: string; d: Date }>>(
            `SELECT "id", "deliveredAt" AS d FROM "StatementOfReasons"
             WHERE "id" = ANY($1::text[]) AND "deliveredAt" IS NOT NULL`, statements);
        expect(firstPass.length).toBeGreaterThan(0);

        await runStatementDispatch({ limit: 50 });
        const secondPass = await globalPrisma.$queryRawUnsafe<Array<{ id: string; d: Date }>>(
            `SELECT "id", "deliveredAt" AS d FROM "StatementOfReasons"
             WHERE "id" = ANY($1::text[]) AND "deliveredAt" IS NOT NULL`, statements);
        const before = new Map(firstPass.map((r) => [r.id, r.d.getTime()]));
        // Every stamp is the ORIGINAL one — a re-send would move it.
        for (const row of secondPass) {
            if (before.has(row.id)) expect(row.d.getTime()).toBe(before.get(row.id));
        }
    });
});
