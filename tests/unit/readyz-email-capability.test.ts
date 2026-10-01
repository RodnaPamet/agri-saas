/**
 * P0.6 — `/api/readyz` reports WHICH mail transport is configured.
 *
 * Mail is a degradable capability, not a dependency: with nothing configured
 * the app keeps serving and `sendEmail` logs to the console sink and throws the
 * message away. That is the silence this capability closes — the same argument
 * as `capabilities.satellite` (missing GEE keys) and `capabilities.basemap`
 * (missing MapTiler key), with a third kind of consequence: invites,
 * verification links and password resets vanish.
 *
 * So the probe must REPORT it and must never GATE on it. These tests drive the
 * real route handler and read the real response body — the provider value is
 * derived from the same selector `initMailerFromEnv` branches on
 * (src/lib/email/provider-selection.ts), so the probe cannot disagree with the
 * sender.
 */
export {};

// ─── Mocks (declared before requires) ───────────────────────────────

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    })),
}));

const pingMock = jest.fn();
jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => ({ ping: pingMock })),
}));

/**
 * Reload the route (and, with it, `@/env`) so the current `process.env` is what
 * the handler sees. `@/env` snapshots at module parse, so without the reset a
 * mail variable set in a test would never reach the route.
 */
function loadRouteFresh() {
    jest.resetModules();
    jest.doMock('@prisma/client', () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        })),
    }));
    jest.doMock('@/lib/redis', () => ({
        getRedis: jest.fn(() => ({ ping: pingMock })),
    }));

    return require('@/app/api/readyz/route');
}

interface ProbeBody {
    status: string;
    failed: string[];
    checks: Record<string, unknown>;
    capabilities: { email: { provider: string; sends: boolean } };
}

async function probe(): Promise<{ status: number; body: ProbeBody }> {
    const { GET } = loadRouteFresh();
    const res = await GET();
    return { status: res.status, body: await res.json() };
}

describe('GET /api/readyz — capabilities.email is REPORTED, never GATING', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.REDIS_URL = 'redis://localhost:6379';
        delete process.env.RESEND_API_KEY;
        delete process.env.RESEND_FROM;
        delete process.env.SMTP_HOST;
        pingMock.mockResolvedValue('PONG');
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('reports provider "resend" when RESEND_API_KEY is set, without echoing the key', async () => {
        // The shape is the point: the assertion below proves readyz does not echo
        // a value that LOOKS like a credential, which a short placeholder would
        // not test. Never a real key.
        process.env.RESEND_API_KEY = 're_live_SUPERSECRETKEYVALUE'; // pragma: allowlist secret -- key-shaped test fixture, never a real credential
        process.env.RESEND_FROM = 'noreply@agrent.bg';
        // SMTP is also configured — Resend must win, exactly as the mailer does.
        process.env.SMTP_HOST = 'smtp.example.test';

        const { status, body } = await probe();

        expect(status).toBe(200);
        expect(body).toMatchObject({ status: 'ready' });
        expect(body.capabilities.email).toEqual({ provider: 'resend', sends: true });
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain('SUPERSECRETKEYVALUE');
        expect(bodyStr).not.toContain('smtp.example.test');
        expect(bodyStr).not.toContain('RESEND_API_KEY');
    });

    it('reports provider "smtp" when only SMTP_HOST is set', async () => {
        process.env.SMTP_HOST = 'smtp.example.test';

        const { status, body } = await probe();

        expect(status).toBe(200);
        expect(body.capabilities.email).toEqual({ provider: 'smtp', sends: true });
        expect(JSON.stringify(body)).not.toContain('smtp.example.test');
    });

    it('reports provider "console" with sends:false, and still returns 200/ready', async () => {
        // Nothing configured: the app is healthy and mail is being DISCARDED.
        // Both facts have to be readable from one response, which is why this
        // lives outside `checks`/`failed`.
        const { status, body } = await probe();

        expect(status).toBe(200);
        expect(body).toMatchObject({ status: 'ready' });
        expect(body.capabilities.email).toEqual({ provider: 'console', sends: false });
        expect(body.failed).not.toContain('email');
        expect(body.checks).not.toHaveProperty('email');
    });
});
