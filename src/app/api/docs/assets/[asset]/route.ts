/**
 * GET /api/docs/assets/<file> — Swagger UI's own JS/CSS, served same-origin.
 *
 * Exists because of the CSP, not because of the CDN (#798). `script-src` is
 * `'self' 'nonce-…' 'strict-dynamic'` with NO `unsafe-inline` in any
 * environment, and under CSP Level 3 `'strict-dynamic'` makes browsers
 * **ignore `'self'` and every host-source expression**. So the origin a
 * script comes from is irrelevant — only its nonce matters. Serving these
 * same-origin buys offline/air-gapped development and drops a third-party
 * script; it is the nonce in `../route.ts` that makes the page work at all.
 *
 * Gated by the SAME `isDocsEnabled()` as the page. Without that this would
 * be a public read path into `node_modules` on every deployment.
 *
 * `swagger-ui-dist` is a devDependency, so `npm prune --omit=dev` removes it
 * from the runtime image — which is fine, because this route 404s there
 * anyway. A missing file is reported as 404, never as a 500.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { isDocsEnabled, docsDisabledResponse } from '../../enabled';

export const runtime = 'nodejs';

/**
 * Exhaustive allowlist. A dynamic segment reaching the filesystem is a
 * path-traversal surface, so the segment is never used to BUILD a path —
 * it is used to LOOK UP one. `..%2f` and friends simply miss the map.
 */
const ASSETS: Record<string, string> = {
    'swagger-ui.css': 'text/css; charset=utf-8',
    'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
    'swagger-ui-standalone-preset.js': 'text/javascript; charset=utf-8',
};

/**
 * Resolved from the project root rather than via `createRequire`.
 *
 * `createRequire` would survive a nested install layout, but mocking
 * `node:module` to test it also replaces `createRequire` for pino's
 * thread-stream transport, which real-requires it from a WORKER THREAD —
 * that crashed the jest worker while the tests themselves passed, i.e. a red
 * shard with no summary. npm installs this tree flat, and the route is
 * local-development only, so a project-root join is sufficient and leaves
 * only `readFile` to stub.
 */
const PACKAGE_DIR = join(process.cwd(), 'node_modules', 'swagger-ui-dist');

/**
 * Wrapped, like its sibling `../../route.ts`.
 *
 * `withApiErrorHandling` accepts a plain `Response` and does not buffer the
 * body, so a 1.4 MB bundle streams through untouched; what it adds is the
 * request-id header and the OTel root span every other route has. The
 * alternative was a `BARE_ROUTE_EXEMPTIONS` entry, but the taxonomy there has
 * no bucket for "serves bytes" — and two routes in one feature, one wrapped
 * and one not, is the same divergence that let the two CI install paths drift
 * apart (#823).
 */
export const GET = withApiErrorHandling(async (
    _req: NextRequest,
    { params }: { params: Promise<{ asset: string }> },
): Promise<Response> => {
    if (!isDocsEnabled()) return docsDisabledResponse();

    const { asset } = await params;
    const contentType = ASSETS[asset];
    if (!contentType) return docsDisabledResponse();

    let body: Buffer;
    try {
        // `asset` matched the map above, so it is one of three literals —
        // the segment indexes a table, it never builds a path.
        body = await readFile(join(PACKAGE_DIR, asset));
    } catch {
        // devDependency absent (pruned image, or a tree that never installed
        // it). 404 rather than 500: the asset is genuinely not here, and a
        // 500 would read as a bug in this route.
        return docsDisabledResponse();
    }

    return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
            'Content-Type': contentType,
            // Dev-only surface; never let a stale bundle survive an upgrade.
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
});
