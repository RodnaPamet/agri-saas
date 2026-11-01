/**
 * «Какво помни асистентът» — list and forget-all (#2671).
 *
 *   GET    /api/account/assistant-memory  -> { facts: RememberedPoint[] }
 *   DELETE /api/account/assistant-memory  -> 204   («Изтрий всичко»)
 *
 * Under `/api/account/**`, not `/api/t/{slug}/**`, and that is the one
 * structural decision in this file. The memory is ONE PER PERSON across their
 * farms, so a tenant-scoped route would be wrong twice over: it would imply
 * per-farm memory, and it would run `runInTenantContext`, which sets
 * `app.actor_user_id` and not the `app.user_id` the person-scoped read arm
 * matches. The whole account family already resolves a session with
 * `getUserCtx` and iOS already reads it over a bearer.
 *
 * FLAG-GATED, default OFF. The assistant itself sits behind
 * `assistant.enabled`; a separate key is what lets the owner turn MEMORY off
 * without taking the assistant down with it — which matters more here than for
 * an ordinary surface, because the thing being switched off is a store of what
 * the product remembers about a person.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import {
    forgetAllRememberedPoints,
    listRememberedPoints,
} from '@/app-layer/usecases/assistant-memory';

/**
 * A string LITERAL, deliberately. `social-routes-flag-gated` extracts literals
 * only, and the reason is operational rather than stylistic: an operator
 * holding the feature-flag console has to be able to find the flag that gates
 * a route by reading the route.
 */
const MEMORY_FLAG = 'assistant.memory';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
    const facts = await listRememberedPoints(ctx.userId);
    return jsonResponse({ facts }, { status: 200 });
});

export const DELETE = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
    // The COUNT is returned rather than a bare 204, so the UI can say how many
    // were forgotten instead of claiming success over an empty profile — the
    // difference between "nothing to forget" and "forgot everything" is one a
    // person notices.
    const forgotten = await forgetAllRememberedPoints(ctx.userId);
    return jsonResponse({ forgotten }, { status: 200 });
});
