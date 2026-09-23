/**
 * The language the person making this request reads in.
 *
 * Distinct from `getTranslations()`, which resolves from the `NEXT_LOCALE`
 * cookie. That is wrong for anything a NATIVE client can reach: a bearer
 * session carries no cookie, so a cookie-derived locale silently hands the
 * phone the unauthenticated default (`en`) — and the phone is the surface
 * most of this product's localisation exists for.
 *
 * Reads the user's own `uiLanguage` column instead, which both session kinds
 * have, and falls back through `resolveRecipientLocale` to `bg` — the column
 * default, and what four of five users carry. Deliberately NOT
 * `DEFAULT_LOCALE`, which is `en` for signed-out surfaces; the same
 * distinction outbound email already draws.
 *
 * Lives in the app layer because a ROUTE may not query Prisma directly
 * (`no-direct-prisma`, `policy-routes-guardrail`). That rule caught the first
 * version of this, which did the lookup inline in the trends route.
 *
 * And it reads the caller's `uiLanguage` through their MEMBERSHIP rather than
 * through the global client. Reading `User` directly would have needed an
 * entry on that guard's allowlist — defensible, since the row is the caller's
 * own and the column is a display preference. But a tenant-bound read needs
 * no exemption at all, stays inside RLS, and is the shape `exchange.ts`
 * already uses to resolve a recipient's language. An allowlist entry is a
 * standing claim someone must re-evaluate later; not needing one is better
 * than justifying one.
 */
import { runInTenantContext } from '@/lib/db-context';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import type { Locale } from '@/lib/i18n/locales';
import type { RequestContext } from '@/app-layer/types';

/**
 * Never throws and never blocks the read it precedes: a locale lookup that
 * fails should cost the reader a language, not the page. An absent user row
 * resolves to the fallback for the same reason.
 */
export async function resolveReaderLocale(ctx: RequestContext): Promise<Locale> {
    try {
        const uiLanguage = await runInTenantContext(ctx, async (db) => {
            const membership = await db.tenantMembership.findFirst({
                where: { tenantId: ctx.tenantId, userId: ctx.userId },
                select: { user: { select: { uiLanguage: true } } },
            });
            return membership?.user.uiLanguage;
        });
        return resolveRecipientLocale(uiLanguage);
    } catch {
        return resolveRecipientLocale(undefined);
    }
}
