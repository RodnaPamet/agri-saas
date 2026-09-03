/**
 * Is the interactive API-docs surface allowed to render?
 *
 * Shared by the HTML route and the asset route so the two can never
 * disagree — an asset route that outlived its page would be a
 * publicly-reachable static file server backed by `node_modules`.
 *
 * ONLY local development. Not production, and — contrary to what this
 * route's docblock claimed until #798 — **not staging either**:
 * `docker-compose.staging.yml:117` sets `NODE_ENV: production`
 * deliberately ("staging runs NODE_ENV=production and is treated as
 * production", GAP-03), so staging takes the same hard 404.
 *
 * Operators who need to read the spec in a deployed environment should
 * fetch `/openapi.json`, which is served statically and is not gated.
 */
export function isDocsEnabled(): boolean {
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv === 'production') return false;
    if (nodeEnv === 'test') return false;
    return true;
}

/** 404 that is indistinguishable from a route that never existed. */
export function docsDisabledResponse(): Response {
    return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}
