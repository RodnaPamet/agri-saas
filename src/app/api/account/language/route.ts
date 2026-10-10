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

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {badRequest } from '@/lib/errors/types';
import { updateOwnUiLanguage } from '@/lib/account/language';
import { LOCALE_COOKIE, LOCALES } from '@/lib/i18n/locales';

/** One year, in seconds — matches the middleware seed lifetime. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const LanguageSchema = z.object({
    language: z.enum(LOCALES),
});

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    // `getUserCtx`, not `auth()` (#1579). It refuses three callers this route
    // used to answer: an `iflk_` API key presented as a person credential
    // (which must not be served as the cookie's user), an MFA-pending session,
    // and — on a social surface — the operator-only persona. This is an
    // `account` surface, so a MECHANISATOR is correctly NOT refused.
    const ctx = await getUserCtx(req);

    const parsed = LanguageSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw badRequest('Invalid language payload.');

    const result = await updateOwnUiLanguage(ctx.userId, parsed.data.language);

    const res = jsonResponse(result, { status: 200 });
    res.cookies.set(LOCALE_COOKIE, result.uiLanguage, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        httpOnly: false,
    });
    return res;
});
