import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { unauthorized, notFound } from '@/lib/errors/types';
import { getPromotionImageStream } from '@/lib/promotions/promotion-image';

/**
 * GET /api/promotions/[id]/image — serve a promotion's artwork.
 *
 * Deliberately NOT under `/api/t/[tenantSlug]/`. `Promotion` is a global
 * catalogue: the same image is shown to every tenant, so scoping the URL to
 * one tenant would be a lie, and would break the moment a second tenant
 * rendered the same card. This mirrors `/api/account/avatar/[userId]`, the
 * existing non-tenant image route.
 *
 * Auth — any authenticated user may fetch it. That is the correct boundary
 * rather than a lax one: the image is already visible to every signed-in user
 * through the offers feed, so requiring a session (not a tenant) matches what
 * the content actually is. Anonymous access stays closed.
 *
 * A missing image resolves to 404, which an `<img>` treats as a load failure —
 * the card then renders without artwork rather than with a broken frame.
 */
export const GET = withApiErrorHandling(
    async (
        _req: NextRequest,
        { params }: { params: Promise<{ id: string }> },
    ): Promise<Response> => {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) throw unauthorized();

        const { id } = await params;
        const stream = await getPromotionImageStream(id);
        if (!stream) throw notFound('Promotion image not found.');

        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
            status: 200,
            headers: {
                'Content-Type': 'image/webp',
                // Private — the image sits behind auth. The key is
                // deterministic per promotion, so a REPLACED image would be
                // served stale for the TTL; five minutes keeps that window
                // short enough for a curation workflow.
                'Cache-Control': 'private, max-age=300',
            },
        });
    },
);
