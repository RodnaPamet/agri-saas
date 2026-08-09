/**
 * Epic 49 — Compliance Calendar schemas + DTOs.
 *
 * Defines the unified CalendarEvent DTO that powers the heatmap,
 * monthly grid, and Gantt timeline; plus the Zod query schema for the
 * `GET /api/t/[tenantSlug]/calendar` route.
 *
 * Design principles:
 *
 *   1. ONE event shape for many views. Heatmap counts events per day,
 *      Month renders dots per day with click-through, Gantt projects
 *      events with a `start..end` window. The same DTO serves all.
 *
 *   2. Sources are pre-existing entities (no new tables). Each entity
 *      contributes a date field; the usecase normalises them all into
 *      this shape.
 *
 *   3. Click-through is encoded as `href` (tenant-relative). The UI
 *      doesn't need to know how to build URLs per entity type.
 *
 *   4. `category` drives color/icon — UI-stable enum; never echo a raw
 *      Prisma status enum here.
 */

import { z } from 'zod';

// ─── Event categories ────────────────────────────────────────────────

/**
 * High-level category that drives icon + dot color in the UI. Each
 * category corresponds to a domain area; the UI maps category → color
 * via a single token table (avoids per-entity-type styling drift).
 */
export const CALENDAR_EVENT_CATEGORIES = [
    'evidence',
    'policy',
    'vendor',
    'audit',
    'control',
    'task',
    'risk',
    'finding',
    // Agriculture data sources (PR 2 of the calendar roadmap) — the
    // 13 date-bearing ag models this product actually runs on.
    // `farm-task` splits off from `task`: a Task with
    // `type: 'FARM_TASK'` is field work, not a compliance to-do, and
    // deserves its own colour + vocabulary.
    'farm-task',
    'lease',
    'contract',
    'planting',
    'agro-signal',
    // Curated agriculture catalogue — fairs, trainings, webinars, subsidy
    // deadlines. Unlike every other category these are GLOBAL rows, not
    // tenant facts, and they link off-site.
    'agri-event',
    // AI news-derived calendar events (calendar roadmap PR 3) — GLOBAL,
    // like `agri-event`, but with a fundamentally different provenance:
    // an `agri-event` is a human curator's assertion; this is a machine
    // extraction from a news article, surfaced only once a platform admin
    // approves it. See `CalendarEvent.provenance` below — every event in
    // this category carries `provenance: 'ai-news'`.
    'ai-news',
] as const;

export type CalendarEventCategory =
    (typeof CALENDAR_EVENT_CATEGORIES)[number];

/**
 * Specific event type — finer-grained than category. Powers tooltip
 * copy ("Vendor renewal", "Policy review", …). Each maps to exactly
 * one category; many events of different types may share a category.
 */
export const CALENDAR_EVENT_TYPES = [
    // evidence
    'evidence-expiry',
    'evidence-review',
    // policy
    'policy-review',
    // vendor
    'vendor-review',
    'vendor-renewal',
    'vendor-document-expiry',
    // audit
    'audit-cycle',
    // control
    'control-review',
    // task
    'task-due',
    // farm-task — Task rows with type: 'FARM_TASK'. Same source model as
    // `task-due`, split by `Task.type` at the loader so field work reads
    // "Farm task due" instead of "Task due" and dots a different colour.
    'farm-task-due',
    // risk
    'risk-review',
    'risk-target',
    // Epic G-7 — treatment plans + milestones live under the risk
    // category but get their own type so the tooltip + colour can
    // distinguish them from review/target events on the parent risk.
    'treatment-milestone-due',
    'treatment-plan-target',
    // finding
    'finding-due',
    // lease — ParcelLease.startDate -> endDate (duration).
    'parcel-lease-term',
    // contract — Contract.deliveryStart -> deliveryEnd (duration).
    'contract-delivery-window',
    // planting — Planting.sowDate -> harvestEndDate (duration).
    'planting-cycle',
    // agro-signal — AgroSignal.signalDate (point). Two types, not one:
    // mirrors the AgriEvent category map below — enumerating both
    // AgroSignalKind values here is deliberate, so a third kind added to
    // the enum is a compile error at the mapper rather than a silently
    // mis-toned dot.
    'agro-signal-spray-window',
    'agro-signal-disease-risk',
    // agri-event — mirrors AgriEvent.category, which is a free string on
    // the model. Enumerating the four curated values here is deliberate:
    // an unmapped value becomes a compile error at the mapper rather than
    // a silently mis-toned dot.
    'agri-fair',
    'agri-training',
    'agri-webinar',
    'agri-subsidy-deadline',
    // ai-news — mirrors NewsDerivedEvent.kind, a free string on the model
    // validated against NEWS_DERIVED_EVENT_KINDS at the extractor boundary.
    // Enumerating both values here is deliberate: a third kind added to
    // that tuple is a compile error at the mapper, not a silently
    // mis-toned dot.
    'ai-news-subsidy-deadline',
    'ai-news-regulation-effective',
] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

/**
 * Status drives whether the event renders in muted (`done`),
 * neutral (`scheduled`), warning (`upcoming`/`due_soon`), or danger
 * (`overdue`) styling. `unknown` is for events whose linked entity
 * doesn't carry a clear status semantic.
 */
export const CALENDAR_EVENT_STATUSES = [
    'scheduled',
    'due_soon',
    'overdue',
    'done',
    'unknown',
] as const;

export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

// ─── Public DTO ──────────────────────────────────────────────────────

/**
 * One unified compliance-calendar event. Every event is either a
 * point-in-time (`date`) or a duration (`start` + `end`). Renderers
 * can branch on the presence of `end` to decide between dot vs bar.
 */
export interface CalendarEvent {
    /** Stable composite id: `${entityType}:${entityId}:${type}`. */
    id: string;
    type: CalendarEventType;
    category: CalendarEventCategory;
    /**

     * i18n key under `calendar.event.*`, resolved by the RENDERER.

     *

     * Titles used to be built here as English strings ("Evidence review: X"),

     * which shipped English to a Bulgarian-first product — and the

     * hardcoded-string ratchet never caught them because it scans only

     * src/app and src/components, not the app layer.

     *

     * Curator-supplied text (the agriculture catalogue) uses the passthrough

     * key whose message is just "{name}", so every event has one shape.

     */

    titleKey: string;

    /** Interpolation values for `titleKey`. */

    titleParams?: Record<string, string>;
    /**
     * Point-in-time date for events without a duration. ISO 8601 date
     * string (UTC midnight) for day-resolution events; ISO datetime is
     * accepted but truncated to day in the UI.
     */
    date: string;
    /** End date for duration events (Gantt). When set, `date` is the start. */
    end?: string;
    status: CalendarEventStatus;
    /** Source entity classification (drives detail navigation). */
    entityType:
        | 'EVIDENCE'
        | 'POLICY'
        | 'VENDOR'
        | 'VENDOR_DOCUMENT'
        | 'AUDIT_CYCLE'
        | 'CONTROL'
        | 'TASK'
        | 'RISK'
        | 'RISK_TREATMENT_PLAN'
        | 'TREATMENT_MILESTONE'
        | 'FINDING'
        | 'PARCEL_LEASE'
        | 'CONTRACT'
        | 'PLANTING'
        | 'AGRO_SIGNAL'
        | 'AGRI_EVENT'
        | 'NEWS_DERIVED_EVENT'
        // A government support-scheme application window. Reuses the existing
        // subsidy-deadline calendar TYPES (a deadline is a deadline whatever
        // produced it) but needs its own entityType so the side panel can link
        // back to /schemes rather than to a news article.
        | 'SUPPORT_SCHEME';
    entityId: string;
    /**
     * Tenant-relative href for click-through. The route handler builds
     * these with the resolved `tenantSlug`; UI consumers do NOT
     * concatenate slugs themselves.
     */
    href: string;
    /**
     * True when `href` points OFF-SITE (an AgriEvent's organiser page).
     * Consumers must render these with a plain anchor: next/link cannot
     * take an external URL. Absent/false means the tenant-relative
     * default, which stays on next/link for client-side navigation.
     */
    external?: boolean;
    /** Optional extra context for tooltips (assignee, framework, …). */
    detail?: string;
    /**
     * Optional owner user id (for filtering "my deadlines" + the
     * deadline monitor's notification routing).
     */
    ownerUserId?: string;
    /**
     * AI-derived provenance marker (calendar roadmap PR 3). ABSENT for
     * every other event on the calendar — those are DATABASE FACTS a
     * human entered or a tenant's own data produced. Present (always
     * `'ai-news'` today) ONLY for a `NewsDerivedEvent` the extraction job
     * proposed and a platform admin approved. A renderer MUST treat this
     * field's presence as the signal to show a distinct style and a
     * mandatory source citation — never render an `ai-news` event
     * identically to a system-of-record one.
     */
    provenance?: 'ai-news';
    /**
     * Model confidence (0..1) the extracted date is correct. Set ONLY
     * alongside `provenance: 'ai-news'`.
     */
    confidence?: number;
    /**
     * Citation for `provenance: 'ai-news'` — the source news article.
     * Duplicates `href` when the event also links off-site (it does
     * today), kept as its own field so a renderer's "Source:" line has a
     * stable, unambiguous read regardless of what `href` is doing.
     */
    sourceUrl?: string;
}

// ─── Zod schemas ─────────────────────────────────────────────────────

/**
 * Query string for `GET /calendar`. Range is required so the API never
 * scans unbounded date ranges. `from`/`to` are accepted as either YYYY-MM-DD
 * (day boundary, treated as UTC midnight) or full ISO datetimes.
 */
export const CalendarQuerySchema = z
    .object({
        from: z.string().min(8, 'from is required (YYYY-MM-DD or ISO date)'),
        to: z.string().min(8, 'to is required (YYYY-MM-DD or ISO date)'),
        types: z
            .preprocess(
                (v) => (typeof v === 'string' ? v.split(',') : v),
                z.array(z.enum(CALENDAR_EVENT_TYPES)),
            )
            .optional(),
        categories: z
            .preprocess(
                (v) => (typeof v === 'string' ? v.split(',') : v),
                z.array(z.enum(CALENDAR_EVENT_CATEGORIES)),
            )
            .optional(),
    })
    .superRefine((data, ctx) => {
        const from = new Date(data.from);
        const to = new Date(data.to);
        if (Number.isNaN(from.getTime())) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['from'],
                message: 'from is not a valid date',
            });
        }
        if (Number.isNaN(to.getTime())) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: 'to is not a valid date',
            });
        }
        if (
            !Number.isNaN(from.getTime()) &&
            !Number.isNaN(to.getTime()) &&
            to.getTime() < from.getTime()
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: 'to must be on or after from',
            });
        }
        // Hard cap: 2 years. Keeps the aggregation bounded — heatmap
        // typically asks for 12 months, Gantt for 6 months. Anyone
        // asking for more is probably making a mistake.
        const MAX_RANGE_MS = 366 * 2 * 86_400_000;
        if (
            !Number.isNaN(from.getTime()) &&
            !Number.isNaN(to.getTime()) &&
            to.getTime() - from.getTime() > MAX_RANGE_MS
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: 'date range exceeds 2-year cap',
            });
        }
    });

export type CalendarQueryInput = z.infer<typeof CalendarQuerySchema>;

/**
 * Response payload — `events` plus a small summary that the heatmap
 * pre-aggregates client-side, but the API surface includes counts so
 * a low-bandwidth client (e.g., mobile widget) doesn't need every event.
 */
export interface CalendarResponse {
    events: CalendarEvent[];
    counts: {
        total: number;
        byCategory: Record<CalendarEventCategory, number>;
        byStatus: Record<CalendarEventStatus, number>;
    };
    range: {
        from: string;
        to: string;
    };
    /**
     * True when AT LEAST ONE source hit its `perSourceLimit` cap. Every
     * loader requests `limit + 1` rows and reports truncation if it got
     * the extra one back (the same +1 trick `getUpcomingDeadlineCount`
     * uses for the badge) — cheaper than a second COUNT query. A
     * truncated response still contains every source's first `limit`
     * rows in a stable, date-ordered set (never an arbitrary slice), so
     * the UI can say "this schedule is partial" rather than silently
     * rendering it as complete.
     */
    truncated: boolean;
}
