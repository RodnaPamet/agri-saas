#!/usr/bin/env bash
# Merge origin/main into the current branch, ALWAYS re-running the generators,
# and resolving any conflict in a generated artifact by taking main's copy.
#
# ## Regeneration is UNCONDITIONAL, and that is the important part
#
# It would be natural to regenerate only what conflicted. That is the wrong
# trigger, because a conflict is a signal that git could NOT decide — it is
# not the set of cases where git decided WRONGLY. Two PRs editing adjacent
# hunks of one schema can merge cleanly into something neither intended, and
# nothing local says so: the `lint-staged` glob that runs
# `check-openapi-sync.sh` matches SOURCE files, so a merge that touches only
# the artifact never triggers it.
#
# ## WHY THIS IS A SCRIPT AND NOT A GIT MERGE DRIVER
#
# #1401 proposed replacing this with `.gitattributes` plus a
# `merge=openapi-regen` driver, so regeneration happened automatically instead
# of being remembered. I built it and measured it, and it is WORSE THAN DOING
# NOTHING. Two branches, each changing a different route summary and
# regenerating:
#
#                              spec has A   spec has B   == regeneration
#     plain git text merge          1            1            YES
#     with the regenerating driver  0            1            NO
#
# A merge driver is invoked DURING the merge, and git has not yet written the
# merged sources to the working tree when it runs. Traced from inside the
# driver at the moment of invocation:
#
#     INVOKED path=src/generated/openapi.json
#       working-tree source has BRANCH-A: 0     <-- not merged yet
#
# So the driver regenerated from the PRE-MERGE sources and silently dropped
# branch A's change, while plain git's three-way text merge produced exactly
# the right file. The driver turns a correct clean merge into a quiet
# contradiction between the artifact and its own sources — the very failure
# #1401 set out to prevent.
#
# This script is correct for the one reason the driver cannot be: it merges
# FIRST and regenerates AFTERWARDS, when the sources are final. The ordering
# is the whole design, not an implementation detail.
#
# ## CORRECTION: the `info.version` evidence this used to cite was wrong
#
# This docblock previously justified unconditional regeneration with a
# measurement from #1401 — a clean auto-merge that produced `info.version`
# 5.5.4 where regeneration said 5.6.0 — and called it a silently wrong merge.
# It is not:
#
#   * `tests/contracts/api-schemas.test.ts` STRIPS `info.version` before
#     comparing, deliberately and with a comment saying why.
#   * semantic-release bumps `package.json::version` AFTER the spec is
#     committed, and the `chore(release)` commit never regenerates. On main
#     today: spec 7.0.0, package.json 7.2.0 — a two-release lag with no merge
#     anywhere near it.
#
# The committed spec is therefore ALWAYS at least one release behind, on every
# branch, and git taking "ours" for that hunk returned the correct value.
#
# The behaviour here is unchanged — the first paragraph is reason enough and a
# generator pass is cheap. Only the evidence was wrong, and a comment that
# gives a false reason is worse than no comment: somebody would eventually
# "fix" the code to match it, which is exactly how the driver came to be
# proposed.
#
# So the generators run on every invocation, conflict or not. On a clean merge
# that costs one generator pass and a no-op diff.
#
# Why this exists: #1404 hit the same conflict four times in one afternoon, and
# every one of them was in a file no human edits —
#
#   package-lock.json                          `chore(release)` bumps `version`
#                                              in the lines adjacent to any
#                                              dependency edit
#   src/generated/openapi.json                 regenerated per PR
#   src/generated/route-inventory.json         regenerated per PR
#   tests/contracts/__snapshots__/*.snap       regenerated per PR
#
# Resolving those by hand is mechanical, slow, and the slowness is what loses
# the race: each manual pass takes long enough for the next release commit to
# land and conflict the branch again. Automating it is not a convenience, it is
# the difference between winning a CI window and not.
#
# `package-lock.json` is the one that needs care rather than regeneration: a
# full `npm install` on a glibc host rewrites the whole packages tree and
# silently drops all 34 `libc` platform entries (caught by
# tests/guards/lockfile-libc-preserved.test.ts, and measured independently by
# backend-1 on #1308 under npm 10.9.8). So take main's and re-apply only the
# declared-dependency delta.
#
# ## The allowlist is an ENUMERATION, and then it is VERIFIED
#
# The first draft matched `src/generated/*` and `tests/contracts/__snapshots__/*`
# as globs. That is the dangerous shape, and backend-1 named it before it bit:
# the day somebody adds a HAND-WRITTEN file under one of those directories,
# a glob resolves it by taking main's copy and "regenerating" it — silently
# discarding the branch's work, with a reassuring log line.
#
# So the list is spelled out file by file. And because an enumeration is still
# a CLAIM that those files are generated, the script proves it: after
# regenerating, it runs the generators a second time and requires that nothing
# changes. A file that moves on the second pass is not deterministically
# generated, so taking main's copy was not a safe resolution for it, and the
# script says so instead of committing.
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] && { echo "refusing to run on main"; exit 1; }

git fetch -q origin main
echo "merging origin/main ($(git rev-parse --short origin/main)) into $BRANCH"

# Capture the dependency names this branch ADDS to package.json, before the
# merge can disturb them. This is the only hand-authored part of the lockfile
# delta; everything else in it is derived.
ADDED_DEPS=$(node -e '
const { execSync } = require("child_process");
const base = execSync("git merge-base HEAD origin/main").toString().trim();
const at = (ref) => JSON.parse(execSync(`git show ${ref}:package.json`).toString());
const mine = at("HEAD").dependencies ?? {};
const theirs = at(base).dependencies ?? {};
const added = Object.keys(mine).filter((k) => !(k in theirs));
process.stdout.write(JSON.stringify(added.map((k) => [k, mine[k]])));
')
echo "dependencies this branch adds: $ADDED_DEPS"

git merge origin/main --no-edit || true

CONFLICTED=$(git diff --name-only --diff-filter=U || true)
if [ -z "$CONFLICTED" ]; then
    echo "no conflicts"
else
    echo "conflicted:"; printf '  %s\n' $CONFLICTED
    for f in $CONFLICTED; do
        case "$f" in
            # ENUMERATED, not globbed. Adding a file here is a decision that
            # it is machine-generated and that discarding this branch's copy
            # of it is therefore safe. Do not replace these with patterns.
            package-lock.json \
            | src/generated/openapi.json \
            | src/generated/route-inventory.json \
            | tests/contracts/__snapshots__/api-schemas.test.ts.snap)
                git checkout --theirs -- "$f"
                git add -- "$f"
                echo "  took main's $f (will regenerate)"
                ;;
            *)
                echo "  !! $f is not on the generated-artifact list."
                echo "     Resolve it by hand and re-run. If it IS generated, add it to"
                echo "     the enumeration in this script — deliberately, because doing so"
                echo "     means this branch's copy of it may be discarded."
                exit 1
                ;;
        esac
    done
fi

# Re-apply the dependency declarations onto main's lockfile, without a full
# install. See the header for why `npm install` is the wrong tool here.
node -e '
const fs = require("fs");
const added = JSON.parse(process.argv[1]);
if (!added.length) { console.log("  no dependency delta to re-apply"); process.exit(0); }
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const [name, range] of added) {
    pkg.dependencies[name] = range;
    lock.packages[""].dependencies[name] = range;
}
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
pkg.dependencies = sortObj(pkg.dependencies);
lock.packages[""].dependencies = sortObj(lock.packages[""].dependencies);
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 4) + "\n");
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
const libc = Object.values(lock.packages).filter((p) => p.libc).length;
console.log(`  re-applied ${added.length} dependency declaration(s); libc entries preserved: ${libc}`);
' "$ADDED_DEPS"

npm run db:generate >/dev/null 2>&1 && echo "  prisma client regenerated"
npm run openapi:generate >/dev/null 2>&1 && echo "  openapi.json regenerated"
npm run routes:inventory 2>&1 | tail -1

# The contract SNAPSHOT is on the take-main's-copy list above but had no
# regeneration step, which made it the one artifact this script could leave
# stale. If this branch added or renamed a component schema, main's snapshot
# does not contain it, `git checkout --theirs` discards ours, and nothing here
# put it back — so `api-schemas.test.ts` fails in CI with "New snapshot was not
# written", which reads as a test problem rather than as a merge resolution.
#
# `-u` WRITES snapshots, so a non-zero exit is a real failure and not "the
# snapshot differed". CI=1 because this file is a jest test and will migrate the
# SHARED test database without it.
if CI=1 npx jest tests/contracts/api-schemas.test.ts -u --silent >/dev/null 2>&1; then
    echo "  api-schemas snapshots regenerated"
else
    echo "  !! the api-schemas snapshot could not be regenerated."
    echo "     Main's copy is staged and may be missing this branch's schemas."
    echo "     Nothing has been committed. Run it yourself and inspect:"
    echo "         CI=1 npx jest tests/contracts/api-schemas.test.ts -u"
    exit 1
fi

git add -A

# ── Prove the "generated" claim rather than trusting the list ──
# Run every generator a SECOND time. A deterministically generated file does
# not move; one that does was not safe to resolve by taking main's copy, and
# the enumeration above is wrong about it.
echo
echo "verifying the resolved artifacts are reproducible..."
npm run db:generate >/dev/null 2>&1 || true
npm run openapi:generate >/dev/null 2>&1 || true
npm run routes:inventory >/dev/null 2>&1 || true
CI=1 npx jest tests/contracts/api-schemas.test.ts -u --silent >/dev/null 2>&1 || true
MOVED=$(git diff --name-only || true)
if [ -n "$MOVED" ]; then
    echo "  !! these moved on a SECOND generator pass, so they are not deterministically generated:"
    printf '     %s\n' $MOVED
    echo "     Taking main's copy was therefore not a safe resolution for them."
    echo "     Nothing has been committed. Resolve by hand."
    exit 1
fi
echo "  all resolved artifacts reproduced identically — the generated claim holds"

echo
echo "files differing from origin/main:"
git diff --cached --name-only origin/main | sed 's/^/  /'
echo
echo "Review the list above, then commit. Nothing has been committed."
