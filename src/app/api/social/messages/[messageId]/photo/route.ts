/**
 * `GET /api/social/messages/[messageId]/photo` — serve a conversation
 * photograph (P8.6, #2800).
 *
 * ## The egress gate is RLS, not a check written here
 *
 * `readDirectPhoto` resolves the storage key through `runInUserContext`, where
 * `direct_message_select` admits a participant's rows and nobody else's. So a
 * non-participant's lookup returns nothing and the empty result becomes the
 * not-found — the refusal is the database's, which is the property every other
 * DM read relies on, and it means there is no second spelling of "may this
 * person see it" to drift from the first.
 *
 * It is also what makes an ORPHANED object unreachable. The bytes are written
 * before the row, so a failed insert leaves an object nothing references — and
 * a key is only ever reached through a row.
 *
 * ## The id is in the PATH, which is safe here and would not be for a person
 *
 * iOS logs the full URL including the path, unsuppressably, which is why
 * `DELETE /api/social/blocks` takes a person's id in its BODY. A message id is
 * an opaque cuid that discloses nothing about who is in the conversation, so
 * the same objection does not apply — the same reasoning
 * `GET /api/social/conversations/[conversationId]` already carries.
 *
 * ## `no-store`, unlike the avatar route
 *
 * An avatar is low-sensitivity and shown across every member list, so it is
 * cached and revalidated. A photograph somebody sent in a private conversation
 * is not: `PERSISTABLE_PATHS` is an allowlist and no entry is added, and the
 * bytes must not sit in a shared cache on a phone that may be lost, sold or
 * handed on. That also means no ETag — there is nothing to revalidate against.
 */
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { readDirectPhoto } from '@/app-layer/usecases/direct-message-photos';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params }: { params: Promise<{ messageId: string }> },
    ): Promise<Response> => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);

        const { messageId } = await params;
        const object = await readDirectPhoto(ctx, messageId);

        return new Response(Readable.toWeb(object.stream) as ReadableStream, {
            status: 200,
            headers: {
                'Content-Type': object.mime,
                'Cache-Control': 'no-store',
                // Belt and braces for a surface serving caller-supplied bytes.
                // The content type is the SNIFFED one recorded at upload — the
                // stripper preserves format, so a conversation can hold a JPEG
                // and a PNG — and `nosniff` is what stops a browser deciding
                // for itself what these bytes are. The two go together: a
                // wrong stored type plus `nosniff` is a broken image rather
                // than a silently-corrected one, which is why the type is
                // stored per message rather than assumed.
                'X-Content-Type-Options': 'nosniff',
            },
        });
    },
);
