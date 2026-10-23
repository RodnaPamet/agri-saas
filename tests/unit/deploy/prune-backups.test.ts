/**
 * `deploy/prune-backups.sh` — EXECUTED against fixtures (#2082).
 *
 * The script deletes files on the production VM, and the thing it deletes is
 * historical copies of production credentials. #2082's own post-mortem is why
 * every case below exists: the earlier ad-hoc prune built its keep-list two
 * ways — three newest from `ls -1t` (NEWLINE-separated) and two by name
 * (SPACE-separated) — matched with a space-delimited `case`, and the newline
 * list silently matched nothing. It deleted 32 files instead of 29, **and the
 * three it deleted were the three it meant to keep**.
 *
 * So "the newest N survive" is not an incidental property here; it is the exact
 * assertion that failure would have broken, and it has its own test.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'deploy/prune-backups.sh');

let tmp: string;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-backups-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a file with an explicit mtime, so "newest" is deterministic. */
function write(name: string, body: string, minutesAgo: number) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, body);
    const t = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(p, t, t);
}

function run(...args: string[]) {
    const r = spawnSync('bash', [SCRIPT, '--dir', tmp, ...args], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const names = () => fs.readdirSync(tmp).sort();
const LIVE_ENV = 'DATABASE_URL=x\nAUTH_SECRET=y\nDATA_ENCRYPTION_KEY=z\n';

/** The four naming styles seen on the real box, newest first. */
function seedEnvFamily() {
    write('.env', LIVE_ENV, 0);
    write('.env.bak-vapid-20261020T210923Z', LIVE_ENV, 1);
    write('.env.bak.20261020-134604', LIVE_ENV, 2);
    write('.env.bak-ratelimit-20261003T104429Z', LIVE_ENV, 3);
    write('.env.bak.dbrename.1787600459', LIVE_ENV, 4);
    write('.env.bak.1782810806', LIVE_ENV, 5);
}

describe('prune-backups.sh', () => {
    it('is a DRY RUN by default and removes nothing', () => {
        seedEnvFamily();
        const before = names();
        const r = run();
        expect(r.status).toBe(0);
        expect(r.out).toContain('DRY RUN');
        expect(names()).toEqual(before);
    });

    it('keeps the THREE NEWEST — the exact thing the earlier prune got backwards', () => {
        seedEnvFamily();
        const r = run('--apply');
        expect(r.status).toBe(0);
        expect(names()).toEqual([
            '.env',
            '.env.bak-ratelimit-20261003T104429Z',
            '.env.bak-vapid-20261020T210923Z',
            '.env.bak.20261020-134604',
        ]);
    });

    it('never touches the LIVE file', () => {
        seedEnvFamily();
        run('--apply');
        expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toBe(LIVE_ENV);
    });

    it('PROTECTS a backup holding a key name the live file lacks, even the oldest', () => {
        // The case that mattered: `DATA_ENCRYPTION_KEY_PREVIOUS`, a previous
        // master KEK present nowhere else. It was retired — but that was not
        // knowable from the filename, and the next one may not be.
        seedEnvFamily();
        write('.env.bak.ancient', 'DATABASE_URL=x\nDATA_ENCRYPTION_KEY_PREVIOUS=old\n', 999);
        const r = run('--apply');
        expect(r.out).toContain('PROTECTED');
        expect(r.out).toContain('DATA_ENCRYPTION_KEY_PREVIOUS');
        expect(names()).toContain('.env.bak.ancient');
    });

    it('protects on NAMES only — a differing value is not a reason to keep', () => {
        // The comparison must never read values: reading them is a read of
        // every secret in the file, and PRESENT/ABSENT is all the decision
        // needs. A backup whose keys match but whose values differ is prunable.
        seedEnvFamily();
        write('.env.bak.oldvalues', 'DATABASE_URL=DIFFERENT\nAUTH_SECRET=DIFFERENT\nDATA_ENCRYPTION_KEY=DIFFERENT\n', 999);
        run('--apply');
        expect(names()).not.toContain('.env.bak.oldvalues');
    });

    it('excludes Caddyfile by default — its snapshots are the only history there is', () => {
        // `/opt/agrent/Caddyfile` is hand-edited and in no repo: apply.sh does
        // not copy it and check-drift.sh does not hash it. Pruning its backups
        // destroys the only record of those edits.
        write('Caddyfile', 'a\n', 0);
        for (let i = 1; i <= 5; i += 1) write(`Caddyfile.bak.${i}`, 'a\n', i);
        const before = names();
        const r = run('--apply');
        expect(r.out).toContain('delete 0');
        expect(names()).toEqual(before);
    });

    it('prunes Caddyfile only when asked for explicitly', () => {
        write('Caddyfile', 'a\n', 0);
        for (let i = 1; i <= 5; i += 1) write(`Caddyfile.bak.${i}`, 'a\n', i);
        const r = run('--family', 'Caddyfile', '--apply');
        expect(r.status).toBe(0);
        expect(names()).toEqual(['Caddyfile', 'Caddyfile.bak.1', 'Caddyfile.bak.2', 'Caddyfile.bak.3']);
    });

    it('is idempotent — a second run deletes nothing', () => {
        seedEnvFamily();
        run('--apply');
        const after = names();
        const r = run('--apply');
        expect(r.out).toContain('delete 0');
        expect(names()).toEqual(after);
    });

    it('prints the DELETE list before acting, in both modes', () => {
        // #2082's remedy: compute and show the delete list rather than a
        // keep-list, so a mistake is visible before the `rm` and not after.
        seedEnvFamily();
        expect(run().out).toContain('DELETE .env.bak.1782810806');
        expect(run('--apply').out).toContain('DELETE .env.bak.1782810806');
    });

    it('--keep 0 still honours protection', () => {
        seedEnvFamily();
        write('.env.bak.unique', 'DATABASE_URL=x\nSOMETHING_ELSE=1\n', 999);
        run('--keep', '0', '--apply');
        expect(names()).toEqual(['.env', '.env.bak.unique']);
    });

    it('refuses a non-numeric --keep and a missing directory', () => {
        seedEnvFamily();
        expect(run('--keep', 'three').status).toBe(2);
        const r = spawnSync('bash', [SCRIPT, '--dir', path.join(tmp, 'nope')], { encoding: 'utf8' });
        expect(r.status).toBe(2);
    });

    it('handles a family with no snapshots at all', () => {
        write('.env', LIVE_ENV, 0);
        const r = run('--apply');
        expect(r.status).toBe(0);
        expect(r.out).toContain('delete 0');
        expect(names()).toEqual(['.env']);
    });
});
