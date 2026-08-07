# Third-Party Notices

This product (agri-saas) is built on the inflect-compliance platform and
reuses **design concepts** — schema shapes, domain ontologies, and UX
patterns — from a number of open-source agriculture and ERP projects.

**License hygiene.** We do **not** copy source code from GPL/AGPL-licensed
projects; from those we take *concepts only* (the idea of a stock ledger,
an intervention record, a log-type ontology) and reimplement them
independently against our own Prisma/TypeScript stack. From
permissively-licensed projects (MIT / Apache-2.0 / BSD / CC0) we may port
schema structure and UX patterns, and we credit them below as those
licenses require.

This file documents **design-concept attribution**. Bundled npm runtime
dependencies carry their own license texts in `node_modules/<pkg>/LICENSE`
and are not re-listed here.

---

## Ported / adapted (permissive — credited)

### InvenTree — MIT License
- **Project:** https://github.com/inventree/InvenTree
- **Used for:** The inventory domain — Item / batch-lot / stock-location
  tree and the stock-movement model. Translated from its Django/ORM shape
  to our Prisma schema (`prisma/schema/inventory.prisma`,
  `prisma/schema/agriculture.prisma`: `Item`, `InventoryLot`,
  `StockTransaction`). No InvenTree source was copied; the schema concepts
  were re-expressed for our multi-tenant, RLS-isolated, hash-chained model.

### Apache OFBiz — Apache License 2.0
- **Project:** https://ofbiz.apache.org/
- **Used for:** The lot-genealogy graph (`LotLink`) — OFBiz's inventory
  lot-tracking and parent/child lot lineage informed the directed
  DERIVATION edge model that threads seed/input lot → field → harvest lot
  for food-safety traceability.

### HortusFox — MIT License
- **Project:** https://github.com/danielbrendel/hortusfox-web
- **Used for:** Field-journal UX concepts — the photo-log and
  calendar/observation patterns behind the journal entry + photo surfaces
  (`src/app/t/[tenantSlug]/(app)/journal/`).

### ISRIC SoilGrids 2.0 — CC-BY 4.0
- **Project:** https://soilgrids.org (ISRIC — World Soil Information).
- **Used for:** Per-parcel soil profiles (#37) — texture (sand/silt/clay),
  pH, organic carbon, bulk density. Fetched at runtime from the SoilGrids
  REST API (`rest.isric.org`, or a self-hosted mirror via `SOIL_BASE_URL`),
  cached per ~100 m grid cell in the global `SoilSample` table, and stored on
  `Parcel.soilJson`. **SoilGrids is a MODEL, not a field survey** — every
  value is a modelled ESTIMATE with quantified uncertainty and is surfaced to
  users as such (never a lab result). CC-BY 4.0 requires attribution: the
  in-app credit "Soil: SoilGrids (ISRIC), CC-BY 4.0" appears on the soil map
  legend and every soil profile card (`src/components/soil/*`).

---

## RAG knowledge corpora (feat/ai-rag — ingested as retrievable text)

The retrieval-augmented-generation layer (`src/app-layer/ai/rag/`,
`scripts/rag/`) ingests agricultural knowledge into the GLOBAL
`KnowledgeChunk` catalog so the general model can give grounded, cited
answers. **Only the corpora below are permitted for TEXT ingestion** — the
allowlist `LICENSED_SOURCES` in `scripts/rag/corpus.ts` is the single source
of truth and `assertLicensedSource()` refuses anything else. Each ingested
chunk records its corpus + licence in its `source` field.

### Agri-SaaS agronomy desk — original content (PR 4/5, no third-party text)
- **Project:** Authored in this repository — the Bulgarian-first agronomy
  corpus (`scripts/rag/corpus.ts`'s `GLOBAL_CORPUS`) and the per-tenant demo
  growing-guide seed (`scripts/import-knowledge.ts`'s `GROWING_GUIDES`).
- **Licence:** N/A — 100% original work, not derived from any third-party
  corpus or copyrighted document. Mirrors the "AI eval golden datasets"
  precedent below: no external text is ingested under this label, so no
  third-party licence obligation attaches; the product holds full rights.
- **Used for:** GLOBAL agronomy chunks — BBCH growth stages, scouting
  thresholds, cultural/preventive practice, nutrition timing WITHOUT
  product rates, and harvest readiness — for Bulgaria's four major arable
  crops (wheat, barley, maize, sunflower), plus a shared entry on checking
  the official БАБХ register before any treatment. **No dose rate, PHI, or
  re-entry interval appears anywhere in this content** — enforced at
  ingest time by `assertNoUnregisteredRegulatedContent()`
  (`scripts/rag/dose-phi-guard.ts`), the structural gate for the product's
  hard rule that such content may only appear alongside a real БАБХ
  registration number, which this product does not have a licensed
  dataset of.
- **Attribution:** Chunks/articles record
  `source = "Agri-SaaS agronomy desk (original)"`.
- **Superseded:** this replaces the previous OpenFarm-modelled home-garden
  vegetable guides (tomato/lettuce/carrot/potato/beans/squash) in
  `scripts/import-knowledge.ts`, which were irrelevant to Bulgarian arable
  farming; the OpenFarm CC0 attribution above has been removed accordingly.

### KCC (Kisan Call Centre) — Government Open Data Licence – India (GODL)
- **Project:** Kisan Call Centre transcripts, data.gov.in.
- **Licence:** GODL-India — permits reuse + redistribution with attribution.
- **Used for:** remains on the `LICENSED_SOURCES` allowlist as a verified
  licence, but as of PR 4/5 no chunk in `GLOBAL_CORPUS` uses it — the
  Indian tomato/paddy Q&A samples it backed were irrelevant to Bulgarian
  arable farming and were replaced. Kept allowlisted (not removed) since
  the licence itself remains valid for any future use.
- **Attribution:** a chunk using this source records `source = "KCC (GODL)"`.

### FAIR Forward / Digital Green — open agricultural advisory Q&A
- **Project:** FAIR Forward (GIZ) / Digital Green open datasets.
- **Licence:** Open / permissive (CC-BY-class) — redistribution with credit.
- **Used for:** remains on the `LICENSED_SOURCES` allowlist as a verified
  licence; as of PR 4/5 unused for the same reason as KCC above.
- **Attribution:** a chunk using this source records
  `source = "FAIR-Forward / Digital Green QA"`.

### EU Regulation 2018/848 — organic production rules
- **Project:** Official Journal of the European Union.
- **Licence:** EU legislation — reusable (CELEX/EUR-Lex reuse policy).
- **Used for:** remains on the `LICENSED_SOURCES` allowlist as a verified
  licence; as of PR 4/5 unused by `GLOBAL_CORPUS` (not organic-specific).
- **Attribution:** a chunk using this source records `source = "EU 2018/848"`.

### USDA National Organic Program — 7 CFR Part 205
- **Project:** US Code of Federal Regulations.
- **Licence:** US Government work — public domain.
- **Used for:** remains on the `LICENSED_SOURCES` allowlist as a verified
  licence; as of PR 4/5 unused by `GLOBAL_CORPUS` (not organic-specific).
- **Attribution:** a chunk using this source records `source = "USDA 7 CFR 205"`.

### ⛔ Tier 4 — PROHIBITED (never ingested as text, regardless of allowlist)
Five sources are HARD-blocked by `assertLicensedSource()` in
`scripts/rag/corpus.ts` — proprietary, copyrighted, or commercially
motivated content this product has no redistribution rights to. The
product may still CITE that a requirement or article exists and direct
the user to the original, but must never ingest its text into a RAG chunk.

**GlobalG.A.P.** — GlobalG.A.P. standards, checklists, and control points
are **proprietary and copyrighted**. They are **CITE-ONLY**: the product
may reference that a GlobalG.A.P. requirement exists and direct the user
to the official document, but it **MUST NEVER ingest GlobalG.A.P. text**
into a RAG chunk. No GlobalG.A.P. text is bundled, sampled, or ingested
anywhere in this repository.

**AHDB** (Agriculture and Horticulture Development Board) — publications
are copyrighted and cite-only.

**Canola Council** (of Canada) — publications are copyrighted and
cite-only.

**agri.bg** and **sinor.bg** — copyrighted commercial editorial sites;
their articles are cite-only.

**Agrochemical vendor portals** — product/label pages from commercial
agrochemical vendors are copyrighted and commercially motivated.
`assertLicensedSource()` names the dominant global vendors
(Bayer CropScience, Syngenta, BASF Agricultural Solutions, Corteva, UPL,
Nufarm) illustratively; the allowlist model (`LICENSED_SOURCES`) is the
primary defence against ingesting any other vendor's text.

---

## AI eval golden datasets (feat/ai-evals-safety — original, in-repo)

The eval harness datasets under `scripts/ai/eval/datasets/`
(`agronomy-mcq.json`, `agronomy-open.json`, `safety-cases.json`) are
**original works authored in this repository** for evaluating AI quality
and safety behaviour. They are NOT derived from any external dataset and
contain no third-party copyrighted text. The questions, reference answers,
and safety/spray/certification cases were written for this project. No
GlobalG.A.P. text is used (the safety cases reference regulatory *concepts*
generically — PHI/REI/MRL/organic standards — never proprietary checklist
wording). Any future external eval dataset added here MUST be
MIT/Apache/BSD/CC0/CC-BY and credited in this file.

---

## Machine-learning models (on-device vision — permissive)

### CropNet / MobileNetV2-PlantVillage — Apache License 2.0

- **Models:**
  - CropNet cassava/crop-disease classifier — https://tfhub.dev/google/cropnet (Apache-2.0, Google)
  - MobileNetV2 trained on the PlantVillage dataset — widely redistributed
    under Apache-2.0 / MIT (e.g. https://github.com/spMohanty/PlantVillage-Dataset
    for the dataset; the ImageNet-pretrained MobileNetV2 backbone is
    Apache-2.0).
- **Used by:** The on-device vision backend
  (`src/app-layer/ai/vision/onnx-provider.ts`) — a leaf/crop photo →
  likely pest/disease classifier run locally via `onnxruntime-node`.
- **Binary NOT vendored.** The model WEIGHTS are **not** committed to this
  repository (they are large binaries and would bloat the tree). The ONNX
  file is loaded at runtime from a **configurable path**:
    - `VISION_MODEL_PATH` — absolute path to the `.onnx` classifier
      weights. When unset or the file is missing, the on-device backend
      reports unavailable and the orchestrator falls back to the Claude
      cloud backend (`VISION_BACKEND=auto`, the default).
    - `VISION_LABELS_PATH` — optional newline-delimited labels file that
      overrides the bundled PlantVillage 38-class list
      (`src/app-layer/ai/vision/labels.ts`) when pointing
      `VISION_MODEL_PATH` at a model with a different taxonomy.
- **Setup (operator).** Export a CropNet / MobileNetV2-PlantVillage model
  to ONNX (input `1×3×224×224`, ImageNet-normalised RGB; output: one logit
  per class in label order), place the `.onnx` file on the worker host,
  and set `VISION_MODEL_PATH` to its absolute path. The bundled label list
  matches the standard 38-class PlantVillage taxonomy; supply
  `VISION_LABELS_PATH` for any other class set. Only Apache-2.0 / MIT
  models may be configured here.
- **Class labels** (text metadata only, not weights) are bundled in
  `src/app-layer/ai/vision/labels.ts` — the public PlantVillage class
  taxonomy. `modelVersion` records the model id plus a short SHA-256 hash
  of the loaded weights so each persisted result is traceable to the exact
  file that produced it.

---

## Concept-only (copyleft — NO code used)

The following projects are GPL/AGPL-licensed. We studied them for **domain
modelling ideas only** and copied **no source code**. Our implementations
are independent.

| Project | License | Concept referenced |
|---------|---------|--------------------|
| farmOS | GPL-2.0 | Log / Asset / Quantity ontology (journal `LogEntry` / `LogQuantity` types) |
| ERPNext | GPL-3.0 | Append-only stock-ledger valuation concept (`StockTransaction`) |
| Ekylibre | AGPL-3.0 | Intervention + per-activity costing concept (`LogEntry.costAmount`) |
| LiteFarm | GPL-3.0 | Farm-management domain breadth; the farm task-type catalog (`src/lib/agriculture/farm-task-types.ts`) — type names + category grouping, reimplemented (keys/enum/TS surface are ours) |
| frappe/wiki | GPL-3.0 | Wiki / knowledge-base feature shape (versioned articles, draft→publish, read-acknowledge) — independently built on IC's Policy machinery |

---

*When a new component ports a permissively-licensed project's schema or UX,
add a credited entry above in the same diff. When a component takes only a
concept from a copyleft project, record it in the concept-only table so the
"no code copied" boundary stays auditable.*
