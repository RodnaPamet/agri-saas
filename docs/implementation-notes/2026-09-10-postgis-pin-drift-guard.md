# 2026-09-10 — the PostGIS pin drift guard, rewritten (#860)

**Commit:** `<pending> fix(ci): rewrite the PostGIS pin guard so it reports the breaks it exists to catch`

Split out of #832. A guard with this four-direction structure was written three
times and rejected three times, each round for the same reason: it was **green
against the very break it exists to prevent**. The structure was sound; the
POPULATIONS were wrong. This change keeps the structure and rebuilds every
population, and ships the four mutation proofs the issue set as the bar.

The rejected guard is preserved at `fix/832-postgis-base-image @ 9ca74e52c`.

## The four defeats, and where each is answered

| defeat | how the old guard lost | where it is answered now |
|---|---|---|
| 1. flag satisfied by a trailing COMMENT | `!line.includes(FLAG)` over the whole PHYSICAL line — putting the flag's text in a `#` comment satisfied it with the real flag gone. 32/32 green, build broken. | `stripLineComment()` cuts comments in the file's own comment syntax BEFORE anything is matched, and `flagged` is decided on the apt SEGMENT, not the line. |
| 2. `apt-get` on a `RUN` CONTINUATION line | `inImage` required the line carrying `apt-get` to itself start with `RUN`, so the dominant `RUN … \` idiom never entered the population. | `logicalLines()` joins continuations first, so a `RUN` block is one logical line however it wraps. |
| 3. a `docker compose exec` site | matched the substring `docker exec`, which `docker compose exec` does not contain. | `CONTAINER_EXEC` accepts v1/v2/`docker-compose`, `sudo`, an absolute path, `-f <file>.yml` in between, and a variable head (`${DOCKER} exec`) — a command reached through a variable is still a command. |
| 4. a `head -1` ALTERNATIVE SPELLING | Direction C blacklisted that one spelling; `head -n 1`, `sed -n 1p`, `awk NR==1` walk past it. | Nothing is blacklisted. `containerSelectionDefects()` asserts the count-based SHAPE positively: the array is filled in ONE stage (any truncation is a second stage, and every second stage is a pipe), its length is tested against both 0 and >1, and the container id comes out of that same array. |

## Measured, old guard vs new

The old guard restored unmodified from `9ca74e52c` and run on the SAME trees.
Its two baseline failures are the literal-count assertions, already stale on
today's main; they appear in every row, so read the DELTA from its baseline.

| tree | OLD guard | NEW guard |
|---|---|---|
| unmutated | 2 fail / 32 | 57 pass / 57 |
| D1 flag moved into a trailing comment | 2 fail / 32 — **no change** | 3 fail / 57 |
| D2 apt-get on a `RUN` continuation line | 4 fail / 32 (+2) | 3 fail / 57 |
| D3 unflagged `docker compose exec` site | 4 fail / 32 (+2) | 8 fail / 57 |
| D4 `head -n 1` on the ancestor lookup | 2 fail / 32 — **no change** | 1 fail / 57 |
| E a NEW unregistered consumer, D2-shaped | 2 fail / 32 — **no change** | 2 fail / 57 |

D1 and D4 moved nothing at all in the old guard. D2 and D3 do turn it red, but
on the WRONG assertion: its per-site REACH control reports "this site no longer
refreshes the index", never "this site is unflagged", because the site fell OUT
of the population rather than failing in it. Row E is what that costs — a new
`deploy/postgres-replica/Dockerfile` carrying the pinned `FROM` and an unflagged
`RUN set -eux \ && apt-get update \` is registered nowhere, so the reach control
has nothing to say and the old guard is green on a site that cannot build. The
new guard names it. (Row E's file was staged so `git ls-files` saw it, measured,
then removed.)

## Design

Three of the four defeats were defeats of one layer — reading a command out of
source text — so that layer is written once and shared:

```
tracked file ──► commentStyle(rel)          hash | slash | none  (md gets none:
                    │                        `#` there is a heading, not a comment)
                    ▼
             stripLineComment()   quote-aware, per physical line
                    │
                    ▼
             logicalLines()       joins `\` continuations  → { line, text }
                    │
                    ▼
             runsInsideImage()    ^RUN…  |  CONTAINER_EXEC
                    │
                    ▼
             commandSegments()    split on && || ; | &
                    │
                    ▼
             isIndexUpdate()      APT_INVOCATION + \bupdate\b
                    │
                    ▼
             flagged = segment.includes(FLAG)     ← the SEGMENT, not the line
```

Direction B's population is then every tracked file that (a) works against the
pinned image — carries the literal, reads the owner file, or names one of the
LOCAL tags the compose parse found — and (b) has at least one such update.
Direction D parses the compose files with js-yaml so no YAML key order can hide
a build service.

## Controls, in two kinds

The old guard's controls were all of one kind, and that is why they did not
save it.

- **REACH controls** (`REQUIRED_SITES`, `REQUIRED_APT_SITES`,
  `REQUIRED_BUILD_SITES`) prove the scan SAW the files that matter. They do not
  prove the verdict has teeth.
- **TEETH controls** take each real site's REAL source, inject the real defect
  into it in memory, and require the SAME function the live assertion calls to
  report it. Each is anti-vacuity-linked to the defeat it stands for: the
  comment control asserts the mutated line still CONTAINS the flag (so a
  whole-line `includes()` would be satisfied); the continuation control asserts
  no PHYSICAL line both starts with `RUN` and carries the update (so the old
  per-line predicate would select nothing); the compose-exec control asserts
  the v1 spelling is GONE from the mutated source, so a finding can only come
  from recognising the v2 one.

A control that feeds SYNTHETIC input proves nothing about the path that
executes — a fixture and the live assertion can stop overlapping and the
control stays green while a one-line change walks past it. Every teeth control
here is derived from the live input.

## Files

| file | role |
|---|---|
| `tests/guards/postgis-image-single-source.test.ts` | **new** — the rewritten guard, 57 tests |
| `.github/postgis-image` | count corrected nine → **ten**; `docs/dev-setup-macos.md` names the image twice, and had done since before the rejected guard was written |
| `.github/workflows/{ci,lighthouse,coverage-reference,load-test}.yml` | six pin comments restated — they said nothing enforced agreement automatically, which stops being true here |
| `docker-compose.yml`, `docker-compose.test.yml` | same restatement, naming Direction D |
| `infra/scripts/restore-test-gcp.sh` | same restatement, naming both properties the guard now holds |

## Decisions

- **The owner file's count was already wrong, and no guard was in the tree to
  say so.** The live literal count is TEN, not nine: `docs/dev-setup-macos.md`
  names the image in the arm64 table AND in its expired-Release section. The
  rejected guard registered that file at one. Corrected here, and the
  correction is what the count assertion now enforces.
- **The guard does not exempt itself, and does not need to.** It qualifies
  under "works against the pinned image" (it names the owner file) and fails
  the second half because its own comment syntax is `//`, which `commentStyle`
  strips before matching. That is a property of the scanner, not a coincidence
  of wording — which is why the old guard's "keep the two spellings on separate
  lines" note is gone.
- **The host-side `apt-get update` in the restore drill stays OUT.** It
  installs `docker.io` on the restore VM's own host — a different, healthy
  suite. Requiring the flag there would teach the next reader to relax a
  working index, so there is a control asserting that line is NOT selected.
- **What this guard cannot do.** It is a SOURCE-TEXT guard: it proves the
  strings agree and never starts a container, so it cannot prove `apt-get
  update` succeeds inside the image — only that no site has quietly dropped the
  flag that makes it. The stopgap flag itself is unchanged and still tracked by
  #832.
