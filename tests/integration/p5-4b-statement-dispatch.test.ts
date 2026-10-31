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
import { queueStatementForAction } from '@/app-layer/usecases/statement-queue';
import { decryptField, encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const actions: string[] = [];
/** Keeps backdated rows deterministically ordered among themselves. */
let seeded = 0;
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
    // `createdAt` is BACKDATED, and that is what makes this suite independent
    // of the queue — #2522.
    //
    // `runStatementDispatch` takes the 50 OLDEST undelivered rows
    // (`orderBy: createdAt asc`, `DEFAULT_BATCH = 50`). Measured in the
    // database this suite actually uses: **111 undelivered rows, every one with
    // no recipient at all**, oldest 2026-10-14, none of them this suite's. They
    // are minted by `statement-queue.ts` through the real `queueStatement`, by
    // suites that then delete their Users and leave the statements — so the
    // dispatch can never resolve a mailbox for them and they can never drain.
    // 111 > 50, so the batch was entirely undrainable rows and a freshly
    // seeded statement was never reached. Nine of ten tests failed, the first
    // as `TypeError: Cannot read properties of undefined (reading '0')` from
    // `mock.calls[0][0]` — "nothing was sent", three frames from its cause.
    //
    // Backdating sorts this suite's rows ahead of any backlog, so the suite
    // stops depending on how much garbage is in front of it. The alternative —
    // deleting every undelivered row — would make this suite's correctness
    // depend on destroying other suites' fixtures. The leak itself is #2574.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "StatementOfReasons"("id","actionId","recipientUserId","locale","bodyRendered","createdAt")
         VALUES ($1,$2,$3,'bg',$4, TIMESTAMP '2000-01-01 00:00:00' + ($5::int * INTERVAL '1 second'))`,
        statementId, actionId, recipientUserId, encryptField('DRAFT — replaced at send time'),
        String(seeded++),
    );
    statements.push(statementId);
    return { actionId, statementId };
}

/**
 * The send for a statement THIS test seeded — #2522.
 *
 * CLAUDE.md's rule for this file is already written: *"A test asserting on this
 * queue must scope itself to its own rows. The queue is global and ordered
 * oldest-first, so `mockRejectedValueOnce` lands on whichever row the run
 * reaches first — which may be one another suite left stuck. Aim a failure at a
 * RECIPIENT, not a call index."* This suite did not follow it, and #2522 is the
 * result: nine of ten tests failed on any reused database, the first as
 * `TypeError: Cannot read properties of undefined (reading '0')` from
 * `sendEmail.mock.calls[0][0]` — "the dispatch sent nothing", three frames from
 * its cause.
 *
 * Scoped by `subjectIds` rather than by the recipient address, which is
 * stronger than the rule asks for: the payload carries the statement's own id,
 * so this cannot match a different statement that happens to share a recipient.
 */
type SentMail = { to: string; subject: string; text: string; subjectIds?: string[] };
function sendFor(statementId: string): SentMail | undefined {
    const call = sendEmail.mock.calls.find((c) => {
        const mail = c[0] as SentMail | undefined;
        return Array.isArray(mail?.subjectIds) && mail.subjectIds.includes(statementId);
    });
    return call?.[0] as SentMail | undefined;
}

/**
 * Backdates a row the PRODUCTION `queueStatementForAction` created — #2522.
 *
 * `makeQueuedStatement` backdates its own inserts, but two tests deliberately
 * go through the real usecase to prove the auto-composed DRAFT is what gets
 * delivered. Those rows arrive with `createdAt = now()`, which puts them at the
 * BACK of an oldest-first queue — behind the 111 undrainable rows #2574 is
 * about — so the dispatch never reaches them either. Backdating after the fact
 * keeps the usecase under test while making its output reachable.
 */
async function backdate(statementId: string): Promise<void> {
    await globalPrisma.$executeRawUnsafe(
        `UPDATE "StatementOfReasons"
         SET "createdAt" = TIMESTAMP '2000-01-01 00:00:00' + ($2::int * INTERVAL '1 second')
         WHERE "id" = $1`,
        statementId, String(seeded++),
    );
}

/** Asserts the statement was sent, and returns it. Fails naming the id. */
function requireSendFor(statementId: string): SentMail {
    const mail = sendFor(statementId);
    expect({ statementId, sent: mail !== undefined }).toEqual({ statementId, sent: true });
    return mail as SentMail;
}

describeFn('P5.4b — Art 17 statement dispatch (#1595)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        // Clear this suite's OWN leftovers — #2522, and note what this does
        // NOT do: it does not make the suite pass. Measured, the backlog
        // contains ZERO rows with this prefix. What it does is stop an
        // INTERRUPTED run of this suite from adding to the undrainable pile
        // that #2574 is about, since `afterAll` never runs when a run is
        // killed and `sendEmail` is mocked here so nothing is ever stamped
        // delivered.
        //
        // `afterAll` below already deletes what a completed run created, and
        // that is not enough: an INTERRUPTED run never reaches it, and
        // `sendEmail` is mocked here so `deliveredAt` is never stamped — which
        // is correct, and is the property this suite exists to protect. So
        // every killed run leaves rows that can never drain, and the dispatch
        // takes the 50 OLDEST, so once the backlog crosses `take` the suite's
        // freshly-seeded rows are never reached at all. Measured on this
        // checkout: 67 undelivered rows, oldest 18 days old, all from here.
        //
        // Scoped to the `p54b` id prefix this suite mints, so it cannot touch
        // another suite's rows even though integration tests run in band.
        // Children first: StatementOfReasons references ModerationAction.
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "StatementOfReasons" WHERE "id" LIKE 'sor-p54b-%'`);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "ModerationAction" WHERE "id" LIKE 'ma-p54b-%'`);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "User" WHERE "id" LIKE 'u-p54b-%'`);
    });

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

    // ── #1667 ──────────────────────────────────────────────────────────

    it('the redress line never says "reply to this message", and never points at a page', async () => {
        // Ruling 2, as finally implemented. `SMTP_FROM` defaults to
        // `noreply@agrent.bg`, so the original copy — "reply to this message
        // and a person will look at it again" — promised a reply nobody reads.
        //
        // And NOT a page either: my first fix pointed at `/dsa-contact`, which
        // agrent-ios then read in production and found rendering "A contact
        // address has not been configured for this deployment". The redress
        // line is now a function of what is CONFIGURED — see
        // `tests/unit/statement-redress-names-a-real-channel.test.ts` for the
        // three configurations.
        //
        // Asserted on what reaches the MAILER rather than on the catalogue: a
        // key that stopped being interpolated would leave a literal
        // `{address}` in a legal notice and still match the catalogue.
        const { id } = await makeUser('bg');
        const { statementId } = await makeQueuedStatement(id);

        await runStatementDispatch();

        const sent = requireSendFor(statementId);
        expect(sent.text).not.toMatch(/\{address\}|\{url\}/);
        expect(sent.text).not.toContain('/dsa-contact');
        expect(sent.text).not.toMatch(/отговорете на това съобщение|reply to this message/i);
        // The judicial route is named whatever the configuration — Art 17
        // requires it and it is true regardless.
        expect(sent.text).toMatch(/съда/);
    });

    it('the auto-queued DRAFT is the text that gets delivered, when the locale has not moved', async () => {
        // The property the shared `composeStatementBody` exists for (#1667).
        //
        // The console's `bodyRendered` was always a draft the dispatch job
        // replaced, which was fine while a HUMAN typed it. A statement queued
        // automatically has no human, so the draft is machine-composed — and if
        // the queue and the job composed separately, the console's undelivered
        // view would misreport what is about to be sent.
        //
        // Equality is asserted rather than "both mention the action", because
        // the whole point is that they are one composition and not two that
        // happen to agree today.
        const { id } = await makeUser('bg');
        const actionId = `ma-p54b-${randomUUID()}`;
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ModerationAction"("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
             VALUES ($1,'platform-key:current','ACCOUNT_SUSPENDED','ACCOUNT',$2,$3)`,
            actionId, id, encryptField('repeated unsubstantiated grade claims'),
        );
        actions.push(actionId);

        const queued = await queueStatementForAction({
            actionId,
            recipientUserId: id,
            actionKind: 'ACCOUNT_SUSPENDED',
            rationale: 'repeated unsubstantiated grade claims',
        });
        expect(queued).not.toBeNull();
        statements.push(queued!.statementId);
        await backdate(queued!.statementId);

        const draft = (await globalPrisma.statementOfReasons.findUnique({
            where: { id: queued!.statementId },
            select: { bodyRendered: true, locale: true },
        }))!;
        expect(draft.locale).toBe('bg');

        await runStatementDispatch();

        const delivered = (await globalPrisma.statementOfReasons.findUnique({
            where: { id: queued!.statementId },
            select: { bodyRendered: true, deliveredAt: true },
        }))!;
        expect(delivered.deliveredAt).not.toBeNull();
        // DECRYPTED, because `bodyRendered` is an encrypted column and AES-GCM
        // uses a random IV — identical text has different ciphertext, so a
        // ciphertext comparison fails for two copies of the same sentence.
        // (`globalPrisma` here is a raw client with no encryption middleware,
        // which is why the rows come back as ciphertext at all.)
        expect(decryptField(delivered.bodyRendered)).toBe(decryptField(draft.bodyRendered));
        // And it is the text that actually went out.
        expect(requireSendFor(queued!.statementId).text).toBe(
            decryptField(delivered.bodyRendered),
        );
    });

    it('a draft composed for a DIFFERENT language is replaced — the control', async () => {
        // Without this, the equality above would also hold for a job that
        // ignored the locale entirely. Art 17 wants the recipient's language at
        // SEND time, so a person who switched language between the decision and
        // the send must get the new one.
        const { id } = await makeUser('bg');
        const actionId = `ma-p54b-${randomUUID()}`;
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ModerationAction"("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
             VALUES ($1,'platform-key:current','ACCOUNT_SUSPENDED','ACCOUNT',$2,$3)`,
            actionId, id, encryptField('repeated unsubstantiated grade claims'),
        );
        actions.push(actionId);

        const queued = await queueStatementForAction({
            actionId,
            recipientUserId: id,
            actionKind: 'ACCOUNT_SUSPENDED',
            rationale: 'repeated unsubstantiated grade claims',
        });
        statements.push(queued!.statementId);
        await backdate(queued!.statementId);
        const draft = (await globalPrisma.statementOfReasons.findUnique({
            where: { id: queued!.statementId }, select: { bodyRendered: true },
        }))!;

        // They change their mind about the interface language.
        await globalPrisma.$executeRawUnsafe(
            `UPDATE "User" SET "uiLanguage" = 'en' WHERE "id" = $1`, id);

        await runStatementDispatch();

        const delivered = (await globalPrisma.statementOfReasons.findUnique({
            where: { id: queued!.statementId },
            select: { bodyRendered: true, locale: true },
        }))!;
        expect(delivered.locale).toBe('en');
        expect(decryptField(delivered.bodyRendered)).not.toBe(decryptField(draft.bodyRendered));
    });

    it('delivers in the recipient’s OWN language, not the sender’s', async () => {
        const { id: en } = await makeUser('en');
        const { statementId } = await makeQueuedStatement(en);

        await runStatementDispatch({ limit: 50 });

        // Scoped by the statement's own id, not by a phrase every row in this
        // suite shares — `subjectIds` carries it, so this cannot match a
        // sibling statement.
        const call = requireSendFor(statementId);
        // English, because THEIR column says so — even though the row was
        // queued with `locale: 'bg'` by the console's default.
        expect(call.subject).toMatch(/decision about your content/i);
        expect(call.text).toMatch(/Digital Services Act/);

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

    it('matches each statement to its OWN send, not to a position in the call list', async () => {
        // The scoping half of #2522, and this test is what makes it real.
        //
        // Backdating alone makes this suite's rows the oldest, so `calls[0]`
        // happens to be the right one — measured: reverting a call site to
        // `sendEmail.mock.calls[0][0]` left all ten tests GREEN. A change
        // nothing can detect is a change nothing protects, and CLAUDE.md's rule
        // for this file ("aim a failure at a RECIPIENT, not a call index") would
        // have been satisfied in letter and unprotected in fact.
        //
        // Two statements in ONE batch, so a positional lookup must get one of
        // them wrong whichever position it picks.
        const a = await makeUser('bg');
        const b = await makeUser('en');
        const first = await makeQueuedStatement(a.id);
        const second = await makeQueuedStatement(b.id);

        await runStatementDispatch({ limit: 50 });

        const mailA = requireSendFor(first.statementId);
        const mailB = requireSendFor(second.statementId);
        expect(mailA.to).toBe(a.email);
        expect(mailB.to).toBe(b.email);
        // And they are DIFFERENT sends. Without this, a lookup returning the
        // same call for both would satisfy the two assertions above whenever
        // the recipients happened to match.
        expect(mailA.to).not.toBe(mailB.to);
        // The locale follows the RECIPIENT, which is the second thing that
        // cannot be true of one mail read twice.
        expect(mailB.subject).toMatch(/decision about your content/i);
        expect(mailA.subject).not.toMatch(/decision about your content/i);
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
