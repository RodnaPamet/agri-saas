/**
 * Shared E2E test utilities.
 *
 * Centralises login, navigation, and retry logic so every spec file
 * benefits from the same cold-start / net-error resilience.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
// `type Request` explicitly: without it `Request` resolves to the DOM global,
// which has no `.failure()` — and the DOM one is structurally close enough
// that the mistake would surface as a confusing error rather than a missing
// import.
import {
    expect,
    type APIRequestContext,
    type Page,
    type Locator,
    type Request,
} from '@playwright/test';

import prisma from '@/lib/prisma';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { hashPassword } from '@/lib/auth/passwords';
import { formatDetailPaintState } from './detail-paint-state';
import { TERMS_VERSION } from '@/lib/legal/terms';

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
            // These two are SURFACED, not silenced — see #748. The
            // suppression below was justified as "the browser's automatic
            // console log for any subresource that doesn't return 2xx", and
            // for `Failed to load resource` that holds. It does NOT hold for
            // these two: on the entity-detail-layout:24 failures the
            // navigation RSC request returned 200 with a complete 1913-byte
            // body (measured from the trace of run 35452167058), so a
            // "Failed to fetch RSC payload" there is not the non-2xx case the
            // exemption was written for — it is the failure itself, dropped on
            // the floor before anyone could read it.
            //
            // Logged under a distinct prefix rather than promoted to an error,
            // so the genuinely benign occurrences stay greppable noise instead
            // of failing unrelated specs.
            if (text.includes('Failed to fetch RSC payload') || text.includes('ClientFetchError')) {
                console.log('BROWSER CONSOLE (suppressed, see #748):', text);
                return;
            }
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
    // BARE on purpose. `<main>` comes from `AppShell`
    // (src/components/layout/AppShell.tsx:237), which `/login` does not
    // mount — there is no `main` landmark on that page to scope to
    // (#1516).
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

    // Verify the page actually rendered — reload if the server was still
    // compiling.
    //
    // This looked for `aside` until #996, and `aside` is the AppShell SIDEBAR,
    // declared `hidden md:flex` (AppShell.tsx:200). Every mobile Playwright
    // project runs below `md`, so the probe was false on all three attempts,
    // the loop ran to exhaustion, and the helper returned having verified
    // NOTHING — on exactly the viewport where a half-rendered page is most
    // likely. Operator mode renders no sidebar at all, so it could not pass
    // for the MECHANISATOR persona on ANY viewport either.
    //
    // `main` is rendered unconditionally by AppShell (line 228, outside every
    // `!operator` branch), so it holds for every persona and every width. The
    // bottom tab bar would NOT do — it is `variant === 'tenant' && !operator`.
    let renderRetries = 3;
    let rendered = false;
    while (renderRetries > 0) {
        // WAIT, do not sample. `isVisible()` answers instantly, so a page
        // that renders a second later reads as "not rendered". That was
        // harmless while the probe targeted `aside` and could never succeed
        // anyway; now that exhaustion THROWS, an instantaneous probe would
        // trade one flake for another.
        rendered = await page
            .locator('main')
            .waitFor({ state: 'visible', timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
        if (rendered) break;
        renderRetries--;
        if (renderRetries > 0) {
            // RE-NAVIGATE, do not wait for the network. Two swallowed
            // `networkidle` waits used to stand here, and neither could
            // condition anything:
            //
            //   - the first waited on a page we are about to navigate AWAY
            //     from, so whatever it settled was discarded a line later;
            //   - the second ran before a `main` probe that already auto-waits
            //     10s for exactly the condition being retried.
            //
            // Both were unbounded, so each could spend the full 30s default
            // before `.catch(() => {})` discarded the timeout without a word.
            // Two retries x two waits is up to 120s of silent dead wall clock
            // on a login that is already failing — #748's "swallowed
            // networkidle" half, in the one helper every spec routes through.
            //
            // `safeGoto` is the robust part (5 attempts, 60s, domcontentloaded);
            // the `waitFor({ state: 'visible' })` above is the real condition.
            await safeGoto(page, `/t/${slug}/dashboard`, { waitUntil: 'domcontentloaded' });
        }
    }

    // Loudly, not silently. The old loop fell through on exhaustion, so a
    // genuinely unrendered page proceeded exactly like a rendered one and the
    // failure surfaced later, somewhere else, as a mystery. A check that
    // cannot fail is not a check.
    if (!rendered) {
        throw new Error(
            `Logged in as ${slug} but <main> never rendered after 3 attempts at ` +
                `/t/${slug}/dashboard. The page did not render — failing here rather ` +
                `than letting the next assertion report it as its own problem.`,
        );
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

        // An auto-waiting probe, not `networkidle` + an instant `isVisible()`.
        // `isVisible()` answers "is it visible in this exact millisecond", so
        // the blanket network wait above it was not redundant — it was the
        // only thing giving the page time, and it still raced the check it was
        // protecting. `waitFor` returns the moment the selector appears and
        // costs nothing when it is already there.
        //
        // This is the helper's hot path: `workers: 1`, so every second saved
        // here comes straight off the shard's wall clock, once per call site.
        const rendered = await page
            .locator(contentSelector)
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 })
            .then(() => true)
            .catch(() => false);

        if (rendered) {
            await waitForHydration(page, '[data-hydrated], main').catch(() => {});
            return;
        }
        attempts--;
        // No sleep between attempts: the 15s probe above already gave the page
        // far longer than the 3s that used to sit here, and a re-navigation is
        // the only thing that recovers a dev-server 500 anyway.
    }

    // Loudly, not silently — the same correction `loginAndGetTenant` above
    // already carries, which this function was missed by. It is named
    // *Verify*, and on exhaustion it returned exactly like a success: a page
    // that never rendered went on to fail somewhere else, as somebody else's
    // assertion. A check that cannot fail is not a check.
    throw new Error(
        `gotoAndVerify: ${url} never rendered \`${contentSelector}\` after ` +
            `${maxAttempts} attempts. Failing here rather than letting the next ` +
            `assertion report this as its own problem.`,
    );
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
    const tenantSlug = `${prefix}-${id}`;

    // Created through `createTenantWithOwner` IN PROCESS, not over HTTP.
    //
    // This used to POST `/api/auth/register`, the one route that made a user
    // and a tenant in a single call. #1376 retired it, and no surviving HTTP
    // path replaces it for a fixture's purposes: `register/start` issues an
    // emailed code this process cannot read, and `POST /api/me/farms` is gated
    // on `social.farm-registration`, which is OFF in E2E — so driving the real
    // signup flow would mean either bypassing verification anyway or turning a
    // product flag on to set up unrelated tests.
    //
    // Calling the usecase directly is also the better shape: a fixture's job
    // is to put the database in a known state, not to exercise the signup UX.
    // The specs that care about signup test it explicitly. And this is the
    // same function the platform-admin bootstrap route calls, so the rows it
    // writes are the rows production writes — tenant, OWNER membership and
    // onboarding, in one transaction.
    //
    // `options.request` is still accepted so no call site changes, and is no
    // longer used: there is no HTTP request left to share a cookie jar with.
    const created = await createTenantWithOwner({
        name: orgName,
        slug: tenantSlug,
        ownerEmail,
        requestId: `e2e-${id}`,
    });

    // The usecase creates the owner with no credential, because its production
    // callers invite people rather than hand out passwords. `signInAs` drives
    // the real credentials form, so the fixture supplies what that needs: a
    // password hash, and a verified address (credentials login refuses an
    // unverified one, which is the P3.5b behaviour and correct).
    await prisma.user.update({
        where: { id: created.ownerUserId },
        data: {
            name: ownerName,
            passwordHash: await hashPassword(ownerPassword),
            emailVerified: new Date(),
            // Consent (P3.1 / #1376). Without it every isolated-tenant spec
            // is held at `/accept-terms` by the Edge gate — which is the gate
            // working, not a bug. A FIXTURE may be stamped; a real user with a
            // null column is held and asked, which is the point.
            acceptedTermsAt: new Date(),
            acceptedTermsVersion: TERMS_VERSION,
        },
    });

    // Track for global-teardown — appended even when the owning test errors
    // mid-flow, so cleanup still reclaims the rows.
    appendTenantToTracker({
        tenantId: created.tenant.id,
        tenantSlug: created.tenant.slug,
        ownerUserId: created.ownerUserId,
        createdAt: new Date().toISOString(),
    });

    return {
        tenantSlug: created.tenant.slug,
        tenantId: created.tenant.id,
        tenantName: created.tenant.name,
        ownerEmail,
        ownerPassword,
        ownerUserId: created.ownerUserId,
        ownerName,
    };
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
 * Wait until the field page's lazily-imported map has actually mounted.
 *
 * `OfflineFieldPanel` renders `MapCanvas` through `dynamic(… ssr: false)`, and
 * the controls a spec interacts with — the per-line Done buttons — sit BELOW
 * it and become visible without it. So waiting on a Done button proves the
 * page rendered, not that the map chunk arrived, and a spec that then cuts the
 * network fails that fetch with a ChunkLoadError (#732).
 *
 * `role="group"` with the parcel-map label is MapCanvas's own root, so it
 * exists only once the chunk has landed. Scoped to `main` because a Next
 * streaming duplicate of the page can otherwise match twice.
 */
export async function waitForFieldMapWarm(page: Page): Promise<void> {
    await expect(
        page.getByRole('main').getByRole('group', { name: /^Parcel map/ }),
    ).toBeVisible({ timeout: 30_000 });
}

/**
 * Open «Нов запис» and drive BOTH steps of the treatment form while ONLINE,
 * stopping at the parcel list with the map chunk landed — the state an offline
 * spec may safely cut the network in. Returns the first parcel's checkbox.
 *
 * ## Why a helper and not two lines per spec (#730, carried forward)
 *
 * This replaces `openJournalEntryModalWarm`, which opened the free-form note
 * «Нов запис» used to show. That helper existed because both offline journal
 * specs waited on `#journal-entry-title` — visible LONG before the ~200KB
 * Tiptap chunk behind it arrived — and cutting the network in that window
 * produced a `ChunkLoadError` that broke the render the later assertions
 * depend on. Measured on main twice before it existed:
 *
 * ```
 * 95ccd2eb  mobile-android  ChunkLoadError: Loading chunk 78301 failed
 * 09cfd8a5  mobile-iphone   ChunkLoadError: Loading chunk 78301 failed
 * ```
 *
 * The form changed; the trap did not. Here the heavy chunk is MapLibre
 * (`MapCanvas` through `dynamic(… ssr: false)`), and the parcel CHECKBOXES
 * render from data that has already arrived while it is still downloading. So
 * the checkbox is this form's `#journal-entry-title`, and the load-bearing
 * wait is the map's own `role="group"` root — the same signal
 * `waitForFieldMapWarm` uses for the field page.
 *
 * It cannot simply call that helper: this map lives inside a Modal, which
 * renders through `Dialog.Portal` / `Drawer.Portal`, so it is mounted OUTSIDE
 * `<main>` and the `getByRole('main')` scoping there would never resolve it
 * (#1516).
 *
 * ## Why every READ happens here, online
 *
 * Step two's crop and parcel lists come from `/parcels/by-crop`, which the
 * persistent SWR cache does not write — `PERSISTABLE_PATHS` allowlists
 * `/journal`, `/farm-tasks`, `/locations` and `/exchange/listings`, and none of
 * this form's reads is among them (#1845). So this warm-up matches what a real
 * device must also do, rather than compensating for an empty test fixture.
 */
export async function openTreatmentFormWarm(
    page: Page,
    opts: { product: string; crop?: string },
): Promise<Locator> {
    const crop = opts.crop ?? 'Wheat';
    await page.getByRole('button', { name: 'Add entry' }).click();

    // ── Step one ───────────────────────────────────────────────────────
    // BARE locators on purpose. These ids belong to a MODAL, and the Modal
    // primitive renders through `Dialog.Portal` / `Drawer.Portal`, so its
    // content is mounted OUTSIDE `<main>` and `getByRole('main')` would never
    // resolve it (#1516).
    await expect(page.locator('#treatment-product')).toBeVisible();
    await page.locator('#treatment-product').click();
    await page.getByRole('option', { name: new RegExp(opts.product) }).click();
    await page.locator('#treatment-dose').fill('2');
    await page.locator('#treatment-unit').click();
    // By position: the dose units are global seed data, and no spec should
    // assert which symbol that seed happens to use.
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Next' }).click();

    // ── Step two ───────────────────────────────────────────────────────
    await page.locator('#treatment-crop').click();
    await page.getByRole('option', { name: new RegExp(crop) }).click();
    const parcel = page.locator('#treatment-parcel-list').getByRole('checkbox').first();
    await expect(parcel).toBeVisible();

    // THE LOAD-BEARING WAIT. Do not replace it with the parcel checkbox above,
    // and do not delete it as redundant — it is the only assertion here that
    // proves MapLibre's lazily-imported chunk is no longer in flight. The
    // checkboxes render from data that has already arrived, while the ~200KB
    // map chunk is still downloading, so waiting on them is the same mistake
    // `#journal-entry-title` was for the form this replaced (#730).
    await expect(page.getByRole('group', { name: /^Parcel map/ })).toBeVisible();

    return parcel;
}

/**
 * Wait out a client-side route transition, budgeting each half for what it
 * actually does.
 *
 * A Next app-router navigation updates the URL BEFORE the new route's RSC
 * payload arrives. So `waitForURL` returns early and consumes almost none of
 * its timeout, while whatever is asserted next pays for the entire
 * transition out of its own budget. A spec that gives each half 15s reads as
 * a 30s allowance and behaves as 15s for the part that takes the time.
 *
 * That is #1076: `entity-detail-layout` needed retries on essentially every
 * run and finally exhausted them, blocking an unrelated dependency bump.
 * Measured on a green CI run — attempts 1 and 2 timed out at 15s; retry 2
 * completed the WHOLE test in 4.2s. A cold first render, fast once warm.
 * Not a hang, and not a product defect.
 *
 * ── Why both waits, and in this order ──
 *
 * The URL wait is kept because it DIAGNOSES. A double-click on an unhydrated
 * row is two no-ops, and that surfaces as a URL that never changed — a
 * different fault from a page that navigated and did not paint, and the
 * caller should not have to tell them apart from one timeout. It keeps a
 * short budget because the failures this fixes all got PAST it.
 *
 * The content wait gets the generous one: 30s, matching
 * `waitForFieldMapWarm`, the repo's existing budget for a genuinely slow
 * first load. A real hang still fails, 15 seconds later than before, which
 * is the cheaper of the two errors.
 */
export async function expectRouteTransition(
    page: Page,
    opts: {
        content: Locator;
        url: RegExp;
        navTimeout?: number;
        paintTimeout?: number;
        /**
         * Row count observed BEFORE the gesture that should have navigated.
         *
         * The #1076 capture showed `rows: 1` at failure against a seed of
         * four, and `rowSelection` non-empty while no rendered row was
         * checked — i.e. the selected row had left the table. Whether the set
         * SHRANK during the gesture or was already 1 when it started is the
         * next fact needed, and only the caller can see the before.
         */
        rowsBefore?: number;
    },
): Promise<void> {
    // `waitUntil: 'domcontentloaded'`, not Playwright's default of `'load'`.
    //
    // This helper was the ONLY place in the suite waiting for the full load
    // event, and it got there by omission rather than by decision: 46 call
    // sites pass `domcontentloaded` deliberately, one passes `networkidle`,
    // one passes `load`, and this passed nothing. `safeGoto` defaults to
    // `domcontentloaded` too.
    //
    // Measured on run 36900688054 (#1076): both of this helper's consumer
    // files failed in one shard, at its two consecutive waits —
    // `data-table-platform:188` here with `page.waitForURL: Timeout 15000ms
    // exceeded. waiting for navigation until "load"`, and
    // `entity-detail-layout:24` on the line below. 100% of its call sites,
    // and the two were on DIFFERENT routes (`/farm-tasks/{id}` and
    // `/assets/{id}`), so it is not one slow page.
    //
    // This is NOT expected to fix both. A locator-visibility wait does not
    // care about the navigation lifecycle, and the exhaustion asymmetry
    // (`data-table` recovered on attempt 2, `entity-detail` exhausted all
    // three) points at two costs of different sizes. The prediction is
    // recorded on #1076 before the change: this one fixes the URL wait and
    // leaves the paint wait open.
    // On failure, append the state that distinguishes the live #1076
    // candidates, because the PLAYWRIGHT ARTIFACT IS NOT KEPT for an attempt
    // that later passes on retry — the upload is conditioned on the shard's
    // outcome (#1492). The job LOG is kept, including this message, so a
    // thrown error is the only channel that survives a 1-in-3 flake.
    //
    // That asymmetry is why six hypotheses have been refuted on #1076 without
    // reaching a cause: the one attempt worth reading is the one CI discards,
    // and the single trace that ever diagnosed it existed only because that
    // run happened to fail all three attempts.
    //
    // What is collected answers the questions the measured facts leave open:
    // one selection toggle took effect, the second click reached nothing, and
    // the selection ended cleared — without the row node being replaced.
    // Armed BEFORE the URL wait, because the evidence it gathers cannot be
    // recovered afterwards. A Resource Timing entry is created on RESPONSE
    // END, so an aborted fetch leaves none — `getEntriesByType('resource')`
    // inside the page is structurally blind to the one event that would
    // explain a navigation that rolls back, and that is the live hypothesis
    // on #1862. Playwright's `requestfailed` sees it.
    const failedRequests: string[] = [];
    const onRequestFailed = (req: Request): void => {
        failedRequests.push(
            `${req.method()} ${req.url().slice(-100)} — ${req.failure()?.errorText ?? 'unknown'}`,
        );
    };
    page.on('requestfailed', onRequestFailed);
    try {
        await page.waitForURL(opts.url, {
            timeout: opts.navTimeout ?? 15_000,
            waitUntil: 'domcontentloaded',
        });
    } catch (err) {
        page.off('requestfailed', onRequestFailed);
        // Reported on THIS half too, not just the paint half. Attaching
        // evidence to only one branch is the exact mistake this file records
        // having made once already — the diagnostics went on the `waitForURL`
        // catch while the paint catch produced nothing, and six hypotheses
        // were refuted without reaching a cause. An aborted request explains
        // a URL that never changed just as readily as one that rolls back.
        throw new Error(
            `${(err as Error).message}\n` +
                `--- #1076 diagnostics (the artifact for this attempt is not kept) ---\n` +
                `  expected url   : ${String(opts.url)}\n` +
                `  failed/aborted requests: ${
                    failedRequests.length === 0
                        ? 'NONE'
                        : `${failedRequests.length}\n    ${failedRequests.slice(-6).join('\n    ')}`
                }\n` +
                (opts.rowsBefore === undefined
                    ? ''
                    : `  rows BEFORE gesture: ${opts.rowsBefore}   <- compare with \`rows\` below;` +
                      ` a DROP means the set changed under the gesture\n`) +
                (await describeListState(page)),
        );
    }
    // The paint wait, and the half that actually fails now (#1076).
    //
    // Measured 2026-10-14 on two independent PRs: three attempts each, all at
    // this line, `element(s) not found` after `waitForURL` had SUCCEEDED. The
    // docblock above predicted exactly that split, and the diagnostics it
    // describes are attached only to the `waitForURL` catch — so the failing
    // half produced no evidence at all, while the stated reason for having a
    // message channel is that the job log survives a flake whose artifact may
    // not. Wired to the other half now too.
    //
    // `describeListState` IS reused here now, conditionally, and the reason it
    // was not is the reason it must be. The note said "a list's rows and
    // selection describe a different page's state" — true only if this failure
    // happens on the detail page, and the CORRECTION below records that it
    // does not: the URL at paint failure is the LIST again.
    //
    // So the two diagnostics that decide this bug — `navigation entries`
    // ("1 means no navigation was ever committed") and `row gestures` ("NONE
    // reached a row" vs a recorded dblclick) — were attached ONLY to the
    // `waitForURL` catch, which is the half that stopped firing. Measured over
    // 19 main runs on 2026-10-20/21: 5 occurrences, every one of them on the
    // paint half, every one reporting neither fact. Instrumentation aimed at
    // the branch that no longer fires is instrumentation that cannot answer
    // the question it was added for.
    //
    // CORRECTED 2026-10-16: the reason given here was "by here the URL wait
    // has passed, so the page is the DETAIL page". That premise is false in
    // exactly the case that fires. Measured twice — 2026-10-15 and
    // 2026-10-16 — the URL at paint failure is the LIST again, with
    // `h1: Farm Assets` and no `entity-detail-*` testid present. The URL wait
    // passing means the URL was the destination at some instant, not that it
    // still is: the transition is ROLLED BACK, not merely unpainted.
    try {
        await expect(opts.content).toBeVisible({ timeout: opts.paintTimeout ?? 30_000 });
    } catch (err) {
        // Back on the list, or genuinely on the detail page that never
        // painted? The answer decides which diagnostics are meaningful, so it
        // is read rather than assumed.
        let rolledBack = false;
        try {
            rolledBack = !opts.url.test(page.url());
        } catch {
            /* a closed page cannot be asked; fall through with the detail view */
        }
        throw new Error(
            `${(err as Error).message}\n` +
                `--- #1076 PAINT-wait diagnostics (the URL wait above SUCCEEDED) ---\n` +
                (opts.rowsBefore === undefined
                    ? ''
                    : `  rows BEFORE gesture: ${opts.rowsBefore}   <- compare with \`rows\` below;` +
                      ` a DROP means the set changed under the gesture\n`) +
                (await describeDetailPaintState(page, opts.content, {
                    expectedUrl: String(opts.url),
                    failedRequests,
                })) +
                (rolledBack
                    ? `  --- the URL ROLLED BACK to a non-matching route, so the list state below is THIS page's ---\n` +
                      (await describeListState(page))
                    : '  (url still matches the destination — list diagnostics omitted as they would describe another page)\n'),
        );
    } finally {
        page.off('requestfailed', onRequestFailed);
    }
}

/**
 * Collect `DetailPaintState` from a page whose detail shell never appeared.
 *
 * Tolerant throughout, for the reason `describeListState` records: this runs on
 * a page that has just failed, and a diagnostic that throws replaces the real
 * error with its own. Every read is inside the one `try`, and a partial result
 * is reported rather than discarded.
 *
 * The per-field reasoning lives in `./detail-paint-state`, next to the type.
 */
async function describeDetailPaintState(
    page: Page,
    content: Locator,
    extra: { expectedUrl?: string; failedRequests?: string[] } = {},
): Promise<string> {
    let contentCount: number | undefined;
    try {
        contentCount = await content.count();
    } catch {
        /* a detached frame cannot be counted; leave it unknown */
    }

    try {
        const inPage = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] as
                | PerformanceNavigationTiming
                | undefined;

            const counts = new Map<string, number>();
            for (const el of Array.from(document.querySelectorAll('[data-testid]'))) {
                const id = el.getAttribute('data-testid');
                if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
            }
            const testids = Array.from(counts.entries())
                .slice(0, 25)
                .map(([id, n]) => (n > 1 ? `${id}×${n}` : id));

            // Resource timings whose name contains this page's own path — i.e.
            // did the route this URL names get fetched at all.
            const path = location.pathname;
            const detailRequests = performance
                .getEntriesByType('resource')
                .filter((e) => e.name.includes(path))
                .map((e) => ({ name: e.name.slice(-90), ms: e.duration }));

            return {
                url: location.href,
                readyState: document.readyState,
                navigationType: nav?.type ?? 'unknown',
                swControlled:
                    typeof navigator !== 'undefined' && 'serviceWorker' in navigator
                        ? navigator.serviceWorker.controller !== null
                        : null,
                h1: Array.from(document.querySelectorAll('h1'))
                    .map((h) => (h.textContent ?? '').trim().slice(0, 60))
                    .filter((t) => t.length > 0),
                testids,
                testidTotal: Array.from(counts.values()).reduce((a, b) => a + b, 0),
                bodyTextLength: document.body?.innerText?.length ?? 0,
                // Next renders its error overlay into this custom element, so
                // its presence means a thrown component rather than a timing
                // problem — a different bug wearing the same symptom.
                nextErrorOverlay: document.querySelector('nextjs-portal') !== null,
                detailRequests,
            };
        });
        return formatDetailPaintState({ ...inPage, contentCount, ...extra });
    } catch (e) {
        // Still print what was gathered outside the page — the locator count
        // alone distinguishes absent from hidden, which is the first question.
        return (
            formatDetailPaintState({ contentCount, ...extra })
            + `\n  (in-page diagnostics unavailable: ${(e as Error).message.slice(0, 80)})`
        );
    }
}

/**
 * A compact snapshot of list-page state, for a failure message.
 *
 * Deliberately NOT an assertion and deliberately tolerant: it runs on a page
 * that has just failed, so every read is wrapped — a diagnostic that throws
 * replaces the real error with its own and destroys the evidence it exists to
 * gather.
 */
/**
 * Record every click and dblclick that reaches a table row, before the gesture.
 *
 * ## Why this and not another DOM read
 *
 * #1076 has had THREE inferences withdrawn, all of them from reading rendered
 * state after the fact. `<DataTable>`'s selection is smoothed on purpose and
 * each indirection has a comment saying so: the toolbar label is a sticky
 * `lastSelectedCount`, the row checkbox is an `isSelected` SNAPSHOT captured at
 * parent-render time, and only the toolbar's `inert` reads live state. Reading
 * paint and reasoning backwards produced a mechanism each time and none of
 * them survived.
 *
 * The fork every remaining hypothesis sits on is about EVENTS, and no amount
 * of reading the DOM afterwards can settle it:
 *
 *   - both clicks hit the same row and the browser never synthesised `dblclick`
 *   - the two clicks had DIFFERENT targets, so `dblclick` fired above the row
 *
 * `MouseEvent.detail` and the target's identity distinguish those directly. So
 * this listens in the capture phase on `document`, which cannot be prevented by
 * a handler and does not change what the page does.
 *
 * Install it BEFORE the gesture; `describeListState` prints what it collected
 * into the failure message, which is the only channel that survives an attempt
 * that later passes on retry (#1493).
 */
export async function instrumentRowGestures(page: Page): Promise<void> {
    await page.evaluate(() => {
        interface Rec { type: string; detail: number; rowKey: string; tag: string }
        const w = window as unknown as { __rowGestures?: Rec[] };
        if (w.__rowGestures) return; // idempotent — a spec may call this twice
        w.__rowGestures = [];
        const describeRow = (el: EventTarget | null): string => {
            const node = el instanceof Element ? el.closest('tr,[role="row"]') : null;
            if (!node) return '(not a row)';
            // The row's own identity: the detail link's href carries the id,
            // which is what `getRowId` keys selection on. Falls back to the
            // first cell's text, which is enough to tell two rows apart.
            const href = node.querySelector('a[href]')?.getAttribute('href') ?? '';
            const id = href.split('/').pop() ?? '';
            return id || (node.textContent ?? '').trim().slice(0, 24) || '(empty row)';
        };
        for (const type of ['click', 'dblclick'] as const) {
            document.addEventListener(
                type,
                (e) => {
                    const me = e as MouseEvent;
                    w.__rowGestures!.push({
                        type,
                        detail: me.detail,
                        rowKey: describeRow(e.target),
                        tag: e.target instanceof Element ? e.target.tagName : '?',
                    });
                },
                true, // CAPTURE — cannot be stopped by a handler on the way down
            );
        }
    });
}

async function describeListState(page: Page): Promise<string> {
    try {
        const snap = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('tbody tr'));
            const checked = document.querySelectorAll(
                '[aria-label="Select row"][data-state="checked"]',
            ).length;
            const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
            // CORRECTED 2026-10-21. The line below used to be
            // `performance.getEntriesByType('navigation').length` with a
            // comment claiming ">1 proves a navigation HAPPENED … ===1 proves
            // none was ever committed". The first half is true and the second
            // is false HERE, which is the worst possible split: that list
            // grows per DOCUMENT navigation, and the thing under test is
            // `router.push` — an App Router client navigation through the
            // History API, which creates no entry at all. So `1` is equally
            // what a SUCCESSFUL row activation looks like, and the capture
            // read "no navigation was ever committed" on every failure
            // regardless of whether one had been.
            //
            // Caught by reasoning about the probe rather than by it failing:
            // it had been reporting `1` on every #1076 capture, and `1` is
            // what it would report if the bug were fixed.
            //
            // The Navigation API DOES observe SPA navigations, and Chromium is
            // the only engine this suite drives. `historyLength` is the
            // fallback and is weaker — a `push` grows it, a `replace` does not
            // — so both are reported and neither is dressed up as proof.
            const nav = (
                window as unknown as { navigation?: { entries(): unknown[] } }
            ).navigation;
            const navs = nav ? nav.entries().length : -1;
            const historyLength = history.length;
            const docNavs = performance.getEntriesByType('navigation').length;
            return {
                url: location.href,
                rowCount: rows.length,
                rowsChecked: checked,
                firstRowText: (rows[0]?.textContent ?? '').trim().slice(0, 60),
                toolbarLabel: (toolbar?.textContent ?? '').trim().slice(0, 40),
                toolbarInert: toolbar?.hasAttribute('inert') ?? null,
                navigationEntries: navs,
                historyLength,
                docNavs,
                activeElement: document.activeElement?.tagName ?? null,
                gestures:
                    (window as unknown as { __rowGestures?: unknown[] })
                        .__rowGestures ?? null,
            };
        });
        return (
            `  url                : ${snap.url}\n` +
            `  rows               : ${snap.rowCount}\n` +
            `  rows CHECKED       : ${snap.rowsChecked}   <- 1 selection toggle leaves 1; a cleared selection leaves 0\n` +
            `  first row          : ${snap.firstRowText}\n` +
            `  selection toolbar  : "${snap.toolbarLabel}" inert=${snap.toolbarInert}   <- label is STICKY (lastSelectedCount), not live\n` +
            `  SPA navigations    : ${
                snap.navigationEntries === -1
                    ? '(no Navigation API)'
                    : `${snap.navigationEntries}   <- Navigation API; >1 means a CLIENT navigation was committed`
            }\n` +
            `  history length     : ${snap.historyLength}   <- a router.push grows this; a replace does not\n` +
            `  document loads     : ${snap.docNavs}   <- >1 means a full page load or RELOAD happened\n` +
            `  activeElement      : ${snap.activeElement}\n` +
            `  row gestures       : ${
                snap.gestures === null
                    ? '(not instrumented — call instrumentRowGestures before the gesture)'
                    : (snap.gestures as Array<Record<string, unknown>>).length === 0
                      ? 'NONE reached a row   <- the clicks never arrived at all'
                      : (snap.gestures as Array<Record<string, unknown>>)
                            .map(
                                (g) =>
                                    `${g.type}(detail=${g.detail}) on ${g.tag} row=${g.rowKey}`,
                            )
                            .join('\n                       ')
            }`
        );
    } catch (e) {
        return `  (diagnostics unavailable: ${(e as Error).message.slice(0, 80)})`;
    }
}

/**
 * Assert a locator resolves to exactly ONE element and that element is visible,
 * holding BOTH in the same observation (#1567).
 *
 * ## The bug this replaces
 *
 * Four call sites had written the barrier as two consecutive statements:
 *
 *     await expect(header).toHaveCount(1, { timeout: 30000 });
 *     await expect(header).toBeVisible();
 *
 * The reasoning above them is right about the mechanism — the App Router keeps
 * the outgoing tree mounted while the incoming one streams in, so both briefly
 * render the same `data-testid` — and right to refuse `.first()`, which would
 * pass just as happily on a page that really did render two.
 *
 * It is wrong that a count assertion SETTLES anything. `toHaveCount(1)`
 * succeeds the moment it observes one, and the transition is not over: the
 * count can go back up. The next statement re-queries and sees two, and
 * `toBeVisible()` on a two-element locator is a strict-mode violation, which
 * fails INSTANTLY rather than retrying.
 *
 * Measured, from attempt 1 of run 38022280789 (`admin-regression.spec.ts:35`):
 *
 *     Error: strict mode violation: getByTestId('page-header-title')
 *     resolved to 2 elements
 *
 * both of them `<h1 …>Administration</h1>`. That is also why the failure took
 * 2.5s in total and so looked like it had happened earlier, in the login or
 * the navigation — #1567's own reading, from the duration alone. A 30s timeout
 * on line 34 is irrelevant when line 35 throws without waiting at all.
 *
 * ## Why `toPass` and not a longer timeout
 *
 * The defect is the WINDOW between the two statements: the invariant is
 * asserted at T and visibility at T+ε, and nothing requires them to describe
 * the same moment. Lengthening either timeout widens the window rather than
 * closing it. `toPass` re-runs both together, so a transient double retries
 * instead of failing, and the one-element invariant is still asserted rather
 * than stepped around.
 *
 * The inner timeouts are deliberately short. They are the cost of ONE
 * observation — a long inner timeout would spend the whole outer budget inside
 * a single attempt and retry nothing.
 *
 * Safe to wrap here because the body is only assertions, which are idempotent
 * reads. `toPass` round a non-idempotent action (a click) deadlocks instead,
 * which is a separate lesson this repo has already paid for.
 */
export async function expectSettledSingle(
    locator: Locator,
    opts: {
        timeout?: number;
        /**
         * What must ALSO hold of the single element, in the same observation as
         * the count. Defaults to visibility, which is what four of the five
         * call sites asserted.
         *
         * Override it rather than adding a second statement after the call —
         * a second statement is the very window this helper exists to close.
         * Give the inner assertion a SHORT timeout for the same reason the
         * defaults are short: it is the cost of one attempt, not of the wait.
         */
        also?: (only: Locator) => Promise<unknown>;
    } = {},
): Promise<void> {
    const also = opts.also ?? ((only: Locator) => expect(only).toBeVisible({ timeout: 1_000 }));
    await expect(async () => {
        await expect(locator).toHaveCount(1, { timeout: 1_000 });
        await also(locator);
    }).toPass({ timeout: opts.timeout ?? 30_000 });
}
