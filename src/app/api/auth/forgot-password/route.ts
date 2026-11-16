/**
 * POST /api/auth/forgot-password   body: { email }
 *
 * Step 1 of the password-reset flow. Mints a single-use, 1-hour reset
 * token for the address (if it maps to a credentials account) and
 * emails the link.
 *
 * The response is ALWAYS `{ ok: true }` — it never reveals whether the
 * email is registered, has a password, or triggered a send. That is
 * the whole point: the endpoint must not be usable to enumerate
 * accounts. `issuePasswordReset` is correspondingly enumeration-safe
 * (silent no-op for unknown / OAuth-only emails, mailer failures
 * swallowed).
 *
 * Rate-limited by EMAIL_DISPATCH_LIMIT (5/hour per IP) — the classic
 * "email bomb" mitigation for an unauthenticated send-mail endpoint.
 */
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { issuePasswordReset } from '@/lib/auth/password-management';
import { EMAIL_DISPATCH_LIMIT } from '@/lib/security/rate-limit';
// Declared ONCE in `@/lib/schemas` so this parse and the OpenAPI entry
// cannot drift — `request-body-declared-once` (#1555), cap zero.
import { ForgotPasswordSchema } from '@/lib/schemas';

export const POST = withApiErrorHandling(
    withValidatedBody(ForgotPasswordSchema, async (req, _ctx, body) => {
        const requestId = req.headers.get('x-request-id') ?? undefined;
        // Never throws, never reveals outcome — see the module docstring.
        await issuePasswordReset(body.email, { requestId }).catch(() => undefined);
        return jsonResponse({ ok: true });
    }),
    { rateLimit: { config: EMAIL_DISPATCH_LIMIT, scope: 'password-reset-request' } },
);
