import { z } from 'zod';

/**
 * AI news-derived calendar events (calendar roadmap PR 3). `NewsDerivedEvent`
 * is a GLOBAL table (no tenantId, like `AgriEvent`) populated exclusively by
 * the daily `news-event-extraction` job — see
 * `src/app-layer/ai/news-event-extractor.ts`.
 *
 * `NewsDerivedEvent.kind` is a plain `String` column, so the *type* system
 * cannot stop a typo. This module is the single place the curated set is
 * spelled, mirroring `agri-event.schemas.ts`'s `AGRI_EVENT_CATEGORIES` — both
 * the extractor's forced-tool schema AND the calendar loader's exhaustive
 * `Record<NewsDerivedEventKind, CalendarEventType>` map key off this tuple.
 */
export const NEWS_DERIVED_EVENT_KINDS = ['subsidy-deadline', 'regulation-effective'] as const;

export type NewsDerivedEventKind = (typeof NEWS_DERIVED_EVENT_KINDS)[number];

export const NewsDerivedEventKindSchema = z.enum(NEWS_DERIVED_EVENT_KINDS);

export const NEWS_DERIVED_EVENT_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const;

export type NewsDerivedEventStatus = (typeof NEWS_DERIVED_EVENT_STATUSES)[number];

export const NewsDerivedEventStatusSchema = z.enum(NEWS_DERIVED_EVENT_STATUSES);

/** Query params for `GET /api/admin/news-derived-events`. */
export const ListNewsDerivedEventsQuerySchema = z.object({
    status: NewsDerivedEventStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListNewsDerivedEventsQuery = z.infer<typeof ListNewsDerivedEventsQuerySchema>;

/** Platform-admin-facing DTO — the review queue + the calendar loader both read this shape. */
export interface NewsDerivedEventDto {
    id: string;
    title: string;
    kind: NewsDerivedEventKind;
    eventDate: string;
    confidence: number;
    sourceExcerpt: string;
    sourceNewsItemId: string;
    sourceUrl: string;
    sourceTitle: string;
    status: NewsDerivedEventStatus;
    reviewedAt: string | null;
    reviewedBy: string | null;
    createdAt: string;
}
