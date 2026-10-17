/**
 * `/api/public/media/{hash}` — the bytes of an image a published farm profile
 * references (P6.3, #1812).
 *
 * Its own module rather than appended to `public-farms.paths.ts`: that one
 * documents a SEARCH over the projection and answers JSON. This answers image
 * bytes, and the two have nothing in common but a URL prefix.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { NO_AUTH, op } from './helpers';

export function registerPublicMediaPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/public/media/{hash}',
        operationId: 'getPublicMedia',
        // Anonymous by design — see NO_AUTH (#1843).
        security: NO_AUTH,
        summary: 'Fetch an image published on a farm profile',
        description:
            'ANONYMOUS. No session, no tenant, no credential — a stranger reading a farm’s page fetches its images from here, and a page whose images 401 is not a public page.\n\n'
            + '**The hash is the content.** `hash` is the sha256 of the stored bytes, so one URL names exactly one byte sequence forever. The response is therefore `Cache-Control: public, max-age=31536000, immutable` and its `ETag` is the hash itself — a STRONG validator with no bookkeeping, because the name and the content cannot disagree. Changing an image changes the URL, which is the point: a farm that replaces its logo gets a new hash and no cache anywhere has to be told.\n\n'
            + '**It is in the PATH, deliberately.** iOS logs the full request URL including the query string, unsuppressably, so an identifier in `?hash=` would land in device logs that outlive the request. Do not "simplify" this to a query parameter.\n\n'
            + '**Publication, not existence, is what it serves.** A hash is unguessable but permanent, so serving any file whose hash matched would be a capability nobody could revoke. This serves a hash only while some published profile references it — withdraw a profile and its images stop resolving in the same step.\n\n'
            + 'Send `If-None-Match` with the hash to get a 304 and no body.\n\n'
            + '**Refusal codes.** None. Every negative case is ONE 404 with `{ "error": "NOT_FOUND" }` — a malformed hash, a hash no published profile references, a reference whose file is gone, and a file the malware scanner quarantined are deliberately indistinguishable. Distinguishing them would let a caller use the response to confirm which hashes exist, and an unguessable identifier stops being unguessable the moment something confirms a guess. The surface itself 404s when the `social.farm-media` flag is off, for the same anti-enumeration reason.',
        tags: ['Public'],
        params: z.object({
            hash: z.string().openapi({
                description:
                    'sha256 of the image bytes, 64 lower-case hex characters. Read it from a farm profile’s payload rather than constructing it.',
                example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            }),
        }),
        success: {
            status: 200,
            description:
                'The image bytes. `Content-Type` is the type recorded at upload, served with `X-Content-Type-Options: nosniff`.',
            // Named media types rather than a JSON schema: a client that
            // assumes JSON here parses an image as garbage, so the type is
            // part of the contract. These are the formats the upload pipeline
            // can store after re-encoding (#1812).
            content: {
                'image/jpeg': z.string().openapi({ format: 'binary' }),
                'image/png': z.string().openapi({ format: 'binary' }),
                'image/webp': z.string().openapi({ format: 'binary' }),
            },
        },
    });
}
