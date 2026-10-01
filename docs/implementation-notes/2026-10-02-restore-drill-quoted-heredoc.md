# 2026-10-02 — the restore drill's remote script never reached the VM

**Commit:** `fix(infra): the restore drill's remote script never reached the VM`

## Design

`infra/scripts/restore-test-gcp.sh` runs its whole validation battery — WAL
recovery, `_prisma_migrations`, the `tenant_isolation` policies, `app_user` — on
a throwaway VM, by building that battery into a string and handing it to
`gcloud compute ssh --command`. The string was built with an **unquoted**
heredoc:

```
REMOTE_SCRIPT=$(cat <<REMOTE        # <- unquoted
...                                 # <- every $ and ` expanded HERE
REMOTE
)
```

Under `<<REMOTE` every `$` and every **backtick** in the body is expanded on the
machine building the string, **including backticks inside `#` comments**. #990
(2026-09-18) added a comment — a comment warning the next reader about this very
heredoc — carrying an *odd* number of backticks. The unterminated command
substitution swallowed every remaining line and ran it on the GitHub runner:

```
line 547: Acquire::Check-Valid-Until=false: command not found
E: Could not open lock file /var/lib/apt/lists/lock   (apt-get update, unprivileged)
line 547: docker.io: command not found
command substitution: line 547: unexpected EOF while looking for matching `'
... a real 9-second `docker build` of postgres:16-trixie + postgis ...
line 563: PGDATA_HOST: unbound variable                (docker run -v "$PGDATA_HOST")
```

`set -u` then killed the drill. **No SSH connection was ever opened**, so the
restore was never attempted and every assertion in the battery was silently
unreachable. Both matrix targets failed identically in run 36851363940 — which
makes it a code defect, not an environment one.

The fix is `<<'REMOTE'`. A quoted heredoc expands nothing at all, so the class
is dead by construction rather than by discipline. The five values the remote
script needs from the host are injected as a generated prelude:

```
REMOTE_SCRIPT=$(
    printf 'PGDATA_VOLUME=%q\nSTACK_DIR=%q\nPG_IMAGE=%q\nDB_USER_HINT=%q\nDB_NAME_HINT=%q\n' \
        "${PGDATA_VOLUME}" "${STACK_DIR}" "${PG_IMAGE}" "${DB_USER}" "${DB_NAME}"
    cat <<'REMOTE'
...
REMOTE
)
```

`%q` shell-quotes, so a value carrying a space or a quote cannot break the
script it is pasted into, and an empty `PG_IMAGE` still arrives as an
assignment (`PG_IMAGE=''`) rather than vanishing under `set -u`.

## Files

| file | role |
|---|---|
| `infra/scripts/restore-test-gcp.sh` | quoted heredoc + `printf %q` prelude; every `\$` / `` \` `` in the body unescaped; the three `\\` continuations in `docker run` reduced to `\` |
| `tests/guards/restore-drill-remote-script.test.ts` | new — EXECUTES the drill against a stubbed `gcloud`, once per matrix leg, captures the `--command` payload, asserts it is complete and `bash -n`-clean |
| `tests/guards/postgis-image-single-source.test.ts` | docblock correction: its "the heredoc structurally cannot carry a `#` comment" reason was a consequence of the unquoted outer heredoc and is no longer true |
| `docs/backup-restore.md` | drill-history rows for 2026-10-01 and the 2026-09-01 manual pass, plus two readings an operator needs |

## Decisions

- **Why a quoted heredoc rather than escaping the backticks.** Escaping is a
  one-line fix that leaves the trap armed: the next comment containing a
  backtick breaks the drill again, and the failure surfaces up to a month later
  because the workflow is monthly cron. Quoting removes the mechanism.
- **The guard EXECUTES rather than greps.** Every existing guard over this file
  is a regex over its SOURCE, and a regex over the source cannot see the string
  the source PRODUCES. `bash -n` on the script is also blind — verified by
  planting an unbalanced quote inside the heredoc body: `bash -n` on the script
  stayed clean while the shipped payload was broken. So the guard runs the real
  script with a stubbed `gcloud` on PATH (the technique
  `tests/unit/restore-drill-error-reporting.test.ts` already uses), captures the
  `--command` argument, and asserts four properties that were all FALSE on
  2026-10-01: the SSH step is reached at all; stderr is silent; the payload ends
  on the battery's last assertion; the payload is valid shell.
- **The guard runs BOTH matrix legs, not just agrent.** `PG_IMAGE` forks the
  payload (empty builds the postgis image from the nested heredoc; non-empty
  pulls a stock one) and the prelude values differ per target, so one leg covers
  one branch and half the injection. Running the inflect-compliance leg also
  found a stub defect that would have passed as a drill defect: a `describe`
  stub echoing a hardcoded agrent policy makes step 1 abort with "running
  WITHOUT automated backups" — so the stub derives the URL from
  `$SNAPSHOT_SCHEDULE`.
- **A `\$` left in the body is now a guard failure, not a silent break.** Under
  the quoted heredoc those escapes ship a literal backslash to the remote shell,
  which breaks the line while reading as correct source. The guard asserts the
  captured payload carries no `\$` and no `` \` ``.
- **The nested `<<'DOCKERFILE'` heredoc is better off too, as a side effect.**
  It used to collapse to one physical line (the unquoted outer heredoc ate its
  backslash-newlines); it now ships verbatim and is byte-identical to
  `deploy/postgres/Dockerfile` with comments and blank lines stripped — verified
  by running the captured fragment with `docker` stubbed to dump stdin.
- **Not verified here: a real green run against GCP.** The workflow has
  `workflow_dispatch`, but a green run on a branch is NEWER than run
  36851363940 and `.github/workflows/ci-failure-issue.yml` applies no branch
  filter, so it would auto-close the tracking issue while `main` was still
  broken. The definitive run is a dispatch after merge.
