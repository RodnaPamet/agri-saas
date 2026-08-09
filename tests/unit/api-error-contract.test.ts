/**
 * Epic E — API Contract Completeness round-trip tests.
 *
 * The unit tests in `tests/unit/errors.test.ts` and
 * `tests/unit/typed-error-hierarchy.test.ts` cover `toApiErrorResponse`
 * directly. This file exercises the full wrapper round-trip: take a
 * handler, wrap it with `withApiErrorHandling`, invoke it with a real
 * `NextRequest`, and assert the HTTP-level contract:
 *
 *   - status code matches the thrown error
 *   - body JSON shape is `{ error: { code, message, requestId } }`
 *   - `x-request-id` header is set on EVERY response (success + error)
 *   - `x-request-id` echoes the inbound header when present
 *   - `Cache-Control: no-store` on error responses (no cached errors)
 *   - successful responses are passed through unchanged
 *   - representative subclasses round-trip correctly (4xx + 5xx + domain)
 *   - unknown thrown values do not leak stack traces
 *   - Prisma P2002/P2025 round-trip to 409/404
 */

import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    badRequest,
    notFound,
    forbidden,
    unauthorized,
    conflict,
    rateLimited,
    internal,
    tenantIsolationViolation,
    staleData,
    deprecatedResource,
    configurationError,
    externalServiceError,
} from '@/lib/errors/types';

function makeRequest(
    method = 'GET',
    headers: Record<string, string> = {},
    url = 'http://localhost/api/test',
): NextRequest {
    return new NextRequest(url, {
        method,
        headers: new Headers(headers),
    });
}

async function readJson(res: Response): Promise<unknown> {
    return res.json();
}

interface ErrorBody {
    error: {
        code: string;
        message: string;
        requestId?: string;
        details?: unknown;
    };
}

describe('Epic E — withApiErrorHandling HTTP contract', () => {
    describe('happy path', () => {
        it('passes a successful response through unchanged', async () => {
            const handler = withApiErrorHandling(async () => {
                return NextResponse.json({ ok: true, value: 42 }, { status: 200 });
            });

            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(200);
            const body = (await readJson(res)) as { ok: boolean; value: number };
            expect(body).toEqual({ ok: true, value: 42 });
        });

        it('always sets x-request-id on success', async () => {
            const handler = withApiErrorHandling(async () => {
                return NextResponse.json({ ok: true });
            });
            const res = await handler(makeRequest(), {});
            const reqId = res.headers.get('x-request-id');
            expect(reqId).toBeTruthy();
            expect(reqId!.length).toBeGreaterThanOrEqual(8);
        });

        it('echoes inbound x-request-id', async () => {
            const handler = withApiErrorHandling(async () => {
                return NextResponse.json({ ok: true });
            });
            const res = await handler(
                makeRequest('GET', { 'x-request-id': 'caller-supplied-id-123' }),
                {},
            );
            expect(res.headers.get('x-request-id')).toBe('caller-supplied-id-123');
        });
    });

    describe('error contract — 4xx subclasses', () => {
        const cases: Array<{
            name: string;
            err: () => Error;
            status: number;
            code: string;
            message: string;
        }> = [
            {
                name: 'ValidationError',
                err: () => badRequest('Bad input', { field: 'email' }),
                status: 400,
                code: 'BAD_REQUEST',
                message: 'Bad input',
            },
            {
                name: 'UnauthorizedError',
                err: () => unauthorized(),
                status: 401,
                code: 'UNAUTHORIZED',
                message: 'Unauthorized',
            },
            {
                name: 'ForbiddenError',
                err: () => forbidden('No access'),
                status: 403,
                code: 'FORBIDDEN',
                message: 'No access',
            },
            {
                name: 'NotFoundError',
                err: () => notFound('User'),
                status: 404,
                code: 'NOT_FOUND',
                message: 'User',
            },
            {
                name: 'ConflictError',
                err: () => conflict('Dup'),
                status: 409,
                code: 'CONFLICT',
                message: 'Dup',
            },
            {
                name: 'RateLimitedError',
                err: () => rateLimited(),
                status: 429,
                code: 'RATE_LIMITED',
                message: 'Too many requests',
            },
        ];

        it.each(cases)(
            '$name → $status with code=$code, requestId, x-request-id, Cache-Control: no-store',
            async ({ err, status, code, message }) => {
                const handler = withApiErrorHandling(async () => {
                    throw err();
                });
                const res = await handler(makeRequest(), {});
                expect(res.status).toBe(status);

                const body = (await readJson(res)) as ErrorBody;
                expect(body.error.code).toBe(code);
                expect(body.error.message).toBe(message);
                expect(body.error.requestId).toBeTruthy();

                expect(res.headers.get('x-request-id')).toBe(body.error.requestId);
                expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
            },
        );

        it('ValidationError preserves details', async () => {
            const handler = withApiErrorHandling(async () => {
                throw badRequest('Validation failed', { field: 'email' });
            });
            const res = await handler(makeRequest(), {});
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.details).toEqual({ field: 'email' });
        });
    });

    describe('error contract — domain errors', () => {
        it('TenantIsolationViolation → 403 with TENANT_ISOLATION_VIOLATION code', async () => {
            const handler = withApiErrorHandling(async () => {
                throw tenantIsolationViolation('Cross-tenant blocked');
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(403);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('TENANT_ISOLATION_VIOLATION');
            expect(body.error.message).toBe('Cross-tenant blocked');
        });

        it('StaleData → 409 with STALE_DATA code', async () => {
            const handler = withApiErrorHandling(async () => {
                throw staleData();
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(409);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('STALE_DATA');
        });

        it('DeprecatedResource → 410 with DEPRECATED_RESOURCE code', async () => {
            const handler = withApiErrorHandling(async () => {
                throw deprecatedResource();
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(410);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('DEPRECATED_RESOURCE');
        });

        it('ConfigurationError → 500 with hidden message (expose=false)', async () => {
            const handler = withApiErrorHandling(async () => {
                throw configurationError('STRIPE_SECRET_KEY missing');
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(500);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('CONFIGURATION_ERROR');
            // 5xx DomainErrors set expose=false → message is generic
            expect(body.error.message).not.toContain('STRIPE');
            expect(body.error.message).toBe('An error occurred');
        });

        it('ExternalServiceError → 502 with hidden message', async () => {
            const handler = withApiErrorHandling(async () => {
                throw externalServiceError('GitHub timed out');
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(502);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('EXTERNAL_SERVICE_ERROR');
            expect(body.error.message).not.toContain('GitHub');
        });
    });

    describe('error contract — ZodError', () => {
        it('ZodError → 400 with VALIDATION_ERROR code and details array', async () => {
            const handler = withApiErrorHandling(async () => {
                throw new ZodError([
                    {
                        code: 'invalid_type',
                        path: ['email'],
                        message: 'Required',
                        expected: 'string',
                        input: undefined,
                    },
                ]);
            });
            const res = await handler(makeRequest('POST'), {});
            expect(res.status).toBe(400);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('VALIDATION_ERROR');
            expect(body.error.message).toBe('Invalid request payload');
            expect(Array.isArray(body.error.details)).toBe(true);
            const details = body.error.details as Array<{ path: unknown; code: string; message: string }>;
            expect(details[0].path).toEqual(['email']);
            expect(details[0].code).toBe('invalid_type');
        });
    });

    describe('error contract — Prisma errors', () => {
        it('Prisma P2002 (unique violation) → 409 CONFLICT', async () => {
            const handler = withApiErrorHandling(async () => {
                throw { code: 'P2002', meta: { target: ['email'] }, message: 'Unique' };
            });
            const res = await handler(makeRequest('POST'), {});
            expect(res.status).toBe(409);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('CONFLICT');
            expect(body.error.details).toEqual(['email']);
        });

        it('Prisma P2025 (record not found) → 404 NOT_FOUND', async () => {
            const handler = withApiErrorHandling(async () => {
                throw { code: 'P2025', message: 'Record not found' };
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(404);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('error contract — unknown / leaky throws', () => {
        it('plain Error → 500 INTERNAL with generic message (no stack leak)', async () => {
            const handler = withApiErrorHandling(async () => {
                throw new Error('I am a leaky stack-trace-carrying error');
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(500);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('INTERNAL');
            expect(body.error.message).toBe('An unexpected internal server error occurred');
            // Ensure the throw message did NOT make it into the response.
            expect(JSON.stringify(body)).not.toContain('leaky');
            expect(body.error.details).toBeUndefined();
        });

        it('thrown string → 500 INTERNAL (no body inflation)', async () => {
            const handler = withApiErrorHandling(async () => {

                throw 'string-throw';
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(500);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('INTERNAL');
            expect(JSON.stringify(body)).not.toContain('string-throw');
        });

        it('InternalError → 500 hides the message', async () => {
            const handler = withApiErrorHandling(async () => {
                throw internal('Database fell over');
            });
            const res = await handler(makeRequest(), {});
            expect(res.status).toBe(500);
            const body = (await readJson(res)) as ErrorBody;
            expect(body.error.code).toBe('INTERNAL');
            expect(body.error.message).toBe('An error occurred');
            expect(JSON.stringify(body)).not.toContain('Database');
        });
    });

    describe('contract invariants — every error response carries observability glue', () => {
        it.each([
            ['ValidationError', () => badRequest('x'), 400],
            ['UnknownThrow', () => new Error('boom'), 500],
        ])(
            '%s response sets x-request-id AND Cache-Control: no-store',
            async (_name, makeErr, expectedStatus) => {
                const handler = withApiErrorHandling(async () => {
                    throw makeErr();
                });
                const res = await handler(makeRequest(), {});
                expect(res.status).toBe(expectedStatus);
                expect(res.headers.get('x-request-id')).toBeTruthy();
                expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
            },
        );
    });
});
