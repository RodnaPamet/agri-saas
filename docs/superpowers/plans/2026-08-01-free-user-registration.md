# Free Self-Service Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built self-service signup flow reachable in production, grant the creator OWNER of their new workspace, make registration atomic, and gate first login on email confirmation without telling a correct-password user their password is wrong.

**Architecture:** No new subsystem. Six focused changes to existing files: the register route (role + atomicity + rate limit), the NextAuth `authorize` callback (surface one actionable failure reason), the login page (post-register state + error copy), and two production env values applied last.

**Tech Stack:** Next.js 16 App Router, NextAuth v4.24.14 (credentials provider), Prisma 7, Jest, Playwright, next-intl.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-01-free-user-registration-design.md` — read it before starting.
- **Every user-facing string goes into BOTH `messages/en.json` AND `messages/bg.json` in the same commit**, with a real Bulgarian translation (never the English pasted in). Enforced by `tests/guardrails/i18n-completeness.test.ts` and `node scripts/i18n-diff.mjs --check`.
- **Never `console.*` in server code.** Use `logger` from `@/lib/observability`.
- **Path alias `@/` maps to `src/`.** Never relative paths across layer boundaries.
- **No raw `process.env`** in new code — add to `src/env.ts` first.
- **Do not widen the `no-auto-join` allowlist.** `src/app/api/auth/register/route.ts` is already listed at `tests/guardrails/no-auto-join.test.ts:57`. This plan changes what that path writes, not how many paths exist.
- **HIBP is mandatory** on any password-accepting route (Epic E.4). The existing `checkPasswordAgainstHIBP` call in the register route must survive every refactor — `tests/guardrails/hibp-coverage.test.ts` fails CI otherwise.
- **Node 22** (`nvm use 22`). `npm ci` must have been run.
- Run the full guardrail sweep before pushing: `npx jest tests/guardrails tests/guards`.

## Why the E2E suite is safe from these changes

`tests/e2e/fixtures.ts::createIsolatedTenant` calls `POST /api/auth/register` for **every mutating test**. Two consequences the implementer must keep in mind:

1. **The register response shape is load-bearing.** It returns `{ user, tenant: { id, name, slug }, emailVerificationRequired }`. Task 2 rewrites the route body — the response shape must come out byte-identical or the whole E2E suite breaks.
2. **The new rate limit will not throttle E2E.** `isRateLimitBypassed()` (`src/lib/security/rate-limit-middleware.ts:315`) returns true when `AUTH_TEST_MODE=1` **or** `NODE_ENV=test`. The Playwright webserver sets `AUTH_TEST_MODE=1`.

Isolated tenants become OWNER instead of ADMIN after Task 1. OWNER is a strict superset of ADMIN, so no existing assertion should lose a permission.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/app/api/auth/register/route.ts` | Modify | Role → OWNER; wrap writes in a transaction; add onboarding row + audit; apply rate limit |
| `src/lib/security/rate-limit.ts` | Modify | New `SIGNUP_LIMIT` preset with its own threat model |
| `src/auth.ts` | Modify (`authorize`, ~line 313-328) | Surface `email_not_verified` distinctly; keep every other reason collapsed |
| `src/app/login/page.tsx` | Modify | "Check your inbox" state; map the new login error |
| `messages/en.json`, `messages/bg.json` | Modify | Three new `login.*` strings |
| `tests/unit/register-route.test.ts` | Create | Route-level unit tests (OWNER, transaction, HIBP survival) |
| `tests/unit/auth-authorize-reason.test.ts` | Create | `authorize` surfaces one reason, collapses the rest |
| `tests/integration/register-atomicity.test.ts` | Create | Real-DB rollback proof |
| `deploy/env.prod.example` | Modify | Document the two production flags |

---

### Task 1: Registration grants OWNER, not ADMIN

**Files:**
- Modify: `src/app/api/auth/register/route.ts:116`
- Test: `tests/unit/register-route.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the register route creates a `TenantMembership` with `role: 'OWNER'`. Task 2 preserves this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/register-route.test.ts`. Mirrors the hand-rolled mock style of `tests/unit/credentials-auth.test.ts` — mock only what the route reaches for.

```ts
/**
 * Unit tests for POST /api/auth/register.
 *
 * The route is the ONLY self-service tenant-membership creation path
 * (allowlisted in tests/guardrails/no-auto-join.test.ts). These tests pin
 * the two properties that make it safe: the creator owns the workspace
 * they just created, and a partial failure leaves nothing behind.
 *
 * bcrypt is CPU-heavy under the parallel full-suite run; 60s headroom.
 */
jest.setTimeout(60_000);

const mockUserCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockMembershipCreate = jest.fn();
const mockOnboardingCreate = jest.fn();
const mockTenantCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            create: (...a: unknown[]) => mockUserCreate(...a),
        },
        tenant: { create: (...a: unknown[]) => mockTenantCreate(...a) },
        tenantMembership: { create: (...a: unknown[]) => mockMembershipCreate(...a) },
        tenantOnboarding: { create: (...a: unknown[]) => mockOnboardingCreate(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

jest.mock('@/lib/security/tenant-key-manager', () => ({
    __esModule: true,
    createTenantWithDek: jest.fn(async (data: { name: string; slug: string }) => ({
        id: 'tenant-1',
        name: data.name,
        slug: data.slug,
    })),
}));

jest.mock('@/lib/security/password-check', () => ({
    __esModule: true,
    checkPasswordAgainstHIBP: jest.fn(async () => ({ breached: false })),
}));

jest.mock('@/lib/auth/email-verification', () => ({
    __esModule: true,
    issueEmailVerification: jest.fn(async () => undefined),
}));

jest.mock('@/lib/auth', () => ({
    __esModule: true,
    signToken: jest.fn(() => 'signed-token'),
}));

import { POST } from '@/app/api/auth/register/route';

function registerRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', ...body }),
    });
}

const VALID = {
    email: 'founder@example.com',
    password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
    name: 'Founder',
    orgName: 'Acme Farms',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'user-1', email: VALID.email, name: VALID.name });
    mockMembershipCreate.mockResolvedValue({ role: 'OWNER' });
    mockTenantCreate.mockResolvedValue({ id: 'tenant-1', slug: 'acme-farms-x', name: 'Acme Farms' });
    mockOnboardingCreate.mockResolvedValue({});
    // Default: run the transaction callback against the mocked client.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
            user: { create: mockUserCreate },
            tenant: { create: mockTenantCreate },
            tenantMembership: { create: mockMembershipCreate },
            tenantOnboarding: { create: mockOnboardingCreate },
        }),
    );
});

it('grants the registering user OWNER of the workspace they created', async () => {
    const res = await POST(registerRequest(VALID) as never, {} as never);
    expect(res.status).toBe(200);

    expect(mockMembershipCreate).toHaveBeenCalledTimes(1);
    const arg = mockMembershipCreate.mock.calls[0][0] as { data: { role: string } };
    expect(arg.data.role).toBe('OWNER');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest tests/unit/register-route.test.ts -t 'grants the registering user OWNER'
```

Expected: FAIL — `expect(received).toBe('OWNER')` with received `"ADMIN"`.

(If it instead fails on a missing mock, add the missing module to the mock list above and re-run — the assertion must be the thing that fails.)

- [ ] **Step 3: Make the change**

In `src/app/api/auth/register/route.ts`, at the `tenantMembership.create` call (~line 112-118):

```ts
    // Create TenantMembership (sole source of role + tenant binding).
    //
    // OWNER, not ADMIN. Epic 1 made OWNER strictly superior — it alone
    // carries `admin.tenant_lifecycle` and `admin.owner_management`
    // (see src/lib/permissions.ts). A self-service tenant created with
    // an ADMIN-only member would be born with ZERO owners, so nobody
    // could ever transfer ownership, rotate the tenant DEK, or delete
    // the workspace. The `tenant_membership_last_owner_guard` trigger
    // cannot catch this: it fires on UPDATE/DELETE that would drop a
    // tenant to zero owners, and is blind to one that starts there.
    const membership = await prisma.tenantMembership.create({
        data: {
            tenantId: tenant.id,
            userId: user.id,
            role: 'OWNER',
        },
    });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest tests/unit/register-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm no guardrail regressed**

```bash
npx jest tests/guardrails/no-auto-join.test.ts tests/guardrails/hibp-coverage.test.ts tests/guardrails/membership-identity.test.ts
```

Expected: PASS (3 suites).

- [ ] **Step 6: Commit**

```bash
git add tests/unit/register-route.test.ts src/app/api/auth/register/route.ts
git commit -m "fix(auth): give the self-service tenant creator OWNER, not ADMIN

A tenant created through /api/auth/register was born with zero OWNERs,
so no member could ever transfer ownership, rotate the tenant DEK, or
delete the workspace — those permissions resolve to false for ADMIN.
The last-owner DB trigger cannot catch it: it guards UPDATE/DELETE that
would drop a tenant to zero owners, not one that starts there."
```

---

### Task 2: Make registration atomic

**Files:**
- Modify: `src/app/api/auth/register/route.ts:92-125`
- Test: `tests/unit/register-route.test.ts` (extend), `tests/integration/register-atomicity.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `role: 'OWNER'`.
- Produces: the route's JSON response shape is UNCHANGED — `{ user: { id, email, name, role }, tenant: { id, name, slug }, emailVerificationRequired }`. `tests/e2e/fixtures.ts` depends on `tenant.slug`.

**Background the implementer needs:** `createTenantWithDek` uses the singleton prisma client and cannot join a transaction (`src/lib/security/tenant-key-manager.ts:194-206`). `createTenantWithOwner` hit this exact wall and solved it by calling `generateAndWrapDek()` and creating the tenant row on the `tx` client — see `src/app-layer/usecases/tenant-lifecycle.ts:79-116`. Copy that approach. The consequence is the DEK cache is not primed; that is accepted and already the case for the platform-admin path (it unwraps on first use).

**Hash the password BEFORE opening the transaction.** bcrypt at cost 12 takes hundreds of milliseconds; holding a DB transaction open across it would pin a pooled connection for the duration, and `DATABASE_URL` points at PgBouncer in transaction mode where that is especially costly.

- [ ] **Step 1: Write the failing unit test**

Append to `tests/unit/register-route.test.ts`:

```ts
it('writes tenant, user, membership and onboarding inside ONE transaction', async () => {
    await POST(registerRequest(VALID) as never, {} as never);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Every row-creating call must have happened via the tx client passed
    // into $transaction, not the singleton — asserted by the fact that our
    // $transaction mock is what routes them.
    expect(mockTenantCreate).toHaveBeenCalledTimes(1);
    expect(mockUserCreate).toHaveBeenCalledTimes(1);
    expect(mockMembershipCreate).toHaveBeenCalledTimes(1);
    expect(mockOnboardingCreate).toHaveBeenCalledTimes(1);
});

it('returns the response shape tests/e2e/fixtures.ts depends on', async () => {
    const res = await POST(registerRequest(VALID) as never, {} as never);
    const body = await res.json();

    expect(body.tenant).toEqual({ id: 'tenant-1', name: 'Acme Farms', slug: 'acme-farms-x' });
    expect(body.user).toEqual(
        expect.objectContaining({ id: 'user-1', email: VALID.email, role: 'OWNER' }),
    );
    expect(body).toHaveProperty('emailVerificationRequired');
});

it('still screens the password against HIBP', async () => {
    const { checkPasswordAgainstHIBP } = jest.requireMock('@/lib/security/password-check');
    (checkPasswordAgainstHIBP as jest.Mock).mockResolvedValueOnce({ breached: true });

    const res = await POST(registerRequest(VALID) as never, {} as never);

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx jest tests/unit/register-route.test.ts
```

Expected: the transaction test FAILS (`mockTransaction` called 0 times — the route still writes directly). The response-shape and HIBP tests should already PASS; they are regression pins for the refactor.

- [ ] **Step 3: Rewrite the registration body**

Replace `src/app/api/auth/register/route.ts` lines ~92-125 (from the `// Create tenant` comment through the `issueEmailVerification` call) with:

```ts
    // Slug is derived from the org name plus a base36 timestamp so two
    // orgs with the same name don't collide.
    const slug =
        String(orgName)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') +
        '-' +
        Date.now().toString(36);

    // Hash BEFORE the transaction. bcrypt at cost 12 costs hundreds of
    // milliseconds; holding a transaction open across it pins a pooled
    // connection, and DATABASE_URL points at PgBouncer in transaction
    // mode where that is expensive.
    const passwordHash = await hashPassword(password);

    // One transaction for all four rows. Previously these were four
    // unguarded sequential writes: a failure between the user insert and
    // the membership insert left a real User with no membership —
    // stranded on /no-tenant forever, and unable to retry because the
    // email was now taken (the duplicate check above returns 409).
    //
    // createTenantWithDek cannot join a transaction (it uses the
    // singleton client), so we create the tenant row on `tx` with a
    // freshly wrapped DEK — the same approach createTenantWithOwner
    // takes in src/app-layer/usecases/tenant-lifecycle.ts. The DEK cache
    // is not primed; it unwraps on first use.
    const { generateAndWrapDek } = await import('@/lib/security/tenant-keys');
    const { wrapped } = generateAndWrapDek();

    let created!: {
        tenantId: string;
        tenantSlug: string;
        tenantName: string;
        userId: string;
        userEmail: string;
        userName: string | null;
        role: Role;
    };

    await (prisma as PrismaClient).$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
            data: { name: orgName, slug, encryptedDek: wrapped },
            select: { id: true, slug: true, name: true },
        });

        const user = await tx.user.create({
            data: {
                email,
                emailHash: hashForLookup(email),
                passwordHash,
                name,
            },
            select: { id: true, email: true, name: true },
        });

        const membership = await tx.tenantMembership.create({
            data: {
                tenantId: tenant.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
            select: { role: true },
        });

        await tx.tenantOnboarding.create({ data: { tenantId: tenant.id } });

        created = {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            role: membership.role,
        };
    });

    // Audit AFTER commit so the data is durable before the hash chain
    // extends. actorType is USER, not PLATFORM_ADMIN — this is
    // self-service, and conflating the two would corrupt the audit story
    // for anyone reviewing tenant provenance.
    await appendAuditEntry({
        tenantId: created.tenantId,
        userId: created.userId,
        actorType: 'USER',
        entity: 'Tenant',
        entityId: created.tenantId,
        action: 'TENANT_CREATED',
        detailsJson: {
            category: 'tenant',
            slug: created.tenantSlug,
            name: created.tenantName,
            ownerUserId: created.userId,
            source: 'self_service_registration',
        },
    }).catch(() => undefined);

    // Fire the verification email. Mailer failures are swallowed inside
    // issueEmailVerification so SMTP latency never holds up the response.
    await issueEmailVerification(email, { userId: created.userId }).catch(() => undefined);
```

Then update the response builder and the deprecated-cookie block to read from `created` instead of the old `tenant` / `user` / `membership` locals:

```ts
    const token = signToken({
        userId: created.userId,
        tenantId: created.tenantId,
        email: created.userEmail,
        role: created.role,
    });

    const response = jsonResponse({
        user: {
            id: created.userId,
            email: created.userEmail,
            name: created.userName,
            role: created.role,
        },
        tenant: { id: created.tenantId, name: created.tenantName, slug: created.tenantSlug },
        emailVerificationRequired: env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1',
    });
```

Add the imports the new body needs, and drop `createTenantWithDek` if it is now unused:

```ts
import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { appendAuditEntry } from '@/app-layer/events/audit';
```

(Check the actual export path of `appendAuditEntry` with
`grep -rn "export .*appendAuditEntry" src/` before importing, and drop the
unused `Prisma` type import if the final body does not reference it.)

- [ ] **Step 4: Run the unit tests**

```bash
npx jest tests/unit/register-route.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Write the real-DB rollback proof**

Create `tests/integration/register-atomicity.test.ts`:

```ts
/**
 * Real-DB proof that a mid-flight registration failure leaves nothing
 * behind. The unit tests assert the transaction is USED; only a real
 * database proves it ROLLS BACK.
 *
 * The failure is induced on the LAST write in the transaction
 * (tenantOnboarding.create). A slug collision would not work: the route
 * appends a Date.now() base36 suffix, so slugs never collide in practice.
 */
import prisma from '@/lib/prisma';
import { resetDatabase } from '../helpers/db';
import { POST } from '@/app/api/auth/register/route';

function registerRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', ...body }),
    });
}

beforeEach(async () => {
    await resetDatabase();
    jest.restoreAllMocks();
});

it('leaves no user, tenant or membership behind when a late write fails', async () => {
    const email = 'rollback@example.com';

    // Force the final write inside the transaction to reject.
    jest.spyOn(prisma.tenantOnboarding, 'create').mockRejectedValueOnce(
        new Error('induced failure'),
    );

    const res = await POST(
        registerRequest({
            email,
            password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Rollback',
            orgName: 'Rollback Farms',
        }) as never,
        {} as never,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);

    // The whole transaction must have rolled back.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.tenant.count({ where: { name: 'Rollback Farms' } })).toBe(0);
    expect(await prisma.tenantMembership.count()).toBe(0);
});

it('leaves the email free to retry after a failed attempt', async () => {
    const email = 'retry@example.com';

    jest.spyOn(prisma.tenantOnboarding, 'create').mockRejectedValueOnce(
        new Error('induced failure'),
    );
    await POST(
        registerRequest({
            email, password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Retry', orgName: 'Retry Farms',
        }) as never,
        {} as never,
    );

    // Second attempt, no induced failure — must succeed, not 409.
    const res = await POST(
        registerRequest({
            email, password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Retry', orgName: 'Retry Farms',
        }) as never,
        {} as never,
    );

    expect(res.status).toBe(200);
});
```

The second test is the one that matters most: it proves the exact user-facing
harm this task removes — before the fix, a failed attempt consumed the email
address and the person could never register again.

- [ ] **Step 6: Run the integration test**

```bash
npx jest tests/integration/register-atomicity.test.ts
```

Expected: PASS. If the local DB is unreachable (PgBouncer on 5433 is often
down locally — use the direct port 5434), note it and let CI run it. Do not
mark the task done on a skipped test; say so explicitly.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/auth/register/route.ts tests/unit/register-route.test.ts tests/integration/register-atomicity.test.ts
git commit -m "fix(auth): make self-service registration atomic

The route ran four unguarded sequential writes. A failure between the
user insert and the membership insert left a real User with no
membership — permanently stranded on /no-tenant and unable to retry,
because the duplicate-email check now returns 409 for their own address.

Wraps tenant + user + membership + onboarding in one transaction,
mirroring createTenantWithOwner, and appends the tenant-created audit
entry after commit. The password is hashed before the transaction opens
so bcrypt never pins a pooled PgBouncer connection."
```

---

### Task 3: Surface `email_not_verified` distinctly at login

**Files:**
- Modify: `src/auth.ts:313-328` (the credentials `authorize` callback)
- Test: `tests/unit/auth-authorize-reason.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `signIn('credentials', ...)` resolves with `result.error === 'EmailNotVerified'` when the account exists, the password is correct, and `emailVerified` is null under `AUTH_REQUIRE_EMAIL_VERIFICATION=1`. Task 4 maps that exact string.

**Why this is safe:** `authenticateWithPassword` verifies the password at `credentials.ts:300` and only reaches the verification gate at `:320`. The distinct reason is therefore reachable ONLY by someone who already proved they know the password. Every other reason stays collapsed, and `dummyVerify` keeps their timing equal. `email_not_verified` is already covered at the chokepoint level by `tests/unit/credentials-auth.test.ts:239`; the gap is that `authorize` throws the reason away.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auth-authorize-reason.test.ts`:

```ts
/**
 * The credentials `authorize` callback must surface exactly ONE failure
 * reason and collapse every other into NextAuth's generic
 * CredentialsSignin, preserving account-enumeration safety.
 */
const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/credentials', () => ({
    __esModule: true,
    authenticateWithPassword: (...a: unknown[]) => mockAuthenticate(...a),
}));

import { authOptions } from '@/auth';

type AuthorizeFn = (creds: Record<string, string>) => Promise<unknown>;

function getAuthorize(): AuthorizeFn {
    const provider = (authOptions.providers as Array<Record<string, unknown>>).find(
        (p) => p.id === 'credentials',
    );
    if (!provider) throw new Error('credentials provider not registered');
    return (provider as { authorize: AuthorizeFn }).authorize;
}

const CREDS = { email: 'user@example.com', password: 'pw' };

beforeEach(() => jest.clearAllMocks());

it('throws EmailNotVerified when the password was correct but the email is not confirmed', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'email_not_verified' });
    await expect(getAuthorize()(CREDS)).rejects.toThrow('EmailNotVerified');
});

it.each(['credentials_invalid', 'unknown_email', 'rate_limited'])(
    'collapses %s into a null return (generic CredentialsSignin)',
    async (reason) => {
        mockAuthenticate.mockResolvedValue({ ok: false, reason });
        await expect(getAuthorize()(CREDS)).resolves.toBeNull();
    },
);

it('returns the user on success', async () => {
    mockAuthenticate.mockResolvedValue({
        ok: true, userId: 'u1', email: CREDS.email, name: 'User',
    });
    await expect(getAuthorize()(CREDS)).resolves.toEqual({
        id: 'u1', email: CREDS.email, name: 'User',
    });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx jest tests/unit/auth-authorize-reason.test.ts
```

Expected: the first test FAILS (resolves to `null` instead of throwing). The other four should PASS.

- [ ] **Step 3: Make the change**

In `src/auth.ts`, replace the `if (!result.ok) return null;` line inside `authorize` (~line 322):

```ts
            if (!result.ok) {
                // ONE reason is surfaced: the only one the user can act
                // on. It is reachable only AFTER the password verified
                // (credentials.ts:300 → :320), so it tells an attacker
                // nothing they did not already know, and the login page
                // can point the user at the resend-verification form
                // instead of claiming their password is wrong.
                //
                // Everything else — unknown email, wrong password, rate
                // limited — stays collapsed into NextAuth's generic
                // CredentialsSignin, which is the account-enumeration-safe
                // shape. Do not add reasons here without re-reading that
                // argument.
                if (result.reason === 'email_not_verified') {
                    throw new Error('EmailNotVerified');
                }
                return null;
            }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest tests/unit/auth-authorize-reason.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Verify the string actually reaches the client**

This step exists because NextAuth v4's handling of a thrown `authorize`
error is version-sensitive. Confirm the contract end-to-end rather than
trusting it:

```bash
npx jest tests/integration/credentials-end-to-end.test.ts
```

Then, with a dev server running and `AUTH_REQUIRE_EMAIL_VERIFICATION=1`,
register a user, do not click the link, and attempt sign-in. Confirm
`signIn('credentials', { redirect: false })` resolves with
`result.error === 'EmailNotVerified'`.

**If NextAuth collapses it to `CredentialsSignin` anyway**, do not fight the
provider. Fall back to the alternative: keep `authorize` returning `null`,
and have the login page treat a `CredentialsSignin` error as ambiguous —
showing the existing resend-verification form more prominently with copy
like "If you have not confirmed your email yet, request a new link below."
That degrades the UX slightly but keeps the flow usable. Record which
branch you took in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts tests/unit/auth-authorize-reason.test.ts
git commit -m "feat(auth): surface email_not_verified distinctly at sign-in

Once verification is enforced, an unverified user typing the CORRECT
password was told their credentials were invalid — the single biggest
support-load risk in enabling signup.

Only this one reason is surfaced, and only after the password has already
verified (credentials.ts:300 -> :320), so it discloses nothing to someone
who does not already know it. Every other reason stays collapsed into
CredentialsSignin and dummyVerify keeps their timing equal."
```

---

### Task 4: "Check your inbox" state and verification-aware login copy

**Files:**
- Modify: `src/app/login/page.tsx:96-141` (submit handler), render block
- Modify: `messages/en.json`, `messages/bg.json`
- Test: manual + i18n guardrails

**Interfaces:**
- Consumes: `result.error === 'EmailNotVerified'` from Task 3; `emailVerificationRequired` from the register response (unchanged by Task 2).
- Produces: no downstream consumers.

- [ ] **Step 1: Add the three i18n strings to BOTH locales**

In `messages/en.json` under `"login"`:

```json
"emailNotVerified": "Confirm your email address to sign in. We sent you a link — check your inbox, or request a new one below.",
"checkInboxTitle": "Check your inbox",
"checkInboxBody": "We sent a confirmation link to {email}. Click it to activate your account, then sign in."
```

In `messages/bg.json` under `"login"` — real Bulgarian, matching the register/verify tone already in that file:

```json
"emailNotVerified": "Потвърдете имейл адреса си, за да влезете. Изпратихме ви линк — проверете пощата си или заявете нов по-долу.",
"checkInboxTitle": "Проверете пощата си",
"checkInboxBody": "Изпратихме линк за потвърждение на {email}. Кликнете върху него, за да активирате акаунта си, след което влезте."
```

- [ ] **Step 2: Verify locale parity before touching the component**

```bash
node scripts/i18n-diff.mjs --check
```

Expected: `missing=0 orphan=0 drift=0 untranslated=0`.

- [ ] **Step 3: Branch on `emailVerificationRequired` instead of auto-signing-in**

In `src/app/login/page.tsx`, add state beside the existing `useState` calls:

```tsx
    const [awaitingVerification, setAwaitingVerification] = useState<string | null>(null);
```

In `handleCredentialsSubmit`, replace the register branch (~lines 106-116) so a
registration that requires verification stops there instead of falling through
to `signIn`:

```tsx
            if (mode === 'register') {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', email, password, name, orgName }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(extractErrorMessage(data?.error, t('registrationFailed')));

                // When verification is enforced, signing in here would fail
                // with EmailNotVerified and show a login error to someone
                // who just registered successfully. Stop and tell them to
                // check their inbox instead.
                if (data?.emailVerificationRequired) {
                    setAwaitingVerification(email);
                    return;
                }
            }
```

Note the `finally` block already clears `loading`, so the early `return` is safe.

- [ ] **Step 4: Map the new sign-in error**

In the same handler, extend the error mapping (~line 126-129):

```tsx
            if (result?.error) {
                const raw = extractErrorMessage(result.error, t('loginFailed'));
                if (raw === 'EmailNotVerified') throw new Error(t('emailNotVerified'));
                throw new Error(raw === 'CredentialsSignin' ? t('invalidCredentials') : raw);
            }
```

- [ ] **Step 5: Render the confirmation panel**

Inside the `<Card>`, immediately after the `{error && ...}` block, add a branch that
replaces the form while awaiting verification. Use the existing primitives — no
hand-rolled markup:

```tsx
                    {awaitingVerification ? (
                        <div className="space-y-default">
                            <Heading level={3}>{t('checkInboxTitle')}</Heading>
                            <p className="text-sm text-content-muted">
                                {t('checkInboxBody', { email: awaitingVerification })}
                            </p>
                            <Button
                                type="button"
                                variant="secondary"
                                className="w-full"
                                onClick={() => {
                                    setAwaitingVerification(null);
                                    setMode('login');
                                }}
                            >
                                {t('signInLink')}
                            </Button>
                        </div>
                    ) : null}
```

Then stop the credentials block rendering underneath the panel. The block
currently opens at line ~278 with:

```tsx
                    {credentialsEnabled === null ? (
                        <CredentialsFormSkeleton />
                    ) : credentialsEnabled ? (
```

Add one leading condition so the whole block short-circuits while awaiting
verification:

```tsx
                    {awaitingVerification ? null : credentialsEnabled === null ? (
                        <CredentialsFormSkeleton />
                    ) : credentialsEnabled ? (
```

Leave the closing `) : null}` untouched.

**Trade-off to be aware of:** the resend-verification form lives inside that
block, so it disappears while the panel is showing. That is acceptable here —
the user has just been told an email is on its way, and offering "resend"
in the same breath invites them to spam themselves. They can return to the
sign-in view (the panel's button) to reach it. If you would rather keep resend
immediately available, render the panel ABOVE the block instead of
short-circuiting it, and skip this step.

- [ ] **Step 6: Verify**

```bash
npx jest tests/guardrails/i18n-completeness.test.ts
npx jest tests/guards/no-hardcoded-ui-strings.test.ts
npm run typecheck
```

Expected: all PASS. `no-hardcoded-ui-strings` has a `CURRENT_BASELINE` — every
new string goes through `t(...)`, so the count must not rise.

Then run the app and walk the flow by hand: register → confirmation panel
appears, no login error → click the emailed link → sign in succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/login/page.tsx messages/en.json messages/bg.json
git commit -m "feat(auth): show a check-your-inbox state after signup

The page signed the user in immediately after registering, which fails
once verification is enforced — a successful signup would render a login
error. Branches on the emailVerificationRequired flag the register route
already returns, and maps the new EmailNotVerified sign-in error to copy
that points at the resend form rather than blaming the password."
```

---

### Task 5: Rate-limit the signup endpoint

**Files:**
- Modify: `src/lib/security/rate-limit.ts` (add preset)
- Modify: `src/app/api/auth/register/route.ts` (apply it)

**Interfaces:**
- Consumes: nothing.
- Produces: `SIGNUP_LIMIT` exported from `@/lib/security/rate-limit`.

**Why a new preset rather than reusing `TENANT_CREATE_LIMIT`:** that preset exists at `rate-limit.ts:263` with a documented threat model of "a leaked `PLATFORM_ADMIN_API_KEY`", keyed by IP for a single shared secret. Public signup is a different threat with a different actor. Reusing it would silently falsify that comment; every preset in this file carries its own threat model and this one should too.

- [ ] **Step 1: Add the preset**

In `src/lib/security/rate-limit.ts`, after `TENANT_CREATE_LIMIT`:

```ts
/**
 * Public self-service signup: 5 per hour per IP.
 *
 * Threat model: an unauthenticated caller farming workspaces. Every
 * successful call provisions a Tenant AND generates + wraps a per-tenant
 * DEK, so this is the most expensive unauthenticated write in the product
 * — the generic API_MUTATION_LIMIT (60/min) would permit 3600 tenants an
 * hour from one IP. 5/hour is far above what a real person needs (they
 * create one workspace) while making bulk provisioning useless.
 *
 * Bypassed automatically in tests and under AUTH_TEST_MODE=1, so the E2E
 * per-test isolated-tenant fixture is unaffected.
 */
export const SIGNUP_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
};
```

- [ ] **Step 2: Apply it to the route**

In `src/app/api/auth/register/route.ts`, add the import and pass the options as
the second argument to `withApiErrorHandling` — the same shape
`src/app/api/auth/forgot-password/route.ts:39` uses:

```ts
import { SIGNUP_LIMIT } from '@/lib/security/rate-limit';

export const POST = withApiErrorHandling(
    withValidatedBody(AuthActionSchema, async (_req, _ctx, body) => {
        // ...unchanged body...
    }),
    { rateLimit: { config: SIGNUP_LIMIT, scope: 'self-service-signup' } },
);
```

- [ ] **Step 3: Verify nothing regressed**

```bash
npx jest tests/unit/register-route.test.ts
npm run typecheck
npx jest tests/guardrails tests/guards
```

Expected: all PASS. The unit tests run under `NODE_ENV=test`, where
`isRateLimitBypassed()` returns true, so the limiter is inert there.

- [ ] **Step 4: Commit**

```bash
git add src/lib/security/rate-limit.ts src/app/api/auth/register/route.ts
git commit -m "feat(security): rate-limit self-service signup to 5/hour per IP

Registration is the most expensive unauthenticated write in the product —
each success provisions a Tenant and generates + wraps a per-tenant DEK.
It inherited the generic 60/min mutation limit, which permits 3600 tenants
an hour from a single IP. Bypassed in tests and under AUTH_TEST_MODE=1,
so the E2E isolated-tenant fixture is unaffected."
```

---

### Task 6: Production rollout

**Files:**
- Modify: `deploy/env.prod.example`

**Interfaces:** none — this task ships no application code.

**Do this task LAST, and only after Tasks 1-5 are merged and green.** Flipping the flags before the code lands would expose the signup form while the auto-sign-in bug is still present.

- [ ] **Step 1: Document both flags**

Add to `deploy/env.prod.example` (parity with `src/env.ts` is guarded by
`tests/guardrails/deploy-env-parity.test.ts` — run it after editing):

```bash
# Set to 1 to hide the email/password form (and the register toggle) on
# /login, leaving the server OAuth-only at the UI layer. Unset/0 exposes
# self-service signup. Read at request time by /api/auth/ui-config, so
# changing it needs only a container recreate — no rebuild.
AUTH_CREDENTIALS_UI_HIDDEN=0

# Set to 1 to require a confirmed email before a credentials login
# succeeds. Only affects the credentials path — OAuth sign-ins never
# reach the gate (src/lib/auth/credentials.ts:320).
AUTH_REQUIRE_EMAIL_VERIFICATION=1
```

- [ ] **Step 2: Confirm the mailer is healthy BEFORE flipping**

`src/lib/observability/metrics.ts:549` documents a verification-email delivery
signal that exists specifically to catch a mailer outage *before* this flag can
lock users out. Check it, and send one real verification email end-to-end
against production. Do not skip this: after the flip, a broken SMTP path means
no new user can complete signup at all.

- [ ] **Step 3: Apply the env change**

Edit `/opt/agrent/.env` on the VM to set both values, back the file up first
(`<file>.bak.<timestamp>`), then recreate the app container. This is an env
change, not a structural compose change, so it does not go through
`deploy/apply.sh`.

- [ ] **Step 4: Verify in production**

```bash
curl -fsS https://35-187-80-26.sslip.io/api/auth/ui-config
```

Expected: `{"credentialsFormHidden":false}`.

Then load `/login` and confirm the register toggle is visible, register a
throwaway account, confirm the email arrives, confirm login is refused before
clicking and succeeds after, and confirm the new membership is `OWNER`:

```sql
SELECT t.slug, m.role, u."emailVerified" IS NOT NULL AS verified
FROM "TenantMembership" m
JOIN "Tenant" t ON t.id = m."tenantId"
JOIN "User" u ON u.id = m."userId"
ORDER BY m."createdAt" DESC LIMIT 3;
```

- [ ] **Step 5: Commit**

```bash
git add deploy/env.prod.example
git commit -m "docs(deploy): document the two self-service-signup flags

AUTH_CREDENTIALS_UI_HIDDEN gates whether the login page renders the
credentials form and register toggle at all; AUTH_REQUIRE_EMAIL_VERIFICATION
gates whether a credentials login needs a confirmed address. Both are read
at request time, so flipping either needs a container recreate, not a
rebuild."
```

**Rollback:** set `AUTH_CREDENTIALS_UI_HIDDEN=1` and recreate the container. Signup disappears immediately with no code deploy.

---

## Verification checklist

Before opening the PR:

```bash
npm run typecheck
npx jest tests/unit/register-route.test.ts tests/unit/auth-authorize-reason.test.ts
npx jest tests/guardrails tests/guards
node scripts/i18n-diff.mjs --check
npm run lint
```

All must pass. A failing test on this branch is a failing test — if one is red on `main` too, fix it in a focused PR and link it, per CLAUDE.md. Never `gh pr merge --admin` past a red check.
