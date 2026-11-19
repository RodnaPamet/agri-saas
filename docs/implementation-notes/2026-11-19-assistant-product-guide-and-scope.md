# 2026-11-19 — the assistant knows Agrent's services and stays on farming

## Design

Asked where a farmer can insure a crop, the assistant named outside routes,
while Agrent itself prices a policy per parcel («Риск» → «Поискай
застрахователна оферта») and sends the request to an insurer. Its prompt said
what it is called and how to treat the farm's data. No line, and no tool,
described what the PRODUCT does, and nothing kept it to agriculture.

Two changes, both on the assistant stream route:

- **A product guide** (`src/app-layer/ai/assistant/agrent-services.ts`): one
  hand-written entry per service with what it does, where it is, and what it
  does NOT do. The `agrent_services` tool serves it, filtered by each entry's
  gate (module, feature flag, visible promotions). The system prompt lists the
  service NAMES and tells the model to call the tool for any question about
  Agrent, and never to send the person elsewhere for something Agrent does.
- **A topic scope** in the system prompt: agronomy and crops, weather as it
  affects field work, subsidies and agricultural regulation, the farm business,
  this farm's records, and Agrent. Anything else gets one sentence and an
  offer of what it can help with.

## Files

| File | Role |
|---|---|
| `src/app-layer/ai/assistant/agrent-services.ts` | The guide, its gates, the per-farm filter, and the answer for named services |
| `src/app-layer/ai/assistant/tools.ts` | `agrent_services` tool; `pageLinks` on the tool shape |
| `src/app-layer/ai/assistant/links.ts` | `linksFromPages`: links to whole screens from the guide |
| `src/app/api/t/[tenantSlug]/assistant/stream/route.ts` | The scope rule and the services rule |
| `tests/unit/ai/agrent-services.test.ts` | Routes are real pages, the guide fits one result, insurance names every product, gates filter |

## Decisions

- **Hand-written, not generated** (owner ruling). A generated list could only
  say a page exists. The cost is drift, so the test fails on a route the app
  no longer serves, and the insurance entry is checked against the premium
  engine's product list and the screen's own button label.
- **Copy from the pages, not from memory.** Each `what` comes from the page's
  own text in `messages/bg/app.json`. A guide written to stop invention must
  not invent. The first draft of the insurance entry listed only the five
  crops; the engine also prices three perils, and the test now derives them.
- **Names in the prompt, details in the tool.** The names are static, so the
  cached prefix stays one entry. The tool does the per-farm filtering, which a
  static prompt cannot.
- **Links only for named services.** The model asks for the services it is
  answering about, and only those get a link. The whole guide (no `names`) is
  unlinked, or an answer about insurance would be followed by five unrelated
  screens. Links are built by the server from the guide, never by the model.
  The phone opens a page link only when it is a tab on the person's bar.
- **Scope by prompt, no classifier.** A second model call to classify
  topics adds latency and cost to every question. The prompt rule is the
  first step. Whether the model follows it is a live eval against the
  production model, tracked on #3227.
