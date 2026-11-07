/**
 * The SEAM: does `withApiErrorHandling` actually run the detector? — #2723
 *
 * `ciphertext-egress.test.ts` proves the matcher and the walker. Neither says
 * the wrapper calls them. An injected reader leaves the seam untested, and the
 * detector's whole value is that it sits on the one choke point 416 of 439
 * route files pass through — so this executes a wrapped handler and asserts on
 * the log line, rather than asserting about the source.
 *
 * It is also the test that would fail if the call were made
 * fire-and-forget: the report is awaited, so the assertion does not race it.
 */
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

const errorLog = jest.fn();
const recordEgress = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        error: (...a: unknown[]) => errorLog(...a),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('@/lib/observability/metrics', () => {
    const actual = jest.requireActual('@/lib/observability/metrics');
    return {
        ...actual,
        recordCiphertextEgress: (...a: unknown[]) => recordEgress(...a),
    };
});

import { withApiErrorHandling } from '@/lib/errors/api';
import { encryptWithKey } from '@/lib/security/encryption';

const envelope = () => encryptWithKey(crypto.randomBytes(32), 'секретна бележка');

const req = () =>
    new NextRequest('http://localhost/api/t/acme/agro/parcels/p1/comments', {
        method: 'GET',
        headers: new Headers(),
    });

const egressCalls = () =>
    errorLog.mock.calls.filter((c) => c[0] === 'encryption.ciphertext_reached_response');

beforeEach(() => {
    errorLog.mockClear();
    recordEgress.mockClear();
});

describe('the wrapper runs the ciphertext detector', () => {
    it('reports an envelope in a JSON response, naming the PATH and not the value', async () => {
        const env = envelope();
        const handler = withApiErrorHandling(async () =>
            NextResponse.json({ rows: [{ id: 'a', body: 'fine' }, { id: 'b', body: env }] }),
        );
        const res = await handler(req(), {});

        expect(res.status).toBe(200);
        const calls = egressCalls();
        expect(calls).toHaveLength(1);
        const fields = calls[0][1] as Record<string, unknown>;
        expect(fields.paths).toEqual(['rows[1].body']);
        expect(fields.route).toBe('/api/t/acme/agro/parcels/p1/comments');
        // The value must never reach the log.
        expect(JSON.stringify(fields)).not.toContain(env);
        expect(JSON.stringify(fields)).not.toContain(env.slice(4, 20));
        expect(recordEgress).toHaveBeenCalledWith({ route: expect.any(String) });
    });

    it('does NOT consume the body — the caller still gets its JSON', async () => {
        // `clone()` is what makes this true, and a detector that ate the body
        // would turn every response into an empty one.
        const env = envelope();
        const handler = withApiErrorHandling(async () =>
            NextResponse.json({ body: env, id: 'x' }),
        );
        const res = await handler(req(), {});
        await expect(res.json()).resolves.toEqual({ body: env, id: 'x' });
    });

    /**
     * The negative control. Without it, a detector that fired on EVERY
     * response would satisfy the test above — and the false-positive direction
     * is the expensive one, because it would log on live traffic forever.
     */
    it('stays silent on a clean response, including near-miss strings', async () => {
        const handler = withApiErrorHandling(async () =>
            NextResponse.json({
                note: 'v2: план за пръскане',
                label: 'v2:draft',
                body: 'Северният ъгъл се подмокря след дъжд.',
            }),
        );
        const res = await handler(req(), {});
        expect(res.status).toBe(200);
        expect(egressCalls()).toHaveLength(0);
        expect(recordEgress).not.toHaveBeenCalled();
    });

    /**
     * The reporter's `truncated` must come from the WALK, not from
     * `paths.length`. Measured: deriving it from the length failed no test,
     * because the walker's own tests check the walker and this field lives in
     * the reporter. A payload that truncates WITHOUT filling the path list is
     * what separates them — one envelope early, then more nodes than the cap.
     *
     * It matters because this is the field that says whether an operator is
     * looking at a complete answer. Reported as `false` on a blind scan, it
     * says "these are all the places", which is the absence-reads-as-success
     * shape the detector exists to remove.
     */
    it('reports truncation from the WALK, not from the path count', async () => {
        const env = envelope();
        const payload = {
            first: env,
            rest: Array.from({ length: 60_000 }, (_, i) => `row ${i}`),
        };
        const handler = withApiErrorHandling(async () => NextResponse.json(payload));
        await handler(req(), {});
        const calls = egressCalls();
        expect(calls).toHaveLength(1);
        const fields = calls[0][1] as Record<string, unknown>;
        // One path found, far below MAX_PATHS...
        expect(fields.paths).toEqual(['first']);
        // ...and the walk still did not finish.
        expect(fields.truncated).toBe(true);
    });

    it('ignores a non-JSON response', async () => {
        const handler = withApiErrorHandling(
            async () =>
                // QUOTED, as real CSV writes a field — so the `"v2:` needle
                // DOES occur in the body and only the content-type filter
                // stops this being reported. With an unquoted field the test
                // passed either way, which made the filter undetectable.
                new Response(`id,body\n1,"${envelope()}"\n`, {
                    status: 200,
                    headers: { 'content-type': 'text/csv' },
                }),
        );
        await handler(req(), {});
        // A CSV export is a different surface with a different fix; claiming
        // to cover it here would be the broader claim this detector cannot
        // honour.
        expect(egressCalls()).toHaveLength(0);
    });

    it('cannot break a response — a detector failure is swallowed', async () => {
        // The response's `clone()` throws, which is the shape of any internal
        // failure in the detector. The request must still succeed.
        const handler = withApiErrorHandling(async () => {
            const res = NextResponse.json({ ok: true });
            Object.defineProperty(res, 'clone', {
                value: () => {
                    throw new Error('clone exploded');
                },
            });
            return res;
        });
        const res = await handler(req(), {});
        expect(res.status).toBe(200);
        expect(egressCalls()).toHaveLength(0);
    });
});
