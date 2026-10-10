/**
 * Every `/account` section is reachable from the UI, and `/account` itself
 * resolves.
 *
 * ── the defect this encodes ──
 *
 * `/account/profile` and `/account/security` both existed, and the user menu
 * linked only `security`. So the profile page — avatar upload, name, feedback
 * preferences — was reachable by typing the URL and **no other way**. Bare
 * `/account` had no `page.tsx` at all and 404'd. And `/no-tenant`, the landing
 * for a user with no membership, offered sign-out and nothing else, so exactly
 * the users with no farm to click through had no route to their own account.
 *
 * None of that is visible from any one file, which is why it survived: each
 * page was individually fine. The property is about the EDGES between them.
 *
 * ── why a derived population ──
 *
 * The sections are discovered from the filesystem rather than listed here. A
 * hard-coded list would pass forever the moment someone adds a third section
 * and forgets to link it — which is precisely the bug above, one iteration
 * later. The floor keeps an empty scan from reading as success.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectTrackedFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const ACCOUNT_DIR = path.join(ROOT, 'src/app/account');

/** Every `/account/<section>` route that has a page, derived from disk. */
function sections(): string[] {
    return fs
        .readdirSync(ACCOUNT_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => fs.existsSync(path.join(ACCOUNT_DIR, e.name, 'page.tsx')))
        .map((e) => e.name)
        .sort();
}

/**
 * Files that may legitimately link into the account area.
 *
 * `collectTrackedFiles` rather than a hand-rolled walk: it refuses an empty
 * result and names a renamed root instead of contributing zero. A hand-rolled
 * collector can be gutted to `return []` with every assertion on it still green
 * — `tests/guards/file-collection-is-not-silently-empty.test.ts` measured that
 * at 81% of the guards it could audit, and it caught this file's first draft.
 *
 * The floor is asserted at the CALL SITE as well, because gutting this wrapper
 * skips the helper's own refuse-empty entirely.
 */
function linkSources(): string[] {
    return collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    }).map((abs) => path.relative(ROOT, abs));
}

describe('the /account area is reachable', () => {
    const found = sections();
    const sources = linkSources();

    it('finds the sections it is meant to be checking', () => {
        // Anti-vacuity: an empty scan would make every assertion below pass
        // while checking nothing.
        expect(found.length).toBeGreaterThanOrEqual(2);
        expect(found).toEqual(expect.arrayContaining(['profile', 'security']));
        expect(sources.length).toBeGreaterThan(500);
    });

    it('bare /account resolves instead of 404ing', () => {
        expect(fs.existsSync(path.join(ACCOUNT_DIR, 'page.tsx'))).toBe(true);
    });

    it.each(sections())('/account/%s is linked from somewhere in the UI', (section) => {
        const href = `/account/${section}`;
        const linkers = sources.filter((rel) => {
            // The section's own page linking itself proves nothing, and neither
            // does the shell nav if the shell is only reachable FROM a section.
            if (rel.startsWith(path.join('src/app/account', section))) return false;
            return fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(href);
        });
        expect(linkers.length).toBeGreaterThan(0);
    });

    it('at least one entry point exists from OUTSIDE the account area', () => {
        // Breaks the circularity the case above cannot: the shell's own nav
        // links every section, so "linked from somewhere" is satisfied by the
        // area linking itself. What makes the area reachable at all is a link
        // from outside it — the user menu for someone with a farm, the
        // no-tenant landing for someone without.
        //
        // Found by mutation: removing the user-menu profile link left the
        // previous case green, correctly (the no-tenant link still reached
        // it) — but nothing yet asserted that ANY outside link existed.
        const entryPoints = sources
            .filter((rel) => !rel.startsWith('src/app/account'))
            .filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('/account/'));
        expect(entryPoints.length).toBeGreaterThan(0);
    });

    it('a user with NO membership can reach their account', () => {
        // `/no-tenant` is where a zero-membership user lands. The phase
        // requires the account shell to work with zero farms; a shell nobody
        // in that state can open does not meet it.
        const noTenant = fs.readFileSync(path.join(ROOT, 'src/app/no-tenant/page.tsx'), 'utf8');
        expect(noTenant).toMatch(/href="\/account/);
    });

    it('the shell does not depend on tenant context', () => {
        // The one property that makes "works with zero farms" true rather
        // than hopeful: nothing in the account subtree may reach for tenant
        // nav or tenant context, since such a user has none.
        //
        // Comments are stripped first. The first version of this case matched
        // the layout's own docblock — which EXPLAINS why it cannot reuse
        // `useNavSections()` — and reported the explanation as the violation.
        // A guard that reads prose is grading the wrong text.
        const code = (src: string) =>
            blankNonCode(src);

        const offenders = sources
            .filter((r) => r.startsWith('src/app/account'))
            .filter((rel) =>
                /useNavSections|getTenantCtx|getTenantServerContext|tenantSlug/.test(
                    code(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
                ),
            );
        expect(offenders).toEqual([]);
    });

    it('…and that check reads CODE, not comments', () => {
        // The control for the case above: prove the strip actually removes a
        // mention, so "no offenders" cannot mean "the regex never fired".
        const code = (src: string) =>
            blankNonCode(src);
        expect(code('/* useNavSections */ const a = 1;')).not.toMatch(/useNavSections/);
        expect(code('// tenantSlug\nconst b = 2;')).not.toMatch(/tenantSlug/);
        expect(code('const c = useNavSections();')).toMatch(/useNavSections/);
    });
});
