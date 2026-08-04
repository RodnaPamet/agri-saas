/**
 * `getAppBaseUrl` must ALWAYS return an absolute origin.
 *
 * The bug this locks out (production, 2026-08-04): three auth surfaces
 * independently wrote `env.APP_URL ?? ''`, so with APP_URL unset they
 * produced RELATIVE URLs. That broke two things at once and silently:
 *
 *   - verification / password-reset emails carried `/api/auth/...` hrefs,
 *     which mail clients cannot resolve (no base document) and render as
 *     dead text rather than a link;
 *   - `NextResponse.redirect()` requires an absolute URL, so the
 *     verify-email route threw and returned 500 on EVERY click.
 *
 * With AUTH_REQUIRE_EMAIL_VERIFICATION=1 that combination meant a user
 * could register but never verify, and therefore never log in.
 *
 * The contract: never return something that yields a relative URL when
 * any app-origin env var is available.
 */

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({
    __esModule: true,
    get env() {
        return mockEnv;
    },
}));

const mockError = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { error: (...a: unknown[]) => mockError(...a), warn: jest.fn(), info: jest.fn() },
}));

import { getAppBaseUrl } from '@/lib/auth/app-base-url';

beforeEach(() => {
    jest.clearAllMocks();
    delete mockEnv.APP_URL;
    delete mockEnv.NEXTAUTH_URL;
});

it('prefers APP_URL when it is set', () => {
    mockEnv.APP_URL = 'https://app.example.com';
    mockEnv.NEXTAUTH_URL = 'https://other.example.com';
    expect(getAppBaseUrl()).toBe('https://app.example.com');
});

it('falls back to NEXTAUTH_URL when APP_URL is unset — the production bug', () => {
    mockEnv.NEXTAUTH_URL = 'https://app.agrent.bg';
    expect(getAppBaseUrl()).toBe('https://app.agrent.bg');
});

it('never returns an empty string while any origin is configured', () => {
    mockEnv.NEXTAUTH_URL = 'https://app.agrent.bg';
    expect(getAppBaseUrl()).not.toBe('');
});

it('strips a trailing slash so callers can concatenate a leading-slash path', () => {
    mockEnv.APP_URL = 'https://app.example.com/';
    expect(getAppBaseUrl()).toBe('https://app.example.com');
    expect(`${getAppBaseUrl()}/login`).toBe('https://app.example.com/login');
});

it('produces an absolute, parseable URL when concatenated with a path', () => {
    mockEnv.NEXTAUTH_URL = 'https://app.agrent.bg';
    const url = `${getAppBaseUrl()}/api/auth/verify-email?token=abc`;
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).protocol).toMatch(/^https?:$/);
});

it('logs an error when nothing is configured, instead of failing silently', () => {
    expect(getAppBaseUrl()).toBe('');
    expect(mockError).toHaveBeenCalled();
});
