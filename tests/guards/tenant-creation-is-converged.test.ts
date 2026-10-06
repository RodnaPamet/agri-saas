/**
 * Tenant creation goes through one helper, and bcrypt stays out of the
 * transaction (P3.3).
 *
 * ── what this prevents coming back ──
 *
 * `createTenantWithDek` could only use the singleton client, so THREE call
 * sites replicated its body against a `tx`: `api/auth/register`,
 * `createTenantWithOwner` in `tenant-lifecycle.ts`, and `org-tenants.ts`.
 *
 * The module's own docblock named only TWO of them. A plan scoped off that
 * comment — which is what I started with — converges two sites and leaves the
 * third diverged, where it then looks deliberate rather than missed. That is
 * the specific failure this file exists to stop repeating: not "someone
 * duplicates the logic", but "someone duplicates it and the census that would
 * have caught it is itself stale".
 *
 * So the check derives the population from the filesystem rather than listing
 * the three known sites.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectTrackedFiles } from '../helpers/collect-files';
import { toSlug } from '@/lib/bg-transliterate';

const ROOT = path.resolve(__dirname, '../..');

/** The two modules that are ALLOWED to touch the DEK primitive. */
const KEY_MODULES = [
    'src/lib/security/tenant-keys.ts',
    'src/lib/security/tenant-key-manager.ts',
];

function sources(): string[] {
    return collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    }).map((abs) => path.relative(ROOT, abs));
}

/** Source with comments stripped — a docblock mentioning a symbol is not a use. */
const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('tenant creation is converged on one helper', () => {
    const files = sources();

    it('finds the population it is meant to be checking', () => {
        expect(files.length).toBeGreaterThan(500);
        for (const m of KEY_MODULES) expect(files).toContain(m);
    });

    it('nothing outside the key modules wraps a DEK by hand', () => {
        // `generateAndWrapDek` + a raw `tenant.create` IS the replicated body.
        // Using the primitive anywhere else means a fourth divergence.
        const offenders = files
            .filter((rel) => !KEY_MODULES.includes(rel))
            .filter((rel) => /generateAndWrapDek/.test(code(fs.readFileSync(path.join(ROOT, rel), 'utf8'))));
        expect(offenders).toEqual([]);
    });

    it('…and that check reads code, not comments', () => {
        // Control: the strip must actually remove a mention, or "no offenders"
        // could mean "the regex never fired".
        expect(code('/* generateAndWrapDek */ const a = 1;')).not.toMatch(/generateAndWrapDek/);
        expect(code('const b = generateAndWrapDek();')).toMatch(/generateAndWrapDek/);
    });

    it('every tenant row is created through the helper, not tenant.create', () => {
        // The other half: a caller could skip the DEK entirely and leave the
        // tenant dependent on backfill. `encryptedDek` is nullable, so this
        // compiles and fails only much later.
        const offenders = files
            .filter((rel) => !KEY_MODULES.includes(rel))
            .filter((rel) =>
                /\b(tx|db|prisma)\.tenant\.create\s*\(/.test(
                    code(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
                ),
            );
        expect(offenders).toEqual([]);
    });
});

describe('the registration slug keeps the farm name', () => {
    const REGISTER = 'src/app/api/auth/register/route.ts';

    it('derives the slug through toSlug, not a bare [a-z0-9] strip', () => {
        // The defect this pins was LIVE, not hypothetical. The old derivation
        // was `String(orgName).toLowerCase().replace(/[^a-z0-9]+/g, '-')`,
        // which for a Bulgarian product strips the ENTIRE name — every
        // Cyrillic character is outside [a-z0-9]. «ЗК Победа» came out as
        // `-m2x3k9`: a leading hyphen and a timestamp, with no trace of the
        // farm. Only Latin names survived, and almost no real name here is
        // Latin.
        //
        // A transliteration library that nothing calls fixes nothing, which is
        // why this asserts the CALL rather than the library's existence.
        const src = fs.readFileSync(path.join(ROOT, REGISTER), 'utf8');
        const stripped = code(src);
        expect(stripped).toMatch(/toSlug\(/);
        expect(stripped).not.toMatch(/orgName[\s\S]{0,120}\[\^a-z0-9\]/);
    });

    it('…and toSlug actually keeps a Cyrillic name', () => {
        // The control for the assertion above: proving the route CALLS it is
        // worth nothing if the function itself drops Cyrillic. Both halves, or
        // neither means anything.
        expect(toSlug('ЗК Победа')).toBe('zk-pobeda');
        expect(toSlug('Агро Търговище ЕООД')).toBe('agro-targovishte-eood');
    });
});

describe('bcrypt stays outside the transaction boundary', () => {
    const REGISTER = 'src/app/api/auth/register/route.ts';

    it('hashPassword runs BEFORE the transaction opens', () => {
        // Not style. bcrypt at cost 12 runs for hundreds of milliseconds, and
        // DATABASE_URL points at PgBouncer in transaction mode — holding the
        // transaction open across it pins a pooled connection under exactly the
        // load where connections are scarce.
        //
        // Nothing fails if this moves: it just gets slow under load, which is
        // why a comment is not enough and this is a check.
        const src = code(fs.readFileSync(path.join(ROOT, REGISTER), 'utf8'));
        const hashAt = src.indexOf('hashPassword(');
        const txAt = src.indexOf('$transaction(');
        expect(hashAt).toBeGreaterThan(-1);
        expect(txAt).toBeGreaterThan(-1);
        expect(hashAt).toBeLessThan(txAt);
    });

    it('the two anchors it depends on still exist', () => {
        // If either call is renamed, the ordering assertion above passes
        // vacuously on two -1s. Asserting both are found is what stops that.
        const src = code(fs.readFileSync(path.join(ROOT, REGISTER), 'utf8'));
        expect(src).toContain('hashPassword(');
        expect(src).toContain('$transaction(');
    });
});
