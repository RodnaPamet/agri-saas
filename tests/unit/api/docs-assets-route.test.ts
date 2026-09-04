/**
 * `/api/docs/assets/<file>` serves Swagger UI's own bundle same-origin.
 *
 * Two properties are load-bearing and neither is visible in a source scan:
 *
 *  1. The dynamic segment is a LOOKUP KEY, never a path component. A route
 *     that joined the segment onto a directory would be a traversal surface
 *     reaching into `node_modules`; because the segment only indexes a
 *     literal map, `../../../etc/passwd` simply misses it.
 *  2. It shares `isDocsEnabled()` with the page. An asset route that
 *     outlived its page would be a public read path into `node_modules` on
 *     every deployment — the page's 404 protects nothing on its own.
 */
// Mock ONLY `readFile`, passing the rest of the module through. A wholesale
// replacement of `node:fs/promises` also replaces it for pino's thread-stream
// transport, which real-requires it from a worker thread — that crashed the
// jest WORKER while the tests themselves passed, i.e. a red shard with no
// summary. Exactly the hazard CLAUDE.md records for over-broad mocks.
const fsMock = { readFile: jest.fn() };
jest.mock('node:fs/promises', () => ({
    ...jest.requireActual('node:fs/promises'),
    readFile: (...args: unknown[]) => fsMock.readFile(...args),
}));

function setEnv(v: string) {
    Object.defineProperty(process.env, 'NODE_ENV', { value: v, configurable: true });
}
const ORIGINAL_ENV = process.env.NODE_ENV;
afterAll(() => setEnv(ORIGINAL_ENV as string));

async function get(asset: string): Promise<Response> {
    const { GET } = await import('@/app/api/docs/assets/[asset]/route');
    // `NextRequest`, not `Request`: the route is wrapped in
    // `withApiErrorHandling`, which reads `req.nextUrl.pathname` and
    // `req.method` for its observability context.
    const { NextRequest } = await import('next/server');
    return GET(
        new NextRequest('http://localhost:3000/api/docs/assets/x'),
        { params: Promise.resolve({ asset }) } as never,
    ) as unknown as Promise<Response>;
}

describe('GET /api/docs/assets/[asset]', () => {
    beforeEach(() => {
        jest.resetModules();
        fsMock.readFile.mockReset();
        fsMock.readFile.mockResolvedValue(Buffer.from('/* swagger */'));
        setEnv('development');
    });

    it.each([
        ['swagger-ui.css', 'text/css; charset=utf-8'],
        ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
        ['swagger-ui-standalone-preset.js', 'text/javascript; charset=utf-8'],
    ])('serves %s with the right content type', async (asset, type) => {
        const res = await get(asset);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe(type);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(await res.text()).toBe('/* swagger */');
        // Read from the swagger-ui-dist package directory, by name.
        const readPath = String(fsMock.readFile.mock.calls[0][0]);
        expect(readPath.endsWith(`/node_modules/swagger-ui-dist/${asset}`)).toBe(true);
    });

    it.each([
        '../../../etc/passwd',
        '..%2f..%2fpackage.json',
        'swagger-ui-bundle.js.map',
        'index.html',
        '',
    ])('404s on %s without touching the filesystem', async (asset) => {
        const res = await get(asset);
        expect(res.status).toBe(404);
        // The decisive assertion: the segment never reached a path builder.
        expect(fsMock.readFile).not.toHaveBeenCalled();
    });

    it.each(['production', 'test'])('404s under NODE_ENV=%s even for a valid asset', async (envName) => {
        setEnv(envName);
        const res = await get('swagger-ui-bundle.js');
        expect(res.status).toBe(404);
        expect(fsMock.readFile).not.toHaveBeenCalled();
    });

    it('404s rather than 500s when the devDependency is absent', async () => {
        // The pruned-image / never-installed case. A 500 here would read as
        // a bug in this route; the file is simply not present.
        fsMock.readFile.mockRejectedValue(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );
        const res = await get('swagger-ui-bundle.js');
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Not Found');
    });
});
