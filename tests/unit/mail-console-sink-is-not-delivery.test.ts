/**
 * #3181 — a drain that stamps delivery must not count the production console
 * sink as a send.
 *
 * With no transport configured, `ConsoleEmailProvider.send` logs and RETURNS in
 * production. `sendEmailOrFail` is what the stamping drains call, and it throws
 * there, so their failure paths leave the row undelivered.
 */
import {
    ConsoleEmailProvider,
    MailTransportMissingError,
    StubEmailProvider,
    sendEmailOrFail,
    setEmailProvider,
} from '@/lib/mailer';

const MSG = {
    to: 'moderator@example.test',
    subject: 'Тест',
    text: 'тяло',
    purpose: 'transactional',
} as never;

const ENV = { ...process.env };
afterEach(() => {
    process.env = { ...ENV };
});

describe('sendEmailOrFail (#3181)', () => {
    it('THROWS in production when only the console sink is configured', async () => {
        process.env = { ...ENV, NODE_ENV: 'production', RESEND_API_KEY: '', SMTP_HOST: '' };
        setEmailProvider(new ConsoleEmailProvider());
        await expect(sendEmailOrFail(MSG)).rejects.toBeInstanceOf(MailTransportMissingError);
    });

    it('control: sends through a real provider', async () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);
        await expect(sendEmailOrFail(MSG)).resolves.toBeUndefined();
    });
});
