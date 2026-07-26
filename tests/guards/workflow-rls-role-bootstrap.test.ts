/**
 * Every workflow that applies migrations must create the RLS roles first.
 *
 * The tenant-isolation migrations `GRANT` to `app_user` (see
 * `docs/rls-tenant-isolation.md`), and a fresh Postgres service container has
 * no such role. So `prisma migrate deploy` dies on the first RLS migration
 * with:
 *
 *     ERROR: role "app_user" does not exist   (SQLSTATE 42704)
 *
 * `ci.yml` and `lighthouse.yml` bootstrap the roles before migrating.
 * `load-test.yml` did not — and had therefore failed on EVERY run for at
 * least eight consecutive days, never reaching a single k6 scenario. A job
 * that always fails teaches everyone to ignore it, which is worse than not
 * having it: the load budget it exists to defend was unguarded the whole time.
 *
 * This guard is deliberately about ORDER, not just presence: a role step that
 * runs after `migrate deploy` is useless, exactly like a `COPY patches` after
 * `npm ci`.
 */
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows');

const MIGRATE = /prisma\s+migrate\s+deploy/;
const CREATE_ROLE = /CREATE ROLE app_user/;
const SEED = /npm run db:seed|tsx prisma\/seed/;
/** Either the shared composite action or an explicit generate call. */
const GENERATES_CLIENT = /setup-node-prisma|prisma generate/;

interface WorkflowFile {
    name: string;
    lines: string[];
}

/**
 * YAML comment lines are stripped before scanning. A comment explaining *why*
 * the role step must precede `prisma migrate deploy` naturally contains that
 * command, which would otherwise register as the first migration and make the
 * ordering check fail on a correctly-ordered file. (It did, on first run.)
 */
function isComment(line: string): boolean {
    return /^\s*#/.test(line);
}

function migratingWorkflows(): WorkflowFile[] {
    return fs
        .readdirSync(WORKFLOWS)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((name) => ({
            name,
            lines: fs
                .readFileSync(path.join(WORKFLOWS, name), 'utf-8')
                .split('\n')
                .map((l) => (isComment(l) ? '' : l)),
        }))
        .filter((w) => w.lines.some((l) => MIGRATE.test(l)));
}

describe('workflow RLS role bootstrap', () => {
    it('finds the workflows that apply migrations', () => {
        // If this drops to zero the detector has broken, not the repo.
        expect(migratingWorkflows().length).toBeGreaterThan(0);
    });

    it.each(migratingWorkflows().map((w) => w.name))(
        '%s creates app_user BEFORE applying migrations',
        (name) => {
            const { lines } = migratingWorkflows().find((w) => w.name === name)!;
            const firstMigrate = lines.findIndex((l) => MIGRATE.test(l));
            const firstRole = lines.findIndex((l) => CREATE_ROLE.test(l));

            expect(firstRole).toBeGreaterThan(-1);
            // Order is the whole point — a role created afterwards is too late.
            expect(firstRole).toBeLessThan(firstMigrate);
        },
    );

    it('grants the role to the connecting user, not just creates it', () => {
        // `CREATE ROLE app_user NOLOGIN` alone leaves `SET LOCAL ROLE app_user`
        // failing with "permission denied to set role" — the CI user has to be
        // a member of it.
        for (const { name, lines } of migratingWorkflows()) {
            const src = lines.join('\n');
            expect(src).toMatch(/GRANT app_user TO \w+/);
            expect(name).toBeTruthy();
        }
    });

    it.each(migratingWorkflows().map((w) => w.name))(
        '%s generates the Prisma client before seeding',
        (name) => {
            // Second half of the same lesson. Fixing the role bootstrap made
            // `prisma migrate deploy` pass and revealed the next failure:
            // `npm run db:seed` died on `Cannot find module
            // '.prisma/client/default'` because nothing generated the client.
            //
            // load-test.yml had duplicated the shared setup action's `npm ci`
            // retry logic but not its `prisma generate` half — duplicating
            // half of a shared setup is how the halves drift apart. Prefer the
            // composite action; an explicit `prisma generate` also satisfies
            // this.
            const { lines } = migratingWorkflows().find((w) => w.name === name)!;
            const src = lines.join('\n');
            if (!SEED.test(src)) return; // nothing to seed, nothing to prove
            expect(src).toMatch(GENERATES_CLIENT);
        },
    );
});
