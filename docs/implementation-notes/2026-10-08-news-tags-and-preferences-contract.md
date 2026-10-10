# Новини: tags, per-person preferences, and search — the contract

**Status:** proposed, for review by agrent-ios and the owner before any of it is built.
**Date:** 2026-10-08.
**Owner decisions this implements** (relayed via agrent-ios, confirmed to backend-1 directly): tags come from the server's keyword rules, several per article; preferences live on the server, per person, so web and every phone agree; opting in filters the feed to articles carrying a chosen tag with an «Всички» switch, and nothing chosen means everything; search runs on the server over every stored article, not just the newest page.

Written before implementation deliberately. agrent-ios builds its half against this, and a contract that arrives after the code is a description rather than an agreement. Object to a line by commenting on the pull request that adds this file.

**The tracker for this work is `agrent-ios#231`, in the iOS repo — not `#231`.** Write the qualified form in commits and comments here. A bare `#231` in agri-saas resolves to agri-saas#231, which is an unrelated merged notifications PR (`fix(notifications): absolute email links`), so the reference renders as a working link to the wrong thing — which is worse than a broken one, because there is nothing to notice. Five merged commits on this work already carry the bare form (#1584); they are not worth rewriting, but nothing new should. `#1444` below is a genuine in-repo citation and is correct as written — this file mixes both, which is exactly why it needs saying.

---

## 1. What exists today, measured

Read off `main` at the time of writing, because every decision below is shaped by one of these facts rather than by preference.

| | |
|---|---|
| Model | `MarketNewsItem` — **global**, not tenant-scoped |
| Fields | `id, source, category, title, summary?, url, imageUrl?, publishedAt, guidHash, fetchedAt, createdAt` |
| Dedupe | `@@unique([guidHash])`, where `guidHash = sha256(guid ‖ link)`; the pull upserts |
| Indexes | `(category, publishedAt)` and `(publishedAt)` |
| **Retention** | **`RETENTION_DAYS = 60`** in `market-news-pull.ts` — older rows are deleted every run |
| Route | `GET /api/t/{tenantSlug}/trends/news?category=&limit=` |
| Query | `category`: a bucket or `'all'` (default `'all'`); `limit`: 1–100, default 50 |
| Caching | Redis, **1 hour**, key `trends:news:v1:${category}:${limit}` — the payload is **tenant-agnostic and shared across every tenant** |
| Transport | `jsonWithETag` → weak ETag + `If-None-Match` → 304 |
| Categories | `['market', 'policy', 'general']`, assigned by `src/lib/news/categorize.ts` |
| Feeds | **4**, and **all four** declare `defaultCategory: 'general'` |

Two of those deserve calling out because they are load-bearing below.

**The feed default is almost never what decides a category.** All four feeds default to `general`, and the categoriser only falls back to the default when no keyword matched. So today's categories are already produced entirely by the keyword rules — extending those rules is a change of degree, not of kind.

**The payload is cached across tenants.** That single fact decides where per-person filtering can happen (§5), and it is the one place this design could go wrong silently.

---

## 2. The tag vocabulary

Stable ASCII slugs. Two groups, matching the owner's proposal.

### Crops — reuse the commodity slugs, do not invent a list

| tag | Bulgarian label |
|---|---|
| `wheat` | Пшеница |
| `maize` | Царевица |
| `sunflower` | Слънчоглед |
| `rapeseed` | Рапица |
| `barley` | Ечемик |

All five are already `CANONICAL_COMMODITIES` in `src/lib/market/commodity-vocabulary.ts`, and that module already holds the Bulgarian spellings that match them: `COMMODITY_ALIASES` maps «пшеница» → `wheat`, «царевица» → `maize`, and so on.

**So crop tagging resolves through the existing alias table rather than through a second keyword list.** This is the one place this contract improves on the proposal as relayed, and the reason is concrete: a parallel list would drift from the search vocabulary. #1444 has just taught Борса search to resolve Bulgarian crop *prefixes* from that same table. If news tagging kept its own copy, adding a crop would mean editing two lists and the next person would update one.

It also means the tag and the search agree by construction: an article the tagger calls `wheat` is an article a farmer searching «пшеница» on Борса would expect to be about wheat.

### Topics — a new keyword list, because nothing models these yet

| tag | Bulgarian label | notes |
|---|---|---|
| `subsidies` | Субсидии | the existing `POLICY_KEYWORDS` are very nearly this list already |
| `prices` | Цени | likewise `MARKET_KEYWORDS` |
| `weather` | Време | new |
| `inputs` | Торове и препарати | new |
| `machinery` | Техника | new |
| `livestock` | Животновъдство | new |

`subsidies` and `prices` are deliberately near-duplicates of the two existing keyword sets. That is a migration path, not an accident: the existing `policy` and `market` categories become expressible as tags, which is what later makes `category` removable.

### Labels live on the server

Neither client hard-codes the vocabulary — the owner's decision. §4 gives the catalogue endpoint.

---

## 3. Tagging is inclusive, and the priority rule does not apply

`categorize.ts` today is **exclusive and ordered**: policy beats market, and the docblock explains why — "a subsidy headline is the more actionable classification". That rule exists *because* a single field forced a choice.

Tags remove the forcing. An article about subsidies for wheat gets **both** `subsidies` and `wheat`. There is no precedence and no tie-break, and the absence is the feature.

- Matching stays **deterministic, no I/O, no AI** — the property that lets `categorize.ts` unit-test without a network, and the reason it is trustworthy.
- Keywords stay **stems matched case-insensitively as substrings** over `title + ' ' + summary`, so one Bulgarian stem catches every inflection (`субсиди` → субсидия / субсидии / субсидиите).
- `tags` may be **empty**. An article matching no rule carries `[]`, and that is not an error — it is the honest answer, and it is what the «Всички» switch exists to keep reachable.

### `category` stays. `tags` is additive.

`category` is not removed in this change, for four reasons: the web UI filters on it today, the Redis cache key is built from it, agrent-ios already decodes the item field — and the response **envelope** carries it too, as a required String in the installed iOS build (§4). Removing a field a shipped client reads is a breaking change, and there is no need to take one here. Once both clients filter on tags, `category` can go in a later change that only has to delete things.

---

## 4. The API

### `NewsItem` gains `tags`

```
tags: string[]       // stable ASCII slugs, possibly empty, order not significant
```

Treat an unrecognised slug as unknown and ignore it, rather than as an error — the vocabulary will grow, and a client that errors on a new tag would break on a server deploy.

### The catalogue

```
GET /api/t/{tenantSlug}/trends/news/tags
  → 200 { groups: [ { key: 'crops'|'topics', label: string, labelEn: string,
                      tags: [ { key: string, label: string, labelEn: string } ] } ] }
```

`labelEn` is there at agrent-ios' request, for iOS Voice Control — a spoken English label needs to exist somewhere, and the slug is a poor one to say out loud. It is a second label, not a localisation mechanism: `label` stays Bulgarian and authoritative.

A separate GET rather than inlined in the feed response, for one reason: the feed is paged and searched, and a catalogue repeated on every page is repeated for nothing. It is static enough to cache hard (24h) and small enough that a client can hold it.

`label` is Bulgarian, because the product's primary language is Bulgarian and the labels are the farmer's words.

### The feed

```
GET /api/t/{tenantSlug}/trends/news
    ?category=        existing; unchanged
    &limit=           existing; 1–100, default 50
    &tags=            NEW: comma-separated keys, ANY-OF
    &q=               NEW: case-insensitive, over title + summary
    &cursor=          NEW: opaque; pass back verbatim
  → 200 { category, tags, q, items: NewsItem[], nextCursor: string | null }
```

**The envelope keeps `category` and gains an echo of every other filter.** The first draft of this document wrote the response as `{ items, nextCursor }`, which was wrong twice over, and agrent-ios blocked on it:

- the installed iOS build decodes `category` as a **required** String, so dropping it breaks Новини on the step-3 deploy — a live client, not a hypothetical one;
- and it would have discarded the field's *purpose*. `TrendNewsResponseSchema` says what that is: "`category` echoes the filter that produced it, **so a client can tell a stale response from the one it asked for**."

Adding filters makes that echo more valuable, not less. A client holding a page now has three things to reconcile rather than one, so `tags` and `q` echo back what was actually applied — including the effect of the rule below, where a tag the server does not recognise is dropped. The echo is how a client discovers that happened.

**`tags` is ANY-OF, not all-of.** Opting into Пшеница and Субсидии means "show me either", which is what a feed filter means to a reader. All-of would make two choices narrower than one, which is the opposite of what a preferences screen implies.

**An unrecognised key in `tags` is IGNORED here, not a 400.** agrent-ios asked for this and the reason is sound: a client passes its stored preferences straight into this parameter, so a tag that has since been renamed would otherwise turn a saved preference into a broken feed. That mirrors §7's ignore-on-read exactly — and note the asymmetry it creates with `PUT /api/me/news-preferences`, which **does** 400 on an unknown tag. The two are consistent once you ask what the caller is doing: a `PUT` is a person choosing, where a typo is a client bug worth surfacing; this parameter is a pass-through of state the server itself issued.

If every key in `tags` is unrecognised the filter is empty, which means **unfiltered** rather than empty-result. The `tags` echo in the response is what tells a client that happened, instead of leaving it to infer a server fault from a suspiciously full feed.

**`q` matches `title` and `summary`, case-insensitively, over every stored row** — subject to §6.

### Per-person preferences

```
GET /api/me/news-preferences  → 200 { tags: string[] | null }
PUT /api/me/news-preferences  { tags: string[] }  → 200 { tags: string[] }
```

Under `/api/me/`, not `/api/t/{tenantSlug}/`, and that is a decision rather than a coin flip. `me-farms.paths.ts` documents what that prefix means: everything there runs with **no tenant context**, there is no `requirePermission` to apply, and **the subject is always the session user, never an id in the body**. A news preference is a property of the person, not of a farm — the same person reading the same feed from two farms wants the same tags. Putting it under a tenant would invite exactly the bug where switching farms silently changes your feed.

---

## 5. Where the filtering happens — the one decision that can go wrong silently

**The server stores the preferences. Both clients read them. Each client passes `tags` explicitly on the feed request. The server does NOT apply the caller's preferences to the feed implicitly.**

This is not a style choice. `getMarketNews` caches its payload in Redis under `trends:news:v1:${category}:${limit}` and the comment on the route says why that is safe: the payload is tenant-independent. If the server started filtering by the caller's own preferences, the first request would write one person's filtered feed into a key every other person reads. Everyone would see the first reader's choices until the hour expired, and nothing would error.

So the preference is **shared state that clients resolve**, which also gives the behaviour the owner asked for — the same opt-ins on web and every phone — without the feed losing its cache.

### Therefore: every filter must appear in the cache key

```
trends:news:v1:${category}:${tags.sorted().join(',')}:${q ?? ''}:${limit}:${cursor ?? ''}
```

`tags` **sorted**, so `wheat,barley` and `barley,wheat` are one entry rather than two. This is the single most important line in this document: adding a parameter to the query without adding it to the key serves the previous caller's filtered payload to the next one, and it fails as a *wrong answer*, not as an error.

---

## 6. Search: honest bounds

**"Every stored article" means at most 60 days.** `RETENTION_DAYS = 60`, and the pull deletes older rows on every run. A search finding nothing from last spring is working correctly. Say so in the UI if the empty state would otherwise read as a failure.

**`q` bypasses the Redis cache.** The key space is unbounded, so caching per query would churn the cache for one-off searches and evict the hot unfiltered feed. A search is therefore a database read every time. The ETag still applies — it is computed over the response — so a repeated identical search still answers 304.

**`q` needs an index.** `title` and `summary` with a case-insensitive `contains` is a sequential scan. At 60 days across 4 feeds the table is small enough that this is acceptable at first, but the figure that matters is a production row count and **I have not measured it** — the test database holds zero rows, and a production query needs the owner's authorisation rather than my assumption. Measure before deciding between a trigram index and leaving it.

**`tags` needs a GIN index** for array containment:

```sql
CREATE INDEX "MarketNewsItem_tags_idx" ON "MarketNewsItem" USING GIN ("tags");
```

### The query string, and what iOS logs

`q` travels in the query string. agrent-ios raised that CFNetwork logs full request URLs including the query, unsuppressably, and has accepted GET here: a news search term is low-sensitivity and it is the convention Борса search already uses.

Recording it so the trade-off is on the record rather than implied: **a news search term is logged on the device.** It is not an identifier, not a credential, and not personal data about a third party. If a future search field carries something stronger than a crop name, that decision has to be taken again rather than inherited from this one.

---

## 7. Storage for the preference

A `Json?` column on `User`, following `bottomTabOrder` — not a new table.

`UserNotificationPreference` is a table because it has per-channel rows with their own lifecycle. A news opt-in is one small list per person, read whole and written whole, which is what `bottomTabOrder` already is.

Three things are borrowed from that column's reasoning, and one is deliberately inverted.

**Borrowed: `null` and `[]` stay distinct.** `null` means "never chose"; `[]` means "chose nothing". Both show the full feed, so the distinction does not affect filtering — it affects whether the UI may prompt. Collapsing them would make a new user indistinguishable from one who cleared their choices, and those two want opposite treatment. The `bottomTabOrder` comment makes this argument; it costs nothing to keep.

**Borrowed: it is a preference, not a grant.** An unknown tag in a stored preference is **ignored on read**, never an error. Tags will be renamed and removed, and a preference validated only when it was written would otherwise filter the feed down to nothing with no way for the reader to understand why.

**Inverted: the write DOES validate against the catalogue.** `bottomTabOrder` validates shape only, and its comment explains why — a server-side allowlist would mean every new client tab waits on a server deploy, and the release cycles are not coupled. Here the opposite holds: the server **owns** this vocabulary by the owner's decision, so an unknown tag on `PUT` is a client bug worth a 400 rather than something to store and silently drop. The two rules are not in tension once you ask who owns the list.

So: reject unknown on write, ignore unknown on read. Both, for different reasons.

---

## 8. Backfill

Existing rows have no tags. The pull upserts on `guidHash` and refreshes `fetchedAt`, so it will re-tag an item only if the tagging runs on upsert — which it will.

That still leaves rows the pull does not see again. A one-off backfill pass over the table is needed, and it is bounded by construction: at most 60 days of items from 4 feeds, re-tagged by a pure function with no I/O. It can run in a single transaction.

**Until the backfill runs, tag filters will under-report.** Sequence the deploy so the backfill runs before either client shows a tag filter, or the first thing a reader does with the new feature is see an empty feed.

---

## 9. What this does not include

Named rather than silently omitted:

- **No per-tag unread counts or badges.** Nothing in the owner's decisions asks for them.
- **No tag editing by users.** The vocabulary is the server's.
- **No full-text ranking.** `q` is a substring match over two fields, returning newest-first. Relevance ordering is a different feature and would want a different index.
- **No change to the 60-day retention.** Raising it is a product decision about storage, not part of this.
- **`category` is not removed.** §3.

---

## 10. Sequence

1. `tags String[] @default([])` + the GIN index, and the extended `categorize.ts`. Nothing reads it yet.
2. The backfill, then the catalogue endpoint.
3. `tags`, `q` and `cursor` on the feed — **with the cache key extended in the same change**, never after.
4. `/api/me/news-preferences`.
5. Clients.

Steps 1–2 are invisible to clients and can land first. Step 3 is where the cache-key mistake would live, so it is the one to review most closely.
