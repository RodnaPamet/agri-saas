/**
 * The invite email is written in the INVITER's language (#722).
 *
 * ## The decision this pins
 *
 * Every other outbound email reads the recipient's `User.uiLanguage`. An
 * invitee has no `User` row — that is the entire point of an invite — so this
 * one email must pick a PROXY. The alternatives were weighed against measured
 * production data (5 users: 4 `bg`, 1 `en`; the column defaults to `bg`):
 *
 *   - inviter's language — right for the common case, a Bulgarian farm
 *     inviting Bulgarian staff; no worse than English for a foreign invitee;
 *   - bilingual — never wrong, doubles the body;
 *   - English — looks neutral, is wrong for four users in five here;
 *   - ask the admin — needs a schema column, UI on three surfaces, and a
 *     decision imposed on every invite.
 *
 * The product call was the inviter's language. These tests exist so that
 * choice is visible in the suite rather than inferable only from a closed
 * issue.
 */
const sendEmailMock = jest.fn();
jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmailMock(...a),
    ConsoleEmailProvider: class {},
    getEmailProvider: () => ({}),
}));

const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const warn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sendInviteEmail } from '@/lib/email/invite-email';
import { inviterLocale } from '@/lib/email/inviter-locale';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const EN = (en.notificationEmail as unknown as { invite: Record<string, string> }).invite;
const BG = (bg.notificationEmail as unknown as { invite: Record<string, string> }).invite;

const base = {
    to: 'agronom@example.bg',
    acceptUrl: 'https://app.example/invite/tok123',
    kind: 'workspace' as const,
    spaceName: 'Ферма Тракия',
    roleLabel: 'Редактор',
    invitedByName: 'Иван Петров',
    expiresAt: new Date('2026-06-10T00:00:00Z'),
    now: new Date('2026-06-03T00:00:00Z'),
};

const sent = () => sendEmailMock.mock.calls.at(-1)![0] as { subject: string; text: string; html: string };

beforeEach(() => {
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    findUnique.mockReset();
    warn.mockReset();
});

describe('sendInviteEmail honours the locale it is given', () => {
    it('writes Bulgarian', async () => {
        await sendInviteEmail({ ...base, locale: 'bg' });
        const msg = sent();
        expect(msg.subject).toContain('Покана да се присъедините');
        expect(msg.text).toContain('Иван Петров ви покани');
        expect(msg.subject).not.toContain('Invitation to join');
    });

    it('writes English', async () => {
        await sendInviteEmail({ ...base, locale: 'en' });
        expect(sent().subject).toContain('Invitation to join');
        expect(sent().subject).not.toContain('Покана');
    });

    it('keeps the acceptance URL and the space name identical in both', async () => {
        // Data is data. A broken deep link is the one failure that makes the
        // email useless rather than merely awkward.
        for (const locale of ['bg', 'en'] as const) {
            await sendInviteEmail({ ...base, locale });
            expect(sent().text).toContain('https://app.example/invite/tok123');
            expect(sent().html).toContain('https://app.example/invite/tok123');
            expect(sent().subject).toContain('Ферма Тракия');
        }
    });

    it('translates the space KIND, which is a word not a name', async () => {
        // `kind` is 'workspace' | 'organization' — a label, unlike spaceName.
        await sendInviteEmail({ ...base, locale: 'bg' });
        expect(sent().text).toContain(
            (BG as unknown as { kind: Record<string, string> }).kind.workspace,
        );
        expect(sent().text).not.toContain('workspace');
    });

    it('uses the no-inviter phrasing when the name is absent', async () => {
        // A separate catalogue key, and the branch a single happy-path test
        // would miss.
        await sendInviteEmail({ ...base, invitedByName: null, locale: 'bg' });
        expect(sent().text).not.toContain('Иван Петров');
        expect(sent().text).toContain('Поканени сте');
    });

    it('pluralises the expiry in both languages', async () => {
        // The previous English copy already pluralised; collapsing it to
        // "day(s)" during translation would have been a quality regression,
        // and the pre-existing test caught exactly that.
        await sendInviteEmail({ ...base, expiresAt: new Date('2026-06-04T00:00:00Z'), locale: 'en' });
        expect(sent().text).toContain(EN.expiresOne);
        await sendInviteEmail({ ...base, locale: 'en' });
        expect(sent().text).toContain(EN.expiresMany.replace('{days}', '7'));
        await sendInviteEmail({ ...base, expiresAt: new Date('2026-06-04T00:00:00Z'), locale: 'bg' });
        expect(sent().text).toContain(BG.expiresOne);
    });
});

describe('inviterLocale resolves from the inviting admin', () => {
    it('reads the inviter uiLanguage', async () => {
        findUnique.mockResolvedValue({ uiLanguage: 'bg' });
        await expect(inviterLocale('u-1')).resolves.toBe('bg');
        expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ select: { uiLanguage: true } }),
        );
    });

    it('an English inviter sends the English invite', async () => {
        // Resolving power: without this the helper could hardcode 'bg' and
        // every assertion above would still hold.
        findUnique.mockResolvedValue({ uiLanguage: 'en' });
        await expect(inviterLocale('u-2')).resolves.toBe('en');
    });

    it('falls back when the inviter is unknown', async () => {
        await expect(inviterLocale(undefined)).resolves.toBe('bg');
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('STILL RESOLVES when the lookup throws — fail-soft', async () => {
        // An invite in the fallback language is recoverable; an invite that
        // never sends because a locale lookup threw is not — the invite row is
        // already committed and the admin has been told it went out.
        findUnique.mockRejectedValue(new Error('db down'));
        await expect(inviterLocale('u-3')).resolves.toBe('bg');
        expect(warn).toHaveBeenCalled();
    });

    it('does not trust an unrecognised column value', async () => {
        // `uiLanguage` is a plain String column; nothing stops a row holding
        // 'de'. It must not reach `translateFor` as a locale.
        findUnique.mockResolvedValue({ uiLanguage: 'de' });
        await expect(inviterLocale('u-4')).resolves.toBe('bg');
    });
});
