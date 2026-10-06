# Nav vocabulary — the product's nouns

This file is the **single source** for the Bulgarian nouns the product uses for
its own surfaces, and for which i18n keys must carry each one.

It exists because a surface with two names has none. Before P2.6 the exchange
was «Борса» in the sidebar section header, the breadcrumbs and the map legend,
«Пазар» in the sidebar item that actually navigated to it, and
`Борса / Exchange` in the page heading — three spellings of one destination,
across four files, with nothing failing. Trends was «Тренд» where you clicked
it and «тенденции» in every sentence about it.

## How a reversal works

The owner changes a noun **here**. `tests/guards/nav-vocabulary.test.ts` parses
the table below and asserts `messages/bg.json` / `messages/en.json` carry those
nouns at those keys, so CI then names every key to update. It is one file to
decide and a mechanical fix to propagate — the guard does not let the decision
and the catalogue drift apart, which is the property the phase plan is after.

Changing a noun is **not** a key rename. The keys are stable; the values move.

## The table

The guard reads this table. Keep the column order and one row per concept.

- **Concept** — a stable slug, used in guard output only.
- **Bulgarian** / **English** — the canonical noun. The listed keys must hold
  this value EXACTLY in the matching catalogue.
- **Keys** — comma-separated dotted i18n keys.
- **Never** — comma-separated Bulgarian nouns that must not appear as the WHOLE
  value of any key under **Namespaces**. This is what stops the convergence
  from silently reversing one key at a time. Keys pinned by ANY row are exempt,
  which is what lets a namespace be wide: `sidebarNav.` can ban «Борса» for
  **market** because `sidebarNav.exchange` is pinned TO «Борса» above.
- **Namespaces** — comma-separated dotted key prefixes the **Never** list is
  swept over.

| Concept | Bulgarian | English | Keys | Never | Namespaces |
|---|---|---|---|---|---|
| exchange | Борса | Exchange | sidebarNav.exchange, exchange.client.heading, exchange.client.breadcrumbExchange, exchange.myListings.breadcrumbExchange, exchange.myInterests.breadcrumbExchange, exchange.messaging.breadcrumbExchange, exchangeMap.exchangeSuffix | Пазар, Маркет, Пазарът | sidebarNav., exchange., exchangeMap., exchangeFilters. |
| trends | Тенденции | Trends | sidebarNav.trends, trends.title | Тренд, Трендове, Трендът | sidebarNav., trends. |
| market | Пазар | Market | sidebarNav.sectionMarket, trends.news.filters.market, trends.news.categories.market | Борса, Борсата | sidebarNav. |

## Why these three and not two

«Борса» and «Пазар» are both right words and they name **different** things, so
the fix was not "pick one".

- **Борса** is the destination: the cross-tenant exchange at `/exchange` where
  farms post and answer offers. One surface, one noun, everywhere — nav item,
  breadcrumb, page heading, map legend, plan-feature bullet.
- **Пазар** is the sidebar SECTION that holds Борса, Тенденции, Новини and
  Схеми. Those four are market *information*; only the first is the exchange.
  Naming the section «Борса» made the group and one of its members share a
  name, which no other section in the sidebar does (`Зърно` holds no item
  called «Зърно»), and left the exchange itself called «Пазар».
- **Тенденции** is the trends surface at `/trends`. The prose already said
  «тенденции» throughout (`trends.chartAria`, `trends.widget.title`,
  `trends.tabsAriaLabel`); only the two labels you navigate by said «Тренд».

«Пазар» therefore stays legal as a news CATEGORY and in price copy
(«пазарна цена», «пазарни тенденции») — those are the commodity market, not
the exchange. The **Never** sweep is scoped per concept for exactly that
reason: it bans «Пазар» as the whole value of an `exchange*` key, not the word.

## Load-bearing spellings that stay

Some GRC-era or exchange-era names are identifiers rather than copy. Renaming
them breaks persisted state, a wire contract or a stored preference, so they
stay and the reason is written down — the same discipline
`tests/guards/no-legacy-brand.test.ts` applies to the previous brand.

| Spelling | Where | Why it stays |
|---|---|---|
| `id: 'exchange'` | `SidebarNav.tsx` section id | Keys the per-section collapse state in the user's browser. Renaming it re-expands every sidebar. |
| `/exchange`, `/trends` | route paths | In `DEFAULT_BOTTOM_TAB_SUFFIXES` and in `User.bottomTabOrder` rows, shared verbatim with the iOS client. Renaming orphans every saved tab arrangement on both platforms. |
| `complianceMailbox` | `TenantNotificationSettings` column + `/api/t/{slug}/notification-settings` body | A persisted column and a request field. P2.6 reworded its LABEL to «Пощенска кутия за архив»; the field name is a contract. |
| `inflect.celebrate:` | `sessionStorage` dedupe prefix | Already an intentional survivor in `no-legacy-brand.test.ts` — renaming re-fires every celebration. |
| `Exchange`, `Exchange messaging`, `Trends` | OpenAPI tags | Tags group operations for generated clients; renaming one regroups somebody's SDK. The operation SUMMARIES carry the product nouns instead. |
