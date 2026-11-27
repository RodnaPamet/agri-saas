# 2026-11-26 — «Почва», the soil section of the knowledge base

Owner, 2026-11-26: «use the first two sections to create a new section in
knowledge — 'Soil' — organise this knowledge into sections and also train the
assistant to respond to soil questions based on these books».

## Design

```
src/lib/knowledge/soil-guide.ts   seven topics × {bg, en} + six sources
        │
        ├── /t/{slug}/knowledge/soil            web page (server component)
        ├── GET /api/t/{slug}/knowledge/soil-guide   the phone's «Почва» (agrent-ios)
        └── soil_guide assistant tool           one topic per call, with sources
```

The topics are Agrent's own summaries of what the sources say: nitrogen rules,
slopes and water, manure, soil analysis, erosion and cover, organic matter and
rotation, earthworms. Every topic names the documents it summarises and links
the full text.

Sources actually read for this (downloaded and extracted on 2026-11-26):

| source | kind |
|---|---|
| Правила за добра земеделска практика … нитрати (Заповед РД 09-1042/01.10.2024) | official |
| МЗХ, Ръководство за ЗИУ (2024) | official |
| МЗХ, Наръчник за ДЗЕС (2023) | official |
| Наредба № 9/2021 за интегрирано производство | official |
| FiBL / Биоселена, «Земните червеи – архитекти на плодородната почва» (2017) | free guide |
| «Наръчник за органичния фермер» (IPA BG–RS, 2012) | free guide |

Four of the owner's listed sources were not used, so nothing here relies on
them. The EIP-AGRI factsheet now redirects to `eu-cap-network.ec.europa.eu`.
The AU Plovdiv page serves an incomplete TLS chain. The UNCCD atlas entry is
only a catalogue record for a JRC map. DOAJ refuses automated reads. The
journal «Почвознание, агрохимия и екология» is CC BY-NC-SA, and Agrent is
commercial, so it would need the publisher's permission before it could be
used at all.

## Files

| file | role |
|---|---|
| `src/lib/knowledge/soil-guide.ts` | the content, ids, sources and the two readers' views |
| `src/app-layer/usecases/knowledge.ts` | `getSoilGuide` / `getSoilSection`, behind `assertCanRead` |
| `src/app/t/[tenantSlug]/(app)/knowledge/soil/page.tsx` | the web page |
| `src/app/t/[tenantSlug]/(app)/knowledge/KnowledgeClient.tsx` | «Почва» link in the knowledge header |
| `src/app/api/t/[tenantSlug]/knowledge/soil-guide/route.ts` | the phone's read |
| `src/lib/openapi/paths/knowledge.paths.ts` | its spec entry |
| `src/app-layer/ai/assistant/tools.ts` | `soil_guide` |
| `src/app/api/t/[tenantSlug]/assistant/stream/route.ts` | the prompt rule pointing soil questions at it |

## Decisions

- **Code, not seeded `KnowledgeArticle` rows.** A seed is an operator step on
  the VM. The satellite guide shows the cost: its page carries a per-section
  fallback for the day the seed has not run. Here a deploy is the publication.
  The cost is that the topics do not appear in the searchable article list or
  the «Попитай» box, which reads `KnowledgeChunk` rows. The header link is how
  people find them.
- **Original wording, sources named.** The repository is public, and two
  sources are somebody's copyright. Facts are restated in our sentences, and
  each topic sends the farmer to the document itself.
- **Grounding, not retrieval, for the assistant.** Seven fixed topics: the model
  picks one by id and receives the whole topic. No embeddings, no ranking, and
  no empty result on an unexpected phrasing (`retrieve` falls back to a
  phrase-substring match whenever no embedding backend answers). Each topic is held
  under `TOOL_RESULT_MAX_CHARS` in both languages, so a rule is never cut in
  half.
- **No crop-by-crop nitrogen norms.** The statutory guide's table depends on
  soil texture and yield. A partial copy would be worse than pointing at it.
- **No pesticide content.** The dose/PHI/REI detector runs over every string in
  the test, with a positive control.
- **ДЗЕС is the 2023 handbook's.** The EU simplified parts of conditionality in
  2024, and no Bulgarian source for the change was read here. The topics that
  cite ДЗЕС therefore tell the farmer to check the current year with ДФЗ / МЗХ
  rather than restating it.
- **The route's language** is `?lang` when given, otherwise the person's own
  `uiLanguage`, never `Accept-Language` (the #1677 rule).
