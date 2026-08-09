/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for the typed API client.
 * Tests error handling, happy paths, and dev-mode Zod validation.
 */
import { apiGet, apiPost, apiPatch, apiDelete, ApiClientError } from '@/lib/api-client';

// ── Mock fetch ──

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
    mockFetch.mockReset();
});

describe('apiGet', () => {
    it('returns parsed JSON on success', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '1', name: 'Test Practice' }),
        });

        const result = await apiGet<{ id: string; name: string }>('http://localhost/api/practices/1');
        expect(result).toEqual({ id: '1', name: 'Test Practice' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/practices/1', { method: 'GET', signal: expect.any(AbortSignal) });
    });

    it('throws ApiClientError on 404 with standard error body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: async () => ({
                error: { code: 'NOT_FOUND', message: 'Practice not found', requestId: 'req-123' },
            }),
        });

        try {
            await apiGet('http://localhost/api/practices/999');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('NOT_FOUND');
            expect(apiErr.message).toBe('Practice not found');
            expect(apiErr.status).toBe(404);
            expect(apiErr.requestId).toBe('req-123');
        }
    });

    it('throws ApiClientError with fallback on non-JSON error body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => { throw new Error('not JSON'); },
        });

        try {
            await apiGet('http://localhost/api/practices/1');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('UNKNOWN');
            expect(apiErr.status).toBe(500);
        }
    });
});

describe('apiPost', () => {
    it('sends JSON body and returns parsed response', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '2', name: 'New Practice' }),
        });

        const result = await apiPost<{ id: string; name: string }>(
            'http://localhost/api/practices',
            { name: 'New Practice' },
        );
        expect(result).toEqual({ id: '2', name: 'New Practice' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/practices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'New Practice' }),
            signal: expect.any(AbortSignal),
        });
    });

    it('throws ApiClientError on validation error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request payload',
                    details: [{ path: ['name'], code: 'too_small', message: 'Name is required' }],
                },
            }),
        });

        try {
            await apiPost('http://localhost/api/practices', {});
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('VALIDATION_ERROR');
            expect(apiErr.status).toBe(400);
            expect(apiErr.details).toEqual([
                { path: ['name'], code: 'too_small', message: 'Name is required' },
            ]);
        }
    });
});

describe('apiPatch', () => {
    it('sends PATCH request with JSON body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '1', name: 'Updated' }),
        });

        const result = await apiPatch<{ id: string; name: string }>(
            'http://localhost/api/practices/1',
            { name: 'Updated' },
        );
        expect(result).toEqual({ id: '1', name: 'Updated' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/practices/1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated' }),
            signal: expect.any(AbortSignal),
        });
    });
});

describe('apiDelete', () => {
    it('sends DELETE request and returns void', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await expect(apiDelete('http://localhost/api/practices/1')).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/practices/1', {
            method: 'DELETE',
            signal: expect.any(AbortSignal),
        });
    });

    it('throws ApiClientError on failed delete', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({
                error: { code: 'FORBIDDEN', message: 'Not allowed' },
            }),
        });

        try {
            await apiDelete('http://localhost/api/practices/1');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('FORBIDDEN');
            expect(apiErr.status).toBe(403);
        }
    });
});

describe('ApiClientError', () => {
    it('has correct name and properties', () => {
        const err = new ApiClientError('test message', 'TEST', 418, { detail: 'x' }, 'req-1');
        expect(err.name).toBe('ApiClientError');
        expect(err.message).toBe('test message');
        expect(err.code).toBe('TEST');
        expect(err.status).toBe(418);
        expect(err.details).toEqual({ detail: 'x' });
        expect(err.requestId).toBe('req-1');
        expect(err).toBeInstanceOf(Error);
    });
});
