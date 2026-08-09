/**
 * Unit tests for the Sentry error reporting module.
 *
 * Tests verify behavior WITHOUT requiring a live Sentry DSN:
 * - initSentry is safe to call without DSN
 * - captureError skips 4xx
 * - captureError invokes Sentry.withScope for 5xx
 * - beforeSend redaction (tested by constructing the beforeSend callback)
 *
 * RUN: npx jest tests/unit/observability-sentry.test.ts --verbose
 */

// Mock @sentry/nextjs before imports
const mockInit = jest.fn();
const mockCaptureException = jest.fn();
const mockWithScope = jest.fn((callback: (scope: unknown) => void) => {
    const scope = {
        setTag: jest.fn(),
        setContext: jest.fn(),
        setUser: jest.fn(),
    };
    callback(scope);
    return scope;
});
const mockSetTag = jest.fn();
const mockSetContext = jest.fn();
const mockSetUser = jest.fn();

jest.mock('@sentry/nextjs', () => ({
    init: mockInit,
    captureException: mockCaptureException,
    withScope: mockWithScope,
    setTag: mockSetTag,
    setContext: mockSetContext,
    setUser: mockSetUser,
}));

import {
    initSentry,
    captureError,
    setSentryContext,
    isSentryInitialized,
    _resetForTesting,
} from '@/lib/observability/sentry';
import { runWithRequestContext } from '@/lib/observability/context';

beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
    delete process.env.SENTRY_DSN;
});

describe('initSentry', () => {
    it('does not call Sentry.init when SENTRY_DSN is not set', () => {
        initSentry();
        expect(mockInit).not.toHaveBeenCalled();
        expect(isSentryInitialized()).toBe(true); // marked initialized even without DSN
    });

    it('calls Sentry.init when SENTRY_DSN is set', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        expect(mockInit).toHaveBeenCalledTimes(1);
        expect(mockInit.mock.calls[0][0].dsn).toBe('https://abc@sentry.io/123');
    });

    it('only initializes once', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        initSentry();
        expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it('sets environment from SENTRY_ENVIRONMENT', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        process.env.SENTRY_ENVIRONMENT = 'staging';
        initSentry();
        expect(mockInit.mock.calls[0][0].environment).toBe('staging');
        delete process.env.SENTRY_ENVIRONMENT;
    });

    it('sets tracesSampleRate from SENTRY_TRACES_SAMPLE_RATE', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        process.env.SENTRY_TRACES_SAMPLE_RATE = '0.5';
        initSentry();
        expect(mockInit.mock.calls[0][0].tracesSampleRate).toBe(0.5);
        delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    });
});

describe('captureError', () => {
    // captureError noops unless Sentry is initialized (the
    // `if (!_initialized) return` guard added in #75 to stop
    // Sentry.withScope throwing on an unbound SDK). The top-level
    // beforeEach calls `_resetForTesting()`, so initialize here — with
    // no SENTRY_DSN this just marks the module initialized and does NOT
    // call Sentry.init, leaving the capture mocks untouched.
    beforeEach(() => {
        initSentry();
    });

    it('skips 4xx errors (status < 500)', () => {
        captureError(new Error('Not found'), { status: 404 });
        expect(mockWithScope).not.toHaveBeenCalled();
        expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('skips 400 validation errors', () => {
        captureError(new Error('Invalid input'), { status: 400 });
        expect(mockWithScope).not.toHaveBeenCalled();
    });

    it('skips 401 auth errors', () => {
        captureError(new Error('Unauthorized'), { status: 401 });
        expect(mockWithScope).not.toHaveBeenCalled();
    });

    it('captures 500 errors', () => {
        captureError(new Error('DB crash'), { status: 500, requestId: 'req-1' });
        expect(mockWithScope).toHaveBeenCalledTimes(1);
        expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('captures errors without status (defaults to capturing)', () => {
        captureError(new Error('Unknown error'));
        expect(mockWithScope).toHaveBeenCalledTimes(1);
        expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('sets tags with requestId, route, method', () => {
        captureError(new Error('fail'), {
            status: 500,
            requestId: 'req-42',
            route: '/api/practices',
            method: 'POST',
            errorCode: 'INTERNAL',
        });

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setTag).toHaveBeenCalledWith('requestId', 'req-42');
        expect(scope.setTag).toHaveBeenCalledWith('route', '/api/practices');
        expect(scope.setTag).toHaveBeenCalledWith('method', 'POST');
        expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'INTERNAL');
    });

    it('sets user context with userId and tenantId', () => {
        captureError(new Error('fail'), {
            status: 500,
            userId: 'user-1',
            tenantId: 'tenant-1',
        });

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'user-1' }),
        );
    });

    it('auto-enriches from ALS context when extra not provided', () => {
        runWithRequestContext(
            { requestId: 'als-req', startTime: 0, tenantId: 't-2', userId: 'u-2' },
            () => {
                captureError(new Error('fail'));
            },
        );

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setTag).toHaveBeenCalledWith('requestId', 'als-req');
    });

    it('wraps non-Error values in Error before capturing', () => {
        captureError('string error', { status: 500 });
        expect(mockCaptureException).toHaveBeenCalledWith(
            expect.any(Error),
        );
    });
});

describe('setSentryContext', () => {
    it('sets tag and user context', () => {
        setSentryContext({
            requestId: 'req-99',
            route: '/api/test',
            tenantId: 'tenant-x',
            userId: 'user-y',
        });

        expect(mockSetTag).toHaveBeenCalledWith('requestId', 'req-99');
        expect(mockSetTag).toHaveBeenCalledWith('route', '/api/test');
        expect(mockSetContext).toHaveBeenCalledWith('tenant', { tenantId: 'tenant-x' });
        expect(mockSetUser).toHaveBeenCalledWith({ id: 'user-y' });
    });
});

describe('beforeSend redaction', () => {
    it('initSentry configures a beforeSend that redacts sensitive data', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();

        const config = mockInit.mock.calls[0][0];
        expect(config.beforeSend).toBeDefined();

        // Simulate an event with sensitive data
        const event = {
            request: {
                headers: {
                    authorization: 'Bearer secret-token',
                    cookie: 'session=abc123',
                    'content-type': 'application/json',
                },
                data: '{"password":"hunter2"}',
                url: 'https://app.example.com/api/callback?code=abc&state=xyz&safe=yes',
                query_string: 'code=abc&state=xyz',
            },
            breadcrumbs: [
                { data: { url: 'https://sso.example.com/auth?token=secret123' } },
            ],
        };

        const result = config.beforeSend(event, {});

        // Headers redacted
        expect(result.request.headers.authorization).toBeUndefined();
        expect(result.request.headers.cookie).toBeUndefined();
        expect(result.request.headers['content-type']).toBe('application/json');

        // Body redacted
        expect(result.request.data).toBe('[Filtered]');

        // Query string redacted
        expect(result.request.query_string).toBe('[Filtered]');

        // Breadcrumb URL params redacted (URL class encodes brackets as %5B/%5D)
        expect(result.breadcrumbs[0].data.url).not.toContain('secret123');
        expect(result.breadcrumbs[0].data.url).toMatch(/Redacted/);
    });

    it('beforeSend drops NEXT_REDIRECT errors', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        _resetForTesting();
        initSentry();

        const config = mockInit.mock.calls[0][0];
        const result = config.beforeSend({}, {
            originalException: new Error('NEXT_REDIRECT'),
        });
        expect(result).toBeNull();
    });

    it('beforeSend drops NEXT_NOT_FOUND errors', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        _resetForTesting();
        initSentry();

        const config = mockInit.mock.calls[0][0];
        const result = config.beforeSend({}, {
            originalException: new Error('NEXT_NOT_FOUND'),
        });
        expect(result).toBeNull();
    });
});
