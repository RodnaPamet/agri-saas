import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getSatelliteGuideArticles } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { isLocale } from '@/lib/i18n/locales';

/**
 * GLOBAL satellite-imagery guide articles for `/knowledge/satellite`
 * (W5 task). `?lang=` narrows to one language; an unrecognised or
 * missing value falls back to `'bg'` (the product default), NOT
 * `DEFAULT_LOCALE` ('en', reserved for unauthenticated pre-login pages —
 * this route is always authenticated tenant traffic).
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const langParam = req.nextUrl.searchParams.get('lang');
        const language = isLocale(langParam) ? langParam : 'bg';
        const articles = await getSatelliteGuideArticles(ctx, language);
        return jsonResponse(articles);
    },
);
