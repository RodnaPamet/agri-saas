# 2026-07-15 — Trends → News tab (RSS agri-news card feed)

**Commit:** `<sha>` feat(trends): News tab — RSS agri-news card feed

## Design

The Trends page (#305) shipped with a two-tab shell — Prices (built) and a
News placeholder. This fills the News tab with an attribution-first,
scrollable card feed of agri-news headlines aggregated from third-party
RSS/Atom feeds.

Data flow mirrors the market-prices backbone (#303) exactly, because
`MarketNewsItem` is the same class of object as `MarketPriceSeries`:

```
MARKET_NEWS_FEEDS ──► news-pull job (~2h) ──► MarketNewsItem (GLOBAL cache)
                         fetch → parse → sanitise → upsert(urlHash) → prune 90d
                                                             │
GET /api/t/{slug}/trends/news?cursor= ◄── getMarketNews() ◄──┘ (Redis 15m)
        │  (getTenantCtx gate; payload tenant-agnostic)
        ▼
NewsTab (CardList feed) — useTenantSWR head page + useCursorPagination
        stretched <a target=_blank rel=noopener> per card → publisher
```

`MarketNewsItem` carries **no tenantId** (public headlines, identical for
every tenant) — the DMMF RLS auto-enroller leaves tenantId-less models out
of `TENANT_SCOPED_MODELS`, so no RLS policy and **no exception-list entry**
is needed (confirmed against how `MarketPriceSeries` is handled). Reads use
the global `prisma` client (allowlisted in `no-direct-prisma.test.ts`
alongside `trends.ts`).

### Legal frame (why RSS)

We store + render **only** title + short snippet (capped 300 chars) + source
+ link, and every card links **out** to the publisher in a new tab. No
full-text republication, no scraping of paywalled/partner content.
**agroportal.bg is never fetched** — its price content is an exclusive
brokerage partnership. `MARKET_NEWS_FEEDS` is operator-configured; the two
verified-working BG feeds are documented as the suggested default.

### Verified feeds (smoke-tested on the prod VM, 200 + valid RSS 2.0)

- `https://www.agro.bg/rss` — channel "АГРО.БГ"
- `https://agrozona.bg/feed` — channel "Agrozona.bg"

agri.bg / fermer.bg / sinor.bg return 403 to server User-Agents — **not**
hardcoded; an operator can add any feed that serves a UA-agnostic RSS/Atom.

## Files

| File | Role |
|---|---|
| `prisma/schema/market.prisma` | `MarketNewsItem` model (GLOBAL, `@@index([publishedAt])`, unique `urlHash`) |
| `prisma/migrations/20260715130000_market_news/migration.sql` | Table + indexes (no RLS — tenantId-less) |
| `src/lib/market/news-feed-client.ts` | Pure `parseFeedXml` (RSS 2.0 + Atom) + `fetchNewsFeed` (UA + timeout) |
| `src/app-layer/jobs/news-pull.ts` | Fetch → sanitise → upsert(urlHash) → prune 90d; per-feed error isolation |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | Register `news-pull` (every 2h) |
| `src/env.ts` + `deploy/env.prod.example` | `MARKET_NEWS_FEEDS` (optional, server-only) |
| `src/app-layer/usecases/trends-news.ts` | `getMarketNews(cursor)` — keyset page, Redis 15m |
| `src/app-layer/schemas/trends.schemas.ts` | `TrendNewsQuerySchema` + `NEWS_PAGE_SIZE` |
| `src/app/api/t/[tenantSlug]/trends/news/route.ts` | Tenant-authed cursor GET |
| `src/components/trends/NewsTab.tsx` | Card feed + infinite scroll + empty/operator/error states |
| `src/components/trends/TrendsPageClient.tsx`, `.../trends/page.tsx` | Thread `newsConfigured` server→client |
| `prisma/seed.ts` | 3 demo `MarketNewsItem` rows (dev + e2e feed render) |
| `messages/{en,bg}.json` | `trends.news.*` (real Bulgarian) |
| `tests/regression/infrastructure-guards.test.ts` | Scheduled-job count 26 → **27** + `news-pull` in the name set |

## Decisions

- **Parser: `@xmldom/xmldom` (already a dep — zero new deps).** The only
  in-repo XML parser (used by `src/lib/spatial/parse.ts`). Handles RSS 2.0
  `<item>` and Atom `<entry>`; tolerates empty `<description>`, `http`
  links, and unparseable dates (→ null). A malformed document yields an
  empty item list rather than throwing — per-feed isolation leans on this.
- **Sanitisation at the job (Epic C.5).** RSS is untrusted remote HTML, so
  title + snippet (and the source label) run through `sanitizePlainText`
  **before** persist, then the snippet is capped at 300 chars. Article URLs
  are restricted to `http(s)` (drops `javascript:`/`data:`). Unit-tested
  with `<script>` / `<img onerror>` fixtures.
- **`newsConfigured` computed server-side.** `page.tsx` reads
  `env.MARKET_NEWS_FEEDS` (server-only — URLs never reach the client) and
  passes a boolean. When feeds are unconfigured **and** the cache is empty,
  the tab shows an operator-configuration hint. The tab itself stays present
  (the 2-tab shell + `single-tab-pattern`/drift guards depend on it) — a
  deliberate softening of "hide the tab when unset": the read side depends
  on cache rows, not the env, so an operator hint is the honest unconfigured
  signal and the feed still renders once rows exist.
- **Keyset pagination by `(publishedAt desc, id desc)`.** `id` is the stable
  tiebreak and the opaque cursor; the API returns `{ items, nextCursor }`.
  The UI seeds `useCursorPagination` from the SWR head page and auto-loads
  via `useInViewport` with a manual "Load more" fallback (jsdom / no-IO).
- **Attribution derived from loaded rows, not env.** The per-card source
  badge and the "Sources: …" footer read the distinct `feedSource` values
  present in the feed — accurate publisher attribution without exposing the
  configured feed URLs.
- **Whole-card stretched `<a target=_blank rel=noopener noreferrer>`** inside
  the shared `CardList.Card` — the entire card is a ≥44px tap target that
  opens the publisher in a new tab, with an external-link affordance icon.
