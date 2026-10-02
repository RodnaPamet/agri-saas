/**
 * The sweep's column derivation — the thing the old rotation got wrong.
 *
 * `key-rotation.ts` iterates `ENCRYPTED_FIELDS` and nothing else, so the whole
 * PII manifest (`User`, `UserIdentityLink`, `NotificationOutbox`, `Account`)
 * was invisible to it. Measured on production: it could re-encrypt 0 values
 * while 40 sat in the manifest it had never heard of. A sweep blind to a
 * manifest is the defect, and the only structural defence is deriving the union
 * rather than maintaining a third list.
 *
 * So these assertions are about the DENOMINATOR, not the mechanics: that both
 * manifests are present, that neither can quietly drop out, and that the
 * derivation picks the ciphertext column rather than the plaintext one.
 */
import { sweepableColumns, selectColumns } from '@/app-layer/usecases/global-key-rotation';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { PII_MANAGED_MODELS, _getPiiFieldMap } from '@/lib/security/pii-middleware';
import { isV1UnderPrimaryKey, encryptField, _resetKeyCache } from '@/lib/security/encryption';

export {};

describe('the union covers BOTH manifests', () => {
    const cols = sweepableColumns();
    /** Keyed by what the MANIFEST says — the entry, not its resolution. */
    const byManifestName = new Set(cols.map((c) => `${c.model}.${c.manifestName}`));
    /** Keyed by the PHYSICAL pair that reaches raw SQL. */
    const have = new Set(cols.map((c) => `${c.table}.${c.column}`));

    it('every ENCRYPTED_FIELDS entry is represented', () => {
        const expected: string[] = [];
        for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
            for (const f of fields) expected.push(`${model}.${f}`);
        }
        expect(expected.length).toBeGreaterThan(10);
        expect(expected.filter((e) => !byManifestName.has(e))).toEqual([]);
    });

    it('every PII-manifest ENCRYPTED entry is represented', () => {
        const expected: string[] = [];
        for (const model of PII_MANAGED_MODELS) {
            for (const spec of _getPiiFieldMap(model) ?? []) expected.push(`${model}.${spec.encrypted}`);
        }
        // The population that was invisible to the old sweep.
        expect(expected.length).toBeGreaterThan(4);
        expect(expected.filter((e) => !byManifestName.has(e))).toEqual([]);
    });

    it('resolves a MANIFEST name to its PHYSICAL column — the two conventions', () => {
        // The subtle part, and the thing that made the first version of the
        // sweep throw 42703 mid-run.
        //
        // `ENCRYPTED_FIELDS` holds PRISMA FIELD names:
        //   PromotionLead.requestMessage is @map("message"), named uniquely on
        //   purpose because the Epic B fan-out encrypt path matches field names
        //   FLAT across the manifest and would otherwise have encrypted
        //   Notification.message / ExchangeInquiry.message / InsuranceLead.message.
        const promo = cols.find((c) => c.model === 'PromotionLead');
        expect(promo).toBeDefined();
        expect(promo?.manifestName).toBe('requestMessage');
        expect(promo?.column).toBe('message');

        // `PII_FIELD_MAP.encrypted` holds PHYSICAL column names — `emailEncrypted`
        // IS the @map target of the Prisma field `email`.
        const email = cols.find((c) => c.model === 'User' && c.manifestName === 'emailEncrypted');
        expect(email?.column).toBe('emailEncrypted');

        // Both spellings land on a real column; neither is taken literally.
        expect(have.has('PromotionLead.message')).toBe(true);
        expect(have.has('PromotionLead.requestMessage')).toBe(false);
    });

    it('the PII models the old sweep could never reach are in here BY NAME', () => {
        // Named explicitly, not derived, because this is the regression: a
        // refactor that drops the PII manifest would still satisfy the derived
        // assertion above if the manifest itself were emptied.
        expect(have.has('User.emailEncrypted')).toBe(true);
        expect(have.has('User.nameEncrypted')).toBe(true);
        expect(have.has('Account.accessTokenEncrypted')).toBe(true);
        expect(have.has('Account.refreshTokenEncrypted')).toBe(true);
        expect(have.has('NotificationOutbox.toEmailEncrypted')).toBe(true);
        expect(have.has('UserIdentityLink.emailAtLinkTimeEncrypted')).toBe(true);
    });

    it('both manifests are REPORTED, so a reader can see the union', () => {
        const manifests = new Set(cols.map((c) => c.manifest));
        expect([...manifests].sort()).toEqual(['encrypted-fields', 'pii']);
    });

    it('picks the ciphertext column, never the plaintext one', () => {
        // `User.email` is @map'd onto `emailEncrypted`; `Account.access_token`
        // is a legacy dual-write PLAINTEXT column. Re-encrypting either would
        // be data loss — one is not a real column, the other holds plaintext.
        expect(have.has('User.email')).toBe(false);
        expect(have.has('User.name')).toBe(false);
        expect(have.has('Account.access_token')).toBe(false);
        expect(have.has('NotificationOutbox.toEmail')).toBe(false);
    });

    it('never a HASH column — those derive from LOOKUP_HMAC_KEY, not the KEK', () => {
        // The P1.1 payoff, asserted here so a later "be thorough" change cannot
        // add them: a KEK rotation does not move a lookup hash, and re-writing
        // one under the KEK would break every lookup by email.
        for (const c of cols) expect(c.column).not.toMatch(/Hash$/);
        expect(have.has('User.emailHash')).toBe(false);
        expect(have.has('UserIdentityLink.emailAtLinkTimeHash')).toBe(false);
    });

    it('no duplicate PHYSICAL pair, and a stable (table, column) order', () => {
        // Deduped on the physical pair, not the manifest name: two manifests can
        // name the same column by different spellings, and sweeping it twice
        // would make `remaining` disagree with reality.
        const pairs = cols.map((c) => [c.table, c.column] as const);
        const keys = pairs.map(([t, c]) => `${t}.${c}`);
        expect(new Set(keys).size).toBe(keys.length);

        // Sorted by table then column. Asserted against a freshly-computed
        // expectation rather than a hand-written sort chain — my first version
        // composed two sorts that matched neither the implementation nor each
        // other, and failed for being wrong about itself.
        const expected = [...pairs]
            .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
            .map(([t, c]) => `${t}.${c}`);
        expect(keys).toEqual(expected);
    });

    it('the denominator is non-trivial — a zero would be a broken derivation', () => {
        expect(cols.length).toBeGreaterThan(15);
    });
});

describe('isV1UnderPrimaryKey is the completion predicate', () => {
    const K1 = 'the-first-master-kek-at-least-32-characters'; // pragma: allowlist secret -- test fixture
    const K2 = 'the-second-master-kek-at-least-32-chars!!!!'; // pragma: allowlist secret -- test fixture
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
        _resetKeyCache();
    });

    it('true when the primary key reads it, false when only the previous can', () => {
        process.env.DATA_ENCRYPTION_KEY = K1;
        delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
        _resetKeyCache();
        const underK1 = encryptField('secret-value');
        expect(isV1UnderPrimaryKey(underK1)).toBe(true);

        // Rotate: K2 primary, K1 previous.
        process.env.DATA_ENCRYPTION_KEY = K2;
        process.env.DATA_ENCRYPTION_KEY_PREVIOUS = K1;
        _resetKeyCache();
        // THE POINT: the envelope is still `v1:`, so `LIKE 'v1:%'` cannot tell
        // this row from a migrated one. This predicate can.
        expect(underK1.startsWith('v1:')).toBe(true);
        expect(isV1UnderPrimaryKey(underK1)).toBe(false);

        // And a value written now reads under the primary.
        expect(isV1UnderPrimaryKey(encryptField('fresh'))).toBe(true);
    });

    it('a re-encrypted value is STILL v1 — which is why the old idempotency claim was false', () => {
        process.env.DATA_ENCRYPTION_KEY = K1;
        _resetKeyCache();
        const a = encryptField('x');
        const b = encryptField('x');
        expect(a.startsWith('v1:')).toBe(true);
        expect(b.startsWith('v1:')).toBe(true);
        // Different IVs, same envelope. `WHERE col LIKE 'v1:%'` matches both
        // before and after a rewrite, so it cannot skip processed rows.
        expect(a).not.toBe(b);
    });

    it('THROWS on a v2 ciphertext rather than answering false', () => {
        // Answering `false` would tell a sweep to migrate a DEK-wrapped value
        // it must not touch.
        expect(() => isV1UnderPrimaryKey('v2:AAAA')).toThrow(/v1:/);
        expect(() => isV1UnderPrimaryKey('')).toThrow();
        expect(() => isV1UnderPrimaryKey('not-a-ciphertext')).toThrow();
    });

    it('false for a corrupt v1 value — conflated with "needs previous" by design', () => {
        process.env.DATA_ENCRYPTION_KEY = K1;
        _resetKeyCache();
        expect(isV1UnderPrimaryKey('v1:' + Buffer.from('garbage-bytes-here-padding').toString('base64'))).toBe(false);
    });
});

describe('a filter that matches nothing is REFUSED', () => {
    it('does not select over an empty set', () => {
        // The defect class this repo names most often: an empty selection is a
        // PASS. A filter naming a column that does not exist is a typo, and
        // running it would report success over nothing — with a `remaining: 0`
        // that reads like the rotation finished.
        expect(() => selectColumns([{ model: 'NoSuchModel', column: 'nope' }])).toThrow(
            /matched no column/i,
        );
        expect(() => selectColumns([{ model: 'User', column: 'notAColumn' }])).toThrow(
            /matched no column/i,
        );
    });

    it('accepts EITHER spelling of a real column, and resolves both the same way', () => {
        // `PromotionLead.requestMessage` is the manifest name; `message` is the
        // physical column. A caller should not have to know which manifest an
        // entry came from.
        const byManifest = selectColumns([{ model: 'PromotionLead', column: 'requestMessage' }]);
        const byPhysical = selectColumns([{ model: 'PromotionLead', column: 'message' }]);
        expect(byManifest).toHaveLength(1);
        expect(byPhysical).toHaveLength(1);
        expect(byManifest[0].column).toBe('message');
        expect(byPhysical[0].column).toBe('message');
        expect(byManifest).toEqual(byPhysical);
    });

    it('an absent or empty filter selects EVERYTHING', () => {
        const all = sweepableColumns().length;
        expect(selectColumns()).toHaveLength(all);
        expect(selectColumns([])).toHaveLength(all);
    });

    it('selects exactly what was asked for, not a superset', () => {
        const picked = selectColumns([
            { model: 'User', column: 'emailEncrypted' },
            { model: 'Account', column: 'accessTokenEncrypted' },
        ]);
        expect(picked.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
            'Account.accessTokenEncrypted',
            'User.emailEncrypted',
        ]);
    });
});
