/**
 * The two auth emails are written in the RECIPIENT's language.
 *
 * Issue #694, first slice. Both reach a user at a moment where a wrong-language
 * message is worst: locked out of a password, or unable to finish signing up.
 * Both had hard-coded English bodies while `User.uiLanguage` — the column that
 * answers the question, `@default("bg")` — sat unread.
 *
 * The locale that matters is the RECIPIENT's. `getTranslations()` resolves from
 * the request cookie, which is the sender's; on a forgot-password form those
 * happen to be the same person, and on nothing else are they. `translateFor`
 * takes an explicit locale for exactly that reason.
 *
 * ── The fallback, and why it is not DEFAULT_LOCALE ───────────────────
 *
 * `DEFAULT_LOCALE` is `'en'` and is documented as the fallback for
 * UNAUTHENTICATED surfaces, kept English so login and its E2E specs stay
 * English. An email recipient is a known user whose column default is `bg`, so
 * `RECIPIENT_FALLBACK_LOCALE` mirrors the column instead. Reading the two as
 * one number is how a Bulgarian farmer gets an English password reset.
 */

const sendEmail = jest.fn();
class MockConsoleEmailProvider {}
jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    ConsoleEmailProvider: MockConsoleEmailProvider,
    getEmailProvider: () => ({}),
}));

const findUnique = jest.fn();
const userUpdate = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findUnique: (...a: unknown[]) => findUnique(...a), update: userUpdate },
        passwordResetToken: {
            create: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUnique: jest.fn(),
        },
        verificationToken: {
            create: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('@/lib/auth/app-base-url', () => ({ getAppBaseUrl: () => 'https://app.example' }));
jest.mock('@/lib/observability/metrics', () => ({
    ...jest.requireActual('@/lib/observability/metrics'),
    recordVerificationEmailDelivery: jest.fn(),
    recordPasswordResetRequested: jest.fn(),
}));

const warn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const EN = en.auth.email as unknown as Record<string, string>;
const BG = bg.auth.email as unknown as Record<string, string>;

type Sent = { to: string; subject: string; text: string; html: string };
const lastSend = (): Sent => sendEmail.mock.calls.at(-1)![0] as Sent;

beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue(undefined);
    findUnique.mockReset();
    warn.mockReset();
});

describe('password-reset email', () => {
    async function request(uiLanguage: string | null) {
        findUnique.mockResolvedValue({
            id: 'u-1',
            email: 'farmer@example.bg',
            passwordHash: 'hash',
            uiLanguage,
        });
        const { issuePasswordReset } = await import('@/lib/auth/password-management');
        await issuePasswordReset('farmer@example.bg');
    }

    it('writes in Bulgarian for a bg user', async () => {
        await request('bg');
        const { subject, text } = lastSend();
        expect(subject).toBe(BG.resetSubject);
        expect(text).toContain(BG.resetIntro);
        expect(text).not.toContain(EN.resetIntro);
    });

    it('writes in English for an en user', async () => {
        await request('en');
        expect(lastSend().subject).toBe(EN.resetSubject);
    });

    it('loads uiLanguage rather than assuming it', async () => {
        await request('bg');
        expect(findUnique.mock.calls[0][0].select).toMatchObject({ uiLanguage: true });
    });

    it('falls back to the RECIPIENT default, not the unauthenticated one', async () => {
        // A null column must not silently mean English: the column default is
        // bg, so bg is what this user would have had.
        await request(null);
        expect(lastSend().text).toContain(BG.resetIntro);
    });

    it('still carries the reset URL, in both languages', async () => {
        await request('bg');
        expect(lastSend().text).toContain('https://app.example/reset-password?token=');
        expect(lastSend().html).toContain('https://app.example/reset-password?token=');
    });

    it('puts the TRANSLATED copy into the HTML body, escaped', async () => {
        // Note what this does and does not claim. Unlike the inquiry email,
        // this template interpolates nothing attacker-controlled — the URL is
        // minted internally and the strings come from the catalogue — so the
        // escaping here is defence-in-depth, not a live XSS boundary. What is
        // worth asserting is that the translated copy actually reaches the
        // HTML body (an em dash the Bulgarian carries and the English does
        // not), and that escaping did not mangle it into entities.
        await request('bg');
        const { html } = lastSend();
        expect(html).toContain('—');
        expect(html).toContain(BG.resetCta);
        expect(html).not.toContain('<script');
        // The anchor carries the real link, not an escaped-to-death version.
        expect(html).toMatch(/<a href="https:\/\/app\.example\/reset-password\?token=[a-f0-9]+">/);
    });
});

describe('verification email', () => {
    async function send(uiLanguage: string | null | undefined, lookupThrows = false) {
        if (lookupThrows) findUnique.mockRejectedValue(new Error('db down'));
        else findUnique.mockResolvedValue(uiLanguage === undefined ? null : { uiLanguage });
        const mod = await import('@/lib/auth/email-verification');
        await mod.issueEmailVerification('new@example.bg', { userId: 'u-1' });
    }

    it('writes in Bulgarian for a bg user', async () => {
        await send('bg');
        const { subject, text } = lastSend();
        expect(subject).toBe(BG.verifySubject);
        expect(text).toContain(BG.verifyIntro);
    });

    it('writes in English for an en user', async () => {
        await send('en');
        expect(lastSend().subject).toBe(EN.verifySubject);
    });

    it('looks the preference up — it is handed only a userId', async () => {
        await send('bg');
        expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ select: { uiLanguage: true } }),
        );
    });

    it('STILL SENDS when the locale lookup throws', async () => {
        // Fail-soft, deliberately. A verification mail in the fallback
        // language is recoverable; one that never arrives locks the user out
        // of signup once AUTH_REQUIRE_EMAIL_VERIFICATION=1.
        await send(null, true);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(lastSend().text).toContain(BG.verifyIntro);
        expect(warn).toHaveBeenCalled();
    });

    it('still sends when the user row is missing entirely', async () => {
        await send(undefined);
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });
});
