/**
 * Every write to the global framework catalogue goes through the platform gate.
 *
 * `Framework` and `FrameworkRequirement` are the repo's only tenant-facing
 * tables with NO `tenantId`. That is the right architecture — a shared
 * catalogue of standards with a per-tenant link table — but it means a write
 * has no tenancy of its own to constrain it. The only thing standing between
 * "one farm edits a standard" and "every farm's coverage changes" is the gate
 * on the usecase.
 *
 * Two usecases had the wrong one. Both resolved from Role
 * (`assertCanInstallFrameworkPack`, `assertCanAdmin`), and Role is what every
 * farm's OWNER already holds — so the gate that was supposed to restrict the
 * catalogue admitted the entire platform.
 *
 * This guard is structural on purpose: the behavioural half lives in
 * `tests/unit/security/catalogue-write-isolation.test.ts` and executes the
 * gate, while this half watches the POPULATION — a NEW usecase that writes
 * `prisma.framework.*` or `prisma.frameworkRequirement.*` and forgets the gate
 * is the regression that matters, and no behavioural test can see a caller
 * that does not exist yet.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const USECASES = join(ROOT, 'src/app-layer/usecases');
// The catalogue ingestion pipeline lives under `prisma/`, not in the usecase
// tree. It is scanned too — an ingestion-shaped bypass there would be exactly
// as global as one in a usecase, and walking only `src/` would leave it
// invisible to this guard.
const INGESTION = join(ROOT, 'prisma');

/** Prisma calls that MUTATE the global catalogue. Reads are deliberately open. */
const CATALOGUE_WRITE = new RegExp(
    String.raw`\b(?:prisma|db|tx)\s*\.\s*(framework|frameworkRequirement)\s*\.\s*` +
        String.raw`(create|createMany|update|updateMany|upsert|delete|deleteMany)\b`,
    'g',
);

const GATE = 'assertCanWriteCatalogue';

/**
 * Files allowed to mutate the catalogue WITHOUT the usecase gate.
 *
 * The catalogue has to be ingested from somewhere. These run outside any
 * request — a CLI importer and the seeder — so there is no `RequestContext` to
 * gate on and no user to attribute the write to. They are reachable only by
 * someone who already has database credentials, which is a strictly stronger
 * position than any tenant session.
 */
const INGESTION_EXEMPT: Readonly<Record<string, string>> = {
    'prisma/catalog-applier.ts':
        'Catalogue ingestion from prisma/catalogs/*.yaml. Runs from the ' +
        'schemes:import CLI and the seeder, outside any request — there is no ' +
        'RequestContext to gate on. Reachable only with DB credentials.',
    'prisma/seed-catalog.ts':
        'Seeder — writes the baseline framework catalogue on a fresh ' +
        'database. Same reasoning as catalog-applier: no request, no user, ' +
        'DB credentials required.',
    'prisma/seed.ts':
        'Seeder entrypoint. Same reasoning as catalog-applier.',
};

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        // Generated client + migrations are not hand-written call sites.
        if (entry === 'node_modules' || entry === 'migrations' || entry === 'generated') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
}

/** Usecase files keep their short path; ingestion files are prefixed `prisma/`. */
function relKey(file: string): string {
    if (file.startsWith(USECASES)) return file.slice(USECASES.length + 1);
    return 'prisma/' + file.slice(INGESTION.length + 1);
}

/** Strip comments so a docblock quoting `prisma.framework.create` is not a hit. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = [...walk(USECASES), ...walk(INGESTION)];

describe('global catalogue writes are platform-gated', () => {
    it('found the usecase tree (self-check)', () => {
        // A broken walker would make every assertion below vacuous — this
        // guard's whole value is the population it inspects.
        expect(FILES.length).toBeGreaterThan(50);
    });

    const writers = FILES.map((file) => ({
        file,
        rel: relKey(file),
        source: stripComments(readFileSync(file, 'utf8')),
    })).filter((f) => CATALOGUE_WRITE.test(f.source) || (CATALOGUE_WRITE.lastIndex = 0, false));

    it('found at least one catalogue writer (self-check)', () => {
        // If the detector matched nothing, the per-file assertions below would
        // all pass by inspecting an empty list.
        expect(writers.length).toBeGreaterThan(0);
    });

    it.each(writers.map((w) => w.rel))('%s gates its catalogue writes', (rel) => {
        const exempt = INGESTION_EXEMPT[rel];
        if (exempt) {
            expect(exempt.length).toBeGreaterThan(20); // a real reason, not a shrug
            return;
        }
        const source = writers.find((w) => w.rel === rel)!.source;
        expect(source).toContain(GATE);
    });

    it('the exemption list has no stale entries', () => {
        // An exempt file that stopped writing the catalogue should leave the
        // list, or the list stops describing reality.
        for (const rel of Object.keys(INGESTION_EXEMPT)) {
            const match = writers.find((w) => w.rel === rel);
            expect(match).toBeDefined();
        }
    });
});

describe('the weaker gates cannot come back', () => {
    const fixtures = readFileSync(join(USECASES, 'framework/fixtures.ts'), 'utf8');

    it('upsertRequirements does not gate on assertCanInstallFrameworkPack', () => {
        // That gate is correct for INSTALLING a pack into your own tenant (it
        // writes Control + ControlRequirementLink rows, both tenant-scoped)
        // and wrong for writing the catalogue every tenant reads.
        expect(stripComments(fixtures)).not.toContain('assertCanInstallFrameworkPack');
    });

    it('the destructive sweep is audited', () => {
        // `deprecateMissing` stamps deprecatedAt across a whole standard, and
        // deprecated requirements drop out of coverage and the SoA for every
        // tenant. It ran with no audit row at all.
        expect(fixtures).toContain('FRAMEWORK_REQUIREMENTS_UPSERTED');
        const deprecateIdx = fixtures.indexOf('deprecateMissing');
        const auditIdx = fixtures.indexOf('FRAMEWORK_REQUIREMENTS_UPSERTED');
        expect(deprecateIdx).toBeGreaterThan(-1);
        expect(auditIdx).toBeGreaterThan(deprecateIdx);
    });
});

describe('the detector works (mutation proof)', () => {
    const check = (src: string) => {
        CATALOGUE_WRITE.lastIndex = 0;
        return CATALOGUE_WRITE.test(stripComments(src));
    };

    it('flags a write', () => {
        expect(check('await prisma.framework.create({ data: {} });')).toBe(true);
        expect(check('await db.frameworkRequirement.updateMany({});')).toBe(true);
    });

    it('does NOT flag a read', () => {
        // Browsing the catalogue is open to every role by design.
        expect(check('await prisma.framework.findFirst({});')).toBe(false);
        expect(check('await db.frameworkRequirement.findMany({});')).toBe(false);
    });

    it('does NOT flag a tenant-scoped table that merely mentions the word', () => {
        expect(check('await db.controlRequirementLink.createMany({});')).toBe(false);
    });

    it('does NOT flag a comment', () => {
        expect(check('// await prisma.framework.create() would be a write')).toBe(false);
        expect(check('/** prisma.framework.updateMany is the wipe */')).toBe(false);
    });
});
