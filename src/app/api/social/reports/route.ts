/**
 * `POST /api/social/reports` — a signed-in DSA Art 16 report.
 * `GET  /api/social/reports` — the caller's own notices (P5.2, #1593).
 *
 * ## Why `/api/social/` and not `/api/me/` or `/api/t/[slug]/`
 *
 * `/api/t/[slug]/` was what the issue originally said, and it cannot work. A
 * tenant route runs `runInTenantContext`, which sets `app.tenant_id` +
 * `app.actor_user_id` and deliberately NOT `app.user_id`. The
 * `content_report_reporter_read` arm matches on `app.user_id`, so under a
 * tenant context it matches nothing and `GET` would return **zero rows with no
 * error** — indistinguishable from having filed none.
 *
 * `/api/social/` over `/api/me/` because `isOperatorBlockedPersonPath`
 * (`src/lib/auth/guard.ts:409`) covers exactly `/api/social/` and `/social/`.
 * That gives these routes the operator-persona refusal, which a reporting
 * surface should have and `/api/me/` would not.
 *
 * ## `getUserCtx`, not `auth()`
 *
 * Following `/api/me/news-preferences`, whose docblock explains what bare
 * `auth()` skips: an `iflk_` API key presented as a person credential (a
 * category error that would otherwise be answered as the cookie's user), an
 * MFA-pending session, and the operator-only persona. A route that files
 * reports about people should not skip any of the three.
 *
 * ## No feature flag — a legal duty
 *
 * Art 16 applies to a signed-in notifier as much as an anonymous one, so this
 * cannot be dark-launched. It takes the second `FLAG_EXEMPT` entry in
 * `social-routes-flag-gated` alongside the public notices route. The person
 * BLOCK routes are a product feature and stay gated; that difference is the
 * seam P5.2 is split along.
 *
 * ## The GET has no `where` clause, on purpose
 *
 * `listOwnReports` filters by POLICY, not by a `where` on `reporterUserId`.
 * A `where` would make the integration test pass with the policy dropped,
 * which is the one thing that test exists to catch.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { FileReportSchema } from '@/lib/schemas';
import { fileNotice, listOwnReports } from '@/app-layer/usecases/trust-safety';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);

    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return jsonResponse({ error: 'invalid_request' }, { status: 400 });
    }
    const parsed = FileReportSchema.safeParse(raw);
    if (!parsed.success) {
        return jsonResponse({ error: 'invalid_request' }, { status: 400 });
    }

    // The reporter comes from the VERIFIED SESSION and never from the body.
    // `FileReportSchema.strip()` is the other half: a client sending
    // `reporterUserId` has it dropped rather than rejected, so a caller can
    // neither attribute a notice to someone else nor learn from an error
    // whether the field exists.
    const filed = await fileNotice(parsed.data, ctx.userId);

    return jsonResponse(filed, { status: 201 });
});

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    const reports = await listOwnReports(ctx);
    // An empty list is a real answer and is not an error: a person who has
    // filed nothing sees `[]`. It is also what a BROKEN policy arm would
    // return, which is why the integration test asserts a NON-ZERO count for
    // a reporter who has filed one.
    return jsonResponse({ reports }, { status: 200 });
});
