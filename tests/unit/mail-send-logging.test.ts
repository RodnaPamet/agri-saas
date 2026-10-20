/**
 * Every send is logged, with the provider's message id (#1753).
 *
 * ## What this exists because of
 *
 * On 2026-10-13 a DSA Art 16 alert was filed on production, the triage job
 * reported a successful send, `alertedAt` was stamped — and the message
 * BOUNCED minutes later (`550 … the account or domain may not exist`). Nothing
 * in the product knew. `sendEmail` was two lines:
 *
 *     await provider.send(msg);
 *
 * No log, no try/catch, no record. The only mailer log in the system was
 * "Mailer transport selected" at startup, so a failed send and a successful
 * one were the same observable — and the Resend message id, which turns a
 * delivery failure into a one-call lookup, was discarded by the provider.
 *
 * Diagnosing it needed a live API call from inside the running container.
 *
 * ## What these cases pin, and the one they deliberately do NOT
 *
 * A success line carrying the id, a failure line at `error`, the rethrow that
 * callers' retry semantics depend on, and the recipient DOMAIN rather than the
 * address.
 *
 * They do NOT pin delivery. `sendEmail` resolving means the provider ACCEPTED
 * the message; a bounce arrives asynchronously at the provider minutes later
 * and no return value here can report it. That is #1753's remaining half — a
 * bounce webhook — and saying so here stops a future reader treating
 * `mail.sent` as proof a human received something. It is exactly the mistake
 * the incident consisted of.
 */
const info = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: (...a: unknown[]) => info(...a), warn: jest.fn(), error: (...a: unknown[]) => error(...a), debug: jest.fn() },
}));

import {
    sendEmail,
    setEmailProvider,
    StubEmailProvider,
    ResendProvider,
    type EmailProvider,
} from '@/lib/mailer';

// `purpose` is required since #1769, so this one fixture carries it for all
// six cases below — the correlation row is written from it.
const MSG = {
    to: 'operator@example.test',
    subject: 'subj',
    text: 'body',
    purpose: 'mail-canary' as const,
};

beforeEach(() => {
    info.mockReset();
    error.mockReset();
});

describe('a successful send is logged', () => {
    it('logs mail.sent with the provider and the recipient DOMAIN', async () => {
        setEmailProvider(new StubEmailProvider());

        await sendEmail(MSG);

        expect(info).toHaveBeenCalledWith('mail.sent', expect.objectContaining({
            component: 'mailer',
            provider: 'stub',
            recipientDomain: 'example.test',
        }));
    });

    it('NEVER logs the address itself', async () => {
        // Epic C.4: an audit actor is an opaque id, never an email. A log line
        // naming who was invited, who reported what, or who asked to be
        // deleted is the disclosure this product is built to avoid.
        setEmailProvider(new StubEmailProvider());

        await sendEmail(MSG);

        expect(JSON.stringify(info.mock.calls)).not.toContain('operator@example.test');
        expect(JSON.stringify(info.mock.calls)).not.toContain('operator');
    });

    it('carries the provider MESSAGE ID when there is one', async () => {
        // THE FIELD THE INCIDENT NEEDED. Without it the bounce could only be
        // found by listing every recent message from the provider's API.
        const withId: EmailProvider = { send: async () => 'msg_abc123' };
        setEmailProvider(withId);

        await sendEmail(MSG);

        expect(info).toHaveBeenCalledWith('mail.sent', expect.objectContaining({
            messageId: 'msg_abc123',
        }));
    });

    it('records null rather than inventing an id for transports that mint none', async () => {
        // SMTP and the console sink have no id. `null` is a legitimate answer
        // and must not read as a failure.
        setEmailProvider(new StubEmailProvider());

        await sendEmail(MSG);

        expect(info).toHaveBeenCalledWith('mail.sent', expect.objectContaining({ messageId: null }));
    });
});

describe('a failed send is loud, and still throws', () => {
    it('logs mail.send_failed at error level', async () => {
        const failing: EmailProvider = {
            send: async () => { throw new Error('Resend API error 422: domain not verified'); },
        };
        setEmailProvider(failing);

        await expect(sendEmail(MSG)).rejects.toThrow();

        expect(error).toHaveBeenCalledWith('mail.send_failed', expect.objectContaining({
            component: 'mailer',
            recipientDomain: 'example.test',
            error: expect.stringContaining('422'),
        }));
    });

    it('RETHROWS, because callers’ retry semantics depend on it', async () => {
        // THE MUTATION TARGET. `notice-triage-alert` stamps `alertedAt` only
        // after `sendEmail` resolves, precisely so a failure retries on the
        // next run. Swallowing here would mark notices alerted that were never
        // sent — converting a loud failure into the silent one this change
        // exists to end.
        const failing: EmailProvider = { send: async () => { throw new Error('boom'); } };
        setEmailProvider(failing);

        await expect(sendEmail(MSG)).rejects.toThrow('boom');
    });

    it('does not log a success when the send failed', async () => {
        const failing: EmailProvider = { send: async () => { throw new Error('boom'); } };
        setEmailProvider(failing);

        await expect(sendEmail(MSG)).rejects.toThrow();

        expect(info).not.toHaveBeenCalledWith('mail.sent', expect.anything());
    });
});

describe('what a log line does NOT claim', () => {
    it('mail.sent means ACCEPTED, and the field names say so', async () => {
        // Pinned as a reminder rather than a mechanism: the incident was
        // exactly this confusion, and the fix for it is a bounce webhook
        // (#1753's remaining half), not anything observable here.
        setEmailProvider(new StubEmailProvider());

        await sendEmail(MSG);

        const [, fields] = info.mock.calls.find((c) => c[0] === 'mail.sent')!;
        expect(Object.keys(fields as object).sort()).toEqual(
            ['component', 'durationMs', 'messageId', 'provider', 'recipientDomain'],
        );
        // No `delivered` field, deliberately — there is nothing here that
        // could set one honestly.
        expect(fields).not.toHaveProperty('delivered');
    });
});

/**
 * The REAL `ResendProvider` extracts the id — not a stub that returns one.
 *
 * Found by mutation: replacing `return body?.id ?? null` with `return null`
 * left the whole suite GREEN, because every case above injects a stub provider
 * and asserts the plumbing between `provider.send` and the log line. The
 * extraction itself — reading `id` out of Resend's success body, which that
 * provider previously DISCARDED — was covered by nothing.
 *
 * `a-control-that-cannot-express-failure`: a self-authored double validates
 * your fiction of the provider, not the provider.
 */
describe('ResendProvider extracts the id from the real response shape', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    function mockResend(status: number, body: unknown) {
        global.fetch = jest.fn(async () => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => JSON.stringify(body),
        })) as unknown as typeof fetch;
    }

    it('returns the id Resend sends back', async () => {
        // THE MUTATION TARGET. Resend's success body is `{ id, from, to, … }`.
        mockResend(200, { id: '01a13699-86b3-78ec-9d77-dadb48ac6627' });
        setEmailProvider(new ResendProvider('key', 'Agrent <noreply@example.test>'));

        await sendEmail(MSG);

        expect(info).toHaveBeenCalledWith('mail.sent', expect.objectContaining({
            provider: 'resend',
            messageId: '01a13699-86b3-78ec-9d77-dadb48ac6627',
        }));
    });

    it('survives a success body with no id rather than throwing', async () => {
        // A provider that changed its response shape must not break sending.
        // `null` is the honest answer and the caller already tolerates it.
        mockResend(200, {});
        setEmailProvider(new ResendProvider('key', 'Agrent <noreply@example.test>'));

        await sendEmail(MSG);

        expect(info).toHaveBeenCalledWith('mail.sent', expect.objectContaining({ messageId: null }));
    });

    it('still throws on a non-2xx, carrying the status', async () => {
        // The behaviour the retry depends on, pinned against the real provider
        // rather than a stub that throws on command.
        mockResend(422, { message: 'domain is not verified' });
        setEmailProvider(new ResendProvider('key', 'Agrent <noreply@example.test>'));

        await expect(sendEmail(MSG)).rejects.toThrow(/422/);
        expect(error).toHaveBeenCalledWith('mail.send_failed', expect.objectContaining({
            provider: 'resend',
        }));
    });
});

