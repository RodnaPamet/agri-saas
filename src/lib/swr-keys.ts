/**
 * Epic 69 — typed SWR cache-key registry.
 *
 * Single source of truth for every tenant-scoped SWR cache key the
 * client uses. Without this, adoption of `useTenantSWR` /
 * `useTenantMutation` is one good-intentions PR away from drift —
 * three components writing `/controls`, `/control`, `/Controls` and
 * none of them invalidating each other.
 *
 * Convention
 * ──────────
 *
 *   - Keys are TENANT-RELATIVE paths starting with `/`. The
 *     `/api/t/{slug}` prefix is added by `useTenantSWR` /
 *     `useTenantMutation` from the active TenantContext, so the
 *     same registry entry produces a different cache entry per
 *     tenant naturally.
 *
 *   - Every resource exposes `list()` and (where the API has a
 *     detail route) `detail(id)`. Sub-views are named methods
 *     beneath the resource (`controls.dashboard()`,
 *     `tasks.metrics()`, …) — never deeply nested objects, never
 *     a generic templating DSL.
 *
 *   - Methods return the literal string. The return type is
 *     deliberately `string` — readable, drops straight into the
 *     hook arg list, and composes with the `invalidate: string[]`
 *     option on `useTenantMutation`.
 *
 *   - `CACHE_KEYS` is `as const`, so IDE autocomplete shows every
 *     resource and every method on a single keystroke.
 *
 * Adding a new resource
 * ─────────────────────
 *
 *   1. Either reuse `makeResource('<base>')` for the standard
 *      list + detail pair, OR spell out the methods if the
 *      resource is irregular (no list, multiple detail keys, …).
 *   2. Spread sub-resource methods alongside if the resource has
 *      named views (`{ ...makeResource('x'), summary: () => '/x/summary' }`).
 *   3. NEVER hand-write `/api/t/${slug}/<path>` in a client
 *      component again — reach for `CACHE_KEYS.<resource>.<verb>()`
 *      and let the hook layer prefix.
 *
 * Non-goals (deliberate)
 * ──────────────────────
 *
 *   - This module does NOT do query-string assembly. Pages with
 *     filterable lists pass an extra path suffix or a query
 *     string to the hook directly — collapsing every filtered
 *     view into the registry would explode the surface.
 *   - This module does NOT carry the absolute URL. Keys must work
 *     for any tenant the user is currently scoped to; resolving
 *     them is the hook's job.
 *   - This module does NOT export hooks. It is data only — pages
 *     compose `CACHE_KEYS.<x>.<y>()` with `useTenantSWR` /
 *     `useTenantMutation` themselves.
 */

/**
 * Type alias for tenant-relative cache keys — every method below
 * returns one of these. Pages that hold keys in arrays
 * (`invalidate: [CACHE_KEYS.risks.list(), CACHE_KEYS.tasks.list()]`)
 * can declare the variable as `CacheKey[]` for clarity.
 */
export type CacheKey = string;

/**
 * Standard resource shape — list + detail. The two endpoints almost
 * every CRUD-style resource exposes. Resources without a detail
 * route can spell out just `list()` directly instead of using this
 * factory.
 */
interface ResourceKeys {
    list: () => CacheKey;
    detail: (id: string) => CacheKey;
}

function makeResource(base: string): ResourceKeys {
    return {
        list: () => `/${base}`,
        detail: (id: string) => `/${base}/${id}`,
    };
}

export const CACHE_KEYS = {
    // ─── Compliance core ─────────────────────────────────────────
    controls: {
        ...makeResource('controls'),
        dashboard: () => '/controls/dashboard' as const,
        templates: () => '/controls/templates' as const,
        consistencyCheck: () => '/controls/consistency-check' as const,
        /**
         * Combined detail-page payload — `/controls/{id}/page-data`
         * collapses the prior detail + sync-status waterfall into
         * one round-trip. Used as the single SWR cache key for the
         * detail page; mutations on the detail page invalidate this
         * (not `detail(id)`) since the page never reads the bare
         * detail endpoint.
         */
        pageData: (id: string) => `/controls/${id}/page-data` as const,
        activity: (id: string) => `/controls/${id}/activity` as const,
        // #102 item 1 — per-tab lazy fetches. The detail page's
        // Tasks / Evidence / Mappings tabs each read their own slice
        // on demand instead of off the eager page-data payload.
        tasks: (id: string) => `/controls/${id}/tasks` as const,
        evidence: (id: string) => `/controls/${id}/evidence` as const,
        mappings: (id: string) => `/controls/${id}/requirements` as const,
    },
    risks: makeResource('risks'),
    evidence: {
        ...makeResource('evidence'),
        metrics: () => '/evidence/metrics' as const,
        files: () => '/evidence/files' as const,
        retention: () => '/evidence/retention' as const,
    },
    policies: {
        ...makeResource('policies'),
        templates: () => '/policies/templates' as const,
    },
    tasks: {
        ...makeResource('tasks'),
        metrics: () => '/tasks/metrics' as const,
    },
    vendors: {
        ...makeResource('vendors'),
        metrics: () => '/vendors/metrics' as const,
    },
    assets: makeResource('assets'),
    // ─── Agriculture (Feature 1 — spray-prescription map) ───
    locations: {
        ...makeResource('locations'),
        parcels: (id: string) => `/locations/${id}/parcels` as const,
        operations: (id: string) => `/locations/${id}/operations` as const,
        smartDefaults: (id: string) => `/locations/${id}/smart-defaults` as const,
    },
    fieldOperations: {
        detail: (taskId: string) => `/field-operations/${taskId}` as const,
    },
    journal: makeResource('journal'),
    items: () => '/items' as const,
    units: () => '/units' as const,
    findings: makeResource('findings'),
    frameworks: makeResource('frameworks'),
    // Схеми — government support schemes (ДФЗ / МЗХ / EC measures a farm
    // applies for), served from `/schemes`. This key used to address the
    // CERTIFICATION scheme catalog; that surface was removed with the
    // compliance uproot and support measures took over the route, so there
    // is now exactly ONE `schemes` resource and no second cache bucket.
    schemes: makeResource('schemes'),
    issues: makeResource('issues'),
    // ─── Market-price trends (global, tenant-agnostic payload) ───
    // `/trends/prices?commodity=&range=` — the query string IS part of the
    // cache key (per-commodity + per-range buckets dedupe naturally). This is
    // the one place the registry carries a query string; the swr-keys "no
    // query-string assembly" non-goal is relaxed here because the filter axes
    // (commodity, range) are a fixed 4×4 grid, not an open-ended filter set.
    trends: {
        prices: (commodity: string, range: string) =>
            `/trends/prices?commodity=${commodity}&range=${range}` as const,
        // `/trends/news?category=` — the News tab feed. `category` is one of the
        // fixed buckets or 'all' (default), so like `prices` the query axis is a
        // small closed set, not an open-ended filter.
        news: (category: string) => `/trends/news?category=${category}` as const,
    },

    // ─── Self-service per-user data ───
    me: {
        // `/me/interests` — the user's chosen News "For You" keywords. Own data
        // (tenant + user scoped server-side); no query axis.
        interests: () => '/me/interests' as const,
    },

    // ─── Workflow automation (Automation Epics 1–10) ─────────────
    automation: {
        rules: {
            list: () => '/automation/rules' as const,
            detail: (id: string) => `/automation/rules/${id}` as const,
            executions: (id: string) => `/automation/rules/${id}/executions` as const,
        },
        templates: () => '/automation/templates' as const,
        analytics: () => '/automation/analytics' as const,
        executions: {
            live: () => '/automation/executions/live' as const,
        },
        // VR-9 — AI rule suggestions (Control-page right rail).
        suggestions: () => '/ai/automation-suggestions' as const,
    },

    // ─── Processes / canvas (R25+ · Visual Rule Editor) ──────────
    processes: {
        // VR-10 — cross-map governance meta-graph.
        governanceGraph: () => '/processes/governance-graph' as const,
    },

    // ─── Audit lifecycle ────────────────────────────────────────
    audits: {
        ...makeResource('audits'),
        readiness: () => '/audits/readiness' as const,
        cycles: () => '/audits/cycles' as const,
        packs: () => '/audits/packs' as const,
    },

    // ─── Dashboards & overview surfaces ─────────────────────────
    //
    // These don't follow the list/detail shape because they're
    // composite read-models, so they get bespoke methods.
    dashboard: {
        home: () => '/dashboard' as const,
        executive: () => '/dashboard/executive' as const,
        trends: () => '/dashboard/trends' as const,
        // Agriculture strip — recent journal + low-stock + my farm tasks,
        // gated by the tenant's enabled modules. Read by <AgDashboardStrip>.
        ag: () => '/dashboard/ag' as const,
        // Farm-task "created vs completed" daily trend. Read by <TasksTrendCard>.
        taskTrend: () => '/dashboard/task-trend' as const,
    },
    coverage: {
        home: () => '/coverage' as const,
    },

    // ─── Cross-cutting ──────────────────────────────────────────
    auditLog: {
        list: () => '/audit-log' as const,
    },
    notifications: {
        list: () => '/notifications' as const,
        settings: () => '/notification-settings' as const,
    },
    search: {
        query: () => '/search' as const,
    },
    traceability: {
        graph: () => '/traceability' as const,
    },
} as const;

/**
 * Re-exported shape for code that wants the registry's value type
 * (e.g. when threading the registry through a generic helper). Use
 * sparingly — most callers should reach into `CACHE_KEYS.x.y()`
 * directly so the IDE can autocomplete.
 */
export type CacheKeyRegistry = typeof CACHE_KEYS;
