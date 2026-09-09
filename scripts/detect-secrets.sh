#!/usr/bin/env bash
# Epic C.2 — local secret-detection scanner.
#
# Run modes:
#
#   bash scripts/detect-secrets.sh
#       Scans every staged file (`git diff --cached --name-only`).
#       Used by .husky/pre-commit so a developer can't accidentally
#       commit credentials.
#
#   bash scripts/detect-secrets.sh path/to/file ...
#       Scans the explicit file list. lint-staged invokes the script in
#       this shape, passing the staged subset that matches its glob.
#
#   bash scripts/detect-secrets.sh --all
#       Scans every tracked file. Useful for one-off audits and the
#       periodic scheduled job; NOT used by the pre-commit hook.
#
# Exit codes:
#   0 — no findings (or only allowlisted lines)
#   1 — at least one finding; commit should be aborted
#   2 — invocation/usage error
#
# Allowlist:
#   Append `# pragma: allowlist secret` to the offending line to skip
#   it. Use sparingly — every allowlist needs a one-line justification
#   in the commit message or the surrounding comment. The CI half of
#   Epic C will keep us honest by flagging new allowlist comments.
#
# Maintainability:
#   Pattern set is intentionally narrow (high-signal classes). Adding a
#   new class is one line in PATTERNS below + a test case in
#   tests/unit/security/detect-secrets.test.ts.

set -uo pipefail

# ─── Colours (best-effort; no-op when stdout is not a TTY) ──────────
if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
    BOLD=""; RED=""; YELLOW=""; DIM=""; RESET=""
fi

# ─── Allowlist substring (line-level) ───────────────────────────────
ALLOWLIST_MARKER='pragma: allowlist secret'

# ─── Path-level skip globs ──────────────────────────────────────────
# Don't scan binaries, lockfiles, the build output, or large vendored
# dirs — they generate noise without catching real secrets.
SKIP_PATHS=(
    'node_modules/' '.next/' 'dist/' 'build/' 'coverage/' 'playwright-report/'
    'test-results/' '.git/' '.husky/_/'
    'package-lock.json' 'yarn.lock' 'pnpm-lock.yaml'
    'prisma/migrations/' 'public/'
    # The scanner itself, the pattern source it reads, and the tests
    # that exercise both — all contain secret-shaped strings on
    # purpose, so exempt them from self-scan.
    'scripts/detect-secrets.sh'
    '.secret-patterns'
    'tests/unit/security/detect-secrets.test.ts'
    'tests/guardrails/no-secrets.test.ts'
    # `tests/fixtures/secrets/` is the canonical home for intentional
    # secret-shaped strings used by tests. Anything dropped here is
    # by definition not a real credential.
    'tests/fixtures/secrets/'
)

is_skipped() {
    local file="$1"
    for skip in "${SKIP_PATHS[@]}"; do
        case "$file" in
            "$skip"*|*"/$skip"*) return 0;;
        esac
    done
    # Skip non-text / binary files — `git check-attr -z binary` is the
    # most reliable check, but a cheap MIME-type sniff via `file` is
    # plenty for our use case.
    if [[ -f "$file" ]]; then
        local mime
        mime=$(file --mime-type --brief "$file" 2>/dev/null || echo "")
        case "$mime" in
            text/*|application/json|application/javascript|application/x-shellscript|application/xml|inode/x-empty|"")
                return 1;;
            *)
                return 0;;
        esac
    fi
    return 1
}

# ─── Pattern table ──────────────────────────────────────────────────
# Loaded from `.secret-patterns` at the repo root so this scanner and
# the CI guardrail (`tests/guardrails/no-secrets.test.ts`) share a
# single source of truth. See that file for the line-format spec and
# maintenance notes.

PATTERN_FILE="${PATTERN_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.secret-patterns}"
if [[ ! -f "$PATTERN_FILE" ]]; then
    echo "${RED}ERROR${RESET}: pattern file not found at $PATTERN_FILE" >&2
    exit 2
fi

PATTERNS=()
while IFS= read -r raw_line; do
    # Strip trailing CR (in case the file was edited on Windows)
    raw_line="${raw_line%$'\r'}"
    # Skip blank + comment lines
    [[ -z "${raw_line// }" ]] && continue
    [[ "${raw_line# }" == \#* ]] && continue
    # Split on the FIRST `|` so regexes containing `|` survive intact.
    name="${raw_line%%|*}"
    regex="${raw_line#*|}"
    # Trim leading/trailing whitespace from the name + regex.
    name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
    regex="${regex#"${regex%%[![:space:]]*}"}"; regex="${regex%"${regex##*[![:space:]]}"}"
    # A line without `|` would round-trip name=regex; treat that as an
    # invalid line and warn loudly so a malformed pattern can't ship.
    if [[ "$name" == "$regex" ]]; then
        echo "${YELLOW}WARN${RESET}: ignoring malformed pattern line: $raw_line" >&2
        continue
    fi
    PATTERNS+=("$name|$regex")
done < "$PATTERN_FILE"

if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    echo "${RED}ERROR${RESET}: no patterns loaded from $PATTERN_FILE" >&2
    exit 2
fi

# ─── File-list resolution ───────────────────────────────────────────

resolve_files() {
    if [[ "${1:-}" == "--all" ]]; then
        git ls-files -z | tr '\0' '\n'
        return
    fi
    if [[ $# -gt 0 ]]; then
        printf '%s\n' "$@"
        return
    fi
    # Pre-commit invocation: only added/modified/copied/renamed files.
    git diff --cached --name-only --diff-filter=ACMR -z | tr '\0' '\n'
}

# ─── Scan loop ──────────────────────────────────────────────────────

# Capture findings as "file\tline\tpattern\texcerpt" so we can render
# all of them at the end (rather than dumping mid-stream).
findings=()

# Bash 4 doesn't ship with PCRE, so the patterns above use an inline
# `(?i)` that grep -P handles. Verify grep supports -P; fall back to
# `pcre2grep` if available, else REFUSE — deliberately, and loudly.
#
# There is no tr-based fallback. An earlier version of this comment promised
# one; it never existed, and a secret scanner that silently degrades to a
# weaker pattern set is worse than one that stops. macOS ships BSD grep with
# no -P, so `brew install pcre2` is a prerequisite there (see
# docs/dev-setup-macos.md).
if echo abc | grep -qP 'a' 2>/dev/null; then
    GREP_CMD=(grep -nP)
elif command -v pcre2grep >/dev/null 2>&1; then
    GREP_CMD=(pcre2grep -n)
else
    echo "${RED}ERROR${RESET}: secret scanner needs PCRE — install GNU grep or pcre2grep." >&2
    exit 2
fi

scan_file() {
    local file="$1"
    [[ -r "$file" ]] || return 0

    for entry in "${PATTERNS[@]}"; do
        local name="${entry%%|*}"
        local regex="${entry#*|}"
        # `|| true` — `grep -P` exits 1 when no match; that's the
        # happy path here, so don't propagate the non-zero exit.
        local hits
        hits=$("${GREP_CMD[@]}" -- "$regex" "$file" 2>/dev/null || true)
        [[ -z "$hits" ]] && continue
        while IFS= read -r line; do
            # Allowlist: skip lines that explicitly opt out.
            if printf '%s' "$line" | grep -qF "$ALLOWLIST_MARKER"; then
                continue
            fi
            local lineno="${line%%:*}"
            local excerpt="${line#*:}"
            # Trim long lines so terminal output stays readable.
            if [[ ${#excerpt} -gt 200 ]]; then
                excerpt="${excerpt:0:200}…"
            fi
            findings+=("$file"$'\t'"$lineno"$'\t'"$name"$'\t'"$excerpt")
        done <<<"$hits"
    done
}

## ─── Env-file filename guard (GAP-16) ───────────────────────────────
#
# Refuses to commit a `.env` file (or any `.env.<name>` variant) by
# filename, REGARDLESS of content. Defense-in-depth on top of three
# existing layers:
#
#   1. .gitignore lines 13-19 cover the common .env variants — primary
#      gate against accidental `git add`.
#   2. The pattern-based content scan below catches real secret
#      payloads inside a force-staged file.
#   3. The CI guardrail at tests/guardrails/no-secrets.test.ts re-runs
#      the same content scan repository-wide.
#
# This filename guard catches the remaining hole: someone deliberately
# `git add -f .env` with placeholder-only content that doesn't trip
# any secret pattern. Such a file should never be committed regardless
# of what's inside.
#
# Allowed filenames (for templates committed for developer onboarding):
#   .env.example, .env.local.example, .env.<env>.example, etc.
#
# Detection: basename matches `.env` or `.env.<name>` AND does NOT end
# in `.example`.

env_reject_findings=()

is_forbidden_env_file() {
    local file="$1"
    local base="${file##*/}"
    case "$base" in
        # Allow templates first.
        *.example) return 1;;
        # Reject .env and .env.<name>.
        .env|.env.*) return 0;;
        *) return 1;;
    esac
}

main() {
    local files
    files=$(resolve_files "$@")
    if [[ -z "$files" ]]; then
        # No staged files; nothing to do. Don't fail — that would block
        # commits that only touch e.g. submodule pointers.
        exit 0
    fi

    # Filename guard runs BEFORE content scanning. A forbidden .env
    # file is a structural mistake; we want to surface it cleanly with
    # an actionable message rather than potentially mask it under a
    # secret-pattern hit (or worse, miss it entirely if the placeholders
    # don't match any pattern).
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        if is_forbidden_env_file "$f"; then
            env_reject_findings+=("$f")
        fi
    done <<<"$files"

    if [[ ${#env_reject_findings[@]} -gt 0 ]]; then
        echo
        echo "${BOLD}${RED}✖ Refusing to commit env file(s)${RESET}"
        echo "${DIM}  scanned by scripts/detect-secrets.sh (GAP-16 filename guard)${RESET}"
        echo
        for f in "${env_reject_findings[@]}"; do
            echo "  ${BOLD}${f}${RESET}"
        done
        cat <<-EOF

${BOLD}How to proceed:${RESET}
  1. ${BOLD}If this is a real env file${RESET} — remove it from the
     working tree (and rotate any credentials it carried at the
     issuer). Add the path to .gitignore if it isn't already.
  2. ${BOLD}If this is a template${RESET} — rename to ${YELLOW}.env.<name>.example${RESET}.
     The .example suffix is the convention for committed templates.
  3. As a last resort (review first!) bypass the hook:
       ${DIM}git commit --no-verify${RESET}
EOF
        exit 1
    fi

    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        is_skipped "$f" && continue
        [[ -f "$f" ]] || continue
        scan_file "$f"
    done <<<"$files"

    if [[ ${#findings[@]} -eq 0 ]]; then
        exit 0
    fi

    echo
    echo "${BOLD}${RED}✖ Possible secrets detected in staged changes${RESET}"
    echo "${DIM}  scanned by scripts/detect-secrets.sh${RESET}"
    echo
    for f in "${findings[@]}"; do
        IFS=$'\t' read -r file lineno name excerpt <<<"$f"
        echo "  ${BOLD}${file}:${lineno}${RESET}"
        echo "    ${YELLOW}${name}${RESET}"
        echo "    ${DIM}${excerpt}${RESET}"
        echo
    done
    cat <<-EOF
${BOLD}How to proceed:${RESET}
  1. ${BOLD}If this is a real secret${RESET} — remove it, rotate it
     immediately at the issuer, and stage the cleaned file.
  2. ${BOLD}If this is a sample / fixture / unit-test input${RESET} —
     move it under tests/fixtures/secrets/ (auto-skipped) or append
     ${YELLOW}# pragma: allowlist secret${RESET} to the line with a
     short comment explaining why it's safe.
  3. To rerun the scan after fixing:
       ${DIM}npm run secret-scan${RESET}
  4. As a last resort (review first!) bypass the hook:
       ${DIM}git commit --no-verify${RESET}
EOF
    exit 1
}

main "$@"
