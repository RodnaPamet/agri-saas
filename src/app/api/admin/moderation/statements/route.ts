/**
 * `GET  /api/admin/moderation/statements` — statements not yet delivered.
 * `POST /api/admin/moderation/statements` — queue one (P5.4a, #1595).
 *
 * ## The table IS the outbox
 *
 * `NotificationOutbox` cannot carry an Art 17 statement: it is tenant-scoped
 * with a non-nullable `tenantId`, and a statement is addressed to a PERSON who
 * may have no farm or several. Resolving one would be inventing a tenant for a
 * person-scoped obligation.
 *
 * It does not need to. P5.1 shaped `StatementOfReasons.deliveredAt` as "NULL
 * until the push succeeds", so a row written here IS a queued statement, and
 * the `GET` is the drain queue. `src/app-layer/jobs/statement-dispatch.ts`
 * drains it every 10 minutes (P5.4b).
 *
 * ## Why an undelivered VIEW is part of the duty, not an operational nicety
 *
 * A statement that never went out is a compliance failure, and the thing that
 * makes it dangerous is that nothing else would show it: the action is
 * recorded, the notice reads ACTIONED, and the recipient simply never heard.
 * So the queue is surfaced rather than inferred, and P5's exit criterion — a
 * median handling time — is measurable from `createdAt` to `deliveredAt`
 * rather than asserted.
 *
 * ## The recipient is supplied, and that is deliberate
 *
 * Unlike `moderatorRef`, `recipientUserId` comes from the body. The subject of
 * an action is content, not a person — a removed listing names a farm, and the
 * person entitled to the statement is a judgement the moderator makes. There
 * is no field on `ModerationAction` this could be derived from without
 * guessing, and guessing who receives a legal notice is worse than being told.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { parseLimitParam } from '@/lib/validation/query-params';
import { QueueStatementSchema } from '@/lib/schemas';
import { queueStatement, listUndeliveredStatements } from '@/app-layer/usecases/moderation';

export const runtime = 'nodejs';

/**
 * What goes in the column so it is never NULL at queue time. Dispatch
 * OVERWRITES it with `resolveRecipientLocale(recipient.uiLanguage)`, so this is
 * a placeholder rather than a decision about anyone's language — see
 * `statement-dispatch.ts`. It stays `bg` because that is this deployment's
 * `User.uiLanguage` default, so the placeholder and the usual answer agree.
 */
const FALLBACK_LOCALE = 'bg';

function platformGate(req: NextRequest): NextResponse | null {
    try {
        verifyPlatformApiKey(req);
        return null;
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const limit = parseLimitParam(req.nextUrl.searchParams.get('limit'), { max: 200 });
        return jsonResponse({ statements: await listUndeliveredStatements(limit) });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-statements' } },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = QueueStatementSchema.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await queueStatement({
            actionId: parsed.data.actionId,
            recipientUserId: parsed.data.recipientUserId,
            // A placeholder, not a language choice: dispatch resolves the
            // recipient's own locale at SEND time and writes it back, because
            // Art 17 says "in the recipient's language" and a console default
            // is not that.
            locale: parsed.data.locale ?? FALLBACK_LOCALE,
            bodyRendered: parsed.data.bodyRendered,
        });

        return jsonResponse(result, { status: 201 });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-queue-statement' } },
);
