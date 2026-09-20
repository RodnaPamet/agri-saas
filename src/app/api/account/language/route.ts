/**
 * PUT /api/account/language — set the caller's own UI language (T00).
 *
 * Self-service (mirrors `/api/account/profile` + `/api/account/avatar`):
 * acts ONLY on the authenticated session user — no userId parameter, so
 * one user can never change another's locale. Account-level, not
 * tenant-scoped; no `requirePermission`.
 *
 * On success it BOTH persists `User.uiLanguage` AND sets the
 * `NEXT_LOCALE` cookie on the response, so the very next SSR render
 * (after the client's `router.refresh()`) already resolves the new
 * locale — no round-trip through the middleware seed required.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { unauthorized, badRequest } from '@/lib/errors/types';
import { updateOwnUiLanguage } from '@/lib/account/language';
import { LOCALE_COOKIE, LOCALES } from '@/lib/i18n/locales';

/** One year, in seconds — matches the middleware seed lifetime. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const LanguageSchema = z.object({
    language: z.enum(LOCALES),
});

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();

    const parsed = LanguageSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw badRequest('Invalid language payload.');

    const result = await updateOwnUiLanguage(session.user.id, parsed.data.language);

    const res = jsonResponse(result, { status: 200 });
    res.cookies.set(LOCALE_COOKIE, result.uiLanguage, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        httpOnly: false,
    });
    return res;
});
