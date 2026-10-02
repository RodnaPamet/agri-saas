/**
 * Every direct `hashForLookup` call site is classified, because only SOME of
 * them survive a lookup-key rotation.
 *
 * ── the gap this makes visible ──
 *
 * P1.1 gives the lookup hash its own key and supports `LOOKUP_HMAC_KEY_PREVIOUS`
 * so a rotation of THAT key can be read through: `hashForLookupCandidates`
 * returns both hashes and `pii-middleware` widens the predicate to
 * `{ in: [...] }`, downgrading `findUnique` to `findFirst` when it does.
 *
 * That only helps callers who hand the middleware a PLAIN address. Sixteen
 * sites in `src/` compute the hash themselves and pass `emailHash: …` straight
 * through, so the middleware never sees a plain field and never widens
 * anything. During a lookup-key rotation those reads get the PRIMARY hash only
 * and MISS every row not yet rehashed — the original defect, one level in.
 *
 * **This does not affect the rotation the product actually needs.** Rotating
 * `DATA_ENCRYPTION_KEY` works precisely because `LOOKUP_HMAC_KEY` stays put, so
 * no hash moves and no fallback is wanted. The gap is specific to rotating the
 * LOOKUP key, which needs the P1.3 rehash sweep anyway.
 *
 * ── why a registry and not a classifier ──
 *
 * The honest reason: a regex cannot reliably tell a read from a write here.
 * `tenant-lifecycle.ts:63` and `org-members.ts:279` assign to a local
 * (`const emailHash = hashForLookup(email)`) and use it later, possibly in
 * either position, so any window-based classification would be guessing — and
 * guessing in the direction of "write, therefore fine" is the failure that
 * reads as green. So the detector demands only that a site be REGISTERED, and
 * the registry carries a human's classification. The list can only shrink.
 *
 * A new call site fails this guard until someone writes down which kind it is.
 * That is the whole point: the next person to add an `emailHash` lookup is the
 * person who has to notice it needs candidates.
 */
import fs from 'fs';
import path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Modules exempt because they ARE the mechanism, not consumers of it.
 *
 * `encryption.ts` defines `hashForLookup`; `pii-middleware.ts` is the choke
 * point that already calls `hashForLookupCandidates` and is the reason a plain
 * `where: { email }` is rotation-safe.
 */
const MECHANISM_FILES = new Set([
    'src/lib/security/encryption.ts',
    'src/lib/security/pii-middleware.ts',
]);

type SiteKind =
    /** Reads the hash in a `where`. MISSES during a lookup-key rotation. */
    | 'read-primary-only'
    /** Writes the hash. Correct as-is — a write should use the primary key. */
    | 'write'
    /** Assigns to a local and uses it later; read the file before changing it. */
    | 'local-then-used';

interface Registration {
    kind: SiteKind;
    note: string;
}

/**
 * Every file in `src/` that calls `hashForLookup` directly, with what it does.
 *
 * `read-primary-only` entries are the P1.3 conversion list. Shrink this map as
 * they are converted to `hashForLookupCandidates`; never grow it without
 * reading the file.
 */
const REGISTERED: Readonly<Record<string, Registration>> = {
    'src/auth.ts': {
        kind: 'read-primary-only',
        note: 'Two reads in the jwt/session callbacks resolving the persisted User by email.',
    },
    'src/lib/auth/credentials.ts': {
        kind: 'read-primary-only',
        note: 'Three reads: the sign-in lookup plus two failure-recording probes.',
    },
    'src/lib/auth/password-management.ts': {
        kind: 'read-primary-only',
        note: 'Reset/change flows resolve the account by email before issuing a token.',
    },
    'src/lib/auth/email-verification.ts': {
        kind: 'read-primary-only',
        note: 'Resolves the account a verification token belongs to.',
    },
    'src/lib/auth/invite-redemption.ts': {
        kind: 'read-primary-only',
        note: 'Resolves the persisted User.id by email inside the jwt callback.',
    },
    'src/app-layer/usecases/tenant-invites.ts': {
        kind: 'read-primary-only',
        note: 'Matches a pending invite against an IdP-verified sign-in email.',
    },
    'src/app-layer/usecases/org-invites.ts': {
        kind: 'read-primary-only',
        note: 'Org-invite counterpart of the tenant-invite match.',
    },
    'src/app-layer/usecases/scim-users.ts': {
        kind: 'read-primary-only',
        note: 'SCIM matches an existing account by email; also WRITES one on create.',
    },
    'src/app-layer/usecases/sso.ts': {
        kind: 'read-primary-only',
        note: 'Reads User and UserIdentityLink by hash; also writes both on first link.',
    },
    'src/app/api/auth/register/route.ts': {
        kind: 'read-primary-only',
        note: 'The uniqueness pre-check, and the write that follows it. A miss here is the duplicate-User defect.',
    },
    'src/app/api/auth/verify-email/resend/route.ts': {
        kind: 'read-primary-only',
        note: 'Resolves the account to re-send verification to.',
    },
    'src/app/api/staging/seed/route.ts': {
        kind: 'read-primary-only',
        note: 'Non-production seed route (403s in prod); upsert by hash. Lowest priority to convert.',
    },
    'src/app-layer/usecases/tenant-lifecycle.ts': {
        kind: 'local-then-used',
        note: 'Line 63 assigns a local `emailHash` used by the owner-bootstrap upsert — read the file.',
    },
    'src/app-layer/usecases/org-members.ts': {
        kind: 'local-then-used',
        note: 'Line 279 assigns a local `emailHash`; same shape as tenant-lifecycle.',
    },
};

/** Mask comments so a site named only in prose does not register as code. */
function codeOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Does this source CALL `hashForLookup` (not merely import or mention it)? */
export function callsHashForLookup(source: string): boolean {
    return /\bhashForLookup\s*\(/.test(codeOf(source));
}

const FILES = collectSourceFiles({
    roots: ['src'],
    // High enough that a broken selector fails rather than reporting a tidy
    // zero; the real figure is in the thousands.
    floor: 500,
}).map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'));

const CALLERS = FILES.filter(
    (rel) => !MECHANISM_FILES.has(rel) && callsHashForLookup(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
);

describe('every direct hashForLookup call site is registered', () => {
    it('reports the population, so a zero would be visible', () => {
        expect(FILES.length).toBeGreaterThan(500);
        // The detector must find the sites that demonstrably exist. A zero here
        // means the collector or the pattern broke, not that the repo is clean.
        expect(CALLERS.length).toBeGreaterThan(10);
    });

    it('no unregistered caller', () => {
        const unregistered = CALLERS.filter((f) => !(f in REGISTERED));
        if (unregistered.length > 0) {
            throw new Error(
                `${unregistered.length} file(s) call hashForLookup and are not registered in ` +
                    `tests/guards/lookup-hash-call-sites-registered.test.ts:\n  ` +
                    unregistered.join('\n  ') +
                    `\n\nClassify each one. A READ (\`where: { emailHash: … }\`) gets the PRIMARY ` +
                    `hash only and MISSES rows still hashed under LOOKUP_HMAC_KEY_PREVIOUS — use ` +
                    `hashForLookupCandidates, or register it as a known gap. A WRITE is correct ` +
                    `as-is and should say so.`,
            );
        }
    });

    it('no stale registration — every entry names a file that still calls it', () => {
        const stale = Object.keys(REGISTERED).filter((f) => !CALLERS.includes(f));
        expect(stale).toEqual([]);
    });

    it('every registration carries a real note', () => {
        for (const [file, reg] of Object.entries(REGISTERED)) {
            expect(reg.note.length).toBeGreaterThan(25);
            expect(['read-primary-only', 'write', 'local-then-used']).toContain(reg.kind);
            expect(file.startsWith('src/')).toBe(true);
        }
    });

    it('the conversion list is non-empty, and shrinking it is the P1.3 work', () => {
        // A ratchet in the honest direction: when a site is converted to
        // candidates its entry leaves, and this number goes down. If it ever
        // reaches zero, a lookup-key rotation is readable end to end and this
        // assertion is what should be deleted — deliberately, not by accident.
        const toConvert = Object.values(REGISTERED).filter((r) => r.kind === 'read-primary-only');
        expect(toConvert.length).toBeGreaterThan(0);
        expect(toConvert.length).toBeLessThanOrEqual(12);
    });
});

describe('the detector has teeth', () => {
    it('sees a call', () => {
        expect(callsHashForLookup("const h = hashForLookup(email);")).toBe(true);
        expect(callsHashForLookup("where: { emailHash: hashForLookup(x) }")).toBe(true);
    });

    it('is not satisfied by an import or a mention in prose', () => {
        // The failure this prevents: a file that imports the symbol, has its
        // call deleted, and still registers — or the reverse, a file named in a
        // docblock counting as a call site it is not.
        expect(callsHashForLookup("import { hashForLookup } from '@/lib/security/encryption';")).toBe(false);
        expect(callsHashForLookup("// hashForLookup(email) would be wrong here")).toBe(false);
        expect(callsHashForLookup("/* uses hashForLookup(x) internally */")).toBe(false);
    });

    it('a CONVERTED site is no longer a call site — which is how the list shrinks', () => {
        // `hashForLookupCandidates(` does NOT match `hashForLookup\s*\(`: the
        // next character is `C`, not whitespace or a paren. That is the wanted
        // behaviour and it is pinned because the distinction decides whether a
        // conversion shrinks the registry, and either mistake is silent — a
        // conversion that never leaves the list, or an unconverted site that
        // slips out of it.
        //
        // (I first wrote this file asserting the opposite two lines apart, and
        // the pair contradicted each other. The regex was right; one assertion
        // was a guess about it.)
        expect(callsHashForLookup('hashForLookupCandidates(email)')).toBe(false);

        // A file that converts its READS and keeps a WRITE still matches, so it
        // stays registered until both are accounted for.
        expect(
            callsHashForLookup(
                'const found = hashForLookupCandidates(email);\n' +
                    'await tx.user.create({ data: { emailHash: hashForLookup(email) } });',
            ),
        ).toBe(true);
    });
});
