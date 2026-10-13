/**
 * P5.8 — the triage alert (#1599).
 *
 * Four claims, each of which fails quietly:
 *
 *   - **a notice flood cannot become a mail flood.** The notice route is
 *     unauthenticated at 10/min per IP, so a per-notice email would be an
 *     amplifier pointed at the one mailbox that has to stay readable during an
 *     incident. One message per run, whatever arrives.
 *   - **nothing is marked until the send resolves.** A notice stamped `alertedAt`
 *     on a failed send leaves the queue silently, and nothing else shows it.
 *   - **the notice TEXT is never in the mail.** `detail` is the notifier's free
 *     text, encrypted at rest; emailing it moves personal data outside the KEK
 *     boundary for no operational gain.
 *   - **it is silent and harmless when unconfigured.** `DSA_CONTACT_EMAIL` is
 *     absent on the VM today, so the common case in production right now is the
 *     no-address branch.
 *
 * The mailer is mocked; the database is real, because the queue and the marker
 * are what carry the behaviour.
 */
const sendEmail = jest.fn();
jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    getEmailProvider: jest.fn(),
    ConsoleEmailProvider: class {},
}));

let contactEmail: string | undefined = 'moderation@example.test';
jest.mock('@/env', () => {
    // A PROXY over the real env, intercepting one key.
    //
    // Spreading it does not work, and the failure is silent: `env` from
    // `@t3-oss/env-nextjs` is a Proxy with ZERO own keys — measured,
    // `Object.keys(env).length === 0` while `env.DATABASE_URL` is a string. So
    // `{ ...actual.env }` yields an EMPTY object, every variable reads
    // `undefined`, and the app's Prisma client falls back to port 5432. That is
    // how my first two attempts failed seven tests with `Can't reach database
    // server at 127.0.0.1:5432` — a mock that looked like a partial override
    // and was a total replacement.
    //
    // The proxy forwards everything and answers one key from a mutable local,
    // so a test can flip the address between cases without re-importing.
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        ...actual,
        env: new Proxy(actual.env, {
            get(target, prop, receiver) {
                if (prop === 'DSA_CONTACT_EMAIL') return contactEmail;
                return Reflect.get(target, prop, receiver);
            },
        }),
    };
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runNoticeTriageAlert, URGENT_REASON_CODES } from '@/app-layer/jobs/notice-triage-alert';
import { encryptField } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const reports: string[] = [];

async function fileNotice(reasonCode: string, detail: string): Promise<string> {
    const id = `cr-p58-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,$3::"ReportReasonCode",'RECEIVED',$4,NULL)`,
        id, `listing-${randomUUID()}`, reasonCode, encryptField(detail),
    );
    reports.push(id);
    return id;
}

/** Clear the queue so each test's own notices are the only ones waiting. */
async function drainQueue(): Promise<void> {
    await globalPrisma.$executeRawUnsafe(
        `UPDATE "ContentReport" SET "alertedAt" = NOW() WHERE "alertedAt" IS NULL`);
}

async function alertedAtFor(id: string): Promise<Date | null> {
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ a: Date | null }>>(
        `SELECT "alertedAt" AS a FROM "ContentReport" WHERE "id" = $1`, id);
    return rows[0]?.a ?? null;
}

describeFn('P5.8 — the triage alert (#1599)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    beforeEach(async () => {
        jest.clearAllMocks();
        sendEmail.mockReset();
        sendEmail.mockResolvedValue(undefined);
        contactEmail = 'moderation@example.test';
        // The queue is global, so another suite's notices would appear in this
        // one's message — the P5.4b lesson about aiming at content rather than
        // at a count.
        await drainQueue();
    });

    afterAll(async () => {
        if (reports.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ContentReport" WHERE "id" = ANY($1::text[])`, reports);
        }
        await globalPrisma.$disconnect();
    });

    it('sends ONE message for many notices', async () => {
        // The flood property. Twelve notices, one email.
        for (let i = 0; i < 12; i += 1) await fileNotice('SPAM', `spam ${i}`);

        const { result } = await runNoticeTriageAlert({ limit: 200 });

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(result.itemsScanned).toBe(12);
        expect(result.itemsActioned).toBe(12);
    });

    it('LEADS with the urgent codes and counts the rest', async () => {
        const urgentId = await fileNotice('ILLEGAL_CONTENT', 'urgent one');
        await fileNotice('SPAM', 'routine one');

        await runNoticeTriageAlert({ limit: 200 });

        const msg = sendEmail.mock.calls[0][0] as { subject: string; text: string };
        // The subject carries the urgent COUNT, so an operator triages from
        // the inbox list without opening anything.
        //
        // Asserted in BULGARIAN, because that is what the job sends: the
        // recipient is resolved at `RECIPIENT_FALLBACK_LOCALE`, not English. I
        // wrote `/1 urgent/` first and it failed against
        // "Agrent модерация: 1 спешен, 2 чакащи сигнала" — which is the job
        // being right and the test being written from the wrong assumption.
        // The count follows a LABEL ("спешни: 1") rather than preceding a
        // noun, which is grammatical at any number in both languages. I
        // reached for an ICU plural first and it came back UNFORMATTED:
        // `translateFor` is a simple `interpolate`, with no ICU support — and
        // the i18n drift check caught the malformed result, reading `{no
        // urgent}` in the English as a placeholder named `no`.
        expect(msg.subject).toMatch(/спешни: 1/);
        expect(msg.subject).toMatch(/чакащи: 2/);
        expect(msg.text).toContain(urgentId);
        expect(msg.text).toMatch(/ILLEGAL_CONTENT/);
    });

    it('NEVER puts the notice text in the mail', async () => {
        const secret = `notifier-words-${randomUUID()}`;
        await fileNotice('HARASSMENT_OR_HATE', secret);

        await runNoticeTriageAlert({ limit: 200 });

        const msg = JSON.stringify(sendEmail.mock.calls[0][0]);
        // `detail` is encrypted at rest for a reason, and a mailbox is outside
        // that boundary. The moderator opens the console to read it.
        expect(msg).not.toContain(secret);
    });

    it('does NOT mark anything when the send fails', async () => {
        const id = await fileNotice('SPAM', 'send will fail');
        sendEmail.mockRejectedValue(new Error('smtp refused'));

        const { result } = await runNoticeTriageAlert({ limit: 200 });

        // Still queued, so the next run tries again. A row marked alerted on a
        // failed send takes the gap off the only surface that showed it.
        expect(await alertedAtFor(id)).toBeNull();
        expect(result.itemsActioned).toBe(0);
        expect(result.itemsSkipped).toBeGreaterThan(0);
        // And the RUN succeeded: an unreachable mailbox is a finding, not a
        // reason to retry the batch and re-send what already went.
        expect(result.success).toBe(true);
    });

    it('does not re-alert an already alerted notice', async () => {
        const id = await fileNotice('SPAM', 'once only');
        await runNoticeTriageAlert({ limit: 200 });
        const first = await alertedAtFor(id);
        expect(first).not.toBeNull();

        const { result } = await runNoticeTriageAlert({ limit: 200 });

        // The queue IS `alertedAt IS NULL`, so idempotence needs no flag of
        // its own — and the second run sends nothing at all.
        expect(result.itemsScanned).toBe(0);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect((await alertedAtFor(id))!.getTime()).toBe(first!.getTime());
    });

    it('sends nothing when there is nothing waiting', async () => {
        const { result } = await runNoticeTriageAlert({ limit: 200 });

        expect(sendEmail).not.toHaveBeenCalled();
        expect(result.details).toMatchObject({ nothingWaiting: true });
    });

    it('is SILENT and marks nothing when no contact address is configured', async () => {
        // This WAS the production state when the case was written (2026-10-11):
        // `DSA_CONTACT_EMAIL` absent, `/dsa-contact` rendering its fallback, so
        // the branch was the common case rather than an edge one.
        //
        // It is no longer: the address is PRESENT as of 2026-10-13 and the job
        // sends. The case stays because the branch still has to be correct —
        // this deployment spent two days in it, a fresh deployment starts in
        // it, and the `alertedAt` assertion below is what makes leaving it
        // safe. Left as a live claim, the comment would tell the next reader
        // the alert path is dormant in production when it is running.
        const id = await fileNotice('ILLEGAL_CONTENT', 'nowhere to send');
        contactEmail = undefined;

        const { result } = await runNoticeTriageAlert({ limit: 200 });

        expect(sendEmail).not.toHaveBeenCalled();
        // Crucially NOT marked: the notice must still be waiting when an
        // operator finally sets the address, or configuring it correctly would
        // silently skip everything filed beforehand.
        expect(await alertedAtFor(id)).toBeNull();
        expect(result.details).toMatchObject({ skippedReason: 'no_contact_address' });
        expect(result.success).toBe(true);
    });

    it('the urgent list is the two codes the owner named, and they are real', async () => {
        expect([...URGENT_REASON_CODES]).toEqual(['ILLEGAL_CONTENT', 'HARASSMENT_OR_HATE']);
        // Both must be live enum values, or the filter silently matches
        // nothing and every notice looks routine.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ v: string }>>(
            `SELECT unnest(enum_range(NULL::"ReportReasonCode"))::text AS v`);
        const values = rows.map((r) => r.v);
        for (const code of URGENT_REASON_CODES) expect(values).toContain(code);
    });

    it('orders oldest first, because that is what the clock measures', async () => {
        const older = await fileNotice('SPAM', 'older');
        await globalPrisma.$executeRawUnsafe(
            `UPDATE "ContentReport" SET "createdAt" = NOW() - INTERVAL '2 hours'
             WHERE "id" = $1`, older);
        const newer = await fileNotice('SPAM', 'newer');

        await runNoticeTriageAlert({ limit: 200 });

        const text = (sendEmail.mock.calls[0][0] as { text: string }).text;
        expect(text.indexOf(older)).toBeLessThan(text.indexOf(newer));
    });
});
