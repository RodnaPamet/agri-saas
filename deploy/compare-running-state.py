#!/usr/bin/env python3
"""Compare a service's CREATE-TIME settings against what the compose declares.

── WHY A SECOND CHECK AT ALL ── #2189

`check-drift.sh` sha256-compares `deploy/docker-compose.vm.yml` against the
VM's copy. On 2026-10-23 both were byte-identical --

    repo  390e83e4ce2723da0237ce42561e452194e58a4203849dce22a0fd0751f4fa76
    vm    390e83e4ce2723da0237ce42561e452194e58a4203849dce22a0fd0751f4fa76

-- while the live `watchtower` container had been running since 2026-07-04
without the `--stop-timeout 30s` its own declaration names:

    declared:  --label-enable --cleanup --interval 300 --stop-timeout 30s
    running:   --label-enable --cleanup --interval 300

A sha256 of a manifest answers "does the VM hold the text we wrote". It cannot
answer "is the VM RUNNING what that text declares", and the two come apart the
moment a setting is read at CREATE time. The compose file predicted exactly
this, in the block that drifted: "`watchtower` itself is not watchtower-enabled
and needs a manual `up -d` to adopt its new flag."

── WHY AN EXPLICIT ALLOWLIST AND NOT EVERY SERVICE ──

Two reasons, and the first is a secret-handling one.

`redis`'s declared command carries `--requirepass "${REDIS_PASSWORD:?...}"`.
The compose file holds the INTERPOLATION; a running container's `Config.Cmd`
holds the VALUE. So a general "compare every service's Cmd" would read a live
credential out of `docker inspect` and print it on a mismatch. The pairs below
are enumerated so that cannot happen by accident, and `assert_no_secret_shape`
refuses to render any value that looks interpolated.

Second, a general `docker compose config` vs `docker inspect` diff is mostly
noise -- defaults, generated names, resolved paths -- and this runs weekly, so
the signal-to-noise is the whole value.

── WHAT IT REFUSES TO DO ──

An EMPTY read fails. If `docker inspect` returns nothing -- a wrong container
name, as `agrent-watchtower-1` did when this was first investigated -- the
comparison must refuse rather than report agreement. `check-drift.sh` already
guards its remote sha that way ("remote sha256 was empty"); this is the same
rule for the same reason.

Usage:
    compare-running-state.py <compose.yml> <inspect.json>

`inspect.json` is the output of `docker inspect` for the containers named by
the pairs below, as a JSON array.
"""
from __future__ import annotations

import json
import re
import sys

import yaml

# (compose service, container name on the VM, what to compare)
#
# `watchtower` is the case this exists for. `app` and `worker` carry
# `stop_grace_period`, which Docker stores as `HostConfig.StopTimeout` and
# reads at create time -- so the same file-vs-process gap applies, and the
# compose block flags both as needing a recreate.
PAIRS = [
    ('watchtower', 'agrent-watchtower', 'command'),
    ('app', 'agrent-app', 'stop_grace_period'),
    ('worker', 'agrent-worker', 'stop_grace_period'),
]

INTERPOLATED = re.compile(r'\$\{[^}]+\}')


def assert_no_secret_shape(service: str, field: str, declared) -> None:
    """Refuse to compare anything whose declaration interpolates a variable.

    A `${VAR}` in the declaration means the RUNNING value is a resolved
    secret, and this script prints values on mismatch. Rather than trust the
    allowlist alone, the shape is checked: a future pair added without reading
    this docblock fails loudly instead of leaking.
    """
    if INTERPOLATED.search(str(declared)):
        raise SystemExit(
            f'refusing to compare {service}.{field}: its declaration interpolates a '
            f'variable, so the running value is a resolved secret. Compare a '
            f'non-secret field, or redact before printing.'
        )


def parse_duration_seconds(value) -> int:
    """`30s` -> 30. Compose accepts bare seconds and `Nm`/`Nh` too."""
    text = str(value).strip()
    m = re.fullmatch(r'(\d+)\s*(s|m|h)?', text)
    if not m:
        raise SystemExit(f'cannot read a duration from {text!r}')
    n = int(m.group(1))
    return n * {'s': 1, 'm': 60, 'h': 3600, None: 1}[m.group(2)]


def normalise_command(value) -> list[str]:
    """Compose allows a string or a list; Docker stores a list."""
    if isinstance(value, list):
        return [str(v) for v in value]
    return str(value).split()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    compose_path, inspect_path = sys.argv[1], sys.argv[2]

    with open(compose_path, encoding='utf-8') as fh:
        # The compose file interpolates `${...}` which is not YAML's business,
        # so it parses as plain scalars — which is what we want, since the
        # point is to compare DECLARATIONS and to refuse where one is a secret.
        compose = yaml.safe_load(fh)
    services = compose.get('services') or {}

    with open(inspect_path, encoding='utf-8') as fh:
        raw = fh.read().strip()
    if not raw:
        print('[running-state] docker inspect returned NOTHING — refusing to report '
              'agreement. Check the container names and that the VM is reachable.',
              file=sys.stderr)
        return 1
    inspected = json.loads(raw)
    by_name = {}
    for entry in inspected:
        name = str(entry.get('Name', '')).lstrip('/')
        if name:
            by_name[name] = entry

    compared = 0
    problems = []
    skipped = []

    for service, container, field in PAIRS:
        decl = services.get(service)
        if decl is None:
            problems.append(f'{service}: named in PAIRS but absent from the compose file')
            continue
        if field not in decl:
            skipped.append(f'{service}.{field} (not declared)')
            continue
        declared = decl[field]
        assert_no_secret_shape(service, field, declared)

        entry = by_name.get(container)
        if entry is None:
            # An absent container is NOT agreement. This is the case that
            # started the issue: the name was guessed wrong and the comparison
            # silently examined nothing.
            problems.append(
                f'{service}: no running container named {container!r} — '
                f'inspected {sorted(by_name) or "nothing"}'
            )
            continue

        if field == 'command':
            running = [str(v) for v in (entry.get('Config', {}).get('Cmd') or [])]
            want = normalise_command(declared)
            compared += 1
            if running != want:
                problems.append(
                    f'{service}: command differs\n'
                    f'      declared: {" ".join(want)}\n'
                    f'      running : {" ".join(running) or "(empty)"}'
                )
        elif field == 'stop_grace_period':
            # `Config.StopTimeout`, NOT `HostConfig.StopTimeout`.
            #
            # I wrote HostConfig first and it cost a round of debugging against
            # the live VM, where Docker's Go template aborts the ENTIRE command
            # on a missing key — so all three containers returned nothing and
            # the comparator correctly refused, for the wrong reason. Probed
            # the key names (names only, never values): HostConfig has 63 keys
            # and no StopTimeout; `Config.StopTimeout` is 30 for `agrent-app`.
            running_raw = entry.get('Config', {}).get('StopTimeout')
            if running_raw is None:
                problems.append(
                    f'{service}: Config.StopTimeout absent from docker inspect — '
                    f'refusing to call that agreement'
                )
                continue
            want_s = parse_duration_seconds(declared)
            compared += 1
            if int(running_raw) != want_s:
                problems.append(
                    f'{service}: stop timeout differs — declared {want_s}s, '
                    f'running {int(running_raw)}s'
                )
        else:
            problems.append(f'{service}: PAIRS names an unsupported field {field!r}')

    # The DENOMINATOR, printed whether this passes or fails. "3 of 7 services
    # compared" is the reading that shows the check narrowing while still
    # green, and this issue was only found by counting by hand.
    total_services = len(services)
    print(
        f'[running-state] {compared} create-time setting(s) compared across '
        f'{len({p[0] for p in PAIRS})} of {total_services} service(s)'
        + (f'; skipped: {", ".join(skipped)}' if skipped else '')
    )

    # PROBLEMS FIRST, before the compared-nothing check.
    #
    # Ordering these the other way round suppressed the most useful diagnostic
    # exactly when it mattered: a wrong container name makes `compared` zero,
    # so returning on that first printed "compared NOTHING" and swallowed the
    # line naming which container was missing and what WAS inspected — which
    # is the whole clue. Found by running the case rather than reading it.
    if problems:
        for problem in problems:
            print(f'[running-state] DRIFT — {problem}', file=sys.stderr)
        print('[running-state] apply with: docker compose up -d <service> on the VM. '
              'watchtower never recreates itself.', file=sys.stderr)
        return 1
    if compared == 0:
        print('[running-state] compared NOTHING — that is a failure, not a pass.',
              file=sys.stderr)
        return 1
    print('[running-state] in sync — every compared container is running what it declares.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
