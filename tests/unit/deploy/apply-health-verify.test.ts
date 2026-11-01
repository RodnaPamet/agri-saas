/**
 * `deploy/apply.sh`'s health-verify step — EXECUTED, with the VM stubbed
 * (#2692).
 *
 * This step reported FAIL on an entirely healthy deploy and printed the
 * rollback command on the next line. Six attempts five seconds apart is ~30s,
 * while `docker-compose.vm.yml` gives the app `start_period: 60s` precisely
 * because `next start` takes tens of seconds to answer `readyz`. The compose
 * healthcheck knew; the script did not.
 *
 * ## Why this EXECUTES rather than greps
 *
 * The property is "a slow boot passes and a dead app does not", which is a
 * statement about a loop with a deadline — a source scan can see the loop
 * exists and not that its bound is reached, and the bug was precisely a bound
 * that was too small while the loop looked right.
 *
 * The whole script runs. `gcloud`, `curl`, `sleep` and `docker` are PATH stubs
 * in a temp dir, and `deploy/` is COPIED there so `SCRIPT_DIR` (and with it
 * `LOCAL_COMPOSE`) follows — which is also how the missing-`start_period` case
 * is reachable without touching the repo's compose file. Nothing here can
 * reach the real VM: every outbound command is a stub, and the test asserts
 * the `gcloud` stub was invoked so a run that silently did nothing cannot pass.
 *
 * `sleep` is stubbed to return immediately, so the 90s deadline costs no wall
 * clock. The elapsed figure the script reports is counted in the loop rather
 * than measured, so it stays truthful under that stub.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

let tmp: string;
let bin: string;
let deploy: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-health-'));
    bin = path.join(tmp, 'bin');
    deploy = path.join(tmp, 'deploy');
    fs.mkdirSync(bin, { recursive: true });
    fs.cpSync(path.join(ROOT, 'deploy'), deploy, { recursive: true });

    // Every outbound command, stubbed. `gcloud` records that it ran.
    stub('gcloud', `echo "gcloud $*" >> "${tmp}/gcloud.log"\nexit 0\n`);
    stub('docker', 'exit 0\n');
    stub('sleep', 'exit 0\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function stub(name: string, body: string) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
    fs.chmodSync(p, 0o755);
}

/**
 * A `curl` stub that answers a SEQUENCE, one entry per invocation.
 *
 * It mimics the real thing as measured on 2026-11-01: `%{http_code}` is
 * written with no trailing newline, and a request that never completes writes
 * nothing at all. `-f` is gone from the script, so the stub exits 0 whenever a
 * request completes — which is what makes the captured code clean.
 */
function curlSequence(codes: string[]) {
    fs.writeFileSync(path.join(tmp, 'codes'), `${codes.join('\n')}\n`);
    stub(
        'curl',
        [
            `n="$(cat "${tmp}/n" 2>/dev/null || echo 0)"`,
            `n=$((n + 1)); echo "$n" > "${tmp}/n"`,
            `code="$(sed -n "${'${n}'}p" "${tmp}/codes")"`,
            `[ -z "$code" ] && code="$(tail -1 "${tmp}/codes")"`,
            // An empty entry means "the request never completed": write
            // nothing, which the script's `probe` turns into 000.
            `if [ "$code" = "-" ]; then exit 7; fi`,
            `printf '%s' "$code"`,
            `exit 0`,
        ].join('\n'),
    );
}

function run(env: Record<string, string> = {}) {
    const r = spawnSync('bash', [path.join(deploy, 'apply.sh')], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HEALTH_ORIGIN: 'https://stub.invalid',
            ...env,
        },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const composePath = () => path.join(deploy, 'docker-compose.vm.yml');

describe("deploy/apply.sh health-verify (#2692)", () => {
    it('passes a deploy whose readyz is slow, and REPORTS how slow', () => {
        // The exact shape that failed: unready well past the old ~30s bound,
        // ready inside the container's own 60s grace. Eight 503s is 40s.
        curlSequence([...Array(8).fill('503'), '200', '200', '200']);
        const { status, out } = run();

        expect(out).toMatch(/OK\s+\/api\/readyz → 200 after 40s/);
        expect(out).not.toMatch(/health checks FAILED/);
        expect(status).toBe(0);
        // The run really did go through the deploy path — otherwise "no
        // failure reported" would also be true of a script that exited early.
        expect(fs.existsSync(path.join(tmp, 'gcloud.log'))).toBe(true);
    });

    it('still FAILS a readyz that never comes up, naming the deadline', () => {
        // The other direction, which is what makes the fix a fix rather than a
        // suppression: a genuinely broken deploy must still say so.
        curlSequence(['503']);
        const { status, out } = run();

        expect(out).toMatch(/FAIL \/api\/readyz → 503 after 90s/);
        expect(out).toMatch(/health checks FAILED/);
        expect(status).toBe(1);
    });

    it('derives the deadline from the compose start_period, not a literal', () => {
        // The defect was the script and the compose file disagreeing. Change
        // the compose grace and the script's deadline must follow, or the two
        // can drift apart again.
        const compose = fs.readFileSync(composePath(), 'utf8');
        fs.writeFileSync(composePath(), compose.replace('start_period: 60s', 'start_period: 10s'));
        curlSequence(['503']);
        const { out } = run();

        expect(out).toMatch(/readyz deadline 40s, from start_period 10s/);
        expect(out).toMatch(/FAIL \/api\/readyz → 503 after 40s/);
    });

    it('refuses to run when start_period cannot be read', () => {
        // An empty substitution would have made the deadline `0 + 30` — a
        // STRICTER check wearing the comment of a laxer one, which is the
        // failure this whole change is about, inverted.
        const compose = fs.readFileSync(composePath(), 'utf8');
        fs.writeFileSync(composePath(), compose.replace('      start_period: 60s\n', ''));
        curlSequence(['200']);
        const { status, out } = run();

        expect(out).toMatch(/could not read the app service's start_period/);
        expect(status).toBe(1);
    });

    it('checks the PWA lifelines ONCE, after readyz, and fails on a 404', () => {
        // #2692 asked for single-shot here and that is only safe in this
        // ORDER: all three paths come from the same Next process, so during
        // boot they fail together. Once readyz has answered, a 404 on the
        // service worker is REAL — the case that strands offline-installed
        // mobile clients.
        curlSequence(['200', '404', '200']);
        const { status, out } = run();

        expect(out).toMatch(/OK\s+\/api\/readyz → 200 after 0s/);
        expect(out).toMatch(/FAIL \/manifest\.webmanifest → 404/);
        expect(status).toBe(1);
        // Exactly three probes: one readyz, one per lifeline. A retry here
        // would mask the 404 behind a boot race.
        expect(fs.readFileSync(path.join(tmp, 'n'), 'utf8').trim()).toBe('3');
    });

    it('reports 000 rather than a concatenated code when a request cannot complete', () => {
        // Measured on the real binary: `curl -fsS -o /dev/null -w '%{http_code}'`
        // on a 404 writes `404` with no newline AND exits 22, so the old
        // `|| echo 000` captured `404000` and the rollback message said so.
        // `-f` is gone; an incomplete request is the only 000 now.
        curlSequence(['-']);
        const { out } = run();

        expect(out).toMatch(/FAIL \/api\/readyz → 000 after 90s/);
        expect(out).not.toMatch(/→ \d{3}000/);
    });
});
