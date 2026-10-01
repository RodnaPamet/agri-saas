/**
 * P0.6 — the mail transport SELECTION is observable, and proven by BEHAVIOUR.
 *
 * Resend went live in production on 2026-10-01 and delivery was proved by
 * calling Resend's API by hand with the container's env. That proves the
 * CREDENTIALS work. It proves nothing about `sendEmail`: the console sink
 * logged at `debug`, which production log levels drop, so a silent fallback to
 * "log the message and throw it away" was indistinguishable from a successful
 * send — for invites, verification links and password resets alike.
 *
 * So these tests assert what each configuration DOES, not what mailer.ts says:
 *
 *   • RESEND_API_KEY present      → an HTTPS POST reaches api.resend.com
 *   • absent, SMTP_HOST present   → nodemailer's sendMail is called
 *   • neither                     → nothing leaves the process, and under
 *                                   NODE_ENV=production the send WARNs that
 *                                   the message was NOT sent
 *   • neither, dev/test           → stays at `debug`; local dev stays quiet
 *
 * A source-text assertion ("mailer.ts mentions RESEND_API_KEY first") would
 * stay green through a refactor that dropped the behaviour. Each case here also
 * checks `emailCapabilityStatus` — what `/api/readyz` reports — agrees with the
 * transport that actually ran, because a probe that can disagree with the
 * sender is worse than no probe.
 */
const createTransportMock = jest.fn();
const sendMailMock = jest.fn().mockResolvedValue(undefined);

jest.mock('nodemailer', () => ({
    __esModule: true,
    default: {
        createTransport: (...args: unknown[]) => {
            createTransportMock(...args);
            return { sendMail: sendMailMock };
        },
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// A mutable stand-in for the validated env, so each case can declare exactly
// the mail configuration it is about (the same technique as
// tests/unit/mailer-default-sender.test.ts).
jest.mock('@/env', () => ({ env: {} as Record<string, unknown> }));

import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import {
    ConsoleEmailProvider,
    NodemailerProvider,
    ResendProvider,
    getEmailProvider,
    initMailerFromEnv,
    sendEmail,
    setEmailProvider,
    type EmailMessage,
} from '@/lib/mailer';
import { emailCapabilityStatus } from '@/lib/email/provider-selection';

const RESET_MSG: EmailMessage = {
    to: 'farmer@example.com',
    subject: 'Нулиране на паролата',
    text: 'Reset your password: https://app.agrent.bg/reset?token=SECRET-RESET-TOKEN',
};

function setEnv(o: Record<string, unknown>): void {
    for (const k of Object.keys(env)) delete (env as Record<string, unknown>)[k];
    Object.assign(env, o);
}

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeEach(() => {
    createTransportMock.mockClear();
    sendMailMock.mockClear();
    (logger.warn as jest.Mock).mockClear();
    (logger.debug as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    // Back to the module default, so each case selects from scratch.
    setEmailProvider(new ConsoleEmailProvider());
});

afterEach(() => {
    global.fetch = realFetch;
    setEnv({});
    setEmailProvider(new ConsoleEmailProvider());
});

describe('mail transport selection — RESEND_API_KEY present', () => {
    it('sends through Resend, and reports provider "resend"', async () => {
        setEnv({
            NODE_ENV: 'production',
            RESEND_API_KEY: 're_live_key',
            RESEND_FROM: 'noreply@agrent.bg',
            // SMTP is configured too, and must lose.
            SMTP_HOST: 'smtp.example.test',
            SMTP_PORT: 587,
        });

        initMailerFromEnv();
        await sendEmail(RESET_MSG);

        expect(getEmailProvider()).toBeInstanceOf(ResendProvider);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
        // SMTP never got constructed, and nothing was discarded.
        expect(createTransportMock).not.toHaveBeenCalled();
        expect(sendMailMock).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();

        expect(emailCapabilityStatus(env)).toEqual({ provider: 'resend', sends: true });
    });
});

describe('mail transport selection — no Resend key, SMTP_HOST present', () => {
    it('sends through SMTP, and reports provider "smtp"', async () => {
        setEnv({
            NODE_ENV: 'production',
            SMTP_HOST: 'smtp.example.test',
            SMTP_PORT: 587,
            SMTP_USER: 'u',
            SMTP_PASS: 'p',
            // An operator-owned sender, NOT the built-in default — otherwise
            // initMailerFromEnv's deliverability warning fires and this case
            // could no longer tell "nothing was discarded" from "something
            // warned" (tests/unit/mailer-default-sender.test.ts owns that one).
            SMTP_FROM: 'mail@agrent.bg',
        });

        initMailerFromEnv();
        await sendEmail(RESET_MSG);

        expect(getEmailProvider()).toBeInstanceOf(NodemailerProvider);
        expect(sendMailMock).toHaveBeenCalledTimes(1);
        expect((sendMailMock.mock.calls[0][0] as { to: string }).to).toBe(RESET_MSG.to);
        // No Resend call, and nothing discarded.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();

        expect(emailCapabilityStatus(env)).toEqual({ provider: 'smtp', sends: true });
    });
});

describe('mail transport selection — neither configured', () => {
    it('keeps the console sink and WARNs in production that mail was NOT sent', async () => {
        setEnv({ NODE_ENV: 'production' });

        initMailerFromEnv();
        await sendEmail(RESET_MSG);

        expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
        // Nothing left the process by either transport.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sendMailMock).not.toHaveBeenCalled();

        // The whole point: a production send through the console sink is a
        // DROPPED message, and it must be visible at a level production keeps.
        const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(([m]: [string]) =>
            /NOT SENT/i.test(m),
        );
        expect(warnCalls).toHaveLength(1);
        const [message, fields] = warnCalls[0] as [string, Record<string, unknown>];
        expect(message).toMatch(/discarded/i);
        expect(fields).toMatchObject({
            component: 'mailer',
            provider: 'console',
            delivered: false,
            subject: RESET_MSG.subject,
        });
        // ...and the warn must not carry the body: these messages hold
        // password-reset and verification tokens, and a WARN reaches log
        // storage.
        expect(JSON.stringify(fields)).not.toContain('SECRET-RESET-TOKEN');
        expect(fields).not.toHaveProperty('bodyPreview');

        expect(emailCapabilityStatus(env)).toEqual({ provider: 'console', sends: false });
    });

    it('stays quiet outside production — the console sink is the dev default', async () => {
        setEnv({ NODE_ENV: 'development' });

        initMailerFromEnv();
        await sendEmail(RESET_MSG);

        expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringMatching(/console sink/i),
            expect.objectContaining({ component: 'mailer' }),
        );
    });
});

describe('the selected transport is named in the logs', () => {
    it.each([
        [{ NODE_ENV: 'production', RESEND_API_KEY: 're_k' }, 'resend', true],
        [{ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.test' }, 'smtp', true],
        [{ NODE_ENV: 'production' }, 'console', false],
    ])('logs provider=%o as %s', (envVars, provider, sends) => {
        setEnv(envVars as Record<string, unknown>);

        initMailerFromEnv();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/transport selected/i),
            expect.objectContaining({ component: 'mailer', provider, sends }),
        );
        // Never the credential itself.
        const fields = JSON.stringify((logger.info as jest.Mock).mock.calls);
        expect(fields).not.toContain('re_k');
    });
});
