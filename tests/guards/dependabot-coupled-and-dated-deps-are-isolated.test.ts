import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Two production dependencies must not ride inside the weekly `production`
 * batch, for two DIFFERENT reasons — and both reasons are invisible in the
 * config, which is why they are asserted here.
 *
 * **The `@aws-sdk` pair is a COUPLED SET.** `getSignedUrl(client, command)`
 * takes its client as `Client<any, ServiceInputTypes, MetadataBearer, any>`, a
 * structural type the presigner resolves through its own tree. Move one package
 * and not the other and that parameter stops accepting our `S3Client`. It fails
 * at COMPILE time with `npm ci` perfectly happy, which is harder to read than
 * the typescript-eslint family's ERESOLVE next door: the error names a generic,
 * not a package.
 *
 * **`stripe` carries a DATED API VERSION into source.** `src/lib/stripe.ts`
 * pins `apiVersion` and the SDK types it as a literal union, so a bump makes
 * the pin un-assignable. The one-line edit that clears it is an ADOPTION of a
 * new Stripe API version — a behaviour change for webhooks and billing objects.
 * Reviewed inside a 21-package diff, the only signal is CI going green.
 *
 * Both were measured on #2731 (#2758): 3.1157 -> 3.1160 broke the presigner
 * parameter and `stripe` 23.1.0 moved the API version, so 19 unrelated bumps
 * were held hostage by the two. Same ending as #572 (26 deps held by the Next
 * patch) and #1150 (15 dev deps held by one ERESOLVE).
 *
 * WHY A GUARD AND NOT A COMMENT. Dependabot assigns a dependency to the FIRST
 * group whose patterns match, and `production` matches by `dependency-type`
 * with NO patterns — so it swallows anything left unclaimed above it. Move the
 * `aws-sdk` group below it, or delete an `exclude-patterns` entry, and the old
 * behaviour returns with no error anywhere: the config stays valid, dependabot
 * keeps running, and the next coupled bump reddens a batch again.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = path.join(REPO_ROOT, '.github/dependabot.yml');
const PKG = path.join(REPO_ROOT, 'package.json');

const raw = () => fs.readFileSync(CONFIG, 'utf8');

interface Group {
    patterns?: string[];
    'dependency-type'?: string;
    'exclude-patterns'?: string[];
    'applies-to'?: string;
}
interface Update {
    'package-ecosystem': string;
    groups?: Record<string, Group>;
}

function npmGroups(): Record<string, Group> {
    const doc = yaml.load(raw()) as { updates: Update[] };
    const npm = doc.updates.find((u) => u['package-ecosystem'] === 'npm');
    if (!npm?.groups) throw new Error('no npm ecosystem with groups');
    return npm.groups;
}

function prodDeps(): string[] {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8')) as {
        dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {});
}

/**
 * Dependabot's pattern syntax, to the extent this guard needs it: a literal
 * name, or a `*` wildcard. Written out rather than reached for from a library
 * so the matcher cannot quietly start accepting a syntax dependabot does not.
 */
function matches(pattern: string, name: string): boolean {
    if (!pattern.includes('*')) return pattern === name;
    const rx = new RegExp(
        '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return rx.test(name);
}

describe('the extractors this file depends on', () => {
    // Every assertion below is about membership in a list; an empty list
    // satisfies most of them. So both extractors are proved first.
    it('reads the npm groups, including ones that predate this guard', () => {
        const g = npmGroups();
        expect(Object.keys(g).length).toBeGreaterThan(4);
        expect(g).toHaveProperty('production');
        expect(g).toHaveProperty('dev-dependencies');
        expect(g).toHaveProperty('typescript-eslint');
    });

    it('reads the production dependencies', () => {
        const deps = prodDeps();
        expect(deps.length).toBeGreaterThan(50);
        console.log(`[dependabot-isolation] ${deps.length} production deps read from package.json`);
    });

    it('the pattern matcher distinguishes a literal from a wildcard', () => {
        // The `next` / `next-auth` distinction this config turns on.
        expect(matches('next', 'next')).toBe(true);
        expect(matches('next', 'next-auth')).toBe(false);
        expect(matches('@aws-sdk/*', '@aws-sdk/client-s3')).toBe(true);
        expect(matches('@aws-sdk/*', '@aws-sdk/s3-request-presigner')).toBe(true);
        expect(matches('@aws-sdk/*', 'stripe')).toBe(false);
    });
});

describe('the @aws-sdk pair is grouped as one unit and kept out of the batch', () => {
    it('a dedicated group exists, matching the whole scope', () => {
        expect(npmGroups()).toHaveProperty('aws-sdk');
        expect(npmGroups()['aws-sdk'].patterns ?? []).toContain('@aws-sdk/*');
    });

    it('every @aws-sdk production dep is actually covered by it', () => {
        // DERIVED, not a list of the two names: a third `@aws-sdk/*` dependency
        // is covered the moment it is declared, rather than when somebody
        // remembers to add it here.
        const patterns = npmGroups()['aws-sdk'].patterns ?? [];
        const aws = prodDeps().filter((d) => d.startsWith('@aws-sdk/'));
        expect(aws.length).toBeGreaterThanOrEqual(2);
        console.log(`[dependabot-isolation] ${aws.length} @aws-sdk production deps: ${aws.join(', ')}`);
        for (const name of aws) {
            expect(patterns.some((p) => matches(p, name))).toBe(true);
        }
    });

    it('the group sits ABOVE production — first match wins', () => {
        // Twice over, as its typescript-eslint sibling does: once on parsed key
        // order (what dependabot reads) and once on byte offsets (which no
        // object-key reordering in the loader can fool).
        const keys = Object.keys(npmGroups());
        expect(keys.indexOf('aws-sdk')).toBeGreaterThan(-1);
        expect(keys.indexOf('aws-sdk')).toBeLessThan(keys.indexOf('production'));

        const text = raw();
        const awsPos = text.indexOf('\n      aws-sdk:');
        const prodPos = text.indexOf('\n      production:');
        expect(awsPos).toBeGreaterThan(-1);
        expect(prodPos).toBeGreaterThan(-1);
        expect(awsPos).toBeLessThan(prodPos);
    });

    it('production still selects by TYPE with no patterns, which is why order binds', () => {
        // If this ever gains explicit `patterns`, the ordering argument changes
        // and the reasoning needs revisiting rather than silently passing.
        const prod = npmGroups().production;
        expect(prod['dependency-type']).toBe('production');
        expect(prod.patterns).toBeUndefined();
    });
});

describe('the production group excludes what must be reviewed alone', () => {
    it('`stripe` is excluded, exactly and not by wildcard', () => {
        const ex = npmGroups().production['exclude-patterns'] ?? [];
        expect(ex).toContain('stripe');
        // A `stripe*` or `@stripe/*` entry would sweep in a future package
        // nobody has decided about. Same discipline as `next` vs `next-auth`.
        expect(ex.filter((p) => p.includes('stripe'))).toEqual(['stripe']);
    });

    it('the @aws-sdk scope is excluded too, so the split survives a reorder', () => {
        expect(npmGroups().production['exclude-patterns'] ?? []).toContain('@aws-sdk/*');
    });

    it('`next` is still excluded — the precedent this is built on', () => {
        expect(npmGroups().production['exclude-patterns'] ?? []).toContain('next');
    });

    it('NO exclusion is stale: each one names a live production dependency', () => {
        // The load-bearing one. An exclusion whose package has gone is cover for
        // whatever arrives under that name next, and nothing else would notice:
        // the config stays valid and the group keeps working. Same rule as every
        // allowlist in this repo.
        const deps = prodDeps();
        const ex = npmGroups().production['exclude-patterns'] ?? [];
        expect(ex.length).toBeGreaterThan(0);
        for (const pattern of ex) {
            const hit = deps.filter((d) => matches(pattern, d));
            expect(hit.length).toBeGreaterThan(0);
        }
        console.log(
            `[dependabot-isolation] ${ex.length} production exclusions, all resolving: ${ex.join(', ')}`,
        );
    });
});

describe('the reasons are written where the next editor will look', () => {
    it('the coupled-set and dated-API arguments are both in the file', () => {
        const text = raw();
        expect(text).toMatch(/COUPLED\s+SET/);
        expect(text).toMatch(/DATED API VERSION/);
        // The mechanism that makes order load-bearing, stated once in the file
        // and relied on by two groups.
        expect(text).toMatch(/FIRST group whose patterns match/);
    });
});
