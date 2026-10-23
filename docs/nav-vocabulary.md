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
| location | Блок | Location | journal.colLocation, locations.detail.fallbackTitle, planning.newPlan.location | Локация, Локации, Обект, Обекти, Нива, Ниви, Землище, землище | locations., journal., myWork., backNav., farmTasks., planning., sidebarNav., grain.costs.form.linkKind. |
| locations | Блокове | Locations | backNav.locations, farmTasks.fieldLocations, journal.detail.locations, journal.entryModal.fieldLocations, locations.bcLocations, locations.title, myWork.locations |  |  |
| locationNav | Блокове | Location | sidebarNav.location |  |  |
| parcel | Парцел | Parcel | ag.map.parcel, ag.rent.colParcel, ag.rent.fieldParcel, notificationEmail.insuranceLead.parcelLabel, offline.parcelDefault, planning.board.colParcel, planning.detail.parcel, planning.newPlan.parcel | Имот, Имоти | ag.map., ag.rent., ag.parcelHistory., locations., planning., grain.costs.form.linkKind., offline. |
| parcels | Парцели | Parcels | ag.parcelHistory.breadcrumbParcels, locations.colParcels, locations.detail.overviewParcels, locations.detail.parcelsAccordion |  |  |

## Land: Блок and Парцел, and why five rows for two entities

Owner ruling 2026-10-16 (#1966): **a Location is «блок»**. The web had carried
three words for the one entity — «Локация» (dominant, and a transliteration of
the English), «Обект», and «Нива» — plus a fourth, «землище», which I
introduced once and which is simply wrong: it is the land of a VILLAGE, an
administrative territory, not a farm's grouping of fields.

**The values were already migrated when these rows landed.** Measured
2026-10-23 across `messages/bg/app.json`: zero «Локация», zero «Имот», zero
«землище», zero capitalised «Нива». What was missing was the thing this file
exists for — nothing stopped it reversing one key at a time, which is exactly
how the exchange ended up with three names. The rows are the enforcement, not
the migration.

### «Нива» was the dangerous one, and it is still permitted in prose

«Нива» names a FIELD, while a Location *groups* fields. So a string saying
«Нива» might not have been a wrong word for a Location at all — it might have
been a string genuinely about a **Parcel**, and renaming it would have
relabelled parcel copy as block copy. That separation had to happen before any
rename.

It is banned only as a **whole value** under the listed namespaces. Five
lowercase uses survive on purpose, because «нива» is what a farmer actually
says for a field: `farmTasks.openFieldMap` («Отвори картата на нивата»),
`satelliteImagery.intro` («…всяка нива по сателитен индекс»), and three in the
grain calculator. Those are prose about fields, not labels for the entity.

### «Имот» is the cadastre's word, and `ag.cadastre.` is NOT swept

**имот** is the CADASTRAL unit — поземлен имот, what КАИС registers. Using it
for a farm's worked parcel conflates the legal parcel with the working one, and
this product has both concepts (#299). `grain.costs.form.linkKind.parcel` said
«Имот» when #1966 was filed; it says «Парцел» now.

So the **parcel** row bans «Имот» under the namespaces where the confusion
lived — and deliberately NOT under `ag.cadastre.`, which is the one place a bare
«Имот» would be the right word. Today that subtree uses «Кадастрален
идентификатор» and holds no bare «Имот», so the exclusion costs nothing and
keeps the ban a claim about the surfaces it was measured on. Widening it later
means deciding that the cadastre must spell its own noun differently.

### Why five rows

The table pins one canonical value per row and checks BOTH catalogues exactly,
so singular and plural need separate rows: «Блок»/`Location` and
«Блокове»/`Locations`.

`sidebarNav.location` gets a third row because it is «Блокове» in Bulgarian and
`Location` in English — and that is the **house pattern** for nav items, not a
defect: `sidebarNav.asset` is «Активи»/`Asset` and `sidebarNav.rent` is
«Ренти»/`Rent`. Pinning it to the plural English row would have meant changing
the English to match a rule the sidebar does not follow.

### What is NOT a Location

`assets.location` and `assets.locationStructured` stay «Местоположение». That
field is where a machine physically is — a place, free text — not a farm's
block, so it is a different concept wearing a similar English word. #1966 lists
it among the names for Location; it is not one, which is why those keys appear
in no row and `assets.` appears in no namespace.

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
