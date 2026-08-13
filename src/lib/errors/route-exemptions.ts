/**
 * Epic E — API Contract Completeness.
 *
 * Single source of truth for API routes that intentionally do NOT use
 * `withApiErrorHandling`. Adding a route here is a deliberate decision
 * that bypasses the standardized `ApiErrorResponse` contract; every
 * entry MUST carry a `reason` describing why.
 *
 * The CI guardrail at `tests/guardrails/api-error-wrapper-coverage.test.ts`
 * walks `src/app/api/**\/route.ts` and fails if:
 *   - a bare route is missing from this list, OR
 *   - a listed route is no longer bare (i.e. now uses the wrapper —
 *     the entry is dead and must be removed in the same PR), OR
 *   - a listed file no longer exists (delete the entry alongside the route).
 *
 * Paths are relative to `src/app/api/` and always end in `route.ts`.
 */

export interface BareRouteExemption {
    /** Path under `src/app/api/`, e.g. `health/route.ts`. */
    file: string;
    /** Bucket the exemption falls into — surfaces in test failure messages. */
    category:
        | 'k8s_probe'
        | 'nextauth_framework'
        | 'redirect_only'
        | 'anti_enumeration'
        | 'csp_report_sink'
        | 'external_webhook'
        | 'scim_2_0'
        | 'staging_fixture'
        | 'sse_stream'
        | 'telemetry_sink';
    /** Why this route does not use `withApiErrorHandling`. */
    reason: string;
}

export const BARE_ROUTE_EXEMPTIONS: ReadonlyArray<BareRouteExemption> = [
    // ─── K8s liveness / readiness / legacy health ───
    //
    // Probe responses carry a structured `CheckResult` shape that
    // monitoring stacks (k8s, GCP MIG, load balancers) parse. Every
    // dependency check is wrapped in its own try/catch and reported as
    // `{ status: 'error', error: <bounded code> }` — these routes are
    // contractually unable to throw. Wrapping them would replace the
    // probe shape with the generic `ApiErrorResponse` on the off
    // chance an unhandled throw escaped, breaking probe automation.
    {
        file: 'health/route.ts',
        category: 'k8s_probe',
        reason:
            'Legacy k8s health probe. Structured CheckResult contract; ' +
            'every dependency check is internally try/catch-wrapped. ' +
            'Must never return ApiErrorResponse JSON.',
    },
    {
        file: 'metrics/route.ts',
        category: 'telemetry_sink',
        reason:
            'Anonymous web-vitals RUM beacon sink. Public + bare on purpose: ' +
            'it must not carry the mutation rate-limit (vitals fire several ' +
            'times per page load) and always 204s — a malformed beacon is ' +
            'swallowed, never an ApiErrorResponse.',
    },
    {
        file: 'livez/route.ts',
        category: 'k8s_probe',
        reason:
            'k8s liveness probe. Always 200 if the process is up; ' +
            'performs no dependency checks; cannot throw.',
    },
    {
        file: 'readyz/route.ts',
        category: 'k8s_probe',
        reason:
            'k8s readiness probe. Per-check timeout + try/catch; bounded ' +
            'error-code enum protects against credential leakage. Probe ' +
            'consumers expect the structured CheckResult shape, not ApiErrorResponse.',
    },

    // ─── NextAuth catch-all ───
    //
    // The NextAuth framework owns its own error rendering, callback
    // URLs, OAuth/credentials routing, and redirect semantics.
    // Wrapping it converts framework-internal errors into our generic
    // shape and breaks the OAuth flow.
    {
        file: 'auth/[...nextauth]/route.ts',
        category: 'nextauth_framework',
        reason:
            'NextAuth catch-all handler. Framework owns its own error ' +
            'shapes, callback redirects, and provider routing. POST is ' +
            'pre-rate-limited via LOGIN_LIMIT before delegating.',
    },

    // ─── Redirect-only contracts ───
    //
    // These routes return a redirect on every code path — success and
    // every failure mode. The "error" channel is the query string on
    // the redirect target (`?error=<code>&error_description=<msg>`).
    // A JSON error response from the wrapper would break the UX (the
    // browser would render the JSON instead of landing on /login).
    {
        file: 'auth/sso/oidc/callback/route.ts',
        category: 'redirect_only',
        reason:
            'OIDC callback. Every success and every failure → 302 to ' +
            '/login with an error code in the query string. JSON error ' +
            'responses are not part of this contract.',
    },
    {
        file: 'auth/sso/saml/callback/route.ts',
        category: 'redirect_only',
        reason:
            'SAML ACS callback. Same redirect-only contract as the ' +
            'OIDC callback above.',
    },
    {
        file: 'auth/verify-email/route.ts',
        category: 'redirect_only',
        reason:
            'Email verification consumer. Always 302 to /login with ' +
            'verifyStatus=verified|expired|invalid; never returns JSON. ' +
            'Status discrimination on the redirect target is the ' +
            'caller-facing contract.',
    },
    {
        file: 'invites/[token]/accept-redirect/route.ts',
        category: 'redirect_only',
        reason:
            'Tenant invite redeemer. Success → /t/<slug>/dashboard; ' +
            'failure → /invite/<token>?error=<msg>. Wrapping would ' +
            'replace the failure redirect with a JSON 4xx, breaking ' +
            'the invite-page error surface.',
    },
    {
        file: 'org/invite/[token]/accept-redirect/route.ts',
        category: 'redirect_only',
        reason:
            'Org invite redeemer. Mirrors the tenant accept-redirect ' +
            'contract: success → /org/<slug>; failure → /invite/org/<token>?error=<msg>.',
    },

    // ─── Anti-enumeration uniform-200 ───
    //
    // The endpoint MUST return the same body shape and status
    // regardless of internal outcome to avoid leaking whether an
    // account exists. A wrapper that converts internal throws into
    // a 500 would create a side channel.
    {
        file: 'auth/verify-email/resend/route.ts',
        category: 'anti_enumeration',
        reason:
            'Verification-email resend. Uniform 200 for every input ' +
            '(unknown email, already-verified, rate-limited, mailer ' +
            'down) so the response cannot be used to enumerate ' +
            'registered emails. Wrapping would break this invariant ' +
            'on internal throws.',
    },

    // ─── CSP report sinks ───
    //
    // Browsers send CSP reports without credentials and ignore the
    // body. Both endpoints always return 204 (and 401/413/429 for
    // rate-limit / size guards). They must never return our
    // ApiErrorResponse shape — there is no consumer that reads it
    // and the 204 invariant lets us never accidentally leak state.
    {
        file: 'csp-report/route.ts',
        category: 'csp_report_sink',
        reason:
            'Legacy CSP report endpoint. Best-effort forwards to the ' +
            '/api/security/csp-report sink and always returns 204.',
    },
    {
        file: 'security/csp-report/route.ts',
        category: 'csp_report_sink',
        reason:
            'Modern CSP report sink. Always returns 204 (or 413 for ' +
            'oversize, 429 for rate-limit). Browser fire-and-forget; ' +
            'no JSON consumer.',
    },

    // ─── External webhook receivers ───
    //
    // Each provider has its own signature scheme, idempotency model,
    // and retry semantics. The handlers return 200 even on processing
    // failure (after logging) to prevent provider retry storms; they
    // return 4xx only for auth/validation. Wrapping them converts
    // unrelated internal throws into the wrong shape from the
    // provider's perspective.
    {
        file: 'integrations/webhooks/[provider]/route.ts',
        category: 'external_webhook',
        reason:
            'Generic integration webhook dispatcher. Provider-specific ' +
            'auth_failed / invalid_provider error codes; raw body ' +
            'required for signature verification before any parsing.',
    },
    {
        file: 'stripe/webhook/route.ts',
        category: 'external_webhook',
        reason:
            'Stripe webhook. Raw body required for ' +
            'constructWebhookEvent signature check; returns 200 on ' +
            'processing failure to avoid Stripe retry storms.',
    },
    // The SP-4 Microsoft Graph change-notification receiver
    // (webhooks/sharepoint/route.ts) was deleted in GRC teardown phase 2 —
    // it verified clientState against `policy.spSubscriptionId` and enqueued
    // a policy pull, so it went with the POLICY half of the SharePoint
    // integration. The evidence delta-sync routes are untouched.
    {
        file: 'storage/av-webhook/route.ts',
        category: 'external_webhook',
        reason:
            'AV scanner callback. HMAC-SHA256 X-AV-Signature with ' +
            'timing-safe comparison; raw body required before JSON parse.',
    },

    // ─── SCIM 2.0 RFC 7644 ───
    //
    // SCIM mandates an error shape: `{ schemas: [...], status, scimType, detail }`.
    // It is not reconcilable with our `ApiErrorResponse`. SCIM
    // consumers (Okta, Entra ID, OneLogin) parse the SCIM shape;
    // wrapping these routes would break enterprise identity-sync.
    {
        file: 'scim/v2/ServiceProviderConfig/route.ts',
        category: 'scim_2_0',
        reason:
            'SCIM 2.0 ServiceProviderConfig. Public endpoint per RFC ' +
            '7644; never errors in normal operation.',
    },
    {
        file: 'scim/v2/Users/route.ts',
        category: 'scim_2_0',
        reason:
            'SCIM 2.0 Users collection. RFC 7644 error shape ' +
            '(urn:ietf:params:scim:api:messages:2.0:Error) is not ' +
            'compatible with ApiErrorResponse.',
    },
    {
        file: 'scim/v2/Users/[id]/route.ts',
        category: 'scim_2_0',
        reason:
            'SCIM 2.0 Users resource. Same RFC 7644 error contract as ' +
            'the collection endpoint.',
    },
    {
        file: 'scim/v2/Groups/route.ts',
        category: 'scim_2_0',
        reason:
            'EI-3 SCIM 2.0 Groups collection. RFC 7644 error shape, same as ' +
            'the Users endpoints — not compatible with ApiErrorResponse.',
    },
    {
        file: 'scim/v2/Groups/[id]/route.ts',
        category: 'scim_2_0',
        reason:
            'EI-3 SCIM 2.0 Groups resource. Same RFC 7644 error contract as ' +
            'the collection endpoint.',
    },

    // ─── Epic G-3 — public vendor questionnaire ───
    //
    // External respondent surface. Uniform `{ error, reason }`
    // contract that the public client renders into "this link is no
    // longer active" messaging — distinct guard reasons (expired,
    // wrong_status, unknown_assessment) intentionally collapse to
    // 401/410 without leaking which one tripped.

    // ─── Agro-intel — public data-stream ingestion ───
    //
    // Device-facing reading ingestion, gated by a per-stream ingest
    // token (SHA-256 hash compare) + the AGRO_DATASTREAMS_ENABLED flag.
    // Custom { error } shapes: 503 feature_disabled when the flag is
    // off, 400 invalid_body, and a UNIFORM 401 access_denied for every
    // token/stream failure (anti-enumeration — probing stream ids
    // without a valid token must not reveal which gate tripped). The
    // wrapper's generic ApiErrorResponse would break that uniform-401
    // contract on an internal throw.
    {
        file: 'agro/data-streams/[streamId]/ingest/route.ts',
        category: 'anti_enumeration',
        reason:
            'Public token-gated data-stream ingestion. Feature-flagged ' +
            '(503 feature_disabled) + per-stream ingest-token gate; ' +
            'collapses every token/stream failure to a uniform 401 ' +
            'access_denied to avoid leaking which gate tripped.',
    },

    // ─── Staging fixture ───
    //
    // Dev-/staging-only seed endpoint with its own token gate, body
    // shape, and E2E-script consumers. Production-disabled at the
    // route level (returns 403 if NODE_ENV=production).
    {
        file: 'staging/seed/route.ts',
        category: 'staging_fixture',
        reason:
            'Staging seed endpoint. NODE_ENV=production → 403; ' +
            'STAGING_SEED_TOKEN gate; bespoke success body shape ' +
            'consumed by E2E scripts.',
    },

    // ─── SSE streaming endpoints ───
    //
    // Server-Sent Events routes return a long-lived
    // `text/event-stream` ReadableStream — not a one-shot JSON
    // response. `withApiErrorHandling` is built around the
    // assumption that the handler returns a single JSON body it
    // can replace with the `ApiErrorResponse` shape on throw; it
    // can't wrap a streaming response without breaking the wire
    // format clients consume via `new EventSource(...)`. The auth
    // guard at the top of the handler (`getLegacyCtx`) throws
    // before the stream is constructed, surfacing as a standard
    // 401 — beyond that the stream's own per-chunk error handling
    // closes the connection cleanly via the abort signal.
    {
        file: 'notifications/stream/route.ts',
        category: 'sse_stream',
        reason:
            'SSE notification stream (PR-C 2026-05-27). Long-lived ' +
            'text/event-stream ReadableStream — cannot be wrapped by ' +
            'withApiErrorHandling without breaking the EventSource ' +
            'wire format. Auth via getLegacyCtx pre-stream; per-chunk ' +
            'errors close the channel via req.signal abort.',
    },
];
