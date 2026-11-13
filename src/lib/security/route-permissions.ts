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
 * Read-mostly tenant routes (practices, evidence, risks, reports,
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
    // ── «Документи» — the farm document library (#2495) ─────────────
    //
    // TWO rules, because reading and writing are different tiers and the
    // first match wins: everyone in the farm previews, writers upload and
    // delete. The uploader-or-admin narrowing on DELETE is enforced in the
    // usecase, not here — a path regex cannot know who uploaded a row.
    //
    // MECHANISATOR never reaches either: `isOperatorAllowedPath` admits no
    // `documents` prefix, and that role also holds `documents.view: false`.
    {
        path: new RegExp(`^${T}\\/documents(\\/.*)?$`),
        methods: ['GET'],
        permission: 'documents.view',
        note:
            'Listing and previewing the farm document library. Every member ' +
            'of the farm sees it; the library is expected to hold lease ' +
            'contracts, so the confinement that matters is the operator ' +
            'persona being kept out entirely.',
    },
    {
        path: new RegExp(`^${T}\\/documents(\\/.*)?$`),
        methods: ['POST', 'PUT', 'DELETE'],
        permission: 'documents.upload',
        note:
            'Uploading and deleting documents. DELETE additionally requires ' +
            'being the uploader or an admin, checked in the usecase against ' +
            'the row — which is what `mayDelete` reports on the list.',
    },

    // ── Machine tracking (#2948) ────────────────────────────────────
    //
    // GET only, on purpose: stage 3 is the READ surface. The tracker and
    // telematics-link writes are a later stage and will need `machines.manage`
    // plus the drivers-informed columns, so there is deliberately no write
    // rule here yet — a permissive rule waiting for its routes is a rule
    // nobody re-reads when they arrive.
    //
    // MECHANISATOR is excluded TWICE, and the redundancy is the point:
    // `isOperatorAllowedPath` admits no `machines` prefix (its API branch
    // enumerates farm-tasks / field-operations / tasks / locations / agro), and
    // the role holds `machines.view: false`. That role sees only the machine
    // on its own open task, through the `farm-tasks` reads, which authorise on
    // assignment rather than on this flag.
    //
    // A position trace is personal data by LINKAGE — MachinePosition → Asset →
    // TaskAsset → Task.assigneeUserId names the person who was at those
    // coordinates, minute by minute — so this is not an ordinary machine
    // register read, and OWNER + ADMIN is the whole audience by owner ruling.
    // #3026 — putting a machine ON a task, and taking it off.
    //
    // The PATH is under `farm-tasks`, and that is why this rule has to exist:
    // `isOperatorAllowedPath` admits `/api/t/{slug}/farm-tasks/…` for the
    // operator persona, so the middleware does NOT keep a MECHANISATOR out
    // here the way it does on `/machines`. This rule is the only thing that
    // does — the C.1 arrangement, and exactly how it gets missed.
    //
    // METHODS ARE NAMED, so the GET keeps its wider audience. That read
    // carries configuration and no coordinates and a MECHANISATOR reaches it
    // for their own open task; the writes are OWNER + ADMIN. Omitting
    // `methods` would gate the read at `machines.manage` and take the machine
    // list away from the person driving it — the inverse of the C.1b mistake,
    // and just as silent.
    //
    // `machines.manage` rather than a task permission: the decision is about
    // the machine register (which machine is where, and therefore whose
    // position trace is attributable to which task), and the role matrix
    // already says OWNER + ADMIN hold it while EDITOR, READER, AUDITOR and
    // MECHANISATOR do not.
    {
        path: new RegExp(`^${T}\\/farm-tasks\\/[^/]+\\/assets(\\/.*)?$`),
        methods: ['POST', 'DELETE'],
        permission: 'machines.manage',
        note:
            'Attaching a machine to a task and detaching it. GET on the same '
            + 'path is deliberately NOT covered: it is the read a MECHANISATOR '
            + 'needs for their own open task, and it carries no coordinates.',
    },

    {
        path: new RegExp(`^${T}\\/machines(\\/.*)?$`),
        methods: ['GET'],
        permission: 'machines.view',
        note:
            'The fleet list, a day\'s track, and a day\'s worked parcels. '
            + 'OWNER + ADMIN only: a track is employee location data, not an '
            + 'asset attribute, so it is NOT readable by every member the way '
            + 'the asset register is.',
    },

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
            'Treated as a member-management action since it practices ' +
            'who currently has live access.',
    },

    // ── SCIM token management ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/scim$`),
        permission: 'admin.scim',
        note:
            'Generating, listing and revoking SCIM bearer tokens — ' +
            'practices automated provisioning from the IdP.',
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
    // «Функции» (#2706) — the session-authenticated door onto the platform
    // flag table, which is what the superuser page can actually call. Same
    // two-gate reasoning as the catalogues above, and one sharper detail:
    // `FeatureFlag` has no `tenantId`, so `admin.manage` alone would let one
    // farm's admin launch a feature for every other farm. The key-gated
    // `/api/admin/feature-flags` stays for scripts — a browser cannot hold
    // that key without inlining it into every user's bundle.
    // «Потвърждаване на стопанства» (#2963) — the session-authenticated door
    // onto the farm-identity review queue, which is what the review page can
    // actually call. Same two-gate reasoning as «Функции» below, and with more
    // force: `FarmIdentityClaim` has no `tenantId` at all, so `admin.manage`
    // alone would let an ADMIN of any farm verify ANOTHER farm's identity —
    // not launch a feature for them, but assert who they are. The key-gated
    // `/api/admin/farm-claims` stays for scripts, for the same reason its
    // sibling does: a browser cannot hold that key without inlining it into
    // every user's bundle.
    //
    // Measured 2026-11-10: one claim, PENDING since 2026-10-13, because the
    // only way to review it was composing a keyed request by hand.
    {
        path: new RegExp(`^${T}\\/admin\\/farm-claims(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Farm-identity review — a verification here decides what «verified farm» ' +
            'means product-wide, and the model is tenantless. Platform-tenant gated ' +
            'in-handler via assertPlatformSupport; admin.manage is the audited role ' +
            'floor, not the isolation practice.',
    },
    // The moderation console's SECOND DOOR — #2735. Same two-gate shape and
    // same reason as farm-claims above: `ContentReport`, `ModerationAction` and
    // `StatementOfReasons` are TENANTLESS and deny `app_user` outright, so
    // `admin.manage` alone would let an ADMIN of any one farm triage every
    // other farm's Art 16 notices.
    //
    // What this door buys that the keyed one cannot: a PERSON. The keyed
    // `/api/admin/moderation/*` can attribute no further than
    // `platform-key:<generation>`, because one `PLATFORM_ADMIN_API_KEY` is
    // shared by every operator — so a regulator asking "who decided this" got
    // "somebody holding the key". Here `ctx.userId` is the verified caller, and
    // `ModerationActor` carries it into `moderatorRef` and `actorUserId` alike.
    //
    // The keyed routes STAY, for scripts and for an incident where the session
    // path is the broken thing. Per-person API keys were the other candidate
    // and were rejected: making `verifyPlatformApiKey` async would convert its
    // 20 bare assertion sites into floating promises that fail OPEN, with
    // `tsc` and `lint` both green (measured).
    {
        path: new RegExp(`^${T}\\/admin\\/moderation(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Moderation console — Art 16 triage and the Art 17 decision, on tenantless ' +
            'models. Platform-tenant gated in-handler via assertPlatformSupport; ' +
            'admin.manage is the audited role floor, not the isolation practice. This ' +
            'door exists so a decision names a PERSON rather than a key generation.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/feature-flags(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Platform flag table — a switch here changes behaviour for EVERY tenant. ' +
            'Platform-tenant gated in-handler; admin.manage is the audited role floor, ' +
            'not the isolation practice.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/promotions(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Global promotions feed — content published to EVERY tenant. ' +
            'Platform-tenant gated in-handler; admin.manage is the audited ' +
            'role floor, not the isolation practice.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/companies(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Global supplier catalogue, incl. DECRYPTED contact PII. ' +
            'Platform-tenant gated in-handler; admin.manage is the audited ' +
            'role floor, not the isolation practice.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/market-prices(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Hand-entered prices for the GLOBAL market cache — a number typed ' +
            'here renders in EVERY tenant\'s Trends chart. Platform-tenant ' +
            'gated in-handler; admin.manage is the audited role floor, not ' +
            'the isolation practice.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/ppp-register(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'The BABH register of approved plant-protection products \u2014 a dose ' +
            'uploaded here is suggested to EVERY tenant and may be transcribed ' +
            'onto a regulated document. Platform-tenant gated in-handler; ' +
            'admin.manage is the audited role floor, not the isolation practice.',
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
            'floor, not the isolation practice.',
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

    // ── Knowledge-base ask (KB wire-up PR, W3/#91) ───────────────────
    // Deliberately narrower than the rest of this file: `knowledge.view`
    // is a READ-tier permission every role but MECHANISATOR holds, not an
    // admin key. It is listed here (rather than left on the usecase-layer
    // assertCanRead gate like the sibling article routes) because this
    // endpoint runs an LLM completion per request — see the matching
    // EXCLUDED_ROUTES-adjacent note in api-permission-coverage.test.ts.
    {
        path: new RegExp(`^${T}\\/knowledge\\/ask$`),
        permission: 'knowledge.view',
        note:
            'RAG Q&A over the tenant + GLOBAL knowledge base — gated so a ' +
            'denial audits cleanly, on top of the KNOWLEDGE_ASK_LIMIT rate limit.',
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
