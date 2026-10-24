/**
 * `deploy/compare-running-state.py` — #2189.
 *
 * Spawned, following `tests/unit/ci/lighthouse-median.test.ts`: the CLI surface
 * is what `check-drift.sh` consumes, so the EXIT CODE is the property that
 * matters most here. This script exists to fail, and a version that printed
 * the right words and exited 0 would be worse than none — `check-drift.sh`
 * reads only the status.
 *
 * ## What it is for
 *
 * `check-drift.sh` sha256-compares the compose file against the VM's copy. On
 * 2026-10-23 both were byte-identical while `watchtower` had been running since
 * 2026-07-04 without the `--stop-timeout 30s` its own declaration names. A
 * sha256 of a manifest cannot answer "is the VM RUNNING what that text
 * declares", and the two come apart the moment a setting is read at CREATE
 * time.
 *
 * ## The secret-handling case is a test, not a comment
 *
 * `redis`'s declared command carries `--requirepass "${REDIS_PASSWORD:?...}"`.
 * The compose file holds the interpolation; a running container's `Cmd` holds
 * the VALUE, and this script prints values on mismatch. So one case below
 * forces a secret-shaped pair through and asserts it REFUSES and that the
 * running value never reaches the output.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'deploy/compare-running-state.py');

const LOGGING = `    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`;

/**
 * Every service declares `logging`, as the real manifest does through its
 * `x-logging` anchor — which `yaml.safe_load` resolves, so the comparator sees
 * the expanded dict rather than an alias.
 *
 * `clamav` is here with NO `container_name` on purpose: it is the one service
 * on the real VM without one, so it is the case that exercises the
 * `<project>-<service>-1` fallback. Getting that wrong is how the first
 * attempt at this check inspected nothing and reported success.
 */
const COMPOSE = `services:
  app:
    image: x
    container_name: agrent-app
    stop_grace_period: 30s
${LOGGING}  worker:
    image: x
    container_name: agrent-worker
    stop_grace_period: 30s
${LOGGING}  redis:
    image: r
    container_name: agrent-redis
    command: redis-server --requirepass "\${REDIS_PASSWORD:?required}"
${LOGGING}  watchtower:
    image: w
    container_name: agrent-watchtower
    command: --label-enable --cleanup --interval 300 --stop-timeout 30s
${LOGGING}  clamav:
    image: c
${LOGGING}`;

const WATCHTOWER_CMD = [
    '--label-enable', '--cleanup', '--interval', '300', '--stop-timeout', '30s',
];

type Entry = Record<string, unknown>;

/** The declared log settings, as Docker stores them — every value a STRING. */
const LOG_OK = { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } };

const container = (
    name: string,
    cfg: Record<string, unknown>,
    log: unknown = LOG_OK,
): Entry => ({
    Name: `/${name}`,
    Config: cfg,
    HostConfig: { LogConfig: log },
});

const AGREEING: Entry[] = [
    container('agrent-watchtower', { Cmd: WATCHTOWER_CMD }),
    container('agrent-app', { StopTimeout: 30 }),
    container('agrent-worker', { StopTimeout: 30 }),
    container('agrent-redis', { Cmd: ['redis-server'] }),
    // No `container_name` in the compose, so the comparator must derive this.
    container('agrent-clamav-1', {}),
];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function run(inspect: unknown, compose = COMPOSE, script = SCRIPT) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'compose.yml'), compose);
    fs.writeFileSync(
        path.join(dir, 'inspect.json'),
        typeof inspect === 'string' ? inspect : JSON.stringify(inspect),
    );
    const r = spawnSync('python3', [script, `${dir}/compose.yml`, `${dir}/inspect.json`], {
        encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('compare-running-state (#2189)', () => {
    it('agreement exits 0 and prints the denominator', () => {
        const { code, out } = run(AGREEING);
        expect(code).toBe(0);
        expect(out).toContain('in sync');
        // The count, because "N of M compared" is what shows this check
        // narrowing while still green — the issue was only found by counting
        // services by hand.
        // Five services now, all five covered: three explicit pairs plus a
        // `logging` comparison DERIVED for every service that declares it. The
        // figure is asserted rather than the words, because "N of M" narrowing
        // while staying green is exactly what this print is for.
        expect(out).toMatch(/8 create-time setting\(s\) compared across 5 of 5 service\(s\)/);
    });

    it('catches the REAL drift: watchtower missing its flag', () => {
        const { code, out } = run([
            container('agrent-watchtower', { Cmd: WATCHTOWER_CMD.slice(0, 4) }),
            container('agrent-app', { StopTimeout: 30 }),
            container('agrent-worker', { StopTimeout: 30 }),
        ]);
        expect(code).toBe(1);
        expect(out).toContain('watchtower: command differs');
        expect(out).toContain('--stop-timeout 30s');
        // And it says how to apply it, including the part that bit: watchtower
        // is not watchtower-enabled.
        expect(out).toContain('watchtower never recreates itself');
    });

    it('catches a stop timeout that never adopted its declaration', () => {
        const { code, out } = run([
            container('agrent-watchtower', { Cmd: WATCHTOWER_CMD }),
            container('agrent-app', { StopTimeout: 10 }),
            container('agrent-worker', { StopTimeout: 30 }),
        ]);
        expect(code).toBe(1);
        expect(out).toContain('app: stop timeout differs — declared 30s, running 10s');
    });

    it('reads Config.StopTimeout, not HostConfig', () => {
        // The path I got wrong, and it cost a round of live debugging:
        // HostConfig has 63 keys and no StopTimeout, and Docker's Go template
        // aborts the whole command on one missing key. A version reading
        // HostConfig sees nothing here and must not call that agreement.
        const { code, out } = run([
            container('agrent-watchtower', { Cmd: WATCHTOWER_CMD }),
            { Name: '/agrent-app', Config: {}, HostConfig: { StopTimeout: 30 } },
            container('agrent-worker', { StopTimeout: 30 }),
        ]);
        expect(code).toBe(1);
        expect(out).toContain('app: Config.StopTimeout absent');
        expect(out).toContain('refusing to call that agreement');
    });

    it('an EMPTY inspect FAILS rather than reporting agreement', () => {
        const { code, out } = run('');
        expect(code).toBe(1);
        expect(out).toContain('returned NOTHING');
        expect(out).not.toContain('in sync');
    });

    it('a wrong container name fails AND names what it did inspect', () => {
        // The original mistake — `agrent-watchtower-1` — and the diagnostic
        // that makes it fixable. These problems used to be suppressed by an
        // earlier `compared == 0` return, which printed the least exactly when
        // the most was needed.
        const { code, out } = run([container('agrent-watchtower-1', { Cmd: ['--x'] })]);
        expect(code).toBe(1);
        expect(out).toContain("no running container named 'agrent-watchtower'");
        expect(out).toContain("inspected ['agrent-watchtower-1']");
    });

    it('REFUSES a secret-shaped declaration, and leaks nothing', () => {
        // The allowlist is not trusted on its own: a future pair added without
        // reading the docblock must fail loudly rather than print a live
        // credential. Forced here by swapping watchtower for redis, whose
        // declaration interpolates `${REDIS_PASSWORD}`.
        const mutated = fs
            .readFileSync(SCRIPT, 'utf8')
            .replace(
                "('watchtower', 'agrent-watchtower', 'command'),",
                "('redis', 'agrent-redis', 'command'),",
            );
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-secret-'));
        dirs.push(dir);
        const script = path.join(dir, 'mutated.py');
        fs.writeFileSync(script, mutated);

        const { code, out } = run(
            [container('agrent-redis', { Cmd: ['redis-server', '--requirepass', 'S3CR3T-VALUE'] })],
            COMPOSE,
            script,
        );
        expect(code).not.toBe(0);
        expect(out).toContain('refusing to compare redis.command');
        expect(out).toContain('resolved secret');
        // The property, not just the message.
        expect(out).not.toContain('S3CR3T-VALUE');
    });

    it('a service named in PAIRS but absent from the compose is a failure', () => {
        const { code, out } = run(AGREEING, 'services:\n  app:\n    image: x\n');
        expect(code).toBe(1);
        expect(out).toContain('absent from the compose file');
    });

    describe('logging — the other create-time setting (#2189)', () => {
        it('catches a log option the container never adopted', () => {
            // The real hazard: `x-logging` is read at CREATE time, exactly like
            // `stop_grace_period`, so a manifest edit to the rotation caps that
            // nobody recreated for leaves the container writing under the OLD
            // ones while check-drift reports the file byte-identical.
            const { code, out } = run(
                AGREEING.map((e) =>
                    (e.Name === '/agrent-worker'
                        ? container('agrent-worker', { StopTimeout: 30 }, {
                            Type: 'json-file',
                            Config: { 'max-size': '100m', 'max-file': '3' },
                        })
                        : e),
                ),
            );
            expect(code).toBe(1);
            expect(out).toContain(
                'worker: log option max-size differs — declared 10m, running 100m',
            );
        });

        it('catches a changed DRIVER, which loses the logs entirely', () => {
            const { code, out } = run(
                AGREEING.map((e) =>
                    (e.Name === '/agrent-app'
                        ? container('agrent-app', { StopTimeout: 30 }, {
                            Type: 'local',
                            Config: { 'max-size': '10m', 'max-file': '3' },
                        })
                        : e),
                ),
            );
            expect(code).toBe(1);
            expect(out).toContain('app: log driver differs — declared json-file, running local');
        });

        it('an UNSET option is named as unset, not reported as matching', () => {
            // `running_opts.get(key)` is None here. Reading a missing option as
            // agreement is the same failure as reading an empty inspect as
            // agreement, one level down.
            const { code, out } = run(
                AGREEING.map((e) =>
                    (e.Name === '/agrent-app'
                        ? container('agrent-app', { StopTimeout: 30 }, {
                            Type: 'json-file',
                            Config: { 'max-size': '10m' },
                        })
                        : e),
                ),
            );
            expect(code).toBe(1);
            expect(out).toContain('app: log option max-file differs — declared 3, running (unset)');
        });

        it('an ABSENT LogConfig refuses rather than agreeing', () => {
            const { code, out } = run(
                AGREEING.map((e) =>
                    (e.Name === '/agrent-app'
                        ? container('agrent-app', { StopTimeout: 30 }, null)
                        : e),
                ),
            );
            expect(code).toBe(1);
            expect(out).toContain('app: HostConfig.LogConfig absent');
            expect(out).toContain('refusing to call that agreement');
        });

        it('compares options as STRINGS, so unquoting a YAML value is not drift', () => {
            // `max-file: "3"` reads as a string and a bare `3` as an int, while
            // Docker stores every option value as a string. Comparing raw would
            // report drift on an edit that only removed a pair of quotes —
            // a false alarm in a check that runs weekly and must stay readable.
            const unquoted = COMPOSE.replace(/max-file: "3"/g, 'max-file: 3');
            const { code, out } = run(AGREEING, unquoted);
            expect(out).not.toContain('max-file differs');
            expect(code).toBe(0);
        });

        it('derives the container name for a service with no container_name', () => {
            // `clamav` has none, so the name must come from
            // `<project>-<service>-1`. A wrong derivation reports a missing
            // container — the original #2189 mistake — rather than passing.
            const { code, out } = run(
                AGREEING.filter((e) => e.Name !== '/agrent-clamav-1'),
            );
            expect(code).toBe(1);
            expect(out).toContain("no running container named 'agrent-clamav-1'");
        });
    });
});
