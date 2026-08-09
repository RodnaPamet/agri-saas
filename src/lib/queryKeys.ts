/**
 * Tenant-scoped cache key factory.
 *
 * Convention:
 *   [entity, tenantSlug, scope, ...params]
 *
 * Every key includes tenantSlug so cache is automatically isolated per tenant.
 * Use queryKeys.<entity>.list / .detail for consistency across the app.
 */

export const queryKeys = {
    practices: {
        all: (tenantSlug: string) => ['practices', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['practices', tenantSlug, 'list', filters ?? {}] as const,
        detail: (tenantSlug: string, practiceId: string) =>
            ['practices', tenantSlug, 'detail', practiceId] as const,
    },
    evidence: {
        all: (tenantSlug: string) => ['evidence', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['evidence', tenantSlug, 'list', filters ?? {}] as const,
    },
    tasks: {
        all: (tenantSlug: string) => ['tasks', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['tasks', tenantSlug, 'list', filters ?? {}] as const,
        detail: (tenantSlug: string, taskId: string) =>
            ['tasks', tenantSlug, 'detail', taskId] as const,
    },
    policies: {
        all: (tenantSlug: string) => ['policies', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['policies', tenantSlug, 'list', filters ?? {}] as const,
    },
    risks: {
        all: (tenantSlug: string) => ['risks', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['risks', tenantSlug, 'list', filters ?? {}] as const,
    },
    assets: {
        all: (tenantSlug: string) => ['assets', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['assets', tenantSlug, 'list', filters ?? {}] as const,
        /** Daily KPI snapshot series backing the Assets-page sparklines. */
        trends: (tenantSlug: string) => ['assets', tenantSlug, 'trends'] as const,
    },
    vendors: {
        all: (tenantSlug: string) => ['vendors', tenantSlug] as const,
        list: (tenantSlug: string, filters?: Record<string, string>) =>
            ['vendors', tenantSlug, 'list', filters ?? {}] as const,
        detail: (tenantSlug: string, vendorId: string) =>
            ['vendors', tenantSlug, 'detail', vendorId] as const,
    },
    frameworks: {
        all: (tenantSlug: string) => ['frameworks', tenantSlug] as const,
        list: (tenantSlug: string) =>
            ['frameworks', tenantSlug, 'list'] as const,
    },
    audits: {
        all: (tenantSlug: string) => ['audits', tenantSlug] as const,
        list: (tenantSlug: string) =>
            ['audits', tenantSlug, 'list'] as const,
    },
    findings: {
        all: (tenantSlug: string) => ['findings', tenantSlug] as const,
        list: (tenantSlug: string) =>
            ['findings', tenantSlug, 'list'] as const,
    },
    members: {
        all: (tenantSlug: string) => ['members', tenantSlug] as const,
        list: (tenantSlug: string) =>
            ['members', tenantSlug, 'list'] as const,
    },
    calendar: {
        all: (tenantSlug: string) => ['calendar', tenantSlug] as const,
        range: (tenantSlug: string, from: string, to: string) =>
            ['calendar', tenantSlug, 'range', from, to] as const,
        upcomingCount: (tenantSlug: string) =>
            ['calendar', tenantSlug, 'upcoming-count'] as const,
    },
} as const;
