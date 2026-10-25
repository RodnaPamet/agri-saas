/**
 * Every relative path `docker-compose.vm.yml` names resolves in a CLONE — #2319.
 *
 * ## The failure this exists for, and why nothing caught it
 *
 * The db service mounted `./init-roles.sh`, which the repo does not have at its
 * root — the script lives in `deploy/`. Production satisfied the mount with an
 * untracked copy somebody had placed at `/opt/agrent/init-roles.sh`, so the
 * deployment worked and the repo could not reproduce it.
 *
 * **A bind mount whose source is missing does not fail.** Docker creates a
 * DIRECTORY at that path and mounts it. Measured on a throwaway VM:
 *
 *     $ ls -ld /opt/agri-saas/init-roles.sh
 *     drwxr-xr-x 2 root root 4096 Oct 25 04:47 .../init-roles.sh
 *
 * So initdb mounted an empty directory, ran nothing, and Postgres came up
 * HEALTHY with no `app_user`. The first RLS migration then failed on
 * `role "app_user" does not exist` — three steps downstream of the cause, and
 * reading like a migration bug. That is the whole reason this is a guard and
 * not a line in a runbook: the signal arrives far from the defect, wearing a
 * different costume.
 *
 * ## The population is DERIVED from the compose file
 *
 * Build contexts and volume sources, read out of the YAML. A hand-listed set
 * would miss the next service, which is how the original escaped: `apply.sh`
 * already documents that `build: context: ./deploy/postgres` means the compose
 * file "cannot be the only thing that decides what the production database
 * image IS", so the paths were on somebody's mind — just not checked.
 *
 * ## `./Caddyfile` is VM-PROVIDED, and "fixing" it would be an outage
 *
 * The one entry below is not an oversight to tidy away. `/opt/agrent/Caddyfile`
 * is hand-assembled and serves a CO-TENANT product; CLAUDE.md and
 * `deploy/caddy-foreign-sites.txt` both state that pointing this at
 * `deploy/Caddyfile` — a deliberately PARTIAL copy — deletes four foreign site
 * blocks and takes a venue-booking product offline. `apply.sh` does not copy it
 * and `check-drift.sh` does not hash it, by design.
 *
 * So this guard cannot simply assert "every path exists in the repo": that
 * assertion would demand a root `Caddyfile`, and satisfying it is the outage.
 * Three categories, as with the paths rule in `verify-changed.rules.json`:
 * resolves in the clone, declared VM-provided with a reason, or a failure.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const COMPOSE_REL = 'deploy/docker-compose.vm.yml';

/**
 * Paths the VM supplies and the repo deliberately does NOT, each with the
 * reason. An entry here is a claim that a file at this path in the repo would
 * be WRONG — not merely absent.
 */
const VM_PROVIDED: Readonly<Record<string, string>> = {
    './Caddyfile':
        'The live /opt/agrent/Caddyfile is HAND-ASSEMBLED and serves a co-tenant product '
        + '(six playerz addresses across four blocks). deploy/Caddyfile is a deliberately '
        + 'PARTIAL record, not a deployment: apply.sh does not copy it and check-drift.sh '
        + 'does not hash it. Pointing this mount at deploy/Caddyfile would delete those '
        + 'blocks and take a venue-booking product offline — see CLAUDE.md and '
        + 'deploy/caddy-foreign-sites.txt. A root Caddyfile in the repo would be WRONG, '
        + 'not missing.',
};

interface Ref {
    service: string;
    kind: string;
    rel: string;
}

function relativeRefs(): Ref[] {
    const doc = yaml.load(fs.readFileSync(path.join(REPO_ROOT, COMPOSE_REL), 'utf8')) as {
        services?: Record<string, { build?: unknown; volumes?: unknown[] }>;
    };
    const out: Ref[] = [];
    for (const [service, svc] of Object.entries(doc.services ?? {})) {
        const build = svc.build;
        const ctx =
            typeof build === 'string'
                ? build
                : typeof (build as { context?: string })?.context === 'string'
                  ? (build as { context: string }).context
                  : undefined;
        if (ctx?.startsWith('.')) out.push({ service, kind: 'build.context', rel: ctx });
        for (const v of (svc.volumes ?? []) as unknown[]) {
            // Only bind mounts. A NAMED volume has no leading `.` and is
            // created by Docker, so it cannot be missing from a clone.
            if (typeof v === 'string' && v.startsWith('.')) {
                out.push({ service, kind: 'volume', rel: v.split(':')[0] });
            }
        }
    }
    return out;
}

const REFS = relativeRefs();

describe('docker-compose.vm.yml paths resolve in a clone (#2319)', () => {
    it('[compose-paths] ranges over a real set', () => {
        console.log(
            `[compose-paths] ${REFS.length} relative path(s) in ${COMPOSE_REL}: `
                + `${REFS.filter((r) => r.kind === 'build.context').length} build context(s), `
                + `${REFS.filter((r) => r.kind === 'volume').length} bind mount(s); `
                + `${Object.keys(VM_PROVIDED).length} VM-provided`,
        );
        // A parse that stopped matching would make every assertion below pass
        // over nothing — and this guard exists because a missing path is
        // SILENT, so an empty population would be the same defect one level up.
        expect(REFS.length).toBeGreaterThanOrEqual(4);
        expect(REFS.some((r) => r.kind === 'build.context')).toBe(true);
        expect(REFS.some((r) => r.kind === 'volume')).toBe(true);
    });

    it.each(REFS.map((r) => [`${r.service} ${r.kind} ${r.rel}`, r] as const))(
        '%s resolves in the repo, or is declared VM-provided',
        (_label, ref) => {
            if (ref.rel in VM_PROVIDED) return;
            const abs = path.resolve(REPO_ROOT, ref.rel);
            expect({
                ref: `${ref.service} ${ref.kind} ${ref.rel}`,
                exists: fs.existsSync(abs),
            }).toEqual({ ref: `${ref.service} ${ref.kind} ${ref.rel}`, exists: true });
        },
    );

    it('every VM-provided entry carries a reason, and is really absent here', () => {
        // The second assertion keeps the hole narrow. Without it, a file that
        // was DELETED from the repo could be parked here and this guard would
        // stop noticing — a real missing path re-entering through the door
        // built for the one that is supposed to be missing.
        for (const [rel, why] of Object.entries(VM_PROVIDED)) {
            expect({ rel, explained: why.length > 120 }).toEqual({ rel, explained: true });
            expect({ rel, presentInRepo: fs.existsSync(path.resolve(REPO_ROOT, rel)) })
                .toEqual({ rel, presentInRepo: false });
        }
    });

    it('every VM-provided entry is actually referenced by the compose file', () => {
        // The other direction: an entry for a path nothing mounts is a reason
        // written down for a risk that no longer exists, and it reads as
        // coverage.
        const referenced = new Set(REFS.map((r) => r.rel));
        for (const rel of Object.keys(VM_PROVIDED)) {
            expect({ rel, referenced: referenced.has(rel) }).toEqual({ rel, referenced: true });
        }
    });

    it('the db init script is mounted from deploy/, where the repo keeps it', () => {
        // The regression pin for the specific defect. Named rather than left to
        // the derived case above, because the derived case would also pass if
        // somebody added a root `init-roles.sh` — which would re-create the
        // two-copies problem that let production and the repo disagree.
        const dbMounts = REFS.filter((r) => r.service === 'db' && r.kind === 'volume');
        const init = dbMounts.find((r) => r.rel.endsWith('init-roles.sh'));
        expect(init?.rel).toBe('./deploy/init-roles.sh');
        expect(fs.existsSync(path.join(REPO_ROOT, 'init-roles.sh'))).toBe(false);
    });

    it('POSTGRES_USER is pinned in the env example, with the reason', () => {
        // Not a free choice: `20260323180000_apply_full_rls_setup` references
        // the role `postgres` by name, so any other value fails migration with
        // `42704 role "postgres" does not exist`. Measured on a throwaway VM
        // where I had picked `loadtest` — the env template said nothing, and
        // the error names a role rather than the variable that chose it.
        const example = fs.readFileSync(path.join(REPO_ROOT, 'deploy/env.prod.example'), 'utf8');
        expect(example).toMatch(/^POSTGRES_USER=postgres$/m);
        // And the reason travels with it, so the next reader does not "clean up"
        // a value that looks like a leftover default.
        const idx = example.indexOf('POSTGRES_USER=postgres');
        expect(example.slice(Math.max(0, idx - 400), idx)).toMatch(/20260323180000|role `postgres`|cannot migrate/);
    });
});
