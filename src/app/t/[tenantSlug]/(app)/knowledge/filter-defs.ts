/**
 * Knowledge Base list page filter configuration.
 *
 * Mirrors `policies/filter-defs.ts` (the Knowledge feature is the
 * policy feature's twin — versioned articles with a publish lifecycle
 * + per-reader acknowledgements). Keys map onto the
 * `GET /api/t/{slug}/knowledge` query (q + status + category).
 *
 * The article status enum is narrower than the policy one:
 * `DRAFT | PUBLISHED | ARCHIVED` (no IN_REVIEW / APPROVED approval
 * stages — acknowledgement, not approval, is the readership gate).
 *
 * Labels are i18n'd (2026-08-07): the static defs below carry NO
 * English copy — only the filter KEYS need to exist at module load,
 * before any translator is available (`createTypedFilterDefs` needs a
 * real object to infer the key union from). `buildKnowledgeFilters`
 * resolves the real facet labels/descriptions AND the enum-member
 * labels through two translators at render time, mirroring
 * `grain/contracts/filter-defs.ts::buildContractFilters` — one source
 * of truth per label, so the filter chip and the status badge two
 * columns away can never drift into disagreeing Bulgarian translations.
 */

import type { FilterDefInput, FilterDef } from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs } from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { CircleDot, Tag } from 'lucide-react';

/** `KnowledgeArticleStatus` enum member values — the single source of
 *  truth for the filter picker AND the row/version badge label
 *  lookup. Labels resolve through `articleStatusOptions` /
 *  `knowledge.status.<MEMBER>`, never a hardcoded English literal. */
export const KNOWLEDGE_ARTICLE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

/** A next-intl translator scoped to `knowledge.filters` — the facet
 *  labels/descriptions ("Status", "Category", …). */
type FacetTranslator = (key: string) => string;

/** A next-intl translator scoped to `knowledge.status` — the ENUM
 *  MEMBER labels, the same keys the list-page badge + detail-page
 *  version history resolve. */
export type StatusTranslator = (key: string) => string;

/** `{ value, label }` options for the three KnowledgeArticleStatus
 *  members, translated. */
export function articleStatusOptions(t: StatusTranslator): FilterOption[] {
    return KNOWLEDGE_ARTICLE_STATUSES.map((value) => ({ value, label: t(value) }));
}

const STATIC_DEFS = {
    status: {
        // Empty placeholders — never rendered directly, always replaced
        // by `buildKnowledgeFilters` before the toolbar mounts. See the
        // file header for why they can't hold real copy at module load.
        label: '',
        description: '',
        group: 'Attributes',
        icon: CircleDot,
        options: null,
        multiple: true,
        resetBehavior: 'clearable',
    },
    category: {
        label: '',
        description: '',
        group: 'Attributes',
        icon: Tag,
        options: null, // derived from loaded rows
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const knowledgeFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const KNOWLEDGE_FILTER_KEYS = knowledgeFilterDefs.filterKeys;

interface ArticleLike {
    category?: string | null;
}

export function categoryOptionsFromArticles(
    articles: ReadonlyArray<ArticleLike>,
): FilterOption[] {
    const seen = new Set<string>();
    for (const a of articles) {
        const c = a.category?.trim();
        if (c) seen.add(c);
    }
    return Array.from(seen)
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
}

/**
 * Produce the FilterDef[] array FilterToolbar consumes, with real
 * translated labels/descriptions/options.
 *
 * Takes TWO translators, deliberately:
 *   - `t`       (`knowledge.filters`) for the FACET labels — "Status" /
 *                "Category".
 *   - `tStatus` (`knowledge.status`)  for the ENUM MEMBER labels, the
 *                same keys the list-page badge resolves.
 */
export function buildKnowledgeFilters(
    t: FacetTranslator,
    tStatus: StatusTranslator,
    articles: ReadonlyArray<ArticleLike>,
): FilterDef[] {
    const categoryOpts = categoryOptionsFromArticles(articles);
    return knowledgeFilterDefs.filters.map((f) => {
        if (f.key === 'status') {
            return {
                ...f,
                label: t('statusLabel'),
                description: t('statusDescription'),
                options: articleStatusOptions(tStatus),
            };
        }
        if (f.key === 'category') {
            return {
                ...f,
                label: t('categoryLabel'),
                description: t('categoryDescription'),
                options: categoryOpts,
            };
        }
        return f;
    });
}
