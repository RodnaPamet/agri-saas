/**
 * Route → permission map for the API surface (Epic C.1).
 *
 * The map is the single declarative source of truth for "which
 * `PermissionKey` does this URL require?" — it lets us:
 *
 *   1. Roll the `requirePermission(...)` middleware across handlers
 *      without duplicating the policy in twelve different files.
 *   2. Guard against a new sensitive route shipping unprotected: the
 *      coverage test in `tests/guards/route-permission-coverage.test.ts`
 *      walks `src/app/api/**\/route.ts` and verifies every in-scope
 *      route has a matching rule AND uses `requirePermission(...)` in
 *      its handler.
 *   3. Surface the policy in code review: a PR that touches an admin
 *      route is forced to update this map, which a reviewer can read
 *      in isolation without context-switching across handler files.
 *
 * Adding or moving an admin/privileged route:
 *   - Add a rule below covering the path + methods.
 *   - Wire `requirePermission(<key>, …)` into the route handler.
 *   - Run `npm test -- tests/guards/route-permission-coverage.test.ts`
 *     to verify the rollout is complete.
 *
 * This file is intentionally narrow in scope. It only enumerates
 * privileged routes (admin, key rotation, member management, etc.).
 * Read-mostly tenant routes (controls, evidence, risks, reports,
 * etc.) continue to authorise via the existing usecase-layer policy
 * helpers (`assertCanRead/Write/Admin/Audit`) — Epic C.2 will widen
 * the route-map to those once the granular policy keys settle.
 */

import type { PermissionKey, PermissionMode } from './permission-middleware';

// ─── Rule shape ─────────────────────────────────────────────────────

/**
 * Closed set of HTTP methods a rule may gate. Template-literal union
 * enforces at compile time that every rule uses the canonical
 * uppercase form — the hot path at line ~210 does a direct
 * `includes` with no per-call normalisation.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePermissionRule {
    /**
     * Regex matched against `req.nextUrl.pathname`. Use `\/[^/]+\/` for
     * a single dynamic segment (so trailing slashes / query strings
     * don't accidentally match).
     */
    path: RegExp;
    /**
     * HTTP methods this rule covers. Omit to apply to every method.
     * MUST be uppercase — the compile-time `HttpMethod` union enforces.
     */
    methods?: readonly HttpMethod[];
    /**
     * Permission key(s) required to call the route.
     */
    permission: PermissionKey | readonly PermissionKey[];
    /**
     * All-of vs any-of when multiple keys. Defaults to `'all'`.
     */
    mode?: PermissionMode;
    /**
     * Short human-readable rationale. Required so a reviewer can sanity-
     * check the policy at a glance — `'admin.scim'` on the SCIM route is
     * obvious; rules that combine keys or carve exceptions are not.
     */
    note: string;
}

// ─── Tenant route prefix ────────────────────────────────────────────

/**
 * Shared prefix for every tenant-scoped API path. Centralised so a
 * future rename (`/api/t/` → `/api/tenants/`) updates one place.
 */
const T = String.raw`\/api\/t\/[^/]+`;

// ─── The map ────────────────────────────────────────────────────────

export const ROUTE_PERMISSIONS: readonly RoutePermissionRule[] = [
    // ── Member management ───────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/members(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing members, inviting, editing role, deactivating — ' +
            'changes who can access the tenant and at what level.',
    },

    // ── Session management (Epic C.3) ────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/sessions(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing + revoking active user sessions for the tenant. ' +
            'Treated as a member-management action since it controls ' +
            'who currently has live access.',
    },

    // ── SCIM token management ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/scim$`),
        permission: 'admin.scim',
        note:
            'Generating, listing and revoking SCIM bearer tokens — ' +
            'controls automated provisioning from the IdP.',
    },

    // ── Custom RBAC roles ───────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/roles(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Creating / editing / deleting custom roles. Falls under ' +
            "admin.manage — there's no separate `admin.roles` key.",
    },

    // ── Tenant-wide settings ────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/settings(\\/.*)?$`),
        permission: 'admin.manage',
        note: 'Tenant settings (display name, branding, defaults).',
    },

    // ── WP-2 module gating ──────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/modules(\\/.*)?$`),
        permission: 'admin.manage',
        note: 'Per-tenant module gating (enable/disable modules; "simple mode").',
    },

    // ── БАБХ farm-record — farm profile ─────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/farm-profile(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Tenant farm identity block (producer name, ЕГН/ЕИК, community, ' +
            'ОДБХ/ОД Земеделие offices) printed on the БАБХ ДНЕВНИК — ' +
            'organisation-level configuration.',
    },

    // ── Outbound integrations ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/integrations(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'CRUD on outbound integrations (Slack, webhooks, ticketing). ' +
            'Mis-configuration leaks data outside the tenant.',
    },

    // ── M2M API keys ────────────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/api-keys(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'API key issuance + revocation — every key is a long-lived ' +
            'credential against the tenant; treat as admin-only.',
    },

    // ── Platform-support console: global catalogues (#12) ───────────
    // NOTE: `admin.manage` here is necessary but NOT sufficient. It resolves
    // from Role, so every tenant's OWNER/ADMIN holds it — on its own it would
    // grant write access to a feed every other tenant reads. The real gate is
    // `assertPlatformSupport(ctx)` inside each handler, which restricts these
    // to the designated PLATFORM_TENANT_SLUG and 404s elsewhere. The
    // permission is still required: it is what makes a denial an audited
    // AUTHZ_DENIED row and keeps these routes inside the Epic C.1 guardrail.
    {
        path: new RegExp(`^${T}\\/admin\\/promotions(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Global promotions feed — content published to EVERY tenant. ' +
            'Platform-tenant gated in-handler; admin.manage is the audited ' +
            'role floor, not the isolation control.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/companies(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Global supplier catalogue, incl. DECRYPTED contact PII. ' +
            'Platform-tenant gated in-handler; admin.manage is the audited ' +
            'role floor, not the isolation control.',
    },
    {
        path: new RegExp(`^${T}\\/schemes(\\/.*)?$`),
        permission: 'admin.manage',
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        note:
            'Certification-scheme AUTHORING writes the global Framework ' +
            'catalogue every tenant reads. Reads stay open to all roles ' +
            '(browsing the catalogue is not privileged), hence the method ' +
            'list. Platform-tenant gated in-handler via ' +
            'assertCanWriteCatalogue; admin.manage is the audited role ' +
            'floor, not the isolation control.',
    },
    {
        path: new RegExp(`^${T}\\/frameworks(\\/.*)?$`),
        permission: 'admin.manage',
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        note:
            'Framework writes span two classes: pack install / bulk-map ' +
            'create TENANT rows, while upsert-requirements rewrites the ' +
            'GLOBAL catalogue (and can deprecate every requirement of a ' +
            'standard, zeroing coverage for all tenants). The catalogue arm ' +
            'is platform-tenant gated in-handler; this rule is what makes a ' +
            'denial on any arm an audited AUTHZ_DENIED row.',
    },

    // ── Master-KEK rotation (Epic B.3) ──────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/key-rotation(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Re-wraps the tenant DEK + re-encrypts v1 ciphertexts ' +
            'after the operator stages a new DATA_ENCRYPTION_KEY. ' +
            'Operator-driven fleet operation; ADMIN tier suffices.',
    },

    // ── Stock-ledger reconciliation (ag observability) ──────────────
    {
        path: new RegExp(`^${T}\\/admin\\/ledger-reconciliation(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Re-walks the hash-chained stock ledger and reports ' +
            'integrity drift. Operator-driven integrity sweep; ' +
            'ADMIN tier suffices (same as key-rotation).',
    },

    // ── Per-tenant DEK rotation (Epic F.2 follow-up) ────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/tenant-dek-rotation(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Generates a fresh per-tenant DEK + sweeps every v2 ' +
            'ciphertext under the new key. Response to a per-tenant ' +
            'compromise — destructive on the timeline that matters ' +
            'and OWNER-only per the role model in CLAUDE.md.',
    },
    // ── Per-tenant DEK rotation — GAP-22 alias path ─────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/rotate-dek(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Same handler as /admin/tenant-dek-rotation; aliased here ' +
            'so the GAP-22-prescribed short URL is gated identically ' +
            'rather than relying on path-equivalence at the runtime ' +
            'permission middleware (the regex matcher is path-string ' +
            'based, not handler-identity based).',
    },

    // ── Billing (Epic D.3 — was legacy requireAdminCtx) ─────────────
    {
        path: new RegExp(`^${T}\\/billing\\/(checkout|portal|events)(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Stripe checkout + customer portal + billing-event listing — ' +
            'commercial actions; treat as admin-only.',
    },

    // ── Security session-management bulk routes (Epic D.3) ──────────
    {
        path: new RegExp(`^${T}\\/security\\/sessions\\/(revoke-all|revoke-user)$`),
        permission: 'admin.members',
        note:
            'Admin-driven session revocation for the whole tenant or a ' +
            'specific colleague — same surface as /admin/sessions; ' +
            'gated under admin.members for consistency.',
    },

    // ── Tenant MFA policy (Epic D.3 — PUT only; GET is open) ────────
    // Only the PUT method is mapped here. The GET handler in the same
    // file is intentionally unprotected by `requirePermission` — any
    // tenant member can read the current MFA posture from the security
    // settings page. The methods array enforces the asymmetry.
    {
        path: new RegExp(`^${T}\\/security\\/mfa\\/policy$`),
        methods: ['PUT'],
        permission: 'admin.manage',
        note:
            'Mutating the tenant MFA policy is admin-only; the GET ' +
            'sibling stays open so the settings UI can render for ' +
            'every tenant member.',
    },

    // ── Tenant SSO configuration (Epic D.3) ─────────────────────────
    {
        path: new RegExp(`^${T}\\/sso(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'SSO provider configuration — provider list, upsert, ' +
            'enable/enforce toggles, deletion. All ADMIN-only.',
    },

    // ── Tenant invite management (Epic 1, PR 3) ──────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/invites(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Creating, listing, and revoking pending tenant invites. ' +
            'Changes who can join the tenant — gated under admin.members.',
    },
] as const;

// ─── Resolver ───────────────────────────────────────────────────────

export interface ResolvedRoutePermission {
    rule: RoutePermissionRule;
    permission: PermissionKey | readonly PermissionKey[];
    mode: PermissionMode;
}

/**
 * Look up the permission rule that applies to a request path + method.
 * Returns `null` for routes the map doesn't cover — callers decide
 * whether to fall back to legacy guards (Epic C.1 scope) or to fail
 * closed (a future Epic C.3 enforcement-by-default mode).
 */
export function resolveRoutePermission(
    pathname: string,
    method: string,
): ResolvedRoutePermission | null {
    const upperMethod = method.toUpperCase() as HttpMethod;
    for (const rule of ROUTE_PERMISSIONS) {
        if (!rule.path.test(pathname)) continue;
        if (rule.methods && !rule.methods.includes(upperMethod)) {
            continue;
        }
        return {
            rule,
            permission: rule.permission,
            mode: rule.mode ?? 'all',
        };
    }
    return null;
}

/**
 * Quick membership test for guard / coverage tests. True iff the path
 * matches at least one rule (regardless of method).
 */
export function isRouteCovered(pathname: string): boolean {
    return ROUTE_PERMISSIONS.some((r) => r.path.test(pathname));
}
