/**
 * `/no-tenant` distinguishes a stale session from no farm at all (#1738).
 *
 * The page serves BOTH tenant-gate refusals — `no_tenant_access` and
 * `cross_tenant` both redirect here (`src/middleware.ts`) — and told both the
 * same thing: ask an administrator for an invitation. For the person who had
 * just created the farm they own, that is false in its first half and right
 * for the wrong reason in its second.
 *
 * The decision is extracted into a pure function and tested here exhaustively,
 * because the thing that can be wrong is WHICH ARM is chosen, and that is
 * decided by a set difference over two inputs rather than by anything the DOM
 * shows. The DOM is pinned separately.
 */
import {
    slugsTheTokenDoesNotKnow,
    type TokenMembership,
} from '@/lib/auth/membership-presence';

function tok(...slugs: string[]): TokenMembership[] {
    return slugs.map((slug) => ({ slug }));
}

describe('a STALE session — the database knows a farm the token does not', () => {
    it('the farm-creation case: database has one, token has none', () => {
        // #1738 as filed. The OWNER membership exists and the token predates
        // it, so the Edge refuses entry to a farm the person owns.
        expect(slugsTheTokenDoesNotKnow(['agrent-platform-83605c04'], tok()))
            .toEqual(['agrent-platform-83605c04']);
    });

    it('the SECOND-farm case: token has the old ones, not the new one', () => {
        // The `cross_tenant` arm. The issue notes the symptom differs for a
        // user who already had farms while the cause is identical, and this
        // page gets both.
        expect(slugsTheTokenDoesNotKnow(['alpha', 'beta', 'gamma'], tok('alpha', 'beta')))
            .toEqual(['gamma']);
    });

    it('the SWAP case, which a count comparison would miss', () => {
        // One membership removed and another added between sign-ins: the
        // counts match, so `dbCount > tokenCount` is false and the person
        // would have been told to find an administrator. A set difference
        // sees it. This case is the reason the helper is a difference.
        expect(slugsTheTokenDoesNotKnow(['kept', 'added'], tok('kept', 'removed')))
            .toEqual(['added']);
    });
});

describe('NOT stale — the original message is the correct one', () => {
    it('no farms anywhere', () => {
        // Who the page was written for, and who must keep the old copy: a
        // person mid-onboarding with no farm. Telling them to sign in again
        // would be a loop with no explanation.
        expect(slugsTheTokenDoesNotKnow([], tok())).toEqual([]);
    });

    it('token already knows every farm the database grants', () => {
        // Reached by navigating here directly with a perfectly good session.
        // Claiming staleness would be a diagnosis of a problem they do not
        // have.
        expect(slugsTheTokenDoesNotKnow(['alpha', 'beta'], tok('alpha', 'beta'))).toEqual([]);
    });

    it('the token knows MORE than the database — a revoked membership', () => {
        // The opposite drift: the farm was deleted or the membership revoked
        // after sign-in. Signing in again removes it rather than revealing
        // anything, so this is NOT the stale arm — and a symmetric-difference
        // implementation would wrongly say it was.
        expect(slugsTheTokenDoesNotKnow(['alpha'], tok('alpha', 'gone'))).toEqual([]);
    });

    it('order does not decide it', () => {
        expect(slugsTheTokenDoesNotKnow(['b', 'a'], tok('a', 'b'))).toEqual([]);
    });

    it('a duplicated token entry does not mask a genuinely unknown farm', () => {
        expect(slugsTheTokenDoesNotKnow(['a', 'new'], tok('a', 'a'))).toEqual(['new']);
    });
});

describe('the copy exists in BOTH locales, and says different things', () => {
    // `require`, not `import`: these are read as DATA. An import would let
    // TypeScript narrow the keys to what the catalogue currently has, which is
    // exactly the absence some of these cases assert.
    const en = require('../../messages/en.json').noTenant as Record<string, string>;
    const bg = require('../../messages/bg.json').noTenant as Record<string, string>;

    it('has staleTitle and staleBody in en and bg', () => {
        for (const cat of [en, bg]) {
            expect(typeof cat.staleTitle).toBe('string');
            expect(typeof cat.staleBody).toBe('string');
            expect(cat.staleTitle.length).toBeGreaterThan(0);
            expect(cat.staleBody.length).toBeGreaterThan(0);
        }
    });

    it('the stale copy does NOT tell the person to find an administrator', () => {
        // The defect, stated as an assertion. This is the sentence that sent
        // the owner of a farm looking for an administrator who does not exist.
        expect(en.staleBody).not.toMatch(/admin/i);
        expect(bg.staleBody).not.toMatch(/администратор/i);
        // And it says the opposite explicitly, so a reader is not left to
        // infer it.
        expect(en.staleBody).toMatch(/do not need an invitation/i);
        expect(bg.staleBody).toMatch(/не Ви е необходима покана/i);
    });

    it('the ORIGINAL copy still names an administrator — it is correct there', () => {
        // The control. If a well-meant edit removed the administrator from
        // BOTH messages, the genuinely-uninvited person would lose the only
        // accurate instruction on the page, and every assertion above would
        // still pass.
        expect(en.body).toMatch(/admin/i);
        expect(bg.body).toMatch(/администратор/i);
    });

    it('the two bodies are not the same string', () => {
        expect(en.staleBody).not.toBe(en.body);
        expect(bg.staleBody).not.toBe(bg.body);
    });

    it('the bg copy is Cyrillic, and uses the formal address', () => {
        for (const v of [bg.staleTitle, bg.staleBody]) {
            expect(v).toMatch(/[Ѐ-ӿ]/);
            expect(v).not.toMatch(/[a-z]{4,}/);
        }
        // Formal «Ви», capitalised, per the phase's standing copy rule. The
        // catalogue is split on this (48 capital / 54 lowercase), so the rule
        // is stated rather than enforced repo-wide — followed here for new
        // copy rather than normalising 54 existing strings in a copy fix.
        //
        // `\p{L}` with the `u` flag, NOT `\b`. JavaScript's `\b` is defined
        // over ASCII `\w`, so every Cyrillic letter is a non-word character
        // and `/\bВи\b/` cannot match ANY Bulgarian string — it failed on
        // copy that plainly contains «Не Ви е необходима покана». An
        // ASCII-boundary assertion over Cyrillic is a check that can only
        // ever fail, which is as useless as one that can only ever pass.
        expect(bg.staleBody).toMatch(/(?:^|[^\p{L}])Ви(?:[^\p{L}]|$)/u);
    });

    it('that formal-address assertion can actually fail — control', () => {
        // Pinning the regex itself, because the first version could not match
        // anything. Without this, a future edit back to `\b` would read as a
        // tightening and silently stop testing the copy.
        const pattern = /(?:^|[^\p{L}])Ви(?:[^\p{L}]|$)/u;
        expect(pattern.test('Не Ви е необходима покана.')).toBe(true);
        expect(pattern.test('Ви е необходима')).toBe(true);
        // Lowercase, and the word embedded in a longer one, must NOT count.
        expect(pattern.test('Не ви е необходима покана.')).toBe(false);
        expect(pattern.test('Вие принадлежите')).toBe(false);
    });
});
