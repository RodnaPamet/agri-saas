# 2026-10-02 — the restore drill's payload, asserted by executing it

**Commit:** `test(infra): assert the restore drill's remote payload by executing the drill`

## Design

#1179 was fixed by #1212: every backtick inside the unquoted `REMOTE` heredoc of
`infra/scripts/restore-test-gcp.sh` is escaped, and
`tests/guards/shell-heredoc-no-live-backticks.test.ts` keeps it that way
repo-wide. That is the right fix for the cause, and this change does not touch
it — the script here is byte-identical to `main`.

What was still missing is a check on the **artifact**. The drill builds its whole
validation battery into a string and hands it to `gcloud compute ssh --command`.
Nothing had ever looked at that string:

- a regex over the source cannot see a string the source *produces*;
- `bash -n` on the drill script cannot either — a heredoc body is not parsed.
  **Measured**: with a deliberate unbalanced quote planted inside the heredoc,
  `bash -n infra/scripts/restore-test-gcp.sh` exits 0 while the payload is broken
  shell.

So `tests/guards/restore-drill-remote-script.test.ts` runs the real script with a
stubbed `gcloud` on PATH, captures the `--command` argument, and asserts on it —
once per matrix leg, because `PG_IMAGE` forks the payload (empty builds the
postgis image from the nested `<<'DOCKERFILE'` heredoc; non-empty pulls a stock
one) and the interpolated paths differ per target. Nothing is provisioned and no
cloud call is made; the technique is `tests/unit/restore-drill-error-reporting.test.ts`'s.

Four properties, every one of which was false in run 36851363940:

1. the drill reaches the SSH step at all (a payload was captured);
2. it gets there with a silent stderr — none of the four strings that run
   printed;
3. the payload is **complete**, ending on the battery's last assertion;
4. the payload is valid shell, carries this target's interpolated paths, keeps
   its `$remote` references intact, and references nothing the remote script does
   not itself assign.

## Files

| file | role |
|---|---|
| `tests/guards/restore-drill-remote-script.test.ts` | new — executes the drill per matrix leg and asserts on the captured payload |
| `docs/backup-restore.md` | drill-history rows for 2026-10-01 and the 2026-09-01 manual pass it was missing, plus two readings an operator needs |

## Decisions

- **Two guards, not one, and neither subsumes the other.** #1212's guard asserts
  a property of the SOURCE TEXT — one known hazard, every shell script in the
  tree. This one asserts a property of the ARTIFACT — one script, whatever the
  cause. The measurement that settles it: dropping one backslash from a `\$` on a
  line meant for the remote shell (zero backticks involved) leaves
  `shell-heredoc-no-live-backticks` **fully green** while this guard goes **20 of
  33 red**. The variable expands locally, to nothing, and the payload reads
  `test -d ""` — still valid shell, still backtick-free, and the drill then
  reports a corrupt backup on a backup that is fine. Same argument as
  `public-routes-self-authenticate`: either half alone is worse than neither.
- **The quoted-heredoc alternative was written, measured, and dropped.** A
  `<<'REMOTE'` body plus a `printf %q` prelude kills the whole local-expansion
  class by construction rather than by discipline, and it was verified end to end
  (both legs, complete and `bash -n`-clean payload, the nested Dockerfile
  arriving byte-identical to `deploy/postgres/Dockerfile` instead of collapsed
  onto one line). It is not here because #1212 landed first with a working fix
  and a guard, and rewriting the same 165 lines a second way is churn in a file
  two sessions were editing. The residual gap is worth naming rather than
  silently carrying: escaping covers backticks, so a `$(…)` or a `${VAR}` written
  in PROSE inside that heredoc would still expand locally and
  `shell-heredoc-no-live-backticks` would not see it. This guard catches the
  consequence; quoting the delimiter would remove the possibility.
- **Both legs, because one leg is half a test.** Running only `agrent` covers the
  build branch and one target's interpolation. Adding the inflect-compliance leg
  also found a stub defect that would otherwise have read as a drill defect: a
  `describe` stub echoing a hardcoded agrent resource policy makes step 1 abort
  with "running WITHOUT automated backups", so the stub derives that URL from
  `$SNAPSHOT_SCHEDULE`.
- **`created_at != started_at` was checked, not assumed.** Both jobs were queued
  (`10:47:56` created; `10:51:25` and `10:59:47` started — `max-parallel: 1`
  serialises them), so the duration figures are real: the drill step took 3m46s
  and 3m20s against `timeout-minutes: 45`. Nothing timed out, and the repo's
  known "a cancelled-while-queued job reads queue wait as duration" trap does not
  apply here.
