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
So the flag stays, and the *reason it stays* is now written where someone
about to remove it will read it, with the falsifiable measurements attached.
Nothing enforces its presence automatically yet — see #860.

## The drift guard was split out to #860

This note originally carried a four-direction guard meant to make the pin
self-enforcing. It is **not** in this change. It failed review three times in
the same way — green against the very break it exists to prevent — and holding
the fix hostage to it helped nobody, so the guard moved to #860 and the fix
lands on its own.

Both surviving defeats are reproduced in that issue. The short version:

- The flag test filtered `!line.includes(STOPGAP_FLAG)` across the whole
  physical line, comments included. Moving the flag's text into a trailing
  comment left the guard at **32/32 green** while the real flag was gone from
  `deploy/postgres/Dockerfile` and the build broke exactly as #832 describes.
- The population predicate required the `apt-get` call to itself start with
  `RUN`, so the ordinary `RUN … \` continuation idiom never entered the
  population at all.

The four-direction *structure* is sound and worth reusing; it is the
populations that were wrong. The rejected guard is preserved on
`fix/832-postgis-base-image` @ `9ca74e52c`.

### What that means for this change

The pin has one owner — `.github/postgis-image` — and every consumer now cites
it in a comment at the site. Agreement is **maintained by hand** until #860
lands. That is a real gap and the comments say so rather than implying a
check exists.

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
| _(no guard)_ | the drift guard was split to #860 — it was green against the break it exists to prevent |

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
