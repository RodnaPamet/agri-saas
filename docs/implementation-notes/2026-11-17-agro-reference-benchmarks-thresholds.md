# 2026-11-17 — National yields, support rates and pest thresholds

**Commit:** `828a1764 feat(agro): national yields, support rates and pest thresholds`

## Design

Two read-only reference routes in the `agro-calendar` family, for the phone
(agrent-ios#638, #636):

- `GET /api/agro-benchmarks[?commodity=]` — МЗХ Agrostatistics national
  average yields (kg/ha, harvest 2024) and coupled-support rates per
  eligible hectare (РД 09-440/2025, the ДФЗ protein-crop notice).
- `GET /api/agro-thresholds[?crop=]` — pest and disease thresholds (ПИВ)
  from МЗХ's 2024 integrated-production guide.

Each is a committed `dataset.json` behind a zod schema, validated ONCE at
module load (`load.ts`), served through `jsonWithETag`. Person-scoped
(`getUserCtx`), no tenant, no table read.

## Files

| File | Role |
|---|---|
| `src/lib/agro/{benchmarks,thresholds}/{schema,load}.ts` | contract + boot-time validation |
| `src/lib/agro/{benchmarks,thresholds}/dataset.json` | the compiled figures, a citation each |
| `src/lib/agro/reference-slugs.ts` | refuses a commodity alias where a canonical slug exists |
| `src/app/api/agro-{benchmarks,thresholds}/route.ts` | the two GETs |
| `src/lib/openapi/paths/agro-reference.paths.ts` | spec |

## Decisions

- **Ungated** by owner ruling ("merge, flags on"). A default-off flag would
  need a production row written by hand before either route answered
  anything but 404; ungated ships it on merge. Both are added to the
  tenant-path exemption beside `agro-calendar`, for the same reason.
- **Figures as printed.** Yields stay kg/ha; rates stay integer стотинки in
  the order's own currency. No conversion (EUR-only ruling, 2026-11-06,
  covers what the app computes, not a published order's own figure — the
  phone shows it as «лв» with the order named).
- **Thresholds stay prose.** The guide mixes counts, percentages and damage
  descriptions; splitting into number + unit would invent structure the
  page does not support. The phone shows the sentence, it does not compare.
- **Unknown filter value is a 400**, never `[]` — the calendar's rule.
- **Aliases are refused at load.** The first compile wrote `canola`; every
  client joins on `commodity-vocabulary`'s `rapeseed`, so that yield would
  have loaded, served and been found by no crop.
