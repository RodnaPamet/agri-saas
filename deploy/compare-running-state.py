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

── WHY AN EXPLICIT ALLOWLIST FOR `command`, AND NOT FOR `logging` ──

The allowlist below governs `command` and `stop_grace_period`. `logging` is
DERIVED instead -- every service in the manifest that declares it, 8 of 8 --
and the difference between the two is the whole reason the allowlist exists.

Two reasons, and the first is a secret-handling one.

`redis`'s declared command carries `--requirepass "${REDIS_PASSWORD:?...}"`.
The compose file holds the INTERPOLATION; a running container's `Config.Cmd`
holds the VALUE. So a general "compare every service's Cmd" would read a live
credential out of `docker inspect` and print it on a mismatch. The pairs below
are enumerated so that cannot happen by accident, and `assert_no_secret_shape`
refuses to render any value that looks interpolated.

A log driver and its size caps are not that: no service interpolates them, and
the values are `json-file`, `10m`, `3`. So `logging` gets the coverage the
manifest supports rather than the narrow coverage `Cmd` has to accept -- which
moves the denominator from 3 of 8 services to 8 of 8, and a check covering one
service in three is exactly what the printed count is for.

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

`inspect.json` is the output of `docker inspect` as a JSON array, for every
container in the compose project -- `check-drift.sh` selects them by the
`com.docker.compose.project` label rather than by name, and projects only the
four keys that are safe to move off the VM. A container named by a pair but
absent from that array is a FAILURE, never agreement: that is the case that
started this issue.
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

# The compose project, which is also the container-name prefix.
#
# There is no top-level `name:` in the manifest, so Docker takes the project
# from the DIRECTORY — `/opt/agrent`. Named here rather than inlined because it
# is a GUESS about the deployment, not a fact about the file, and a wrong one
# fails loudly: the comparison reports `no running container named X` and lists
# what it DID inspect.
COMPOSE_PROJECT = 'agrent'

# `logging` is compared for EVERY service that declares it, derived from the
# compose rather than listed above.
#
# The allowlist exists for a secret-handling reason that does not apply here: a
# general `Cmd` comparison would read `redis`\'s resolved `--requirepass`, while
# a log driver and its size caps carry no credential. So this field gets the
# coverage the manifest supports — 8 of 8 services — instead of the three the
# `Cmd` rule has to be narrow for.
#
# It belongs in a CREATE-TIME check because that is exactly what it is: the
# `x-logging` block\'s own comment is what `stop_grace_period`\'s cites when it
# says applying it needs a recreate. A service whose log rotation was changed in
# the manifest and never recreated keeps writing unbounded files, and the file
# and the process agree on nothing while `check-drift.sh` reports byte-identity.
LOGGING_FIELD = 'logging'


def container_for(service: str, decl: dict) -> str:
    """The container name Docker gives a service.

    `container_name` when the manifest sets one — seven of eight services do —
    and otherwise the compose default `<project>-<service>-1`. Derived rather
    than enumerated because a hand-written name is what broke the first attempt
    at this check: `agrent-watchtower-1` does not exist, the inspect returned
    nothing, and the comparison examined zero containers while reporting
    success. `clamav` is the one service here with no `container_name`, so it
    is the case that keeps this branch honest.
    """
    explicit = decl.get('container_name')
    if explicit:
        return str(explicit)
    return f'{COMPOSE_PROJECT}-{service}-1'


def logging_pairs(services: dict) -> list[tuple[str, str, str]]:
    """Every service declaring `logging`, as (service, container, field)."""
    return [
        (name, container_for(name, decl), LOGGING_FIELD)
        for name, decl in sorted(services.items())
        if isinstance(decl, dict) and decl.get(LOGGING_FIELD) is not None
    ]


def compare_logging(service: str, declared, entry: dict) -> list[str]:
    """`HostConfig.LogConfig` against the manifest\'s `logging:` block.

    Docker splits the declaration across two keys — `Type` for the driver and
    `Config` for the options — and stores every option VALUE as a string, while
    YAML reads `max-file: "3"` as a string and a bare `3` as an int. So options
    are compared as strings; comparing raw would report drift on a manifest edit
    that only removed a pair of quotes.
    """
    problems: list[str] = []
    log = entry.get('HostConfig', {}).get('LogConfig')
    if log is None:
        # Not agreement. An absent key means the projection dropped it or the
        # inspect shape changed, and calling that "in sync" is the failure this
        # whole script exists to refuse.
        return [f'{service}: HostConfig.LogConfig absent from docker inspect — '
                f'refusing to call that agreement']

    want_driver = str(declared.get('driver', ''))
    running_driver = str(log.get('Type', ''))
    if want_driver and running_driver != want_driver:
        problems.append(
            f'{service}: log driver differs — declared {want_driver}, '
            f'running {running_driver or "(none)"}'
        )

    want_opts = {str(k): str(v) for k, v in (declared.get('options') or {}).items()}
    running_opts = {str(k): str(v) for k, v in (log.get('Config') or {}).items()}
    for key, want in sorted(want_opts.items()):
        running = running_opts.get(key)
        if running != want:
            problems.append(
                f'{service}: log option {key} differs — declared {want}, '
                f'running {running if running is not None else "(unset)"}'
            )
    return problems

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

    # Explicit pairs plus the derived logging population. Derived SECOND so a
    # hand-listed pair always wins if the two ever name the same (service,
    # field), rather than the answer depending on dict ordering.
    pairs = [*PAIRS, *logging_pairs(services)]

    for service, container, field in pairs:
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
        elif field == LOGGING_FIELD:
            compared += 1
            problems.extend(compare_logging(service, declared, entry))
        else:
            problems.append(f'{service}: PAIRS names an unsupported field {field!r}')

    # The DENOMINATOR, printed whether this passes or fails. "3 of 7 services
    # compared" is the reading that shows the check narrowing while still
    # green, and this issue was only found by counting by hand.
    total_services = len(services)
    covered = len({p[0] for p in pairs})
    print(
        f'[running-state] {compared} create-time setting(s) compared across '
        f'{covered} of {total_services} service(s)'
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
