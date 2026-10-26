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

/** One stack's worth: script + unit + timer + the README. See `tracked()`. */
const MIN_TRACKED = 4;

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const DRIFT = read('deploy/check-drift.sh');

/**
 * The backup SCRIPTS, DERIVED from what is tracked — one per stack.
 *
 * This list used to be hand-written and named only `agrent-db-backup`, with the
 * population asserted as `files.length >= PIECES.length`. When
 * `inflect-db-backup` was tracked (#2367) that became 7 tracked files against 3
 * expected, which passes — so every content assertion below graded agrent's
 * script and inflect's was **completely ungraded**. That is the worse half to
 * miss: its globals matter 7× more (1,010 GRANTs against agrent's 142), so a
 * broken `pg_dumpall --roles-only` there costs the most and showed the least.
 *
 * Derived, so the next stack cannot be missed the same way — the failure mode
 * of a hand-listed population is that it stays green while shrinking in
 * coverage, which is indistinguishable from working.
 */
function backupScripts(): string[] {
    return tracked()
        .filter((f) => /^deploy\/backup\/[a-z0-9-]+-db-backup$/.test(f))
        .sort();
}

/** Every installed piece, derived from each script: itself, its unit, its timer. */
function pieces(): { rel: string; remote: string }[] {
    const out: { rel: string; remote: string }[] = [];
    for (const script of backupScripts()) {
        const base = path.basename(script);
        out.push({ rel: `backup/${base}`, remote: `/usr/local/sbin/${base}` });
        for (const ext of ['service', 'timer']) {
            out.push({
                rel: `backup/${base}.${ext}`,
                remote: `/etc/systemd/system/${base}.${ext}`,
            });
        }
    }
    return out;
}

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

/**
 * `collectTrackedFiles` rather than a direct `git ls-files`, per
 * `file-collection-is-not-silently-empty`: a hand-rolled collector can be
 * gutted to `return []` with every assertion built on it still green.
 *
 * `floor` is the real expectation rather than the default 1 — the module's own
 * comment asks for it ("raise it when a guard knows its population is
 * larger"). FOUR is the floor for ONE stack: a script, its unit, its timer and
 * the README. It is deliberately not derived from the piece list, because that
 * list is itself derived from this collector — a floor computed from the thing
 * it is meant to bound would be satisfied by any value, including zero.
 *
 * The helper returns ABSOLUTE paths, so they are mapped back to
 * repo-relative. Forgetting that in the sibling WIF guard doubled the path and
 * made the suite fail to LOAD, which reports `Tests: 0 total` — not a failing
 * assertion, and indistinguishable from an empty population.
 */
function tracked(): string[] {
    return collectTrackedFiles({ roots: [DIR], floor: MIN_TRACKED }).map((abs) =>
        path.relative(REPO_ROOT, abs),
    );
}

describe('the production backup mechanism is tracked and drift-checked (#2329)', () => {
    it('[backup-tracked] ranges over a real set', () => {
        const files = tracked();
        console.log(`[backup-tracked] ${files.length} tracked file(s) under ${DIR}: ${files.join(', ')}`);
        // git ls-files returning nothing is the exact state this guard was
        // written against, and it would make every assertion below vacuous.
        const scripts = backupScripts();
        const all = pieces();
        console.log(
            `[backup-tracked] ${scripts.length} stack(s): ${scripts.map((f) => path.basename(f)).join(', ')}`
                + ` = ${all.length} installed piece(s)`,
        );
        expect(files.length).toBeGreaterThanOrEqual(MIN_TRACKED);
        // Two stacks are live. A derivation that silently found ONE would make
        // every per-script assertion below range over half the mechanism and
        // still pass — which is exactly the state this guard was just in.
        expect(scripts.length).toBeGreaterThanOrEqual(2);
        // Every script must bring its unit and its timer.
        expect(all.length).toBe(scripts.length * 3);
    });

    it.each(pieces().map((p) => [p.rel, p] as const))('deploy/%s is tracked', (rel) => {
        expect({ rel, tracked: tracked().includes(`deploy/${rel}`) })
            .toEqual({ rel, tracked: true });
    });

    it.each(pieces().map((p) => [p.rel, p] as const))(
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

    it.each(backupScripts().map((f) => [path.basename(f), f] as const))(
        '%s dumps ROLES, not only the database',
        (_name, rel) => {
            const SCRIPT_CODE = code(read(rel));
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
        },
    );

    it.each(backupScripts().map((f) => [path.basename(f), f] as const))(
        "%s's role check is DERIVED from the dump, not a hard-coded name",
        (_name, rel) => {
            const SCRIPT_CODE = code(read(rel));
        // A hard-coded `app_user` would pass forever and miss the next role.
        // The script extracts the roles its own GRANTs name and requires the
        // globals to create each.
        expect(SCRIPT_CODE).toMatch(/granted_roles=/);
        expect(SCRIPT_CODE).toMatch(/GRANT .* TO/);
        expect(SCRIPT_CODE).toMatch(/CREATE\|ALTER\) ROLE|CREATE\|ALTER/);
        // The specific role must NOT be the thing being tested for.
            const from = SCRIPT_CODE.indexOf('granted_roles=');
            const to = SCRIPT_CODE.indexOf('step="upload');
            const assertionWindow = SCRIPT_CODE.slice(from, to);
            // The window must EXIST before anything is concluded from its
            // contents. A rename of either marker empties it, and an empty
            // string passes the negated assertion below while checking nothing
            // — the failure this repo has hit from both directions.
            expect({ rel, windowFound: from >= 0 && to > from, length: assertionWindow.length > 40 })
                .toEqual({ rel, windowFound: true, length: true });
            expect({ hardCodedRole: /app_user/.test(assertionWindow) }).toEqual({ hardCodedRole: false });
        },
    );

    describe("the encryption key's durable copy is checked too (#2357)", () => {
        /**
         * `DATA_ENCRYPTION_KEY` cannot be in the dump — a `pg_dump` carries no
         * environment — so a restored database is undecryptable without it. The
         * key lives in Secret Manager as a durable COPY while the VM's env file
         * stays the runtime source, because `roles/editor` includes 18
         * `secretmanager.*` permissions and both VMs run as a project editor:
         * having them read the secret at boot would need the `cloud-platform`
         * scope, which would also hand a compromised box both products' keys.
         *
         * A copy of a value that can change goes stale silently, so
         * `check-drift.sh` compares it. These assert that comparison is real.
         */
        const keyBlock = () =>
            DRIFT_CODE.slice(DRIFT_CODE.indexOf('KEY_PAIRS='), DRIFT_CODE.indexOf('KEY_EXPECTED='));

        it('[key-drift] the block it examines exists', () => {
            const b = keyBlock();
            console.log(`[key-drift] key block: ${b.replace(/\s+/g, ' ').trim().slice(0, 150)}…`);
            // Without this every assertion below reads an empty string.
            expect({ found: b.length > 200 }).toEqual({ found: true });
            expect(b).toContain('gcloud secrets versions access');
        });

        it('covers every stack that has a backup script', () => {
            // Derived from the same place as the pieces above: a stack whose
            // database is backed up but whose KEY has no checked copy is a
            // restore that produces unreadable columns.
            const b = keyBlock();
            for (const script of backupScripts()) {
                // `agrent-db-backup` -> `agrent`, `inflect-db-backup` -> `inflect`
                const stack = path.basename(script).replace(/-db-backup$/, '');
                expect({ stack, inKeyTable: new RegExp(`${stack}[a-z-]*-data-encryption-key`).test(b) })
                    .toEqual({ stack, inKeyTable: true });
            }
        });

        it('compares a HASH, never the key itself', () => {
            const b = keyBlock();
            expect(b).toMatch(/sha256sum/);
            // The value must never reach a log, a shell history or CI output.
            // `printenv DATA_ENCRYPTION_KEY` appears, but only ever piped into
            // a hash — never echoed, assigned bare, or compared directly.
            const pipesToHash = b
                .split('\n')
                .filter((l) => l.includes('printenv DATA_ENCRYPTION_KEY'))
                .every((l) => /sha256sum/.test(l) || /\\$/.test(l.trimEnd()));
            expect({ pipesToHash }).toEqual({ pipesToHash: true });
            expect({ echoesTheKey: /echo .*\$\{?DATA_ENCRYPTION_KEY/.test(b) })
                .toEqual({ echoesTheKey: false });
        });

        it('tells "they differ" apart from "I could not look"', () => {
            // Collapsing both into one verdict reports DRIFT when the real
            // answer is that the check was blind — and an empty `$( )` under
            // `set -e` makes that collapse the DEFAULT, which is why each side
            // is classified before they are compared.
            const b = keyBlock();
            expect(b).toMatch(/-z "\$live_h"/);
            expect(b).toMatch(/-z "\$stored_h"/);
            expect(b).toMatch(/could not read/);
        });

        it('KEY_DRIFT reaches the exit status', () => {
            // The bug this assertion exists for was in the first version of
            // that block: KEY_DRIFT was set on every failure path and never
            // read, so the script printed the errors and still exited 0. A
            // check that cannot fail is the thing this whole file is about.
            expect(DRIFT_CODE).toMatch(/KEY_DRIFT" -ne 0 \] && FAILED=/);
            // And the count must equal the table, as the backup loop does.
            expect(DRIFT_CODE).toMatch(/KEY_CHECKED" -ne "\$KEY_EXPECTED/);
        });

        it('the runbook says the key is not in the dump, and where it is', () => {
            // A secret nobody knows to retrieve is not a recovery plan. The
            // recovery procedure must name BOTH facts.
            const runbook = read('docs/backup-restore.md');
            expect(runbook).toMatch(/secrets versions access/);
            expect(runbook).toMatch(/not in the dump|carries no environment/);
            expect(runbook).toMatch(/agrent-data-encryption-key/);
            expect(runbook).toMatch(/inflect-compliance-data-encryption-key/);
            // And it must NOT claim the copy restricts access — it does not.
            expect(runbook).toMatch(/durability control, not an access control/);
        });
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
