#!/usr/bin/env bash
#
# deploy/caddy-sites.sh — print the site addresses a Caddyfile serves, one per line.
#
# Factored out of check-drift.sh so it can be TESTED. The comparison it feeds is
# a set difference, and a set difference against an empty set reports "nothing
# missing" — so an extractor that silently matches nothing would make the
# foreign-site check pass on every input, including the one it exists to catch.
# tests/guardrails/caddy-foreign-sites.test.ts runs this against fixtures for
# exactly that reason.
#
# What counts as a site address:
#   · a block header at COLUMN 0 ending in `{`, comma-split and trimmed
#   · NOT the global options block (a bare `{`), which configures the server
#     rather than serving a name
#   · NOT a snippet definition `(name) {`, which is a template until imported
#
# Usage:  deploy/caddy-sites.sh <Caddyfile>
# Exit:   0 = one or more addresses printed
#         2 = unreadable argument
#         3 = parsed cleanly and found NOTHING, which is refused rather than
#             returned, because an empty answer is indistinguishable from a
#             broken parser to every caller that compares sets.
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ]; then
    echo "usage: deploy/caddy-sites.sh <Caddyfile>" >&2
    exit 2
fi
if [ ! -r "$FILE" ]; then
    echo "caddy-sites: cannot read '${FILE}'" >&2
    exit 2
fi

ADDRS="$(
    sed -e 's/#.*$//' "$FILE" \
    | grep -E '^[^[:space:]].*\{[[:space:]]*$' \
    | sed -E 's/\{[[:space:]]*$//' \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -vE '^$' \
    | grep -vE '^\(' \
    | sort -u || true
)"

if [ -z "$ADDRS" ]; then
    echo "caddy-sites: parsed '${FILE}' and found NO site addresses — refusing to" >&2
    echo "  report an empty set. Either the file has no site blocks, or this" >&2
    echo "  extractor no longer understands the syntax. Both need a human." >&2
    exit 3
fi

printf '%s\n' "$ADDRS"
