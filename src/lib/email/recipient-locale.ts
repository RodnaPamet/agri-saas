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
import { type Locale } from '@/lib/i18n/locales';

export const RECIPIENT_FALLBACK_LOCALE: Locale = 'bg';
