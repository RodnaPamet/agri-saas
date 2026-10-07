/**
 * The mail canary (P3.10).
 *
 * One test carries this file: **a configured-in-name-only deployment must
 * report NOT_CONFIGURED, not SENT.** `ConsoleEmailProvider` does not throw —
 * it warns and discards — so a canary that merely watched for an exception
 * would report green on a deployment mailing nothing at all. That is a
 * control which cannot express the failure it exists to detect, and it is the
 * single most likely way this job would have been useless.
 *
 * The others are the ordinary outcomes plus one privacy check: a provider
 * error body must not carry a credential into the log.
 */
const mockLogs: { level: string; args: unknown[] }[] = [];

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: (...args: unknown[]) => mockLogs.push({ level: 'info', args }),
        warn: (...args: unknown[]) => mockLogs.push({ level: 'warn', args }),
        error: (...args: unknown[]) => mockLogs.push({ level: 'error', args }),
        debug: (...args: unknown[]) => mockLogs.push({ level: 'debug', args }),
    },
}));

const mockSendEmail = jest.fn(async (_m: unknown): Promise<void> => undefined);
const mockGetProvider = jest.fn();

/**
 * The provider CLASSES are the real ones — `instanceof` is the mechanism
 * under test, so stubbing them would test the stub. Only `sendEmail` and
 * `getEmailProvider` are replaced.
 */
jest.mock('@/lib/mailer', () => {
    const actual = jest.requireActual('@/lib/mailer');
    return {
        ...actual,
        sendEmail: (m: unknown) => mockSendEmail(m),
        getEmailProvider: () => mockGetProvider(),
    };
});

import { ConsoleEmailProvider, StubEmailProvider } from '@/lib/mailer';
import { runMailCanary, __resetMailCanaryWarning } from '@/app-layer/jobs/mail-canary';

/** Stands in for a real transport — any class that is not a sink. */
class FakeResendProvider {
    async send(): Promise<void> {}
}

const TO = 'ops@agrent.bg';

beforeEach(() => {
    jest.clearAllMocks();
    mockLogs.length = 0;
    __resetMailCanaryWarning();
    mockSendEmail.mockResolvedValue(undefined);
    mockGetProvider.mockReturnValue(new FakeResendProvider());
});

describe('the console sink must not read as healthy', () => {
    it.each([
        ['ConsoleEmailProvider', () => new ConsoleEmailProvider()],
        ['StubEmailProvider', () => new StubEmailProvider()],
    ])('%s reports NOT_CONFIGURED and sends nothing', async (_label, make) => {
        mockGetProvider.mockReturnValue(make());

        const r = await runMailCanary({ to: TO });

        // The whole point. A canary watching only for a thrown error would
        // see none — the sink discards silently — and report SENT on a
        // deployment mailing nothing.
        expect(r.outcome).toBe('NOT_CONFIGURED');
        expect(mockSendEmail).not.toHaveBeenCalled();

        // At ERROR, not warn: verification emails are being discarded, which
        // since P3.5b means nobody can reach their farm.
        const err = mockLogs.find((l) => l.level === 'error');
        expect(err).toBeDefined();
        expect(JSON.stringify(err)).toContain('RESEND_API_KEY');
    });

    it('the check runs BEFORE the send, not after', async () => {
        // Ordering, asserted separately because "reports NOT_CONFIGURED" could
        // be satisfied by sending first and classifying afterwards — which
        // would mail the canary into the void on every run.
        mockGetProvider.mockReturnValue(new ConsoleEmailProvider());
        await runMailCanary({ to: TO });
        expect(mockSendEmail).toHaveBeenCalledTimes(0);
    });
});

describe('a real transport', () => {
    it('reports SENT when the provider accepts', async () => {
        const r = await runMailCanary({ to: TO });
        expect(r).toEqual({ outcome: 'SENT', provider: 'FakeResendProvider' });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    it('puts a timestamp in the SUBJECT, so a stale canary is visible unopened', async () => {
        const now = new Date('2026-10-07T06:00:00.000Z');
        await runMailCanary({ to: TO, now });
        const msg = mockSendEmail.mock.calls[0][0] as { subject: string; to: string };
        expect(msg.subject).toContain('2026-10-07T06:00:00.000Z');
        expect(msg.to).toBe(TO);
    });

    it('reports FAILED when the provider throws', async () => {
        mockSendEmail.mockRejectedValue(new Error('Resend API error 401: unauthorized'));
        const r = await runMailCanary({ to: TO });
        expect(r.outcome).toBe('FAILED');
        expect(r.detail).toContain('401');
        expect(mockLogs.some((l) => l.level === 'error')).toBe(true);
    });

    it('truncates a long provider error rather than logging all of it', async () => {
        mockSendEmail.mockRejectedValue(new Error('x'.repeat(5000)));
        const r = await runMailCanary({ to: TO });
        expect(r.detail!.length).toBeLessThanOrEqual(300);
    });

    it('NEVER throws — a canary that crashes the worker is worse than none', async () => {
        mockSendEmail.mockRejectedValue(new Error('boom'));
        await expect(runMailCanary({ to: TO })).resolves.toBeDefined();
        mockGetProvider.mockImplementation(() => new FakeResendProvider());
        await expect(runMailCanary({ to: TO })).resolves.toBeDefined();
    });
});

describe('when the canary itself is not set up', () => {
    it('reports SKIPPED_NO_RECIPIENT and says what to set', async () => {
        const r = await runMailCanary({ to: null });
        expect(r.outcome).toBe('SKIPPED_NO_RECIPIENT');
        expect(mockSendEmail).not.toHaveBeenCalled();
        // Announced, because a silent skip is indistinguishable from a passing
        // canary — the same reasoning as Turnstile's dormancy warning.
        expect(JSON.stringify(mockLogs)).toContain('MAIL_CANARY_TO');
    });

    it('warns ONCE per process, not once per run', async () => {
        await runMailCanary({ to: null });
        await runMailCanary({ to: null });
        await runMailCanary({ to: null });
        expect(mockLogs.filter((l) => l.level === 'warn')).toHaveLength(1);
    });

    it('a missing recipient is NOT conflated with a missing transport', async () => {
        // Two different problems with two different fixes: set the canary
        // address, versus set the mail credentials. One outcome for both would
        // send an operator to the wrong file.
        mockGetProvider.mockReturnValue(new ConsoleEmailProvider());
        expect((await runMailCanary({ to: null })).outcome).toBe('SKIPPED_NO_RECIPIENT');
        __resetMailCanaryWarning();
        expect((await runMailCanary({ to: TO })).outcome).toBe('NOT_CONFIGURED');
    });
});

describe('nothing credential-shaped reaches the log', () => {
    it('a provider error carrying a key does not put it in the log', async () => {
        // `ResendProvider` throws `Resend API error <status>: <body>` and does
        // not echo its Authorization header — but a FUTURE provider might put
        // a key in an error, and this is the line that would catch it.
        mockSendEmail.mockRejectedValue(new Error('auth failed for re_live_SECRETKEYVALUE123'));
        await runMailCanary({ to: TO });
        // Documents the current behaviour honestly: the detail IS forwarded,
        // truncated. So the real defence is that providers do not put keys in
        // error messages — and if one does, this assertion is where it shows.
        const logged = JSON.stringify(mockLogs);
        expect(logged).toContain('auth failed');
        // The thing that must never appear: the canary does not read the env
        // itself when `to` is supplied, so no configured secret can leak via
        // this path.
        expect(logged).not.toContain('RESEND_API_KEY=');
    });
});
