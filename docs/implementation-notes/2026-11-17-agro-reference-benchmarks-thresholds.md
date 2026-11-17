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
- **Figures as printed, one derived euro figure per rate.** Yields stay
  kg/ha; rates stay integer стотинки in the order's own currency, untouched.
  Beside each rate the server adds `perDaEurCents` at the fixed peg (owner,
  2026-11-17: "convert, mark it", as the vine card), through the calendar's
  integer converter with an area of 10 дка per ha. The peg guard now allows
  `src/lib/agro/benchmarks/` beside the calendar, and detects an import of
  the converter as well as of the constant — matching the constant alone,
  the population had been zero while a conversion could still be imported.
- **Thresholds stay prose.** The guide mixes counts, percentages and damage
  descriptions; splitting into number + unit would invent structure the
  page does not support. The phone shows the sentence, it does not compare.
- **Unknown filter value is a 400**, never `[]` — the calendar's rule.
- **Aliases are refused at load.** The first compile wrote `canola`; every
  client joins on `commodity-vocabulary`'s `rapeseed`, so that yield would
  have loaded, served and been found by no crop.
