import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listInsuranceProducts } from '@/app-layer/usecases/insurance';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from '@/lib/i18n/locales';

/**
 * Which language to answer in — DECLARED, never negotiated.
 *
 * An explicit `?locale=` wins. The `NEXT_LOCALE` cookie is the only fallback,
 * because it is also a DECLARATION: the user picked that language in this
 * product. `Accept-Language` is deliberately NOT consulted.
 *
 * That omission is the whole point, and it is not defensive programming. The
 * native client is Bulgarian by declaration, not by what the handset reports,
 * and its owner's device reports `en_BG` — English language, Bulgarian region,
 * an ordinary thing for a person to set. Negotiating from that header would
 * return English product names onto an otherwise entirely Bulgarian screen. The
 * iOS app already carries two CI guards against exactly that class (one
 * rejecting English date spellings, one forcing every commodity name through its
 * own resolver), and a header-negotiated catalogue would walk the same defect in
 * through a door neither guard watches. Reported by that client while this
 * endpoint was being built.
 *
 * A locale is not sensitive, so it is safe in a query string — unlike an id. iOS
 * writes the full request URL to the unified log below anything the app
 * controls, which is why ids on this surface travel as path segments.
 */
function readLocale(req: NextRequest): Locale {
    const explicit = req.nextUrl.searchParams.get('locale');
    if (isLocale(explicit)) return explicit;

    const cookie = req.cookies.get(LOCALE_COOKIE)?.value;
    if (isLocale(cookie)) return cookie;

    // Neither declared. `DEFAULT_LOCALE` is 'en', so a client that wants
    // Bulgarian must SAY so — which is the contract this endpoint wants: a
    // caller that forgets is wrong loudly rather than served a guess.
    return DEFAULT_LOCALE;
}

/**
 * The insurance product catalogue and its tariffs.
 *
 * For clients that cannot import `src/lib/insurance`. The web app has no use for
 * it — it imports the same constant the engine does — so this exists for a
 * SEPARATE codebase, where a compiled-in tariff is a second description of one
 * thing that drifts silently against the server's recompute.
 *
 * ETagged: the catalogue changes when a tariff changes, which is rarely, so a
 * phone should get a 304 rather than re-download it on every launch. The ETag
 * covers the localised body, so switching language re-fetches correctly.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const catalogue = await listInsuranceProducts(ctx, readLocale(req));
        return jsonWithETag(req, catalogue);
    },
);
