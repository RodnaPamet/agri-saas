/**
 * The production backup mechanism is in the repo, and drift-checked — #2329.
 *
 * ## Why this exists
 *
 * Within hours of standing the nightly backup up, the script, its unit and its
 * timer existed **only** at `/usr/local/sbin` and `/etc/systemd/system` on one
 * machine. `git ls-files | grep -c agrent-db-backup` returned **0**.
 *
 * That is the #2319 shape precisely: production depending on files the repo
 * cannot reproduce, discoverable only by logging in. It is worse here than
 * there, because of what the dependency is — the backups themselves live
 * offsite and survive the VM, while the thing that writes them did not.
 *
 * ## The load-bearing assertions are about the SCRIPT'S CONTENT
 *
 * A tracked file that drifted into uselessness is still tracked. The two
 * invariants below are the ones whose absence made the first version of this
 * backup **unrestorable**, and neither is visible from the outside:
 *
 *   - it dumps ROLES. `pg_dump` omits them (they are cluster-level) while
 *     emitting every GRANT that needs them: 142 `GRANT … TO app_user` and zero
 *     `CREATE ROLE`. Restored into a clean cluster, all 142 fail with
 *     `42704 role "app_user" does not exist`.
 *   - the role check is DERIVED from the dump's own GRANTs, not a hard-coded
 *     name, so a role added to the schema later cannot be silently missed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectTrackedFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIR = 'deploy/backup';

/** What the mechanism consists of, and where each piece is installed. */
const PIECES: ReadonlyArray<{ rel: string; remote: string }> = [
    { rel: 'backup/agrent-db-backup', remote: '/usr/local/sbin/agrent-db-backup' },
    { rel: 'backup/agrent-db-backup.service', remote: '/etc/systemd/system/agrent-db-backup.service' },
    { rel: 'backup/agrent-db-backup.timer', remote: '/etc/systemd/system/agrent-db-backup.timer' },
];

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const DRIFT = read('deploy/check-drift.sh');
const SCRIPT = read('deploy/backup/agrent-db-backup');

/**
 * Comment lines removed. Both scripts DOCUMENT the mechanisms asserted below,
 * at length, so a match against the raw text is satisfied by the prose alone:
 * a mutation that replaced the real `pg_dumpall --roles-only` call left the
 * header's mention of it and this guard stayed green. The assertion has to
 * read the CODE.
 */
const code = (src: string) =>
    src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');

const DRIFT_CODE = code(DRIFT);
const SCRIPT_CODE = code(SCRIPT);

/**
 * `collectTrackedFiles` rather than a direct `git ls-files`, per
 * `file-collection-is-not-silently-empty`: a hand-rolled collector can be
 * gutted to `return []` with every assertion built on it still green.
 *
 * `floor` is the real expectation rather than the default 1 — the module's own
 * comment asks for it ("raise it when a guard knows its population is
 * larger"), and here the population is known exactly: the three installed
 * pieces plus the README.
 *
 * The helper returns ABSOLUTE paths, so they are mapped back to
 * repo-relative. Forgetting that in the sibling WIF guard doubled the path and
 * made the suite fail to LOAD, which reports `Tests: 0 total` — not a failing
 * assertion, and indistinguishable from an empty population.
 */
function tracked(): string[] {
    return collectTrackedFiles({ roots: [DIR], floor: PIECES.length }).map((abs) =>
        path.relative(REPO_ROOT, abs),
    );
}

describe('the production backup mechanism is tracked and drift-checked (#2329)', () => {
    it('[backup-tracked] ranges over a real set', () => {
        const files = tracked();
        console.log(`[backup-tracked] ${files.length} tracked file(s) under ${DIR}: ${files.join(', ')}`);
        // git ls-files returning nothing is the exact state this guard was
        // written against, and it would make every assertion below vacuous.
        expect(files.length).toBeGreaterThanOrEqual(PIECES.length);
    });

    it.each(PIECES.map((p) => [p.rel, p] as const))('deploy/%s is tracked', (rel) => {
        expect({ rel, tracked: tracked().includes(`deploy/${rel}`) })
            .toEqual({ rel, tracked: true });
    });

    it.each(PIECES.map((p) => [p.rel, p] as const))(
        'check-drift.sh compares deploy/%s against the installed path',
        (rel, piece) => {
            // Both halves. The repo path alone could be hashed against the
            // wrong destination, and an installed path alone could be hashed
            // against the wrong source.
            expect({
                rel,
                repoPathInTable: DRIFT.includes(piece.rel),
                remotePathInTable: DRIFT.includes(piece.remote),
            }).toEqual({ rel, repoPathInTable: true, remotePathInTable: true });
        },
    );

    it('the drift loop cannot swallow its own table', () => {
        // ssh reads STDIN, and stdin inside this loop IS the pair table. The
        // first version compared ONE file of three and reported no drift:
        // `agrent-db-backup` in sync, the unit and timer never mentioned.
        //
        // Asserted on the ssh INVOCATION, not on the window. `/dev/null`
        // appears in the same command as `2>/dev/null`, so a window-wide
        // search for it passes with the stdin redirect removed — which is
        // exactly how a mutation of this line survived.
        const loop = DRIFT_CODE.slice(
            DRIFT_CODE.indexOf('BACKUP_PAIRS='),
            DRIFT_CODE.indexOf('BACKUP_EXPECTED='),
        );
        expect(loop).toContain('gcloud compute ssh');
        // The invocation spans a line continuation, so join it before reading.
        const joined = loop.replace(/\\\n\s*/g, ' ');
        const sshCall = joined
            .split('\n')
            .find((l) => l.includes('gcloud compute ssh'));
        expect({ found: sshCall !== undefined }).toEqual({ found: true });
        expect({ sshRedirectsStdin: /<\s*\/dev\/null/.test(sshCall as string) })
            .toEqual({ sshRedirectsStdin: true });
    });

    it('the drift check asserts the FULL count, not merely more than zero', () => {
        // `-eq 0` was the first form and is too weak by exactly the bug it
        // failed to catch: comparing a subset passes "greater than zero".
        expect(DRIFT_CODE).toMatch(/BACKUP_CHECKED" -ne "\$BACKUP_EXPECTED/);
        expect(DRIFT_CODE).not.toMatch(/BACKUP_CHECKED" -eq 0/);
    });

    it('the backup dumps ROLES, not only the database', () => {
        // Without this the dump carries 142 GRANTs to a role nothing creates,
        // and a restore into a clean cluster fails every one of them.
        // Asserted on the INVOCATION, not on any line mentioning it. The
        // script carries `step="pg_dumpall --roles-only"` as a progress label,
        // which is code rather than a comment — so stripping comments was not
        // enough, and a mutation that replaced the real call with `pg_dump -s`
        // left the label behind and this assertion stayed green.
        const invokesRolesDump = SCRIPT_CODE.split('\n')
            .map((l) => l.trim())
            // A `VAR=` or `VAR="…"` line is a label or a value, never a call.
            .filter((l) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
            .some((l) => /pg_dumpall\b.*--roles-only/.test(l));
        expect({ invokesRolesDump }).toEqual({ invokesRolesDump: true });
        expect(SCRIPT_CODE).toMatch(/globals_object=/);
    });

    it('the role check is DERIVED from the dump, not a hard-coded name', () => {
        // A hard-coded `app_user` would pass forever and miss the next role.
        // The script extracts the roles its own GRANTs name and requires the
        // globals to create each.
        expect(SCRIPT_CODE).toMatch(/granted_roles=/);
        expect(SCRIPT_CODE).toMatch(/GRANT .* TO/);
        expect(SCRIPT_CODE).toMatch(/CREATE\|ALTER\) ROLE|CREATE\|ALTER/);
        // The specific role must NOT be the thing being tested for.
        const assertionWindow = SCRIPT_CODE.slice(
            SCRIPT_CODE.indexOf('granted_roles='),
            SCRIPT_CODE.indexOf('step="upload'),
        );
        expect({ hardCodedRole: /app_user/.test(assertionWindow) }).toEqual({ hardCodedRole: false });
    });

    it('does not carry the service-account key into a PUBLIC repo', () => {
        // The one piece deliberately absent. Tracking it would publish a
        // long-lived credential.
        for (const f of tracked()) {
            const body = read(f);
            expect({ f, hasPrivateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body) })
                .toEqual({ f, hasPrivateKey: false });
            expect({ f, hasServiceAccountJson: /"private_key"\s*:/.test(body) })
                .toEqual({ f, hasServiceAccountJson: false });
        }
    });
});
