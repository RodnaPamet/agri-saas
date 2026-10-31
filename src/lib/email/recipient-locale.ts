/**
 * The language an email is written in when the recipient's own preference
 * cannot be read.
 *
 * ## Why this is NOT `DEFAULT_LOCALE`
 *
 * `DEFAULT_LOCALE` in `@/lib/i18n/locales` is `'en'`, and it is documented
 * there as the fallback for **unauthenticated** surfaces — login, invite
 * preview, shared audit packs — deliberately kept English so those pages and
 * the English-copy E2E specs that exercise them stay English.
 *
 * An email recipient is a different case: they are a **known user** whose
 * `User.uiLanguage` column carries `@default("bg")`
 * (`prisma/schema/auth.prisma`). So when that preference fails to load, the
 * honest fallback is what the column would have given them, not what an
 * anonymous visitor gets.
 *
 * Reading the two as one number is exactly how a recipient-addressed message
 * ends up in the wrong language — and the schema docblock actively invited
 * that mistake until #686, having claimed the column "Defaults to English"
 * while it defaults to `bg`.
 *
 * Extracted here rather than left inline once a second sender needed it. If
 * the column default ever changes, this changes with it.
 *
 * @module lib/email/recipient-locale
 */
import { isLocale, type Locale } from '@/lib/i18n/locales';

export const RECIPIENT_FALLBACK_LOCALE: Locale = 'bg';

/**
 * Narrow a stored `User.uiLanguage` to a `Locale`, falling back when it is
 * absent or unrecognised.
 *
 * The column is a plain `String`, so nothing at the type level stops a row
 * holding `'de'` or `''`. Every sender needs the same narrowing, and before
 * this it was copy-pasted at three call sites as
 * `isLocale(x) ? x : RECIPIENT_FALLBACK_LOCALE`. One site means one place to
 * change if the column default moves, and one place to test.
 */
export function resolveRecipientLocale(uiLanguage: unknown): Locale {
    return isLocale(uiLanguage) ? uiLanguage : RECIPIENT_FALLBACK_LOCALE;
}

/**
 * The recipient's own language, looked up by user id.
 *
 * For a notification whose recipient is known only as an id — a bell row whose
 * producer never loaded the user. Where the producer ALREADY selects
 * `user.uiLanguage` (the exchange inquiry fan-out does, for its email), use
 * that instead: this costs a query and that one does not.
 *
 * This is deliberately NOT `inviterLocale`, which runs the same query for an
 * unrelated reason — that one picks the INVITER as a PROXY because an invitee
 * has no `User` row at all, and its choice of proxy is the decision #722
 * argued. Here the recipient is the recipient, so there is nothing to choose.
 *
 * Fail-soft for the same reason every locale lookup in this module is: a
 * notification in the fallback language is read and understood, while one that
 * never writes because a lookup threw is a farmer not being told. The caller is
 * usually a best-effort notify path whose subject row is already committed.
 *
 * Uses the GLOBAL client: `User` carries no `tenantId`, so a tenant-scoped read
 * of it returns nothing under RLS.
 */
export async function recipientLocaleForUser(userId: string | undefined): Promise<Locale> {
    if (!userId) return RECIPIENT_FALLBACK_LOCALE;
    try {
        const { default: prisma } = await import('@/lib/prisma');
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { uiLanguage: true },
        });
        return resolveRecipientLocale(row?.uiLanguage);
    } catch {
        return RECIPIENT_FALLBACK_LOCALE;
    }
}
