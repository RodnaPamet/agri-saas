/**
 * `POST /api/public/notices` — an anonymous DSA Art 16 notice (P5.2, #1593).
 *
 * ## Why this route has no authentication, and why that is not a hole
 *
 * Art 16 requires a mechanism that **any** person or entity can use to notify
 * illegal content. Requiring an account would be requiring an account to
 * exercise a right, so this is the one write path in the product that accepts
 * a body from nobody.
 *
 * `tests/guards/public-routes-self-authenticate.test.ts` enforces the opposite
 * rule — a route behind a public prefix must authenticate itself — because
 * opening the Edge for the credential-verifying routes would otherwise turn
 * dead endpoints into anonymous ones. This route is in that guard's exemption
 * map with the duty named, alongside `/api/public/eik-check`.
 *
 * ## No feature flag, and that is also a duty rather than an oversight
 *
 * P5's standing rule puts every social route behind a runtime flag, default
 * OFF. Account deletion and the notice endpoints are explicitly carved out:
 * a legal duty cannot be dark-launched. This takes one of the first two
 * `FLAG_EXEMPT` entries in `social-routes-flag-gated`.
 *
 * ## What it discloses: nothing
 *
 * The response is `{ id, status: 'RECEIVED' }` and never says whether the
 * subject existed. A notice form that distinguished a real listing id from a
 * made-up one would be an enumeration oracle on an unauthenticated route, so
 * `SUBJECT_NOT_FOUND` is recorded on the snapshot for the moderator and not
 * returned to the notifier.
 *
 * The id IS returned, because Art 16 wants the notifier able to refer to their
 * notice. It is a random cuid-shaped value that reveals nothing and cannot be
 * read back on this route — there is no `GET` here, and
 * `content_report_reporter_read` matches on `app.user_id`, which an anonymous
 * notice has none of (`reporterUserId` is NULL, and `NULL = NULL` is NULL).
 *
 * ## Rate limiting
 *
 * `PUBLIC_NOTICE_LIMIT` — 10/min per IP, tightened from the 60/min that
 * `withApiErrorHandling` would otherwise apply by default. The scope is
 * per-route so a notice flood cannot spend the ЕИК lookup's budget.
 */
import type { NextRequest } from 'next/server';

import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { PUBLIC_NOTICE_LIMIT } from '@/lib/security/rate-limit';
import { FileReportSchema } from '@/lib/schemas';
import { fileNotice } from '@/app-layer/usecases/trust-safety';

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = FileReportSchema.safeParse(raw);
        if (!parsed.success) {
            // Uniform shape, no field detail. A validation message naming
            // which field failed would tell an unauthenticated caller the
            // schema, and `reasonCode`'s accepted values are a product
            // decision rather than public API surface.
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        // `null` reporter: this is the anonymous path, and DECISION 5 on #1553
        // is that an anonymous notice stores NO identifier at all — not an IP,
        // not a hash of one. The rate limiter sees the IP; the row never does.
        const filed = await fileNotice(parsed.data, null);

        return jsonResponse(filed, { status: 201 });
    },
    {
        rateLimit: { config: PUBLIC_NOTICE_LIMIT, scope: 'public-notices' },
    },
);
