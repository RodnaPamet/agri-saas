import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The VM's `/opt/agrent/Caddyfile` is hand-assembled and serves a SECOND,
 * unrelated product. `deploy/Caddyfile` describes only ours, so it is a PARTIAL
 * copy of the live file by design — and that makes it a trap, because every
 * other deploy artifact in this repo IS canonical. `apply.sh` pushes the compose
 * up and `check-drift.sh` fails when the VM differs; applying the same reflex to
 * the Caddyfile deletes the other product's site blocks and takes its domains
 * offline. Measured 2026-09-27: 4 site blocks live, 1 described here.
 *
 * Prose cannot stop that, so `deploy/check-drift.sh` now compares the live SITE
 * ADDRESS SET against `deploy/Caddyfile` plus the recorded difference in
 * `deploy/caddy-foreign-sites.txt`. This file guards the comparison's teeth.
 *
 * WHY THE EXTRACTOR IS TESTED AND NOT JUST WRITTEN: the check is a set
 * difference, and a set difference against an empty set reports "nothing
 * missing". An extractor that silently stopped matching would turn every one of
 * those three failure conditions green — the exact shape of a guard that passes
 * because it selected nothing. `caddy-sites.sh` therefore exits 3 rather than
 * printing an empty set, and that refusal is asserted below.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SITES_SH = path.join(REPO_ROOT, 'deploy/caddy-sites.sh');
const CADDYFILE = path.join(REPO_ROOT, 'deploy/Caddyfile');
const FOREIGN_LIST = path.join(REPO_ROOT, 'deploy/caddy-foreign-sites.txt');
const CHECK_DRIFT = path.join(REPO_ROOT, 'deploy/check-drift.sh');

/** Run the extractor. Returns the address list, or the exit code on refusal. */
function sites(file: string): { code: number; addrs: string[] } {
    try {
        const out = execFileSync('bash', [SITES_SH, file], { encoding: 'utf-8' });
        return { code: 0, addrs: out.split('\n').filter((l) => l.trim() !== '') };
    } catch (e) {
        const err = e as { status?: number };
        return { code: err.status ?? -1, addrs: [] };
    }
}

/** A Caddyfile written to a temp path, cleaned up by the caller. */
function fixture(body: string): string {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caddyfix-')), 'Caddyfile');
    fs.writeFileSync(p, body);
    return p;
}

const recorded = (): string[] =>
    fs
        .readFileSync(FOREIGN_LIST, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));

describe('caddy-sites.sh — the extractor the drift check depends on', () => {
    it('finds the real site addresses in deploy/Caddyfile', () => {
        const { code, addrs } = sites(CADDYFILE);
        expect(code).toBe(0);
        // Positive control: a broken extractor would return [] and satisfy
        // every set comparison in check-drift.sh in silence.
        expect(addrs).toContain('app.agrent.bg');
        expect(addrs.length).toBeGreaterThan(0);
    });

    it('REFUSES an empty result instead of returning one', () => {
        // This is the assertion that keeps the whole check honest. A Caddyfile
        // with no site blocks must not read as "no foreign sites".
        const p = fixture('{\n    email admin@agrent.bg\n}\n');
        const { code, addrs } = sites(p);
        expect(code).toBe(3);
        expect(addrs).toEqual([]);
    });

    it('excludes the global options block and snippet definitions', () => {
        const p = fixture(
            ['{', '    email a@b.bg', '}', '(logging) {', '    log', '}', 'real.example.bg {', '    respond "ok"', '}', ''].join('\n'),
        );
        const { code, addrs } = sites(p);
        expect(code).toBe(0);
        expect(addrs).toEqual(['real.example.bg']);
    });

    it('splits a comma-separated header and ignores indented braces', () => {
        const p = fixture(
            ['one.example.bg, two.example.bg {', '    header {', '        X-A "1"', '    }', '}', ''].join('\n'),
        );
        const { code, addrs } = sites(p);
        expect(code).toBe(0);
        // `header {` is indented, so it is a directive and not a site.
        expect(addrs).toEqual(['one.example.bg', 'two.example.bg']);
    });

    it('would SEE a foreign block added to the live file', () => {
        // The mutation the real check exists to catch, run against the extractor
        // directly: a block appearing on the VM must show up as an address.
        const withForeign = fs.readFileSync(CADDYFILE, 'utf-8') + '\napp.someoneelse.bg {\n    respond "hi"\n}\n';
        const p = fixture(withForeign);
        const { code, addrs } = sites(p);
        expect(code).toBe(0);
        expect(addrs).toContain('app.someoneelse.bg');
        expect(sites(CADDYFILE).addrs).not.toContain('app.someoneelse.bg');
    });

    it('errors rather than succeeds on a missing file', () => {
        expect(sites(path.join(REPO_ROOT, 'deploy/does-not-exist')).code).toBe(2);
    });
});

describe('deploy/caddy-foreign-sites.txt — the recorded difference', () => {
    it('lists at least one address, and parses', () => {
        // Without this control, an emptied list would make `UNRECORDED` equal
        // every live foreign site — loud — but `STALE` trivially empty.
        expect(recorded().length).toBeGreaterThan(0);
    });

    it('records no address that deploy/Caddyfile also describes', () => {
        // An address cannot be both ours and foreign. If it were in both, the
        // VM_ONLY set would never contain it and its record would read stale.
        const ours = new Set(sites(CADDYFILE).addrs);
        expect(recorded().filter((a) => ours.has(a))).toEqual([]);
    });

    it('uses literal addresses, never wildcards', () => {
        // A pattern would quietly absorb the NEXT foreign domain, which is the
        // surprise the file exists to prevent. Its header promises this.
        expect(recorded().filter((a) => a.includes('*'))).toEqual([]);
    });

    it('explains the hazard and names the reflex that causes it', () => {
        const head = fs.readFileSync(FOREIGN_LIST, 'utf-8');
        expect(head).toMatch(/hand-assembled/i);
        expect(head).toMatch(/deploy\/apply\.sh/);
        expect(head).toMatch(/check-drift\.sh/);
        // The outcome, stated — not merely that they differ.
        expect(head).toMatch(/offline/i);
    });
});

describe('deploy/check-drift.sh — the check is wired, not just written', () => {
    const script = () => fs.readFileSync(CHECK_DRIFT, 'utf-8');

    it('is valid bash', () => {
        expect(() => execFileSync('bash', ['-n', CHECK_DRIFT])).not.toThrow();
    });

    it('reads the Caddyfile, the extractor and the recorded list', () => {
        const s = script();
        expect(s).toContain('caddy-sites.sh');
        expect(s).toContain('caddy-foreign-sites.txt');
        expect(s).toMatch(/REMOTE_CADDY=/);
        // Deleting the section removes these three together, which is why all
        // three are asserted rather than one standing in for the others.
    });

    it('fails on all THREE conditions, not only the new-site one', () => {
        const s = script();
        expect(s).toMatch(/UNRECORDED=/);
        expect(s).toMatch(/STALE=/);
        expect(s).toMatch(/REPO_ONLY=/);
        expect(s).toMatch(/CADDY_DRIFT=1/);
    });

    it('does NOT compare the Caddyfile by hash, and says why', () => {
        const s = script();
        // A sha256 comparison is the wrong instrument here: permanently red,
        // and the obvious repair for it is the outage.
        expect(s).not.toMatch(/sha256sum.*Caddyfile/);
        expect(s).toMatch(/hand-assembled|NOT repo-canonical/i);
    });

    it('warns against copying the repo Caddyfile up on the SUCCESS path', () => {
        // The moment a reader is most likely to reach for that scp is when the
        // check just said "in sync", so the warning belongs there.
        const s = script();
        expect(s).toMatch(/Never scp deploy\/Caddyfile over it/);
    });
});
