# 2026-11-09 — P9.2: seeding the channel catalogue

**Issue:** #2936. **Owner ruling:** seed all fifteen, the five inputs as
channels of their own (2026-11-09).

## Design

`dist/seed.mjs channels` — a fifth subcommand on the existing CLI — writes 43
channels and joins nobody.

| channels | source | key |
|---|---|---|
| 10 `CROP` | `CANONICAL_COMMODITIES` | `crop:wheat` |
| 5 `TOPIC` | `INPUT_COMMODITIES` | `input:urea` |
| 28 `OBLAST` | `BULGARIA_REGIONS` | `oblast:BG-16` |

## «15 crops» was 10 + 5, and the five are not crops

The plan says "15 crops, 28 oblasti". Measured: `CANONICAL_COMMODITIES` has
**ten** and `INPUT_COMMODITIES` has **five** — diesel, urea, dap, map,
ammonium-nitrate. Fuel and fertiliser.

The owner ruled to seed all fifteen on `commodity-vocabulary.ts`'s own
argument: *"fuel and fertiliser are the two largest cash costs in an arable
budget, and a farmer deciding when to buy urea needs the same trend line a
farmer deciding when to sell wheat does."*

## Files

| File | Role |
|---|---|
| `scripts/channels/seed-channels.ts` | the catalogue (pure) and the upsert |
| `scripts/seed.ts` | the `channels` subcommand, in `all` too |
| `tests/unit/channels/channel-catalogue.test.ts` | the catalogue's shape, no database |
| `tests/integration/p9-2-seed-channels.test.ts` | idempotence and the trample case |
| `tests/guards/channels-are-never-auto-joined.test.ts` | the clause this phase is about |
| `tests/guards/seed-deployment.test.ts` | extended from four subcommands to five |

## Decisions

- **`CropType` is the obvious source and the wrong one.** It is
  **tenant-scoped** (`tenantId String`, not nullable), so it is each farm's own
  list and seeding from it would create a channel per farm per crop. The join
  that makes suggestion work is `CropType.commodityCanonical`, pointing a
  farm's crop type at the canonical vocabulary this seed reads — an equality
  join on `Channel.key`, no string matching.

- **THE KEY PREFIX IS LOAD-BEARING.** An input channel is `TOPIC` with an
  `input:` key, never `CROP` with `crop:`, because suggestion treats the two
  differently: a crop channel joins a farm's crops, and an input channel has no
  such join because *every* arable farm buys diesel and fertiliser — so it is
  suggested to everybody or to nobody. The prefix lets one query tell them
  apart without a second column. It also meant no schema change: `TOPIC`
  already existed in #2935.

- **`dap` and `map` keep the trade letters, in Cyrillic.** «ДАП» and «МАП» are
  what a Bulgarian farmer buys at a depot; expanding them to «диамониев
  фосфат» would be a translation nobody uses.

- **Names are COLUMNS, not `messages/` keys** (decided in #2935). A seeded row
  cannot reach a `next-intl` catalogue — which also means no i18n guard can see
  these strings, so the catalogue test asserts every `nameBg` is Cyrillic and
  differs from `nameEn`. That is the untranslated check, hand-rolled, one layer
  out of `i18n-completeness`'s reach.

- **A missing Bulgarian name THROWS rather than skipping.** A new canonical
  commodity with no entry would otherwise seed one fewer channel than the
  vocabulary has, and 42 reads as plausibly as 43.

- **The upsert's `update` touches NAMES ONLY.** `memberCount` is maintained by
  the join path, `slowModeSeconds` is an operator throttling a flooded channel,
  and `archivedAt` is somebody's decision to retire one. A seed writing the
  create-shape every run would reset all three on every deploy — silently
  undoing an operator's action, and a channel that un-slows itself when
  somebody ships an unrelated change is worse than one that was never slowed.

- **Idempotence is the UNIQUE INDEX**, not a flag — `NoticeScore.reportId`'s
  precedent. It also means a renamed channel keeps its membership: the key is
  the identity, the names are data.

- **`channels` is in `all`.** It is idempotent, needs no tenant and no
  embeddings backend, so there is no deployment where running it is wrong —
  unlike `corpus`, which fails loudly without `AI_EMBED_BASE_URL`.

- **No suggestion READ ships here.** The issue's clause is about not joining,
  and the guard covers that. A suggestion usecase with no caller would be dead
  code; it lands with P9.5's UI, which is the thing that would call it.

## Two guards that needed work, and one that was already wrong

- **`channels-are-never-auto-joined` is a SEPARATE file from `no-auto-join`.**
  Folding channels into that guardrail was the obvious move and is wrong: its
  allowlist entries each answer "gated by what? audit-logged how?
  email-bound?" — questions about TENANT privilege that do not apply here, and
  mixing the two would leave a reader unable to tell which rule an entry obeys.

  Its allowlist is EMPTY, because P9.2 ships no join path, so the detector is
  proved against crafted sources — a guard whose population is empty passes
  whatever it asserts.

- **A `git ls-files` population cannot see an unstaged new file.** The guard's
  own assertion that the seed is in its population failed until the seed was
  `git add`ed. Not a hole in CI, where everything is tracked by definition, but
  proving a NEW file is covered has to happen after staging it. Same family as
  `git checkout -- <path>` being a no-op on an untracked file.

- **`seed-deployment` claimed "all four subcommands" and passed with a fifth
  unpinned.** Its assertions name the subcommands they know about and nothing
  asserted a count. Extended to five — and the first attempt had no teeth:
  `toMatch(/'channels'/)` passed with the value REMOVED from `SUBCOMMANDS`,
  because the string also occurs in `runChannels`'s result name and the
  dispatch arm. Measured by trimming the declaration and watching the suite
  stay green. It is anchored on the declaration now.

## Mutation proofs

| mutation | result |
|---|---|
| the seed calls `channelMembership.createMany` | ✕ `channels-are-never-auto-joined` names the file |
| the upsert's `update` resets `memberCount`/`slowModeSeconds`/`archivedAt` | ✕ the trample case only |
| `'channels'` removed from `SUBCOMMANDS` | ✕ `seed-deployment` (after anchoring; it passed before) |

The trample test carries a positive control asserting `nameBg` is correct after
the re-run, because "it did not reset the counter" is exactly what a seed that
crashed early also produces.
