/**
 * POST /api/auth/accept-terms — record that this user accepted the terms.
 *
 * The way OUT of the consent gate (P3.1 / #1376). A signed-in session whose
 * `acceptedTermsAt` is null is held at `/accept-terms` by the Edge; this is
 * what clears it.
 *
 * ── it exists because one signup path records consent and the other does not ──
 *
 * `POST /api/auth/register/start` captures acceptance inline, so a user who
 * came through the wizard never sees the gate. A first-time Google sign-in
 * creates its `User` row through `PrismaAdapter` inside NextAuth, so it passes
 * no route of ours and records nothing. Stamping consent on that callback was
 * the obvious fix and the wrong one: it would file an agreement nobody gave,
 * which is worse than the null, because a null honestly means "we do not
 * know" — that is why the column has no default.
 *
 * So the product asks. Which is also what the terms promise, in those words:
 * *"Continuing to use the service after a change does not by itself count as
 * accepting it — we will ask."*
 *
 * ── the version is checked, not trusted ──
 *
 * Same rule as `register/start`: the client sends the version it DISPLAYED and
 * the server refuses anything that is not the one it is serving. Recording the
 * server's current version against an acceptance made on a page loaded before
 * a terms change would file a consent to a document the person never read.
 *
 * ── it is idempotent, and does NOT re-stamp ──
 *
 * A second POST from a user who already accepted returns 200 and leaves the
 * stored timestamp alone. Re-stamping would move the record of WHEN they
 * agreed every time a tab was replayed, and that timestamp is the artifact —
 * the whole point of the column is to be able to say when.
 */
import { NextRequest } from 'next/server';

import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { API_MUTATION_LIMIT } from '@/lib/security/rate-limit';
import { logger } from '@/lib/observability/logger';

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const session = await auth();
        if (!session?.user?.id) {
            return jsonResponse({ error: 'unauthenticated' }, { status: 401 });
        }

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const { acceptedTerms, termsVersion } = body ?? {};

        // Identity, not truthiness — `'yes'`, `1` and `{}` are all truthy, and
        // a client that never rendered a control should not be able to satisfy
        // a consent gate with any non-empty value.
        if (acceptedTerms !== true) {
            return jsonResponse({ error: 'terms_not_accepted' }, { status: 400 });
        }
        if (termsVersion !== TERMS_VERSION) {
            return jsonResponse(
                { error: 'terms_version_stale', currentVersion: TERMS_VERSION },
                { status: 400 },
            );
        }

        // Conditional on the column still being null, so a replay cannot move
        // the recorded timestamp. `updateMany` rather than `update` because the
        // predicate is the point: zero rows affected means "already accepted",
        // which is a success, not a conflict.
        const claimed = await prisma.user.updateMany({
            where: { id: session.user.id, acceptedTermsAt: null },
            data: {
                acceptedTermsAt: new Date(),
                acceptedTermsVersion: TERMS_VERSION,
            },
        });

        logger.info('accept-terms.recorded', {
            component: 'auth',
            event: 'terms_accepted',
            userId: session.user.id,
            version: TERMS_VERSION,
            // 0 is the idempotent replay, not a failure. Logged so a flood of
            // them is visible rather than looking like fresh acceptances.
            firstTime: claimed.count === 1,
        });

        // The JWT resolves `termsPending` from this column on every pass, so
        // the client only has to refresh its session for the gate to open —
        // there is no second write and nothing to invalidate.
        return jsonResponse({ ok: true, version: TERMS_VERSION });
    },
    {
        // The generic mutation tier. This is a once-per-user write behind a
        // session, so it needs no stricter preset; the limit is here to stop a
        // replay loop costing a database round trip per request.
        rateLimit: { config: API_MUTATION_LIMIT, scope: 'accept-terms' },
    },
);
