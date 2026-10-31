/**
 * Epic C.3 — admin session management API.
 *
 *   GET    /api/t/:tenantSlug/admin/sessions
 *     Returns the live (non-revoked, non-expired) sessions for every
 *     member of this tenant. Powers the upcoming Security → Sessions
 *     admin UI: "who's signed in right now, from where".
 *
 *   DELETE /api/t/:tenantSlug/admin/sessions
 *     Body: { sessionId: string }
 *     Marks the named session revoked. The next authenticated request
 *     carrying that session's JWT trips the `verifyAndTouchSession`
 *     check in `src/auth.ts` and is forced through re-authentication.
 *
 *   Both verbs are gated by `admin.members` — managing a colleague's
 *     active sessions is functionally a member-management action.
 *
 * Tenant safety
 * -------------
 *   - GET filters strictly by `ctx.tenantId`. A row with a different
 *     `tenantId` is invisible to this route by construction.
 *   - DELETE re-validates the session's `tenantId` matches `ctx.tenantId`
 *     before revoking. Without this, an admin in tenant A could revoke
 *     a session belonging to tenant B if they guessed the session id.
 *   - Sessions with `tenantId IS NULL` (a rare race during the very
 *     first JWT mint) are excluded from both reads and writes.
 *
 * Audit
 * -----
 *   Every successful DELETE writes a hash-chained audit entry
 *   (`SESSION_REVOKED_BY_ADMIN`). Failures (404, tenant mismatch,
 *   already-revoked) do NOT audit — they're not state changes.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import {
    listActiveSessionsForTenant,
    listActiveSessionsForUserInTenant,
    revokeSessionById,
    findOwnTenantSession,
} from '@/lib/security/session-tracker';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';
import { badRequest, notFound } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

// ─── GET ────────────────────────────────────────────────────────────

export const GET = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        // `?userId=<id>` narrows to a single user — used by the
        // members-page modal. Always tenant-scoped, so an admin in
        // tenant A cannot peek at a colleague's tenant B sessions even
        // by guessing the userId.
        const userId = req.nextUrl.searchParams.get('userId');
        const sessions = userId
            ? await listActiveSessionsForUserInTenant({
                  tenantId: ctx.tenantId,
                  userId,
              })
            : await listActiveSessionsForTenant(ctx.tenantId);
        return jsonResponse({
            sessions,
            count: sessions.length,
        });
    }),
);

// ─── DELETE ────────────────────────────────────────────────────────

const RevokeSchema = z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
    /**
     * Free-form note that lands in the audit detail. Caller-supplied;
     * defaults to "Revoked by admin" when absent. Long enough to carry
     * a reason (e.g. "stolen device reported by user"), bounded to keep
     * the audit log row size sane.
     */
    reason: z.string().max(280).optional(),
});

export const DELETE = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json().catch(() => ({}));
        const parsed = RevokeSchema.safeParse(body);
        if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
        }
        const { sessionId, reason } = parsed.data;

        // Tenant-scope the lookup: only revoke if the row belongs to
        // this tenant. Don't expose whether the id exists in another
        // tenant — return 404 either way.
        const row = await findOwnTenantSession({
            tenantId: ctx.tenantId,
            sessionId,
        });
        if (!row || row.revokedAt) {
            throw notFound('Session not found or already revoked');
        }

        const result = await revokeSessionById({
            sessionId,
            reason: reason ?? `admin:${ctx.userId}`,
        });

        // Audit. Best-effort — a failed audit write must not undo the
        // (already-committed) revocation.
        try {
            await logEvent(prisma, ctx, {
                action: 'SESSION_REVOKED_BY_ADMIN',
                entityType: 'UserSession',
                entityId: sessionId,
                details: `Session revoked by admin ${ctx.userId}` +
                    (reason ? ` — reason: ${reason}` : ''),
                detailsJson: {
                    // `access` is the canonical category for
                    // authn/authz state changes per the audit schema.
                    category: 'access',
                    event: 'session_revoked_by_admin',
                    targetUserId: row.userId,
                    sessionId,
                    // OMITTED when absent, never null: `reason` is a declared
                    // `z.string().optional()` on the audit schema, so `null`
                    // fails it and the revoke 400s with no reason given.
                    ...(reason ? { reason } : {}),
                },
                metadata: {
                    targetUserId: row.userId,
                    revokedBy: ctx.userId,
                },
            });
        } catch {
            // Audit infrastructure failure — ignored intentionally.
        }

        return jsonResponse({
            ok: true,
            sessionId: result.sessionId,
            userId: result.userId,
        });
    }),
);
