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
import { blankNonCode } from '../helpers/blank-non-code';

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
    | 'local-then-used'
    /**
     * Compares a STORED hash against what the current key produces.
     *
     * The one kind where this guard's standing advice — "use
     * `hashForLookupCandidates`" — is not merely unnecessary but WRONG.
     * Candidates include the previous key's hash, so a row still on the old key
     * would match and be judged current; the rehash sweep's `stale` count would
     * read zero from the first pass, and an operator would retire
     * `LOOKUP_HMAC_KEY_PREVIOUS` while rows still depended on it.
     *
     * A site of this kind must therefore use the PRIMARY hash deliberately, and
     * saying so is the whole value of registering it.
     */
    | 'compare-to-current';

interface Registration {
    kind: SiteKind;
    note: string;
}

/**
 * Kinds that are CORRECT on the primary hash alone.
 *
 * A write should use the primary key — that is what a rotation then sweeps
 * forward. A comparison against the current key must use it, because
 * candidates would match a row still on the previous key and report it as
 * current.
 */
const SAFE_KINDS = ['write', 'compare-to-current'] as const;

/**
 * Kinds that MISS rows during a lookup-key rotation.
 *
 * The conversion list. It has reached empty; an entry appearing here again is
 * a regression, which is what the case below asserts.
 */
const UNSAFE_KINDS = ['read-primary-only', 'local-then-used'] as const;

/**
 * Every file in `src/` that calls `hashForLookup` directly, with what it does.
 *
 * `read-primary-only` entries are the P1.3 conversion list. Shrink this map as
 * they are converted to `hashForLookupCandidates`; never grow it without
 * reading the file.
 */
const REGISTERED: Readonly<Record<string, Registration>> = {
    'src/app/api/auth/native/apple/route.ts': {
        kind: 'write',
        note: 'Writes the hash when Sign in with Apple creates a user on first authorisation. Its link READ is on candidates, which matters more here than elsewhere: Apple only sends the email on that first authorisation, so a missed match does not merely create a duplicate row — it creates one the user can never be linked out of, because no later token carries the address again.',
    },
    'src/app-layer/usecases/scim-users.ts': {
        kind: 'write',
        note: 'Writes the hash when SCIM provisions an account. Its MATCH read is on candidates.',
    },
    'src/app-layer/usecases/sso.ts': {
        kind: 'write',
        note: 'Writes emailHash and emailAtLinkTimeHash on first identity link. Both reads are on candidates.',
    },
    'src/app/api/auth/register/start/route.ts': {
        kind: 'write',
        note: 'Registration v2 step 1 (P3.5b): writes emailHash for the new unverified account. Its existence check ahead of it reads candidates, so a rotation window cannot create a duplicate.',
    },
    'src/lib/auth/email-verification-code.ts': {
        kind: 'write',
        note: 'Keys a 6-digit code row on emailHash instead of storing the address, so a dump of that table identifies nobody. Both its reads use candidates; the index is deliberately non-unique because a rotation window can hold a row under each key.',
    },
    'src/app-layer/usecases/tenant-lifecycle.ts': {
        kind: 'write',
        note: 'Owner bootstrap: the candidate read runs first, and this hash keys the upsert that follows it.',
    },
    'src/app-layer/usecases/farm-creation.ts': {
        kind: 'write',
        note:
            "P3.6 farm creation: writes the `eik`-kind blind index onto FarmIdentityClaim. " +
            'Write-only — this file never reads by eikHash, so there is no primary-only read to ' +
            'get wrong. The rotation hazard is real but lands elsewhere: a pre-rotation claim ' +
            'keeps the OLD hash, so the partial unique index cannot relate it to a new one and ' +
            'the guarantee is one VERIFIED claim per ЕИК PER KEY GENERATION. Closing that is ' +
            'the verification path (P3.9), which must read with the full candidate set before ' +
            'promoting and re-hash the row it promotes.',
    },
    'src/app-layer/usecases/org-members.ts': {
        kind: 'write',
        note: 'Org-member placeholder: same find-on-candidates-then-upsert shape as tenant-lifecycle.',
    },
    'src/app/api/staging/seed/route.ts': {
        kind: 'write',
        note: 'Non-production seed (403s in prod); the candidate read precedes the upsert this hash keys.',
    },
    'src/app-layer/usecases/farm-identity-review.ts': {
        kind: 'write',
        note: 'P3.9 staff verification: the candidate read matches a claim hashed under EITHER key, then the promotion REHASHES it under the current one. The rehash is the point — without it the partial unique index on (eikHash) WHERE status = VERIFIED is split across two key generations and stops enforcing one-VERIFIED-claim-per-ЕИК, which is the gap P3.4 left to this path.',
    },
    'src/app-layer/usecases/lookup-rehash.ts': {
        kind: 'compare-to-current',
        note:
            'The P1.3 rehash sweep. Asks "is this stored hash what the current key produces", ' +
            'which is a COMPARISON, not a lookup — so the primary hash is required and ' +
            'candidates would make every stale row read as current and the stop condition ' +
            'unreachable. This is the site that RETIRES the other kinds.',
    },
};

/** Mask comments so a site named only in prose does not register as code. */
function codeOf(source: string): string {
    return blankNonCode(source);
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
        //
        // Recalibrated from `> 10` to the post-conversion truth. Sixteen reads
        // moved to `hashForLookupCandidates`, which does not match the detector,
        // so the caller count fell to the six files that still WRITE the hash.
        // Pinned at the real figure rather than relaxed to a number a broken
        // selector would also satisfy — the whole job of this case is to tell a
        // clean repo apart from a detector that stopped looking.
        expect(CALLERS.length).toBeGreaterThanOrEqual(6);
        // And the two must agree: a caller the registry does not know about is
        // caught below, but a detector finding FEWER files than the registry
        // lists would otherwise read as "nothing left to classify".
        expect(CALLERS.length).toBe(Object.keys(REGISTERED).length);
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

    it('every registration carries a real note and a KNOWN kind', () => {
        for (const [file, reg] of Object.entries(REGISTERED)) {
            expect(reg.note.length).toBeGreaterThan(25);
            // Both lists, not a denylist of the unsafe ones. A kind that is
            // neither listed as safe nor as unsafe fails HERE, which is what
            // forces the next person adding a kind to say which it is — a
            // denylist would admit it silently, and that is the shape of a
            // guard quietly losing its teeth.
            expect([...SAFE_KINDS, ...UNSAFE_KINDS]).toContain(reg.kind);
            expect(file.startsWith('src/')).toBe(true);
        }
    });

    it('the conversion is COMPLETE — no site reads the primary hash alone', () => {
        // This assertion replaces the shrinking ratchet that stood here while
        // the conversion was outstanding ("non-empty, and ≤ 12"). It has
        // reached zero, which was its stated exit condition, so the direction
        // flips: the old form would now FAIL on success, and keeping it would
        // have meant a green suite required a known gap to exist.
        //
        // What it guards from here is the regression. A new read registered as
        // `read-primary-only` or `local-then-used` fails here rather than being
        // quietly absorbed into a list that used to have room for it.
        //
        // This read `r.kind !== 'write'` while WRITE was the only safe kind.
        // #1237 added a second — `compare-to-current`, the rehash sweep, which
        // must use the primary hash and would be BROKEN by candidates — so the
        // test now names the unsafe kinds it is actually about. Spelled as the
        // unsafe set rather than widened to "not one of the safe ones" so the
        // assertion still says what it means.
        const unconverted = Object.entries(REGISTERED).filter(([, r]) =>
            (UNSAFE_KINDS as readonly string[]).includes(r.kind),
        );
        expect(unconverted).toEqual([]);
    });

    it('the write entries are real, not an empty set dressed as completion', () => {
        // The positive control for the assertion above. `[].every(…)` is true
        // and `[].filter(…)` is empty, so an emptied registry would satisfy it
        // while proving nothing. These files genuinely still write the hash.
        const writes = Object.values(REGISTERED).filter((r) => r.kind === 'write');
        expect(writes.length).toBeGreaterThanOrEqual(6);

        // And the rehash sweep is here, which is the one entry that would
        // disappear unnoticed: it is the site that RETIRES the whole problem,
        // so a build where it vanished would look tidier and be worse.
        const compares = Object.values(REGISTERED).filter(
            (r) => r.kind === 'compare-to-current',
        );
        expect(compares.length).toBeGreaterThanOrEqual(1);

        // Every registration accounted for by a SAFE kind — the form the
        // previous `writes.length === total` had while `write` was the only
        // one. An entry of some third, unexamined kind fails here.
        const safe = Object.values(REGISTERED).filter((r) =>
            (SAFE_KINDS as readonly string[]).includes(r.kind),
        );
        expect(safe.length).toBe(Object.keys(REGISTERED).length);
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
