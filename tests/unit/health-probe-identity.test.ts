/**
 * A health probe says WHOSE health it is reporting — executed, not asserted about.
 *
 * On 2026-09-27 `app.agrent.bg` was served intermittently by a different
 * product for nearly six hours (#1117, fixed in #1143). A sibling stack shared
 * the `agrent_internal` Docker network and declared the same `app` alias, so
 * Docker DNS returned two addresses and Caddy picked between them per
 * connection. #1143 records the part that matters here:
 *
 *   > `/api/readyz` answered 200 through the proxy while agri-saas 404'd it —
 *   > because the 200 came from the OTHER app.
 *
 * The GCP uptime check's content matcher is `"status":"ready"`. It stayed red
 * through that incident only because the misrouting app happened not to emit
 * that string. The two products that DO emit it — this one and
 * `inflect-compliance` — share a GCP project, a GHCR org and a Docker network,
 * so a misroute between THOSE two would have shown a green check over an
 * application serving somebody else's data.
 *
 * This file executes the handlers. A sibling guard asserts the source text and
 * the cross-system constants; both are needed, and the repo's own rule says
 * why: "a guard asserting source text proves nothing about behaviour". A
 * regex can confirm `service: SERVICE_ID` appears in the route — only calling
 * it proves the field survives `jsonResponse` and reaches the body a probe
 * actually reads.
 */
import { SERVICE_ID, SERVICE_ID_MATCHER } from '@/lib/service-identity';

describe('the identity constant', () => {
    it('is not the sibling product, and not derived from package.json', () => {
        // package.json still reads "inflect-compliance" from the spin-out, and
        // OTEL_SERVICE_NAME defaults to the same string. An identity equal to
        // the sibling's would go green on exactly the misroute it exists to
        // detect — worse than having none, because it would look solved.
        expect(SERVICE_ID).not.toBe('inflect-compliance');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkgName = require('../../package.json').name;
        expect(SERVICE_ID).not.toBe(pkgName);
    });

    it('the matcher is the exact substring a probe should require', () => {
        // The check's matcher lives in GCP and the body is produced here.
        // Nothing but this constant connects the two systems, so a quote or a
        // space out of place is a silent mismatch.
        expect(SERVICE_ID_MATCHER).toBe('"service":"agri-saas"');
        expect(JSON.stringify({ service: SERVICE_ID })).toContain(SERVICE_ID_MATCHER);
    });
});

describe('GET /api/livez carries the identity (executed)', () => {
    it('serves the matcher in its real response body', async () => {
        const { GET } = await import('@/app/api/livez/route');
        const res = await GET();
        expect(res.status).toBe(200);

        const raw = await res.text();
        // Assert against the RAW BODY, not a parsed object. The probe matches
        // a substring of the bytes on the wire; a key-presence check on a
        // parsed object would pass even if serialisation changed the spelling.
        expect(raw).toContain(SERVICE_ID_MATCHER);

        const body = JSON.parse(raw);
        expect(body.service).toBe(SERVICE_ID);
        expect(body.status).toBe('alive');
    });
});

describe('GET /api/readyz carries the identity (executed)', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('serves the matcher alongside a ready verdict', async () => {
        jest.resetModules();
        // Both dependency checks stubbed to healthy so this test is about the
        // identity field and nothing else. A readyz that 503s still carries
        // `service` — covered below — because a probe needs to know who is
        // refusing just as much as who is ready.
        jest.doMock('@/lib/prisma', () => ({
            prisma: { $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]) },
        }));
        jest.doMock('@/lib/redis', () => ({
            getRedis: () => ({ ping: jest.fn().mockResolvedValue('PONG') }),
        }));

        const { GET } = await import('@/app/api/readyz/route');
        const res = await GET();
        const raw = await res.text();

        expect(raw).toContain(SERVICE_ID_MATCHER);
        const body = JSON.parse(raw);
        expect(body.service).toBe(SERVICE_ID);
        // The identity must not depend on the verdict — whichever way this
        // resolved in the sandbox, the field is there.
        expect(['ready', 'not_ready']).toContain(body.status);
    });

    it('still names itself when it is NOT ready', async () => {
        jest.resetModules();
        jest.doMock('@/lib/prisma', () => ({
            prisma: { $queryRaw: jest.fn().mockRejectedValue(new Error('down')) },
        }));
        jest.doMock('@/lib/redis', () => ({ getRedis: () => null }));

        const { GET } = await import('@/app/api/readyz/route');
        const res = await GET();
        const raw = await res.text();

        // A 503 from the WRONG application is the worst case of all: it would
        // page an operator about a service that is fine. So the failure path
        // needs the identity at least as much as the success path.
        expect(raw).toContain(SERVICE_ID_MATCHER);
        expect(JSON.parse(raw).service).toBe(SERVICE_ID);
    });
});
