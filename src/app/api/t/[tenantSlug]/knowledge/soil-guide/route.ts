import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getSoilGuide } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { soilLanguage } from '@/lib/knowledge/soil-guide';
import { resolveRequestLocale } from '@/lib/i18n/request-locale';

/**
 * The «Почва» soil guide for the phone's screen under «Знания» (owner,
 * 2026-11-26). `?lang=en` or `?lang=bg` chooses; with no `lang` the person's
 * own interface language is used (`resolveRequestLocale`, the session claim —
 * never `Accept-Language`, which a phone fills with the device's languages),
 * and anything unrecognised is Bulgarian.
 *
 * Wrapped in `{ sections }` rather than a bare array so a later field (an
 * "updated" date, say) is additive for a client that already decodes this.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const lang = req.nextUrl.searchParams.get('lang') ?? resolveRequestLocale();
        const sections = getSoilGuide(ctx, soilLanguage(lang));
        return jsonResponse({ sections });
    },
);
