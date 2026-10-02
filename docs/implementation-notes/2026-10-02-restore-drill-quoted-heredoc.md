# 2026-10-02 — the restore drill's remote heredoc is quoted

**Commit:** `fix(infra): quote the restore drill's remote heredoc and inject host values`

Closes the second half of #1179. #1212 fixed the live break by escaping 19
backticks inside the drill's UNQUOTED heredoc; #1226 added a guard that executes
the payload. #1225 is the remaining gap: escaping covers backticks, and the
unquoted delimiter left `$(…)`, `${VAR}` and a dropped `\$` equally live.

**This was a latent trap, not an outage.** The drill was dispatched on
2026-10-02 (run 36979511033, `12f52f0d`) and passed on both targets — snapshot
restored to a WAL-recovered Postgres with migrations, RLS policies and
`app_user` intact. Nothing was broken when this landed.

## Design

`infra/scripts/restore-test-gcp.sh` builds its whole validation battery into a
string and hands it to `gcloud compute ssh --command`. The delimiter is now
`<<'REMOTE'`, which expands nothing: every `$`, `${…}`, `$(…)` and backtick in
the 167-line body is a byte the VM receives, so the body's own prose cannot
execute on the machine building it.

The five values the VM cannot know are injected ahead of the body as a generated
prelude:

```bash
REMOTE_SCRIPT=$(
    printf '%s=%q\n' \
        PGDATA_VOLUME "${PGDATA_VOLUME}" \
        STACK_DIR "${STACK_DIR}" \
        PG_IMAGE "${PG_IMAGE}" \
        DB_USER_HINT "${DB_USER}" \
        DB_NAME_HINT "${DB_NAME}"
    cat <<'REMOTE'
…
REMOTE
)
```

**Those five are MEASURED, not assumed.** Scanning the unquoted body for
unescaped expansions found 11 live `${…}` references over exactly five distinct
names — `PGDATA_VOLUME` ×2, `STACK_DIR` ×4, `PG_IMAGE` ×2, `DB_USER` ×2,
`DB_NAME` ×1 — plus **zero** `$(…)` and **zero** bare `$VAR`. The 47 `\$`, 22
`` \` `` and 3 `\\` were all escaped-for-the-remote and were un-escaped
mechanically rather than by hand; the 6 trailing `\` line-continuations and the
one `\+` (a grep BRE) were left alone, because a backslash before anything other
than `$`, `` ` `` or `\` was never special in a heredoc.

The transform was verified by DIFFING the payload, not by reading the diff.
Capturing `--command` from a stubbed `gcloud` before and after, substituting the
prelude back in and joining line-continuations, both matrix legs produce a
byte-identical payload to `main`'s — the only intended differences being the
five prelude lines, the continuations that now survive instead of being
pre-joined by the host, and one comment paragraph that had become false.

## Files

| file | role |
|---|---|
| `infra/scripts/restore-test-gcp.sh` | the fix: quoted delimiter, `printf %q` prelude, 72 escapes removed, two comment blocks corrected |
| `tests/guards/restore-drill-remote-script.test.ts` | the byte-identity assertion, the prelude equality per leg, a hostile-value leg, and a payload-derived unresolved-reference scan |
| `tests/guards/shell-heredoc-no-live-backticks.test.ts` | the drill's delimiter pinned QUOTED (replacing a control whose premise this change makes false), and a parser fix: a heredoc mentioned in a `#` comment is no longer read as an opener |
| `tests/guards/postgis-image-single-source.test.ts` | its docblock claimed the nested Dockerfile heredoc "structurally cannot" carry a comment, which was only true while the outer delimiter was unquoted |
| `docs/backup-restore.md` | "Editing the remote half" — the operator-facing rule — plus the 2026-10-02 drill-history row |
| `CLAUDE.md` | the backup paragraph now states the quoted-delimiter invariant |

## Decisions

- **The central assertion is an equality, not a list of symptoms.** The payload
  must equal the prelude followed by the heredoc source, byte for byte. That one
  equality is what a quoted heredoc *means*, and it subsumes the class: a `$(…)`
  or `${VAR}` in prose, a backtick in a comment, a dropped backslash — each would
  make the two differ. The four symptom checks from #1226 are kept anyway,
  because they name the real 2026-10-01 failure and an equality someone widens is
  cheaper to notice beside them than alone.

- **`DB_USER` and `DB_NAME` are injected under DIFFERENT names.** The remote
  script assigns both itself, from what the restored cluster actually has
  (`DB_USER=""` then a candidate loop; `DB_NAME` falls back to a `pg_database`
  query). A prelude using those names would be clobbered one line later, and the
  "tried X, postgres, inflect" message would print an empty first candidate. They
  are `DB_USER_HINT` / `DB_NAME_HINT`, and only the 3 live `${…}` sites were
  renamed — the `\${DB_USER}` in the `psql` wrapper is a remote reference and
  still points at the remote's own variable.

- **`printf %q`, with the empty case as the reason.** `%q` shell-quotes, so a
  value carrying a space or a quote arrives as data: a hostile
  `PGDATA_VOLUME="pg data'; echo PWNED #"` round-trips through bash unchanged and
  the payload stays `bash -n`-clean (asserted, with the round-trip read back
  through bash rather than against a hand-written expectation of bash's
  escaping). The empty case is the one that would bite silently — `PG_IMAGE` is
  empty for the agrent leg, and bash renders that as `PG_IMAGE=''`; a `%s` format
  would emit `PG_IMAGE=` with nothing after it, which is still a valid assignment
  here but would not be if the value were ever substituted rather than assigned.
  Both legs are in the matrix with `PG_IMAGE` on opposite sides of empty.

- **Un-quoting now fails LOUDLY and immediately, which is a design property
  worth recording.** Measured: with the delimiter un-quoted, the drill dies on
  the host with `PGDATA_HOST: unbound variable` before any cloud call — the exact
  2026-10-01 signature, because the body's `$PGDATA_HOST` is no longer escaped.
  The previous failure mode was the dangerous one: a *balanced* pair of backticks
  would have spliced locally-executed output into the payload silently.

- **A guard was found measuring a comment.** The new "the delimiter is quoted"
  pin passed on the unmutated tree and stayed GREEN when the delimiter was
  un-quoted. `findHeredocs` matches `<<WORD` anywhere in a line, and the design
  note this change added above the heredoc contains the literal `` `<<'REMOTE'` ``
  — so the scan anchored on the PROSE, consumed forward to the terminator, and
  reported one quoted heredoc that never examined the `cat <<REMOTE` fourteen
  lines below. The fix is a comment-skip in the parser plus a fixture control
  that reproduces the exact shape; removing the skip reddens that one test and
  nothing else. Found by a mutation, not by reading — the pin would otherwise
  have shipped vacuous.

- **`unresolvedRefs` derives its denominator from the payload now.** It used to
  compare against a hand list of remote-assigned names, which was the right
  instrument while an unexpanded `${FOO}` meant the host had failed to
  substitute. With a quoted delimiter the host substitutes nothing on purpose,
  and the only remaining failure is a reference nothing in the payload assigns —
  a question about the payload, answerable from it. A new prelude entry needs no
  edit, and a body reference whose prelude line is MISSING is caught without
  one (measured: deleting the `PG_IMAGE` prelude line reddens 8 of 45).

- **`$(…)` in body prose is now GREEN on both guards, and that is the design.**
  It is not an undetected defect: measured, the payload carries the literal
  `$(hostname)` and does NOT carry this machine's hostname, with zero bytes on
  stderr. The class is removed rather than detected, so there is nothing left for
  a guard to fire on. The same prose with the delimiter un-quoted reddens the
  artifact guard 28/45 and the text guard 2/9.

## Mutation proof

Each mutation applied to `restore-test-gcp.sh`, both guards run, source restored
byte-for-byte afterwards. The two columns are the evidence for "neither guard
subsumes the other", measured rather than argued.

| mutation | artifact guard | text guard |
|---|---|---|
| un-quote the delimiter | RED 28/45 | RED 2/9 |
| `$(hostname)` in a body COMMENT | GREEN | GREEN |
| `${SOURCE_DISK}` in body prose | GREEN | GREEN |
| drop the `PG_IMAGE` prelude line | RED 8/45 | GREEN |
| `%q` → `%s` | RED 3/45 | GREEN |
| half-rename the `DB_USER` hint (prelude only) | RED 6/45 | GREEN |
| truncate the last battery assertion | RED 3/45 | GREEN |
| live backtick in a comment + un-quoted delimiter | RED 30/45 | RED 2/9 |
| remove the comment-skip from `findHeredocs` | — | RED 1/9 |

The two GREEN rows are the design and were checked rather than assumed: with the
delimiter quoted, the payload carries the literal `$(hostname)` and does NOT
carry this machine's hostname, with zero bytes on stderr. The same prose with the
delimiter un-quoted makes the drill die on the host with `PGDATA_HOST: unbound
variable` — the 2026-10-01 signature — before any cloud call.

## Not verified

The change has not been exercised against real GCP. The next scheduled run is
2026-11-01; a dispatch needs the owner's authorisation, and the drill costs real
resources. What *is* verified is the payload the VM would receive — captured
from the real script via a stubbed `gcloud`, `bash -n`-clean on both legs, and
semantically identical to the payload `main` produces. The residual risk is
confined to what the stub cannot model: `gcloud compute ssh --command` handling
of a payload whose line-continuations now survive as `\`+newline rather than
being pre-joined by the host. It is passed as a single `--command` argument
either way, and `bash -n` accepts both forms.
