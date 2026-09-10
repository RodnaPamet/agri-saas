# 2026-09-10 — un-break the two apt sites #833 missed, and give the PostGIS pin one owner

**Commits:**
- `7ee92209 fix(ci): give the PostGIS pin one owner, and un-break the two apt sites #833 missed`
- `7275bb21 fix(ci): make the PostGIS pin guard derive every population it checks`
- `<pending> fix(ci): close three blind spots in the PostGIS pin guard`

*(The line here previously quoted a subject no commit on this branch has —
the clauses of the first one in the other order. Corrected, and the two
later commits added.)*

**The live breakage leads.** On today's `main`, `deploy/postgres/Dockerfile:7`
and the heredoc copy of it at `infra/scripts/restore-test-gcp.sh:385` both run
a bare `apt-get update` against a frozen Debian index, and both fail. Measured
here, 2026-09-10, with a real `--no-cache` build of main's file:

```
E: Release file for http://deb.debian.org/debian-security/dists/bullseye-security/InRelease
   is expired (invalid since 2d 9h 39min 38s). Updates for this repository will not be applied.
ERROR: process "/bin/sh -c apt-get update && apt-get install -y ... postgresql-16-pgvector ..."
   did not complete successfully: exit code: 100
```

The same build with this change's Dockerfile exits 0 and lands
`/usr/share/postgresql/16/extension/vector*`. The restore-drill heredoc is
byte-identical to main's `FROM` + `RUN` pair, so that one measurement covers
both sites. So since 2026-09-07, `docker-compose up -d`, the VM's
`agrent-db:local` build and the monthly restore drill have all been unbuildable
while CI stayed green — because #833 shipped the fix to the CI action ONLY.

Issue #832 asked for a migration off the expired base. **That migration is not
available today** — see the table below — so this change ships the un-breaking
plus the drift guard that would have caught a one-site-out-of-three fix, and
leaves the image choice to its own issue.

## The image question, answered with evidence

`postgis/postgis:16-3.4` is Debian bullseye, whose security `Release` file
froze at `Valid-Until: Mon, 07 Sep 2026 21:13:04 UTC`. Past that instant
`apt-get update` exits 100. The obvious move is a newer tag. Measured
2026-09-10, against Docker Hub and the upstream `postgis/docker-postgis`
repo:

| candidate | base OS | PG major | pgvector for PG16? | verdict |
|---|---|---|---|---|
| `16-3.4` (current) | Debian 11 bullseye | 16 | yes, from PGDG | frozen index — the problem |
| `16-3.5` | **Debian 11 bullseye** | 16 | yes, from PGDG | **does not fix it** |
| `16-3.5-alpine` | Alpine 3.24 | 16 | **no** | unusable |
| `18-3.6` | Debian 13 trixie | **18** | yes | forces a MAJOR bump |
| `postgres:16-trixie` + PGDG | Debian 13 trixie | 16 | yes (postgis 3.6.4, pgvector 0.8.6) | needs us to publish an image |

The three load-bearing measurements:

- **`16-3.5` is bullseye too.** Upstream's `16-3.5/Dockerfile` is literally
  `FROM docker.io/postgres:16-bullseye`. Update the index in it without the
  flag and it exits 100 with the same expired-Release error. Across all 159
  `postgis/postgis` tags there is **no** OS-suffixed Debian variant, and every
  Debian tag for PG ≤ 17 is bullseye; `18-3.6` and `19beta1-3.6` are the only
  trixie ones. So the Postgres major and the maintained base are welded
  together upstream, and #832 cannot be closed by editing a tag.
- **Alpine cannot carry pgvector for PG16.** Alpine 3.24's package is
  `postgresql-pgvector`, and `apk info -R` shows it `depends on postgresql18`
  — installing it into the PG16 image drags in a second Postgres and puts
  `vector.control` in PG18's extension directory. (There is no `pgvector`
  package at all; the `vector` package in the repo is the Datadog log agent.)
- **`postgres:16-trixie` would work**, and is the shape of the real fix: the
  index refreshes cleanly, and PGDG trixie carries `postgresql-16-postgis-3`
  3.6.4 and `postgresql-16-pgvector` 0.8.6. But a GitHub Actions service
  container takes a pullable `image:`, not a build — so this route means
  publishing our own image to a registry. That is a supply-chain decision, not
  a tag edit, and it contradicts the action's own "no new image in the trust
  boundary" premise.

**Deliberately deferred.** Choosing that image is its own issue, argued on its
own merits. This change does not attempt it, and does not move the pin.

## Does the stopgap come out here? No.

**For removing it:** its own comment calls it a stopgap; a permanently frozen
security index is not a resting state; and leaving a flag that reads as a
security relaxation invites a future reader to "fix" it and re-break every job
that touches the action.

**Against, and decisive:** removing it requires a base image that does not
have the problem, and the table above shows there isn't one for PG16. Removing
it without that is not a cleanup, it is an outage. The secondary argument —
that changing the base and dropping the flag in one diff makes a red run
ambiguous between two causes — is real but subordinate; it would matter if the
choice were live, and it isn't.

So the flag stays, and the *reason it stays* is now written where someone
about to remove it will read it, with the falsifiable measurements attached.
`tests/guards/postgis-image-single-source.test.ts` also fails if the flag is
dropped from any site that needs it.

## The drift guard, and why not nine literals alone

Six of the sites are `jobs.<id>.services.<id>.image`, which accepts no `env`
context and cannot call an action; two are `FROM`; one is a doc table row.
All nine are literals by necessity. The tenth consumer is different in kind:
`.github/actions/enable-pgvector/action.yml` selects the service container
with `docker ps --filter ancestor=<image>`.

A guard asserting the literals agree with *each other* would have a hole
exactly there — move all six `image:` lines together and it stays green while
the action filters for an image nothing is running. So the action **derives**
its value from `.github/postgis-image` and holds no literal at all: a site
with nothing to drift cannot drift.

The guard has four directions:

- **A — every literal in the tracked tree equals the owner.** Derived by
  scanning `git ls-files`, not from a list, so a new site is covered the moment
  it exists. It also ties the owner file's *enumeration* to the tree: the
  header claims nine literals, and A asserts the tree holds exactly nine.
- **B — every site that updates the package index inside this image carries
  the flag.** Population derived by scanning, not listed (see below).
- **C — the action reads the owner file and restates nothing.**
- **D — a local tag that ENCODES the pinned version encodes the current one.**

Every assertion carries a positive control on its own population, and each was
mutation-proven red. One of those proofs earned its keep immediately: the first
draft of check (C) matched `toContain('postgis-image')`, and pointing
`pin_file` at `/dev/null` left every test green — the word survives in the
comments that explain the derivation. It matches the assignment now.

## What the review changed

Three findings, all confirmed, all fixed here.

### 1. Direction B was a hardcoded list, so it did not generalise

The first draft's `APT_SITES` was a three-item literal array. A reviewer proved
the hole: add `deploy/postgres-replica/Dockerfile` with the pinned `FROM` and
an unflagged index update, `git add -N` it, and the guard passed everything.
That is the **#833 recurrence shape verbatim** — a real site, running against
the frozen index, invisible to the check that claimed to cover it. An earlier
revision of this note said "check (B) is the guard that would have caught it",
which was not true of the list version.

B now derives its population the way A derives its own. A file is in it when it
BOTH works against the pinned image — carries the literal, or reads the owner
file, since the action holds no literal by Direction C — AND updates the
package index inside that image (a Dockerfile `RUN`, or an exec into the
running service container). The three-item list survives only as the *positive
control* proving the scan reached the sites we already know about.

The reviewer's mutation was re-run against the derived version:

| mutation | result |
|---|---|
| replica Dockerfile, pinned `FROM`, index update **unflagged**, `git add -N` | **RED** — B names `deploy/postgres-replica/Dockerfile: RUN apt-get update \` |
| same file, index update **flagged** | B green (A still red: a tenth literal must be registered, by design) |
| flag dropped from `deploy/postgres/Dockerfile` (the original #833 shape) | **RED** |
| `inImage` over-tightened so the scan selects nothing | **RED** at B's non-empty control |

The narrowing to `RUN` and exec lines is load-bearing rather than cosmetic:
`infra/scripts/restore-test-gcp.sh` also refreshes the index on the restore
VM's own HOST to install docker.io, which is a different, unfrozen suite and
must NOT carry the flag. Requiring it there would teach the next reader to
relax an index that is perfectly healthy.

One pleasing detail: the derived scan does not exempt the guard's own file, and
an early draft of the comment explaining `inImage` put an exec and an index
update on one line — so the guard reported *itself* as an unflagged site. The
derivation working exactly as intended.

### 2. The owner file was off by one, four lines apart

`.github/postgis-image` said "those **nine** literals (six `image:` lines, two
`FROM`s, one doc table row)" on line 19 and "that is what makes **eight**
literals safe" on line 23 — in the one file whose entire argument is exact
enumeration. Counted against the tree: 3 in `ci.yml`, 1 each in
`lighthouse.yml`, `coverage-reference.yml`, `load-test.yml`, the
`deploy/postgres` Dockerfile, the restore heredoc and
`docs/dev-setup-macos.md` = **nine**. Nine is right; "eight" was the typo,
and both sentences now say nine.

Prose that counts is prose that can drift, so the count is no longer only
prose: Direction A asserts the tree holds exactly nine live references, that
`REQUIRED_SITES` sums to nine, and that the owner file's sentence says "nine".
Mutation-proven both ways — restoring "eight literals" goes red, and so does
claiming ten when nine exist.

### 3. Two compose tags encode the pin where no image search can reach them

`docker-compose.yml` and `docker-compose.test.yml` both publish the build
as `agri-saas-postgres:16-3.4-pgvector`. That `16-3.4` **is** the pin, spelled
a second way inside a local image name — and Direction A's
`postgis/postgis:<tag>` regex cannot see either. A coordinated bump of the nine
literals would leave both lines lying about their base, with CI green.

Direction D closes it, derived rather than listed: find every compose service
that BUILDS `deploy/postgres/Dockerfile` — by the explicit `dockerfile:` key
**or** by a `context:` pointing at the directory, which is how
`deploy/docker-compose.vm.yml` does it — and require any version its published
tag encodes to equal the owner's. A tag that encodes no version at all
(`agrent-db:local`) is correct and stays out of the way. (D's *how* changed in
the next round — see below — but its rule did not.)

| mutation | result |
|---|---|
| owner bumped to `16-3.5`, compose tags left behind | **RED** — D names both compose files |
| one compose tag alone moved to `16-3.5-pgvector` | **RED** |
| both tags stripped of any version (`agri-saas-postgres:pgvector`) | **RED** at D's non-empty control |
| `context:` shape dropped from the build-site scan (vm compose falls out) | **RED** at D's build-site control |

Both compose lines now carry a comment saying the tag repeats the pin and
naming the guard that holds them together.

## What the second review changed

Three more findings against the guard, all confirmed by reproducing them
against the previous commit's guard file before fixing anything. The Dockerfile
fix itself is untouched. In every case below, "OLD" means
`7275bb21:tests/guards/postgis-image-single-source.test.ts` run against the
*same* mutated tree, so the two columns are a direct comparison and not a
recollection.

### 4. Direction D was defeated by YAML key order

`publishedTags()` found the `build:` key by regex and then scanned **forward
only** (`k = j + 1`) for a sibling `image:`. Compose does not care which side of
`build:` the `image:` key sits on, and neither does YAML — so moving that one
line up hid the whole service.

Reproduced verbatim: with `image:` moved above `build:` in `docker-compose.yml`,
`docker compose -f docker-compose.yml config` still lists the `postgres`
service, the old walker returns `[]` for that file, and the old guard passes
25/25. Then, still with the key moved, staling the tag to
`agri-saas-postgres:16-3.5-pgvector` — a live lie about the base image — left
the old guard at **25/25 green**.

D now **parses** the compose files with `js-yaml` (already a devDependency; six
other guards use it) and reads `services.<id>.build`, so key order does not
exist. Parsing also picked up two shapes the line regex was not handling: the
`build: <dir>` shorthand, and `dockerfile:` resolved *relative to* `context:`
the way Compose actually resolves it.

| mutation | OLD | NEW |
|---|---|---|
| `image:` moved above `build:` in `docker-compose.yml` | walker returns `[]`, 25/25 green | 32/32 green — tag still seen |
| …and that moved tag staled to `16-3.5-pgvector` | **25/25 green** | **RED** — `docker-compose.yml: agri-saas-postgres:16-3.5-pgvector` |
| `docker-compose.yml` corrupted to unparsable YAML | n/a | **RED** at the new parse control, which names the file |

The parse control is there because a parse error is the parsed population's
version of an empty scan: any tracked YAML that mentions the pinned
Dockerfile's directory must parse, by name, or D fails.

### 5. Direction D's control was a global floor, not a per-site one

`expect(encoded.length).toBeGreaterThanOrEqual(1)` is satisfied by whichever
site is still healthy. One build site could leave the population entirely and
the surviving one would answer for it — the exact vacuity the rest of this
guard spends its length refusing.

D's controls are now per site, in the shape A and B already use: a
`REQUIRED_BUILD_SITES` table carrying, for each compose file, how many tags its
pin-building services publish and how many of those encode a version.
`deploy/docker-compose.vm.yml` is registered at **one tag, zero encoded** —
`agrent-db:local` correctly encodes no version, and is now required to be SEEN
rather than merely tolerated by its absence.

| mutation | OLD | NEW |
|---|---|---|
| `image:` deleted from `docker-compose.test.yml` (exactly one site hidden) | **25/25 green** | **RED ×3**, naming that file twice and the population control once |
| both compose tags stripped of any version | RED at the `>= 1` floor | **RED ×3**, naming *which* sites lost their version |
| `deploy/docker-compose.vm.yml` `context:` pointed elsewhere | RED at the build-site control | **RED ×3**, incl. the vm file's own per-site row |

### 6. The owner file's count assertion covered one sentence of two

`.github/postgis-image` states its count twice. `toContain('nine literals')`
matched only the second: in the first, "nine" ends one line and "literals"
begins the next behind a `# `, so the substring never existed. The
eight-vs-nine contradiction that finding 2 fixed could therefore be reinstated
in the *other* sentence with the guard green.

The assertion now strips the comment markers, flattens the whitespace, and
collects **every** `<number> literals` / `<number> live references` claim in the
file, requiring all of them to say what `DECLARED_LITERALS` says and requiring
at least as many claims as the file makes today. `NUMBER_WORDS[count] === word`
is also asserted, so the constant cannot itself say `{ count: 9, word: 'eight' }`.

| mutation | OLD | NEW |
|---|---|---|
| "eight" reinstated in the FIRST sentence alone (line 19) | **25/25 green** | **RED** — the diff prints `"eight"` |
| "eight" in the second sentence (line 23) | RED | RED |
| "exactly nine live references" → "ten" | green (unchecked prose) | **RED** |

### Residue: Direction B did not know the pin's local spelling

`usesPinnedImage` recognised the `postgis/postgis:` literal and a reference to
the owner file, but not `agri-saas-postgres:<tag>-pgvector` — which Direction D
had just established *is* the pin, spelled a second way. A Dockerfile beginning
`FROM agri-saas-postgres:16-3.4-pgvector` and refreshing the package index
unflagged sat on the frozen bullseye index one layer down and was invisible to
B: the #833 recurrence shape again, through the door D had opened.

Fixed rather than deferred — it is the same defect class this branch exists to
close, and the fix is three lines with no new list: B now also matches the local
names **derived** from D's compose parse, so renaming a tag carries B with it.

| mutation | OLD | NEW |
|---|---|---|
| `deploy/postgres-replica/Dockerfile`, `FROM agri-saas-postgres:16-3.4-pgvector`, index update **unflagged**, `git add -N` | **25/25 green** | **RED** — `deploy/postgres-replica/Dockerfile: RUN apt-get update \` |
| the same file with the flag added | green | green (B trips on the flag, not on the file) |
| the local-name recogniser deleted from `usesPinnedImage` | n/a | **RED** at B's control |

### The inherited proofs, re-run rather than trusted

Every mutation the previous commit claimed was re-applied to this tree and
re-observed, not copied forward. All red: the flag dropped from each of the
three apt sites; `inImage` over-tightened to select nothing (4 red, including
all three per-site controls); the carve-out stretched to `deploy/`; the owner
pin bumped to `16-3.5` with the compose tags left behind (2 red); one compose
tag alone moved; a literal drifted in `ci.yml`; the Postgres major bumped to 18
(3 red); the action's `pin_file` pointed at `/dev/null`; the action restating a
literal; and `lighthouse.yml` renamed out from under the scan.

**Verification.** Guard 25 → 32 tests, all green. `tests/guards` 502 suites /
3879 tests and `tests/guardrails` 100 suites / 3525 tests green; `tsc --noEmit`
clean; `eslint` clean on the changed file; `docker compose config` still
accepts the two compose files this branch edits, and all 38 tracked YAML files
load under `js-yaml` with zero parse failures (`deploy/docker-compose.vm.yml`
is unmodified here and `config` on it needs the VM's full `.env`, so the parse
is what covers it). The pin does not move and the stopgap stays.

## Files

| file | role |
|---|---|
| `.github/postgis-image` | **new** — the owner. First non-comment line is the image ref. Enumeration corrected to nine, and the compose tags documented. |
| `.github/actions/enable-pgvector/action.yml` | derives the pin; counts matches instead of `head -1`; carries the WHY-NOT-YET argument |
| `.github/workflows/{ci,lighthouse,coverage-reference,load-test}.yml` | six pins, unchanged in value, each annotated with where the owner lives |
| `deploy/postgres/Dockerfile` | **un-broken** — gains the flag |
| `infra/scripts/restore-test-gcp.sh` | **un-broken** — gains the flag in its heredoc copy |
| `docker-compose.yml`, `docker-compose.test.yml` | local build tag encodes the pin; annotated and brought under Direction D |
| `docs/dev-setup-macos.md` | the "add the flag locally" workaround is obsolete |
| `tests/guards/postgis-image-single-source.test.ts` | **new** — the four-direction guard; D parses the compose files with `js-yaml`, and every population control is per-site |

## Decisions

- **The pin does NOT move, and the image choice is deferred.** `16-3.5` would
  be a strictly fresher image (the 3.4 line has not been rebuilt since
  2024-10-14; 3.5 was rebuilt 2026-08-31) but it does not address the defect
  this change is about, and it is not free: `deploy/postgres/Dockerfile` is
  what the agrent VM builds `agrent-db:local` from, and moving PostGIS 3.4 →
  3.5 under an existing cluster needs an `ALTER EXTENSION postgis UPDATE`
  runbook. CI and prod deliberately share one image, so bumping CI alone would
  break that documented parity. Publishing our own trixie-based image is the
  real fix and is a separate issue with a production step in it.
- **#833's fix was one site out of three.** `deploy/postgres/Dockerfile` and
  the `restore-test-gcp.sh` heredoc run the same index update against the same
  frozen suite and never got the flag. That is the cost of a per-site literal,
  and check (B) — *now that its population is derived* — is the guard that
  would have caught it. The list version would not have.
- **The restore drill's failure would have lied.** It cannot build a Postgres
  to restore *into*, which reads on the dashboard as a failed restore rather
  than as a broken build — a backup-confidence signal reporting the wrong
  thing.
- **`head -1` became a count.** The old selection collapsed "no container" and
  "one container" into one variable; only a separate emptiness check told them
  apart, and two matches silently picked the first. Zero and two are now
  distinct, named errors that dump `docker ps` alongside.
- **The host index refresh in `restore-test-gcp.sh` is deliberately NOT
  flagged.** It installs `docker.io` on the restore VM's own host — a
  different, healthy suite. Check (B) narrows to `RUN` and exec lines for
  exactly that reason.
