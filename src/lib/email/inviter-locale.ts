/**
 * The language an invite email is written in — the INVITER's (#722).
 *
 * ## Why a proxy at all
 *
 * Every other outbound email in this product reads the recipient's
 * `User.uiLanguage`. An invite cannot: the invitee has no `User` row, which is
 * the entire point of an invite. So this one email must choose a proxy, and
 * the choice was made deliberately rather than defaulted.
 *
 * The alternatives, weighed against measured production data (5 users — 4
 * `bg`, 1 `en`; `uiLanguage` defaults to `bg`):
 *
 *   - **inviter's language** — right for the common case, a Bulgarian farm
 *     inviting Bulgarian staff. Wrong when inviting an external agronomist or
 *     a foreign buyer, where it is no worse than English would have been.
 *   - **bilingual** — never wrong, visibly clunky, doubles the body.
 *   - **English** — looks neutral and is not: against this user base it is the
 *     wrong language for four people in five.
 *   - **ask the admin** — most correct, needs a schema column plus UI on three
 *     surfaces, and imposes a decision on every invite.
 *
 * ## Failure behaviour
 *
 * Fail-soft, and deliberately so. An invite in the fallback language is
 * recoverable — the recipient still gets a working link. An invite that never
 * sends because a locale lookup threw is not: the invite row is already
 * committed and the admin is told the email went out. Same reasoning as the
 * verification-email lookup in `@/lib/auth/email-verification`.
 *
 * @module lib/email/inviter-locale
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { RECIPIENT_FALLBACK_LOCALE, resolveRecipientLocale } from './recipient-locale';
import type { Locale } from '@/lib/i18n/locales';

export async function inviterLocale(userId: string | undefined): Promise<Locale> {
    if (!userId) return RECIPIENT_FALLBACK_LOCALE;
    try {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { uiLanguage: true },
        });
        return resolveRecipientLocale(row?.uiLanguage);
    } catch (err) {
        logger.warn('invite email: inviter locale lookup failed', {
            component: 'email',
            error: err instanceof Error ? err.message : String(err),
        });
        return RECIPIENT_FALLBACK_LOCALE;
    }
}
