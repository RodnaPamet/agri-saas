/**
 * `scripts/wait-for-migrations.sh` actually WAITS, and is actually BOUNDED.
 *
 * ── why this is executed rather than read ──
 *
 * The script is the only thing standing between a deploy carrying a migration
 * and a worker consuming jobs against the old schema. Its behaviour is a loop,
 * an exit code and a bound — none of which a grep for "while" establishes. So
 * each case RUNS it against a stub `prisma` whose exit codes the test controls.
 *
 * The stub is a real file on disk at the path the script hardcodes
 * (`./node_modules/.bin/prisma`) inside a throwaway directory, so the script is
 * exercised unmodified. A version that took the binary path as a parameter
 * would have been easier to test and would have been testing a different
 * script from the one that ships.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '../../scripts/wait-for-migrations.sh');

interface Run {
    status: number;
    stdout: string;
    /** How many times the stub was invoked — the proof it retried. */
    calls: number;
}

/**
 * Run the script in a temp cwd with a stub prisma.
 *
 * `failures` is how many invocations exit non-zero before one succeeds;
 * `Infinity` never succeeds.
 */
function runWithStub(opts: { failures: number; attempts?: number; omitStub?: boolean }): Run {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waitmig-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'prisma/schema'), { recursive: true });
        const counter = path.join(dir, 'calls');
        fs.writeFileSync(counter, '');
        if (!opts.omitStub) {
            const limit = opts.failures === Infinity ? '999999' : String(opts.failures);
            fs.writeFileSync(
                path.join(dir, 'node_modules/.bin/prisma'),
                `#!/bin/sh\n` +
                    `echo x >> "${counter}"\n` +
                    `n=$(wc -l < "${counter}" | tr -d ' ')\n` +
                    `if [ "$n" -le ${limit} ]; then echo "pending"; exit 1; fi\n` +
                    `echo "up to date"; exit 0\n`,
                { mode: 0o755 },
            );
        }
        let status = 0;
        let stdout = '';
        try {
            stdout = execFileSync('sh', [SCRIPT], {
                cwd: dir,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    MIGRATION_WAIT_ATTEMPTS: String(opts.attempts ?? 5),
                    // Keep the suite fast: the bound is what is under test, not
                    // the wall-clock interval.
                    MIGRATION_WAIT_INTERVAL: '0',
                },
            });
        } catch (err) {
            const e = err as { status?: number; stdout?: string; stderr?: string };
            status = e.status ?? 1;
            stdout = (e.stdout ?? '') + (e.stderr ?? '');
        }
        const calls = fs.existsSync(counter)
            ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
            : 0;
        return { status, stdout, calls };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('wait-for-migrations.sh', () => {
    it('exits 0 immediately when the schema is already current', () => {
        const r = runWithStub({ failures: 0 });
        expect(r.status).toBe(0);
        // Exactly one probe: no sleeping when there is nothing to wait for.
        expect(r.calls).toBe(1);
    });

    it('RETRIES and then succeeds — the whole point of the script', () => {
        const r = runWithStub({ failures: 2 });
        expect(r.status).toBe(0);
        // Three calls: two pending, then up-to-date. Asserting the COUNT, not
        // just the exit code — a script that ignored the first answer and
        // returned 0 regardless would pass an exit-code-only test.
        expect(r.calls).toBe(3);
        expect(r.stdout).toMatch(/up to date|Schema is up to date/i);
    });

    it('is BOUNDED — it exits non-zero rather than waiting forever', () => {
        // An unbounded loop makes a permanently failing migration look like a
        // worker that is merely quiet. `restart: always` turns a non-zero exit
        // into a visibly restarting container.
        const r = runWithStub({ failures: Infinity, attempts: 4 });
        expect(r.status).not.toBe(0);
        expect(r.calls).toBeGreaterThanOrEqual(4);
        expect(r.stdout).toMatch(/still not applied/i);
    });

    it('fails loudly when the prisma CLI is missing', () => {
        // The CLI is a production dependency on purpose. If it ever moves to
        // devDependencies the image loses it, and this is the message that says
        // so rather than a bare "not found".
        const r = runWithStub({ failures: 0, omitStub: true });
        expect(r.status).not.toBe(0);
        expect(r.stdout).toMatch(/prisma CLI not found/i);
    });

    it('emits no shell error text — no unquoted backticks in its output', () => {
        // Found in review of my own first draft: the timeout branch contained
        // `echo "... \`restart: always\` ..."`, and backticks inside double
        // quotes are COMMAND SUBSTITUTION. It printed `restart:: not found` to
        // stderr and dropped the words — in the one message someone reads while
        // diagnosing a stuck deploy. `sh -n` does not catch it.
        const r = runWithStub({ failures: Infinity, attempts: 1 });
        // The words survive intact...
        expect(r.stdout).toMatch(/restart: always/);
        // ...and the shell did not try to EXECUTE them. `restart:: not found`
        // on stderr is the signature of the substitution bug.
        expect(r.stdout).not.toMatch(/restart:+ not found/);
    });
});
