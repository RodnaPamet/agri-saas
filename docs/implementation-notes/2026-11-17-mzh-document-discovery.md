# 2026-11-17 — МЗХ document discovery (agri-saas#3146, second slice)

## Design

A daily job (`source-document-discovery`, 05:10 UTC) reads the pages where МЗХ
LISTS each publication series and emails the owner what is new (owner,
2026-11-17: "email me"). `source-document-watch` (first slice) watches the
documents we already cite for revision; this one notices what МЗХ publishes.

Listings, located 2026-11-17 (`src/lib/sources/mzh-listings.ts`):

| series | page |
|---|---|
| «Оперативен анализ» | `/bg/ikonomicheski-analizi/tekushi-operativni-analizi-…/` |
| technology cards | `/bg/sektori/rastenievadstvo/tehnologichni-karti/` |
| «Аграрен доклад» | `/bg/politiki-i-programi/otcheti-i-dokladi/agraren-doklad/` |
| coupled-support orders, integrated-production guides | `/bg/press-center/novini/` (3 pages), by TITLE |

## Files

| File | Role |
|---|---|
| `src/lib/sources/mzh-listings.ts` | listing config, PDF/news parsers, news title → series |
| `src/app-layer/jobs/source-document-discovery.ts` | the job: read, baseline, record, email, stamp |
| `prisma/schema/market.prisma` | `SourceDocumentDiscovery`, `SourceListingRead` |
| `MZH_WATCH_NOTIFY_EMAIL` | the owner's address; unset = record only, send nothing |

## Decisions

- **Baseline on a listing's first read**, so switching it on does not mail the
  back catalogue. "First read" is a row in `SourceListingRead`, NOT "the
  listing has documents": the news list records only matching items, so a
  first read with no match leaves nothing, and judging by documents would have
  baselined the first real support order silently. The unit test caught it.
- **Stamp after the send**, the `notice-triage-alert` rule; with no address
  nothing is stamped, so setting the address later announces what was found.
- **A listing that is unreachable or parses to zero links is reported by name**
  in one `mzh-discovery.run` line with every denominator — a zero from this
  publisher is a changed page (#3165 was a silent zero), not a quiet day.
- **The series comes from the listing (or the news title), never the
  filename** — #3154 measured МЗХ's filenames as unreliable.
- **Both coupled-support words required** in a news title: «ставк…» alone
  matches the national aid for sheep, which is not an order of this series.
