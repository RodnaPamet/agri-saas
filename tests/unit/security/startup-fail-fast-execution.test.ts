/**
 * GAP-03 checks 2 and 3, EXECUTED — issue #674 item 2.
 *
 * CLAUDE.md claims three independent checks each refuse to start a production
 * process whose `DATA_ENCRYPTION_KEY` is missing, too short, or equal to the
 * documented dev fallback. The 2026-08-19 enforcement-seam audit found that
 * only the first had ever run:
 *
 *   1. the zod schema in `src/env.ts` — EXECUTED, via a real child-process
 *      module load (`tests/unit/env.test.ts`).
 *   2. the startup hooks in `src/instrumentation.ts`, `scripts/worker.ts`,
 *      `scripts/scheduler.ts` — the two helper FUNCTIONS are executed by
 *      `startup-encryption-check.test.ts`, but the WIRING was grep-only
 *      (`tests/guardrails/encryption-key-enforcement.test.ts`).
 *   3. the Compose `:?error` layer — grep-only.
 *
 * "Three independent checks" is a claim about behaviour, and two thirds of it
 * rested on `readFileSync` + regex. This file closes both. It spawns real
 * processes with real bad keys and watches them refuse to boot, and it runs
 * `docker compose config` to make the interpolation guard actually fire.
 *
 * ── Why child processes ─────────────────────────────────────────────
 *
 * The thing under test IS `process.exit(1)`, which cannot be observed from
 * inside the process that calls it. `startup-encryption-check.ts` was
 * deliberately factored so the LOGIC is unit-testable without spawning — its
 * own docblock says so — and that factoring is good. But it left the half that
 * turns a failed check into a dead process untested, and that half is the
 * whole point of a fail-fast.
 *
 * ── What the sentinel can actually catch (measured) ─────────────────
 *
 * See the last describe block. `runEncryptionSentinel` documents itself as
 * catching "a key that's structurally valid (32+ chars, not the fallback) but
 * breaks under HKDF/AES-GCM (e.g. a binary blob written to env)". Measured
 * against the real derivation, no such key exists — so those tests record what
 * it CAN do rather than restating what it claims.
 */

import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

const REPO = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

/**
 * A structurally valid key that is not the dev fallback. Generated once and
 * inlined — it is a throwaway test value, not a secret.
 */
const GOOD_KEY = 'aG93IG11Y2ggd29vZCB3b3VsZCBhIHdvb2RjaHVjayBjaHVjaz0='; // pragma: allowlist secret

/**
 * A key below the 32-character floor, chosen to be DISTINCTIVE so the
 * "never echoes the key material" assertion below can actually look for it.
 * A value like `too-short` would appear nowhere and the assertion would pass
 * vacuously.
 */
const SHORT_KEY = 'zzq-marker-must-not-be-logged'; // 29 chars // pragma: allowlist secret

/** Env every surface needs before it reaches the encryption check. */
const BASE_ENV = {
    SKIP_ENV_VALIDATION: '1',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/x',
    DIRECT_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/x',
};

interface BootResult {
    status: number | null;
    output: string;
}

/**
 * Booting these surfaces is the expensive part of this file, so two things
 * keep it bounded. Measured cost per boot: web 0.8s, scheduler 2.0s,
 * worker 6.4s.
 *
 * 1. RESULTS ARE MEMOISED by (entry, env). The boots are deterministic and
 *    side-effect-free, and several assertions want different views of the same
 *    run — the exit code, the absence of the key, the message ORDER.
 *
 * 2. A HEALTHY WORKER NEVER EXITS. That is the whole point of a worker, and
 *    waiting for one costs the full timeout: the first draft of this file spent
 *    180 of its 257 seconds sitting on two `spawnSync` calls that were never
 *    going to return. `SURVIVE` mode caps the wait and requires an "alive"
 *    marker in the captured output, so the shorter wait is PROVEN sufficient
 *    rather than assumed — without the marker, a wait that was too short would
 *    look exactly like a clean pass.
 */
type BootMode = 'EXIT' | 'SURVIVE';

const bootCache = new Map<string, BootResult>();

/**
 * SURVIVE mode waits for a MARKER, not for a clock.
 *
 * The first version of this used `spawnSync` with a fixed 15s window and
 * asserted the marker afterwards. That is a race, and it lost one: run alone
 * the suite was 38/38, but under a full parallel sweep two BOOT cases failed
 * with `Received: {"msg":"starting worker"}` — the worker had got that far and
 * the window expired. A spawned `tsx` compiling, importing the app graph and
 * connecting to Redis does not reliably reach `worker process started` inside
 * 15 seconds while 1200+ suites compete for the box. (Found by the parallel
 * session running the full sweep; credited because I would have shipped it.)
 *
 * #698 makes that strictly worse — the encryption sentinel now BLOCKS startup
 * instead of racing it, so the worker does more work before the marker.
 *
 * Raising the constant would only move the race. Reading the stream until the
 * marker appears removes it: the wait ends on the event, the cap is a
 * backstop rather than the mechanism, and a healthy boot is killed the
 * instant it has proven itself.
 */
function bootAsync(
    entry: string,
    env: Record<string, string>,
    mode: BootMode,
    marker?: string,
): Promise<BootResult> {
    return new Promise((resolve) => {
        const child = spawn(TSX, [entry], {
            cwd: REPO,
            env: { ...process.env, ...BASE_ENV, ...env },
        });
        let output = '';
        let settled = false;
        const finish = (status: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            try {
                child.kill('SIGKILL');
            } catch {
                /* already gone */
            }
            resolve({ status, output });
        };
        const onData = (chunk: Buffer) => {
            output += chunk.toString();
            // SURVIVE: the process is expected to keep running, so the marker
            // is the only signal that it got where it was going.
            if (mode === 'SURVIVE' && marker && output.includes(marker)) finish(null);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => finish(code));
        child.on('error', () => finish(null));
        const cap = setTimeout(() => finish(null), 90_000);
    });
}

async function boot(
    entry: string,
    env: Record<string, string>,
    mode: BootMode = 'EXIT',
    marker?: string,
): Promise<BootResult> {
    const key = `${mode}|${entry}|${JSON.stringify(env)}`;
    const hit = bootCache.get(key);
    if (hit) return hit;
    const result = await bootAsync(entry, env, mode, marker);
    bootCache.set(key, result);
    return result;
}

/**
 * The three production surfaces that carry the check.
 *
 * `alive` is the line each prints once it is past the check and doing its job.
 * `terminates` says whether a HEALTHY boot ends by itself: the web harness and
 * the scheduler finish and exit 0, a worker by definition does not.
 */
const SURFACES = [
    {
        name: 'web (instrumentation hook)',
        entry: 'tests/fixtures/startup/boot-instrumentation.ts',
        alive: 'REGISTER_RETURNED_OK',
        terminates: true,
    },
    {
        name: 'worker (BullMQ)',
        entry: 'scripts/worker.ts',
        alive: 'worker process started',
        terminates: false,
    },
    {
        name: 'scheduler (deploy-time)',
        entry: 'scripts/scheduler.ts',
        alive: 'registering repeatable jobs',
        terminates: true,
    },
] as const;

jest.setTimeout(180_000);

describe('GAP-03 check 2 — the startup hook actually kills the process', () => {
    describe.each(SURFACES)('$name', ({ entry, alive, terminates }) => {
        it('refuses to boot in production when the key is below the length floor', async () => {
            const { status, output } = await boot(entry, {
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: SHORT_KEY,
            });
            expect(status).toBe(1);
            expect(output).toContain('[startup] FATAL:');
            expect(output).toContain('DATA_ENCRYPTION_KEY');
        });

        it('refuses to boot in production when the key IS the documented dev fallback', async () => {
            // The regression this exists for: a prod deploy where someone
            // copied the dev key out of the docs. It passes every structural
            // check — right length, present, parses — and is public.
            const { status, output } = await boot(entry, {
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: DEV_FALLBACK_DATA_ENCRYPTION_KEY,
            });
            expect(status).toBe(1);
            expect(output).toContain('[startup] FATAL:');
            expect(output).toContain('dev fallback');
        });

        it('never echoes the rejected key material', async () => {
            // An operator pastes a startup log into an issue. The refusal has
            // to name the PROBLEM, never the value.
            const { output } = await boot(entry, {
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: SHORT_KEY,
            });
            expect(output).toContain('[startup] FATAL:'); // it really did fail
            expect(output).not.toContain(SHORT_KEY);
        });

        it('boots past the check with a valid key — the guard is passed, not skipped', async () => {
            // Resolving power. Without this, every assertion above is
            // satisfied by a surface that exits 1 unconditionally.
            const { output } = await boot(
                entry,
                { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: GOOD_KEY },
                terminates ? 'EXIT' : 'SURVIVE',
                alive,
            );
            expect(output).not.toContain('[startup] FATAL:');
            // …and it got far enough to prove the absence means something.
            expect(output).toContain(alive);
        });

        it('leaves development alone — a short key is fine outside production', async () => {
            // The dev fallback exists so contributors never manage this var.
            // A check that fired here would be a contributor-experience
            // regression, and it is a documented part of the contract.
            //
            // Measured mutation resistance, stated so nobody assumes more:
            // this assertion survives removing EITHER guard alone — the hook's
            // `NODE_ENV === 'production'` gate, or the early return inside
            // `checkProductionEncryptionKey`. It fails only when both go. The
            // dev exemption is genuinely double-guarded, so no single-point
            // mutation kills this; it catches the removal of the exemption,
            // not the removal of one layer of it.
            const { output } = await boot(
                entry,
                { NODE_ENV: 'development', DATA_ENCRYPTION_KEY: SHORT_KEY },
                terminates ? 'EXIT' : 'SURVIVE',
                alive,
            );
            expect(output).not.toContain('[startup] FATAL:');
            expect(output).toContain(alive);
        });
    });

    it('the web hook completes register() with a valid key', async () => {
        // Surface-specific: proves the hook ran to the END rather than dying
        // quietly somewhere after the check. `not.toContain('FATAL')` alone
        // cannot tell those apart.
        const { status, output } = await boot(SURFACES[0].entry, {
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: GOOD_KEY,
        });
        expect(output).toContain('REGISTER_RETURNED_OK');
        expect(status).toBe(0);
    });

    it('covers every surface the guardrail names, derived from the same list', () => {
        // If a fourth production entrypoint gains the check, this file should
        // grow with it — so tie the surface list to something that moves.
        const guardrail = fs.readFileSync(
            path.join(REPO, 'tests', 'guardrails', 'encryption-key-enforcement.test.ts'),
            'utf-8',
        );
        for (const rel of ['src/instrumentation.ts', 'scripts/worker.ts', 'scripts/scheduler.ts']) {
            expect(guardrail).toContain(rel);
        }
        expect(SURFACES).toHaveLength(3);
    });
});

// ─── GAP-03 check 3 — the Compose interpolation guard ────────────────

const DOCKER_AVAILABLE = (() => {
    try {
        execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 20_000 });
        return true;
    } catch {
        return false;
    }
})();

/** Every compose manifest in the repo, derived from the filesystem. */
function composeFiles(): string[] {
    const out: string[] = [];
    for (const dir of ['.', 'deploy']) {
        const abs = path.join(REPO, dir);
        if (!fs.existsSync(abs)) continue;
        for (const name of fs.readdirSync(abs)) {
            if (/^docker-compose(\..+)?\.ya?ml$/.test(name)) out.push(path.join(dir, name));
        }
    }
    return out.sort();
}

const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8');

/**
 * Manifests that hand `DATA_ENCRYPTION_KEY` to a service at all.
 *
 * The rule is derived from CONTENT, not from a hand-kept list of "production"
 * files: if a manifest passes the key to a service, it must use the `:?`
 * fail-fast form. `docker-compose.yml` (local dev) and `docker-compose.test.yml`
 * never mention it — no service gets a key, so there is nothing to guard, and
 * requiring it there would break `docker-compose up` for contributors.
 *
 * That derivation matters: CLAUDE.md names three files, and there are FOUR.
 * `deploy/docker-compose.vm.yml` — the manifest the live agrent stack actually
 * runs — is absent from the documented list and has carried the guard all
 * along.
 */
function keyBearingComposeFiles(): string[] {
    return composeFiles().filter((rel) => read(rel).includes('DATA_ENCRYPTION_KEY'));
}

/** Of those, the ones using the `:?` fail-fast form rather than `:-` or bare. */
function keyGuardedComposeFiles(): string[] {
    return keyBearingComposeFiles().filter((rel) =>
        /\$\{DATA_ENCRYPTION_KEY:\?/.test(read(rel)),
    );
}

function composeConfig(rel: string, withKey: boolean): { status: number | null; err: string } {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        POSTGRES_PASSWORD: 'test-only',
        REDIS_PASSWORD: 'test-only',
    };
    if (withKey) env.DATA_ENCRYPTION_KEY = GOOD_KEY;
    else delete env.DATA_ENCRYPTION_KEY;

    const res = spawnSync('docker', ['compose', '-f', rel, 'config'], {
        cwd: REPO,
        encoding: 'utf-8',
        timeout: 60_000,
        env,
    });
    return { status: res.status, err: res.stderr ?? '' };
}

const describeDocker = DOCKER_AVAILABLE ? describe : describe.skip;

describe('GAP-03 check 3 — execution status', () => {
    // Always runs. A skipped suite is indistinguishable from a passing one, so
    // the non-execution has to be visible rather than silent — the shape
    // `rls-coverage.test.ts` established.
    it('reports whether the Compose layer was actually exercised', () => {
        if (!DOCKER_AVAILABLE) {
            console.warn(
                '\n' +
                '  ┌─────────────────────────────────────────────────────────────┐\n' +
                '  │  GAP-03 check 3 DID NOT RUN — docker compose is unavailable │\n' +
                '  │  The Compose `:?` fail-fast layer was NOT executed here.    │\n' +
                '  │  Structural coverage only (encryption-key-enforcement).     │\n' +
                '  │  Set STARTUP_GUARD_REQUIRE_DOCKER=1 to make this a failure. │\n' +
                '  └─────────────────────────────────────────────────────────────┘\n',
            );
        }
        if (process.env.STARTUP_GUARD_REQUIRE_DOCKER === '1') {
            expect(DOCKER_AVAILABLE).toBe(true);
        }
        expect(typeof DOCKER_AVAILABLE).toBe('boolean');
    });

    it('every manifest that carries the key guards it with the `:?` form', () => {
        // Structural, and it runs with or without docker. Derived from
        // content: a new manifest that passes the key without `:?` — or an
        // existing one relaxed to `:-` — fails here.
        const bearing = keyBearingComposeFiles();
        expect(bearing.length).toBeGreaterThanOrEqual(3); // anti-vacuity
        expect(keyGuardedComposeFiles().sort()).toEqual(bearing.sort());
    });

    it('and the dev/test manifests deliberately carry no key at all', () => {
        // The other half of the derivation. If `docker-compose.yml` ever
        // starts passing a key, the rule above begins applying to it — this
        // states that today it does not, so the exclusion is a fact rather
        // than an oversight.
        const bearing = new Set(keyBearingComposeFiles());
        for (const rel of ['docker-compose.yml', 'docker-compose.test.yml']) {
            if (composeFiles().includes(rel)) expect(bearing.has(rel)).toBe(false);
        }
    });
});

describeDocker('GAP-03 check 3 — the Compose guard actually fires', () => {
    const files = keyBearingComposeFiles();

    it('found manifests to test', () => {
        expect(files.length).toBeGreaterThanOrEqual(3);
    });

    describe.each(files)('%s', (rel) => {
        it('refuses to render a config when DATA_ENCRYPTION_KEY is unset', () => {
            const { status, err } = composeConfig(rel, false);
            expect(status).not.toBe(0);
            expect(err).toContain('DATA_ENCRYPTION_KEY');
        });

        it('and the refusal is CAUSED by the missing key, not by something else', () => {
            // Differential control. These manifests reference an `env_file`
            // that does not exist in a checkout, so `config` exits non-zero
            // either way — asserting only the exit code would pass on a file
            // with no guard at all. What separates the two runs is whether
            // DATA_ENCRYPTION_KEY is named in the error.
            const { err } = composeConfig(rel, true);
            expect(err).not.toContain('DATA_ENCRYPTION_KEY');
        });
    });
});

// ─── What the sentinel can actually catch ────────────────────────────

describe('runEncryptionSentinel — what it can and cannot catch', () => {
    /**
     * Its docblock says it catches "a key that's structurally valid (32+
     * chars, not the fallback) but breaks under HKDF/AES-GCM (e.g. a binary
     * blob written to env)".
     *
     * Measured against the real derivation, no such key exists. `deriveKey` is
     * `HMAC-SHA256` over `Buffer.from(raw, 'utf8')`, and `Buffer.from` never
     * throws on a JS string — a lone surrogate becomes U+FFFD. So every input
     * that clears the length floor round-trips.
     *
     * These tests record that rather than restating the claim, because a
     * docblock promising a guarantee the code cannot provide is how a check
     * gets trusted for the wrong reason.
     */
    const EXOTIC: Array<[string, string]> = [
        ['high bytes via latin1', Buffer.from(Array.from({ length: 48 }, (_, i) => i + 128)).toString('latin1')],
        ['lone surrogates', '\uD800'.repeat(40)],
        ['astral plane', '\u{1F511}'.repeat(20)],
        ['whitespace only', ' '.repeat(48)],
        ['exactly 32 chars', 'a'.repeat(32)],
    ];

    it.each(EXOTIC)('round-trips a %s key — the sentinel cannot fail on it', async (_label, key) => {
        const { runEncryptionSentinel } = await import('@/lib/security/startup-encryption-check');
        const { _resetKeyCache } = await import('@/lib/security/encryption');
        const prev = process.env.DATA_ENCRYPTION_KEY;
        try {
            process.env.DATA_ENCRYPTION_KEY = key;
            _resetKeyCache();
            await expect(runEncryptionSentinel()).resolves.toEqual({ ok: true });
        } finally {
            process.env.DATA_ENCRYPTION_KEY = prev;
            _resetKeyCache();
        }
    });

    it('DOES fail when the key is below the floor — its one reachable failure', async () => {
        // Reachable, but redundant: `checkProductionEncryptionKey` rejects the
        // same input one line earlier at every call site. The sentinel's real
        // value is forward-looking — it is the only thing that would catch a
        // future derivation (a real HKDF, a base64 decode, a KMS call) that
        // CAN throw.
        const { runEncryptionSentinel } = await import('@/lib/security/startup-encryption-check');
        const { _resetKeyCache } = await import('@/lib/security/encryption');
        const prevKey = process.env.DATA_ENCRYPTION_KEY;
        const prevEnv = process.env.NODE_ENV;
        try {
            process.env.DATA_ENCRYPTION_KEY = 'short';
            (process.env as Record<string, string>).NODE_ENV = 'production';
            _resetKeyCache();
            const r = await runEncryptionSentinel();
            expect(r.ok).toBe(false);
            expect(r.ok === false && r.reason).toContain('encryption sentinel:');
        } finally {
            process.env.DATA_ENCRYPTION_KEY = prevKey;
            (process.env as Record<string, string>).NODE_ENV = prevEnv as string;
            _resetKeyCache();
        }
    });
});

// ─── Ordering: is the fail-fast actually FAST? ───────────────────────

describe('the refusal arrives before the process is doing work', () => {
    /**
     * Writing the exit-code tests above surfaced a defect they could not see:
     * both standalone entrypoints ran the check inside a NON-AWAITED async
     * IIFE, so module evaluation raced past it. They did exit 1 — but only
     * after they were already live. Issue #698, measured then as:
     *
     *     worker:     starting worker
     *                 worker process started — press Ctrl+C to stop
     *                 [startup] FATAL: DATA_ENCRYPTION_KEY is required …
     *
     *     scheduler:  registering repeatable jobs
     *                 [startup] FATAL: DATA_ENCRYPTION_KEY is required …
     *
     * #702 pinned that wrong order in two CHARACTERISATION tests so the defect
     * was visible in CI rather than only in a filed issue, and said they were
     * expected to fail when the fix landed. They did — exactly those two, with
     * the other 36 green. These are the flipped versions.
     *
     * What the assertions below are really about: `new Worker(...)` is what
     * SUBSCRIBES to the queue, and `registering repeatable jobs` is the
     * scheduler's first write. A refusal printed after either of those is a
     * process that was already doing work.
     */
    async function orderOf(entry: string): Promise<string[]> {
        const { output } = await boot(entry, {
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: SHORT_KEY,
        });
        return output
            .split('\n')
            .map((line) => {
                try {
                    return String((JSON.parse(line) as { msg?: string }).msg ?? '');
                } catch {
                    return line;
                }
            })
            .filter(Boolean);
    }

    const indexOfFatal = (lines: string[]) =>
        lines.findIndex((l) => l.includes('[startup] FATAL:'));

    it('web: the hook refuses before register() does anything else', async () => {
        // The correct shape. `register()` is async and awaits the check
        // inline, so nothing downstream of it ever runs.
        const lines = await orderOf(SURFACES[0].entry);
        expect(indexOfFatal(lines)).toBeGreaterThanOrEqual(0);
        expect(lines.some((l) => l.includes('REGISTER_RETURNED_OK'))).toBe(false);
    });

    it('worker: refuses BEFORE it ever subscribes to the queue', async () => {
        const lines = await orderOf(SURFACES[1].entry);
        const fatal = indexOfFatal(lines);
        // FIRST line, not merely "before the marker". Measured: with the
        // `await` reverted to `void`, the worker logs `starting worker` and
        // THEN the refusal — fatal at index 1 — while every absence assertion
        // below still passes, because the un-awaited gate resolves before the
        // heavy bootstrap import does. Only the index separates them.
        expect(fatal).toBe(0);
        // `worker process started` is logged at the END of main(), after both
        // Workers exist. It must never appear on a refused boot.
        expect(lines.some((l) => l.includes('worker process started'))).toBe(false);
        // Nor may the runtime bootstrap have run — an automation dispatcher and
        // an SMTP mailer installed by a process that is about to exit 1 is work
        // done on a broken key.
        expect(lines.some((l) => l.includes('automation bus dispatcher'))).toBe(false);
    });

    it('scheduler: refuses BEFORE it registers anything', async () => {
        const lines = await orderOf(SURFACES[2].entry);
        const fatal = indexOfFatal(lines);
        expect(fatal).toBe(0);
        expect(lines.some((l) => l.includes('registering repeatable jobs'))).toBe(false);
    });

    it('the FATAL line is the first thing either script says at all', async () => {
        // Pins the refusal at the front, so a log line added above the gate
        // fails here rather than silently re-opening the window.
        for (const surface of [SURFACES[1], SURFACES[2]]) {
            const lines = await orderOf(surface.entry);
            expect(indexOfFatal(lines)).toBe(0);
        }
    });
});
