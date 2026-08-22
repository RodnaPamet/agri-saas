/**
 * Shared E2E test utilities.
 *
 * Centralises login, navigation, and retry logic so every spec file
 * benefits from the same cold-start / net-error resilience.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Pick an option from one of the shared `<Combobox>` practices (Epic 55
 * replaced the legacy `<select>` here). Resolves the trigger by `id`,
 * opens the popover, and clicks the option whose accessible name
 * matches `optionLabel` (regex or string).
 *
 * Drop-in replacement for `page.selectOption('#foo', 'BAR')` against
 * the migrated dropdowns — pass the visible LABEL of the desired
 * option, not the underlying enum value.
 */
export async function selectComboboxOption(
    page: Page,
    triggerId: string,
    optionLabel: string | RegExp,
) {
    await page.locator(`#${triggerId}`).click();
    const matcher =
        optionLabel instanceof RegExp
            ? optionLabel
            : new RegExp(`^\\s*${escapeRegex(optionLabel)}\\s*$`);
    await page.getByRole('option', { name: matcher }).first().click();
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const DEFAULT_USER = { email: 'admin@acme.com', password: 'password123' };

/** Errors that indicate a transient server/network issue worth retrying. */
const TRANSIENT_ERRORS = ['net::', 'ERR_CONNECTION_REFUSED', 'ERR_EMPTY_RESPONSE'];

/** Errors that mean the page/context is dead — retrying on the same page is pointless. */
const FATAL_ERRORS = ['Target page, context or browser has been closed', 'Target closed'];

/**
 * Navigate to a URL with retry on transient network errors.
 * Uses `domcontentloaded` by default to avoid hanging on slow network requests.
 */
export async function safeGoto(
    page: Page,
    url: string,
    options?: Parameters<Page['goto']>[1],
    retries = 5,
) {
    const defaultOptions: Parameters<Page['goto']>[1] = {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
        ...options,
    };
    for (let i = 0; i < retries; i++) {
        try {
            return await page.goto(url, defaultOptions);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);

            // Fatal: page/context is dead — no point retrying on the same page
            if (FATAL_ERRORS.some(f => msg.includes(f))) {
                throw e;
            }

            // Transient: wait and retry
            if (i < retries - 1 && TRANSIENT_ERRORS.some(t => msg.includes(t))) {
                await page.waitForTimeout(5000);
                continue;
            }
            throw e;
        }
    }
}

/**
 * Login via the credentials form and return the tenant slug.
 *
 * Includes retry logic for:
 * - `net::` connection errors during cold-start
 * - Server 500s / blank pages on first compilation
 * - Sidebar hydration checks to confirm the page actually rendered
 */
export async function loginAndGetTenant(
    page: Page,
    user: { email: string; password: string } = DEFAULT_USER,
): Promise<string> {
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
    page.on('console', msg => {
        if (msg.type() === 'error') {
            const text = msg.text();
            // Suppress known-benign network noise. These messages are the
            // browser's automatic console log for any subresource that
            // doesn't return 2xx — they're not JS errors and the tests
            // that care about the response already assert on it directly.
            // - RSC payload fetch failures during JIT compilation
            // - ClientFetchError from session polling during transitions
            // - `Failed to load resource: <status>` for 4xx / 5xx / aborted /
            //   ERR_SSL_PROTOCOL_ERROR caused by chromium's speculative
            //   prefetch of same-origin links while the previous navigation
            //   is tearing down, and by tests that deliberately probe a
            //   forbidden route (non-admin → /admin/*, expecting 403).
            if (text.includes('Failed to fetch RSC payload') || text.includes('ClientFetchError')) return;
            if (text.startsWith('Failed to load resource')) return;
            console.log('BROWSER CONSOLE ERROR:', text);
        }
    });

    // Force English for E2E regardless of the app's default locale (which is
    // now Bulgarian for first-time users) — these specs assert English copy.
    // Set BEFORE the first navigation so the middleware's seedLocaleCookie
    // (which only seeds when NEXT_LOCALE is absent) never overrides it. The
    // `url` mirrors the config's baseURL resolution so it always matches the
    // navigation host.
    await page.context().addCookies([
        { name: 'NEXT_LOCALE', value: 'en', url: process.env.URL || 'http://localhost:3006' },
    ]);

    // Wait for the dev server to be ready — first navigation may trigger JIT compilation
    await safeGoto(page, '/login', { timeout: 90_000 });

    // Scope every form-control lookup to the primary credentials form so
    // the resend-verification form rendered below it (separate email +
    // submit button) doesn't trigger Playwright strict-mode violations.
    // The `#credentials-form` anchor lives on the login page's primary
    // <form>. See src/app/login/page.tsx.
    const credentialsForm = page.locator('#credentials-form');
    const emailInput = credentialsForm.locator('input[type="email"][name="email"]');
    // Resilience against `next dev` server pressure on long serial runs:
    // if the form doesn't render within 30s, reload once and try again.
    // Both the original test and the Playwright retry have hit cases
    // where the dev server returned a partial /login page (login GET
    // succeeded but the React tree didn't hydrate) — a single reload
    // forces a fresh JIT compile and unsticks the page.
    const formVisible = await emailInput
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
    if (!formVisible) {
        await safeGoto(page, '/login', { timeout: 60_000 });
        await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
    }

    // Wait for React hydration — ensure onSubmit is attached before interacting.
    // Without this, the browser does a native form POST to '#', not the JS auth flow.
    await page.waitForFunction(() => {
        const form = document.querySelector('form');
        return form && Object.keys(form).some(k => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, { timeout: 30000 });

    // Retry loop: covers dev-server JIT compilation races on the very first
    // login attempt. With AUTH_URL aligned to the test port, CSRF no longer
    // flakes, so two attempts is enough.
    const LOGIN_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            await safeGoto(page, '/login', { timeout: 60_000 });
            await credentialsForm.locator('input[type="email"][name="email"]').waitFor({ state: 'visible', timeout: 30000 });
            await page.waitForFunction(() => {
                const form = document.querySelector('form');
                return form && Object.keys(form).some(k => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
            }, { timeout: 15000 });
        }

        await emailInput.click();
        await emailInput.fill(user.email);
        await credentialsForm.locator('input[type="password"]').fill(user.password);
        await credentialsForm.locator('button[type="submit"]').click();

        const navigated = await page.waitForURL(/\/t\/[^/]+\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        if (navigated) break;

        const url = page.url();
        if (/\/t\/[^/]+\/dashboard/.test(url)) break;

        if (attempt < LOGIN_ATTEMPTS && url.includes('/login')) {
            await page.waitForTimeout(2000);
            continue;
        }

        console.error("LOGIN TIMEOUT! URL is:", url);
        console.error("PAGE CONTENT:", await page.content());
        throw new Error(`Login failed after ${attempt} attempts. URL: ${url}`);
    }
    const match = new URL(page.url()).pathname.match(/^\/t\/([^/]+)\//);
    if (!match) throw new Error('Could not extract tenant slug from ' + page.url());
    const slug = match[1];

    // Verify the page actually rendered — reload if server was still compiling.
    let renderRetries = 3;
    while (renderRetries > 0) {
        const hasSidebar = await page.locator('aside').isVisible().catch(() => false);
        if (hasSidebar) break;
        renderRetries--;
        if (renderRetries > 0) {
            await page.waitForLoadState('networkidle').catch(() => {});
            await safeGoto(page, `/t/${slug}/dashboard`, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle').catch(() => {});
        }
    }

    return slug;
}

/**
 * Wait until React has hydrated the given element so that its onClick /
 * onSubmit handlers are attached. After `page.reload`, the DOM lands
 * before the client bundle finishes hydrating; clicking a button whose
 * onClick is still detached fires the click against a no-op DOM node and
 * the test then waits forever for a side effect that never happens.
 */
export async function waitForHydration(
    page: Page,
    selector = 'main',
    timeoutMs = 15_000,
) {
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel as string);
            return !!el && Object.keys(el).some(
                (k) =>
                    k.startsWith('__reactEvents') ||
                    k.startsWith('__reactFiber') ||
                    k.startsWith('__reactProps'),
            );
        },
        selector,
        { timeout: timeoutMs },
    );
}

/**
 * Navigate to a page and verify that a specific selector is rendered.
 * Retries on server 500s / blank pages from JIT compilation.
 */
export async function gotoAndVerify(
    page: Page,
    url: string,
    contentSelector: string,
    maxAttempts = 3,
) {
    let attempts = maxAttempts;
    while (attempts > 0) {
        await safeGoto(page, url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        const rendered = await page
            .locator(contentSelector)
            .first()
            .isVisible()
            .catch(() => false);
        if (rendered) {
            await waitForHydration(page, '[data-hydrated], main').catch(() => {});
            return;
        }
        attempts--;
        if (attempts > 0) await page.waitForTimeout(3000);
    }
}

// ─── GAP-23 — Tenant tracker for global teardown ────────────────────
//
// The factory below appends every created tenant + owner user id to a
// JSONL file. `tests/e2e/global-teardown.ts` reads the file at
// end-of-suite and hard-deletes the rows so a CI run leaves the test
// DB exactly as it found it (modulo the seeded fixture tenant).
//
// File format: one JSON object per line, each carrying
// { tenantId, tenantSlug, ownerUserId, createdAt }.
//
// Why a file, not in-memory: Playwright workers run as separate
// processes; an in-memory list would only see the current worker's
// state. The teardown's a separate process too. A file is the
// cheapest cross-process queue. Append-only writes are atomic for
// the small payload we emit — no need for locking.

export const TENANT_TRACKER_PATH = resolvePath(
    __dirname,
    '.tenant-tracker.jsonl',
);

export interface TenantTrackerEntry {
    tenantId: string;
    tenantSlug: string;
    ownerUserId: string;
    createdAt: string;
}

function appendTenantToTracker(entry: TenantTrackerEntry): void {
    try {
        mkdirSync(dirname(TENANT_TRACKER_PATH), { recursive: true });
        appendFileSync(TENANT_TRACKER_PATH, JSON.stringify(entry) + '\n', {
            encoding: 'utf8',
        });
    } catch (err) {
        // Tracker write failures must not abort the test. Worst case
        // we leave a tenant behind for the next nightly cleanup. Log
        // for operator visibility.

        console.warn(
            `[e2e-utils] failed to append tenant tracker (continuing): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

// ─── GAP-23 — Test-data isolation factory ───────────────────────────
//
// `createIsolatedTenant()` provisions a fresh tenant + OWNER user via
// the production `/api/auth/register` route and hands the spec back
// everything it needs to authenticate and navigate. Each call yields
// a globally-unique tenant slug + user email so two concurrent
// invocations CANNOT collide, which is the precondition for moving
// the suite off `fullyParallel: false`.
//
// Why API-driven rather than direct Prisma writes:
//   - Exercises the same code path real users hit (PII middleware,
//     onboarding row, audit log, tenant DEK creation).
//   - Keeps test code free of schema knowledge — a future schema
//     change updates the route, not every fixture.
//   - The HIBP and password-policy gates apply, ensuring our test
//     credentials are realistic (we use crypto-random passwords for
//     this same reason — predictable test passwords like "password123"
//     fail the HIBP check).
//
// Identity-collision strategy:
//   - `randomUUID().slice(0, 12)` (96 bits of entropy) is appended to
//     orgName + email + name. The register route's slug derivation
//     adds a `Date.now().toString(36)` suffix, so even if two workers
//     hit register in the same millisecond the slug PREFIX (from the
//     UUID-bearing orgName) already differs.

export interface IsolatedTenantCredentials {
    /** Tenant slug — use to build URLs like `/t/{slug}/dashboard`. */
    tenantSlug: string;
    /** Tenant id (cuid). For DB-side cleanup or assertions. */
    tenantId: string;
    /** Tenant display name as it appears in the UI. */
    tenantName: string;
    /** Owner user's email — pass to `loginAndGetTenant` or any
     *  credentials-form interaction. */
    ownerEmail: string;
    /** Plaintext password — present ONLY to enable login from the
     *  same factory call; never written anywhere persistent. */
    ownerPassword: string;
    /** Owner user id (cuid). For audit-row assertions. */
    ownerUserId: string;
    /** Owner display name. */
    ownerName: string;
}

export interface CreateIsolatedTenantOptions {
    /**
     * A live `APIRequestContext`. If omitted, an ephemeral one is
     * created against `process.env.URL` (or the Playwright
     * `baseURL`) and disposed inside this call. Specs inside a
     * Playwright test should pass `request` from the test fixture
     * so cookies / session state stay coherent with the rest of
     * the spec.
     */
    request?: APIRequestContext;
    /**
     * Optional base URL override. Defaults to `process.env.URL`
     * then `'http://localhost:3006'` (matches the Playwright
     * config's webServer port).
     */
    baseURL?: string;
    /**
     * Friendly prefix used in the generated org/user names for
     * easier log-grepping. Sanitised to `[a-z0-9-]`. Defaults to
     * `'iso'`.
     */
    namePrefix?: string;
}

const DEFAULT_BASE_URL = 'http://localhost:3006';

function generateOwnerPassword(): string {
    // Strong entropy + mixed character classes so the password
    // policy AND the HIBP screen at /api/auth/register accept it.
    // 32 hex chars = 128 bits + a fixed mixed-case prefix.
    return `Iso!${randomBytes(16).toString('hex')}`;
}

function sanitisePrefix(prefix: string): string {
    const cleaned = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '');
    return cleaned.length > 0 ? cleaned : 'iso';
}

/**
 * Provision a fresh tenant + OWNER user dedicated to a single spec
 * (or describe block). Returns the credentials and tenant slug so
 * the spec can authenticate and navigate without depending on any
 * shared seed state.
 *
 * Usage:
 * ```ts
 * import { test } from '@playwright/test';
 * import { createIsolatedTenant, signInAs } from './e2e-utils';
 *
 * test.describe('feature X with isolated state', () => {
 *     test.beforeEach(async ({ page, request }) => {
 *         const tenant = await createIsolatedTenant({ request });
 *         await signInAs(page, tenant);
 *         // page is now at /t/<slug>/dashboard
 *     });
 * });
 * ```
 */
export async function createIsolatedTenant(
    options: CreateIsolatedTenantOptions = {},
): Promise<IsolatedTenantCredentials> {
    const baseURL =
        options.baseURL ?? process.env.URL ?? DEFAULT_BASE_URL;
    const prefix = sanitisePrefix(options.namePrefix ?? 'iso');
    // Truncate to keep the resulting slug under Prisma's 80-char limit
    // and visually scannable. 12 chars of a UUIDv4 = 48 bits — well
    // beyond what the per-millisecond tenant-create rate could ever
    // collide on.
    const id = randomUUID().replace(/-/g, '').slice(0, 12);

    const ownerEmail = `${prefix}-${id}@e2e.test`;
    const ownerName = `${prefix} ${id}`;
    const orgName = `${prefix} ${id}`;
    const ownerPassword = generateOwnerPassword();

    // Use the caller's request context if supplied so it shares
    // cookies / fixtures with the rest of the test; otherwise spin
    // one up and dispose it inside this call.
    const request =
        options.request ?? (await playwrightRequest.newContext({ baseURL }));
    const ownsRequest = !options.request;

    try {
        const res = await request.post('/api/auth/register', {
            data: {
                action: 'register',
                email: ownerEmail,
                password: ownerPassword,
                name: ownerName,
                orgName,
            },
            failOnStatusCode: false,
        });
        if (!res.ok()) {
            const body = await res.text();
            throw new Error(
                `createIsolatedTenant: /api/auth/register failed ` +
                    `(status ${res.status()}): ${body.slice(0, 400)}`,
            );
        }
        const json = (await res.json()) as {
            user: { id: string; email: string; name: string };
            tenant: { id: string; name: string; slug: string };
        };
        if (!json?.tenant?.slug) {
            throw new Error(
                'createIsolatedTenant: register response missing tenant.slug — ' +
                    'check src/app/api/auth/register/route.ts response shape.',
            );
        }
        // Track for global-teardown — appended even on a partially
        // failing test so the cleanup phase reclaims rows whose owning
        // test errored mid-flow.
        appendTenantToTracker({
            tenantId: json.tenant.id,
            tenantSlug: json.tenant.slug,
            ownerUserId: json.user.id,
            createdAt: new Date().toISOString(),
        });

        return {
            tenantSlug: json.tenant.slug,
            tenantId: json.tenant.id,
            tenantName: json.tenant.name,
            ownerEmail: json.user.email,
            ownerPassword,
            ownerUserId: json.user.id,
            ownerName: json.user.name,
        };
    } finally {
        if (ownsRequest) {
            await request.dispose().catch(() => undefined);
        }
    }
}

/**
 * Sign in via the credentials form using the provided owner
 * credentials and verify the URL settled on `/t/<slug>/dashboard`.
 *
 * Designed as the natural follow-up to `createIsolatedTenant` —
 * the credentials passed in are typically the factory's return
 * value. Returns the resolved tenant slug for callers that didn't
 * already capture it.
 */
export async function signInAs(
    page: Page,
    credentials: { ownerEmail: string; ownerPassword: string; tenantSlug?: string },
): Promise<string> {
    const slug = await loginAndGetTenant(page, {
        email: credentials.ownerEmail,
        password: credentials.ownerPassword,
    });
    if (credentials.tenantSlug && slug !== credentials.tenantSlug) {
        throw new Error(
            `signInAs: signed in but landed on tenant '${slug}', expected ` +
                `'${credentials.tenantSlug}'. Likely cause: the user has ` +
                `additional memberships and the JWT's default tenantSlug ` +
                `differs from what createIsolatedTenant returned.`,
        );
    }
    return slug;
}

/**
 * Open the journal create-entry modal and wait until its LAZY CHUNK has
 * actually landed, so a caller may safely cut the network next.
 *
 * ## Why this is a helper and not two lines in each spec (#730)
 *
 * Both offline journal specs open this modal online "so its lazy chunk lands",
 * then go offline. Both waited on `#journal-entry-title` — the plain title
 * `<input>` — which is the WRONG element. The modal's lazy chunk is
 * `RichTextEditor`:
 *
 * ```ts
 * const RichTextEditor = dynamic(
 *     () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
 *     { ssr: false, loading: () => <SkeletonCard lines={4} /> },
 * );
 * ```
 *
 * It renders a skeleton while loading, so the title input is visible LONG
 * BEFORE the ~200KB Tiptap/ProseMirror chunk arrives. Cutting the network in
 * that window fails the fetch, and `ChunkLoadError` breaks the render pass the
 * assertions later depend on.
 *
 * Measured on main, twice, before this existed:
 *
 * ```
 * 95ccd2eb  mobile-android  ChunkLoadError: Loading chunk 78301 failed
 * 09cfd8a5  mobile-iphone   ChunkLoadError: Loading chunk 78301 failed
 * ```
 *
 * Same chunk both times, on different projects — a race, not a loaded runner.
 *
 * `data-testid="rich-text-editor"` sits on the Card the REAL component renders
 * (`RichTextEditor.tsx:227`); `SkeletonCard` carries no such attribute. So its
 * visibility is exactly the signal "the chunk resolved and mounted", which the
 * title input never was.
 */
export async function openJournalEntryModalWarm(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Add entry' }).click();
    await expect(page.locator('#journal-entry-title')).toBeVisible();
    // THE LOAD-BEARING WAIT. Do not replace this with the title input, and do
    // not delete it as redundant — it is the only assertion here that proves
    // the lazy chunk is no longer in flight.
    await expect(page.getByTestId('rich-text-editor')).toBeVisible();
}
