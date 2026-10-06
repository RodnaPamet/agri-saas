/**
 * Data Protection — Field-Level Encryption
 *
 * AES-256-GCM authenticated encryption with versioned payload format.
 * Used for PII fields (emails, names) at the application layer.
 *
 * Payload format: "v1:" + base64(iv ∥ ciphertext ∥ authTag)
 *   - iv:        12 bytes (96-bit, GCM recommended)
 *   - ciphertext: variable length
 *   - authTag:   16 bytes (128-bit)
 *
 * Key derivation: HKDF-SHA256. Field encryption derives from
 * DATA_ENCRYPTION_KEY; the lookup hash derives from LOOKUP_HMAC_KEY (P1.1),
 * which BOOTSTRAPS to DATA_ENCRYPTION_KEY's material when unset so no existing
 * hash changes. Each purpose — and, for lookups, each identifier KIND — gets a
 * distinct derived key. The separation is what makes the master KEK rotatable:
 * see `isLookupKeyPinned`, and the rotation banner in CLAUDE.md.
 *
 * SECURITY NOTES:
 * - Never log plaintext PII after decryption.
 * - Never reuse IVs (crypto.randomBytes ensures this).
 * - The version prefix ("v1:") enables future algorithm rotation.
 * - HMAC-SHA256 lookup hashes are deterministic by design — they enable
 *   WHERE clause lookups without decrypting every row.
 */
import crypto from 'crypto';
import { logger } from '@/lib/observability/logger';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from './encryption-constants';

// ─── Constants ──────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;        // 96-bit IV (GCM recommendation)
const AUTH_TAG_LENGTH = 16;  // 128-bit auth tag
const KEY_LENGTH = 32;       // AES-256

/**
 * Envelope versions.
 *
 *   v1 — ciphertext under the **global KEK** (HKDF-derived from
 *        DATA_ENCRYPTION_KEY). Produced by `encryptField()` — the
 *        Epic B.1 baseline.
 *
 *   v2 — ciphertext under a **per-tenant DEK** (Epic B.2). Produced
 *        by `encryptWithKey(dek, plaintext)` and consumed by
 *        `decryptWithKey(dek, ciphertext)`. The middleware emits v2
 *        when a tenant context is available on the request and
 *        falls back to v1 otherwise, so a gradual rollout works
 *        without any big-bang re-encrypt.
 */
const VERSION_PREFIX_V1 = 'v1:';
const VERSION_PREFIX_V2 = 'v2:';
// Kept for backwards compatibility with callers that import the
// private constant (internal tests). The public behaviour is unchanged.
const VERSION_PREFIX = VERSION_PREFIX_V1;

// HKDF info strings — distinct per purpose to ensure key separation
const ENCRYPT_INFO = 'inflect-data-encryption';
const HMAC_INFO = 'inflect-data-lookup-hash';

// ─── P1.1 — identifier kinds for the lookup hash ─────────────────────
//
// A lookup hash is derived per IDENTIFIER KIND, so a hash of an email and a
// hash of some future phone number cannot be the same bytes. Without that
// separation one deterministic value correlates a person across columns, and a
// hash leaked from one table is a working lookup key against another.
//
// `email` is GRANDFATHERED onto the original `HMAC_INFO` string, and it has to
// be. Every `User.emailHash` and `UserIdentityLink.emailAtLinkTimeHash` row in
// the database was computed with it, and a hash has no authentication failure
// to signal a wrong key — the lookup simply MISSES. Giving `email` a tidy new
// info string would therefore not error: sign-in would report no such user,
// password reset and invite redemption would fail to find existing accounts,
// and registration would SUCCEED and create a duplicate, because its
// uniqueness check is the same hash that now misses. Silent corruption, not an
// outage. So the inconsistency below is load-bearing: the only kind that may
// keep this info string is the one that already shipped under it.
//
// A NEW kind gets its own string and is free to be tidy. A rename of an
// existing one is a REHASH, not an edit.
export type LookupKind = 'email' | 'eik';

const LOOKUP_INFO: Record<LookupKind, string> = {
    email: HMAC_INFO,
    // P3.4 — the blind index on `FarmIdentityClaim.eikHash`. A new kind, so
    // it takes a tidy string of its own per the paragraph above.
    //
    // The separation earns its keep twice here. An ЕИК is a 9- or 13-digit
    // number, so the whole keyspace is enumerable by brute force in minutes
    // given the key — which means the index is only ever as strong as
    // `LOOKUP_HMAC_KEY`, and must never be derivable from a hash leaked out
    // of another column. And unlike an email, an ЕИК is PUBLIC: it is in the
    // Търговски регистър. The index is not hiding the identifier, it is
    // keeping this table from being a membership oracle over a public list.
    // `agrent-`, not `inflect-` like its sibling above, and the inconsistency
    // is correct rather than careless. `tests/guards/no-legacy-brand.test.ts`
    // permits the legacy-brand HKDF info strings under one reasoned survivor
    // category — "renaming breaks decryption of all existing ciphertext" —
    // which is exactly why `email` keeps its string and exactly why this one
    // must not borrow it: nothing is stored under the `eik` kind yet, so there
    // is no ciphertext to break and no licence to add a legacy reference. The
    // guard caught the first version of this line, which read
    // `inflect-eik-lookup-hash`.
    eik: 'agrent-eik-lookup-hash',
};

/** Every kind, for tests and sweeps that must cover the whole surface. */
export const LOOKUP_KINDS = Object.keys(LOOKUP_INFO) as LookupKind[];

// ─── Key Management ─────────────────────────────────────────────────

let _cachedEncryptKey: Buffer | null = null;
let _cachedHmacKey: Buffer | null = null;
let _lastKeySource: string | null = null;

/**
 * Gets the raw encryption key material from environment.
 * In production, DATA_ENCRYPTION_KEY is required.
 * In development/test, falls back to a deterministic dev key (logs a warning).
 */
function getRawKeyMaterial(): string {
    const key = process.env.DATA_ENCRYPTION_KEY;
    if (key && key.length >= 32) {
        return key;
    }

    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv === 'production') {
        throw new Error(
            'DATA_ENCRYPTION_KEY is required in production and must be at least 32 characters. ' +
            'Generate one with: openssl rand -base64 48'
        );
    }

    // Dev/test fallback — deterministic so tests are reproducible.
    // GAP-03 — the value is shared from `encryption-constants.ts` so
    // env validation + the startup hook can reject this exact string
    // when NODE_ENV=production.
    if (nodeEnv !== 'test') {
        logger.warn('Using development fallback encryption key', { component: 'encryption' });
    }
    return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

/**
 * Derives a 256-bit key via HKDF-SHA256 for the given purpose.
 */
function deriveKey(rawMaterial: string, info: string): Buffer {
    const salt = Buffer.from('inflect-data-protection-salt-v1', 'utf8');
    const ikm = Buffer.from(rawMaterial, 'utf8');
    const infoBuffer = Buffer.from(info, 'utf8');

    // HKDF-Extract
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    // HKDF-Expand (single block = 32 bytes, sufficient for AES-256)
    const derived = crypto.createHmac('sha256', prk)
        .update(Buffer.concat([infoBuffer, Buffer.from([1])]))
        .digest();

    return derived; // 32 bytes = 256 bits
}

/**
 * Gets the encryption key, caching it for performance.
 * Cache is invalidated if the underlying key material changes.
 */
function getEncryptionKey(): Buffer {
    const raw = getRawKeyMaterial();
    if (_cachedEncryptKey && _lastKeySource === raw) {
        return _cachedEncryptKey;
    }
    _cachedEncryptKey = deriveKey(raw, ENCRYPT_INFO);
    _cachedHmacKey = deriveKey(raw, HMAC_INFO);
    _lastKeySource = raw;
    return _cachedEncryptKey;
}

// ─── Epic B.3 — previous-KEK for rotation ────────────────────────────
//
// During a master-key rotation, the operator sets
// `DATA_ENCRYPTION_KEY_PREVIOUS` to the outgoing key material alongside
// the new primary `DATA_ENCRYPTION_KEY`. Writes always use the new
// primary; reads try the new primary first and fall back to the
// previous on an AES-GCM auth failure. The rotation job
// (`src/app-layer/jobs/key-rotation.ts`) walks every v1 ciphertext and
// re-encrypts it under the new primary, eventually making the previous
// key retirable.
//
// Cached separately from the primary so a rotation-complete state
// (primary alone, previous unset) naturally evicts the old key from
// memory on next access.

let _cachedPreviousEncryptKey: Buffer | null = null;
// Three states matter, distinguished intentionally:
//   undefined — never checked; first `getPreviousEncryptionKey` call
//               does the env read.
//   null      — checked + no previous key configured (env var unset
//               or too short). Subsequent calls short-circuit
//               without re-reading the env.
//   string    — checked + previous key present; value is the raw
//               env string so the cache invalidates correctly when
//               the operator swaps `DATA_ENCRYPTION_KEY_PREVIOUS`.
let _lastPreviousKeySource: string | null | undefined = undefined;

function getPreviousRawKey(): string | null {
    const key = process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    if (!key || key.length < 32) return null;
    return key;
}

/**
 * The previous-generation encryption key, if rotation is in flight.
 * Returns null when no previous key is configured — the `decryptField`
 * fallback branch is skipped and decrypt behaves exactly as in B.1.
 */
function getPreviousEncryptionKey(): Buffer | null {
    const raw = getPreviousRawKey();
    if (raw === null) {
        // Rotation either hasn't started or just finished — clear the
        // cached key so the next rotation generation starts from a
        // clean slate.
        _cachedPreviousEncryptKey = null;
        _lastPreviousKeySource = null;
        return null;
    }
    if (_cachedPreviousEncryptKey && _lastPreviousKeySource === raw) {
        return _cachedPreviousEncryptKey;
    }
    _cachedPreviousEncryptKey = deriveKey(raw, ENCRYPT_INFO);
    _lastPreviousKeySource = raw;
    return _cachedPreviousEncryptKey;
}

// ─── P1.1 — the lookup key is INDEPENDENT of the master KEK ──────────
//
// Until P1.1 the lookup HMAC key was HKDF-derived from DATA_ENCRYPTION_KEY, so
// rotating the KEK moved every `emailHash` in the database and nothing
// rehashed them. The rotation job re-encrypts `v1:` ciphertexts and re-wraps
// per-tenant DEKs; it contains zero references to this path. That made the
// master KEK effectively UN-ROTATABLE — see the banner in CLAUDE.md.
//
// `LOOKUP_HMAC_KEY` breaks the coupling. It BOOTSTRAPS to the KEK's material
// when unset, so this change rehashes nothing and every existing row keeps
// resolving; pinning it explicitly is what makes a KEK rotation safe, because
// the pinned material then stays behind while DATA_ENCRYPTION_KEY moves.
//
// **Shipping this code does not by itself make the KEK rotatable.** While the
// key is bootstrapped it still tracks the KEK, so the hazard is unchanged and
// only LOOKS fixed. `isLookupKeyPinned()` exists so that distinction is
// observable rather than inferred — `/api/readyz` reports it.

/** Cache shape: the material it was derived from, plus one key per kind. */
interface LookupKeyCache {
    material: string;
    keys: Partial<Record<LookupKind, Buffer>>;
}
let _lookupKeyCache: LookupKeyCache | null = null;
let _lookupPreviousKeyCache: LookupKeyCache | null = null;

/**
 * Is the lookup key pinned to its own material, or bootstrapped off the KEK?
 *
 * The honest answer to "is the master KEK rotatable yet". Read from the
 * environment per call, never captured at module load, so an operator setting
 * the variable and restarting gets a truthful answer from the new process.
 */
export function isLookupKeyPinned(): boolean {
    const pinned = process.env.LOOKUP_HMAC_KEY;
    return typeof pinned === 'string' && pinned.length >= 32;
}

/**
 * Material for the lookup hash: the pinned key, else the KEK's material.
 *
 * The length floor matches `getRawKeyMaterial`'s. A SHORT value is treated as
 * absent rather than as an error, deliberately — a half-set variable must fall
 * back to the bootstrap, because the alternative is that every lookup in the
 * product starts missing on a typo.
 */
function getLookupKeyMaterial(): string {
    const pinned = process.env.LOOKUP_HMAC_KEY;
    if (pinned && pinned.length >= 32) return pinned;
    return getRawKeyMaterial();
}

/**
 * The outgoing lookup material during a lookup-key rotation, or null.
 *
 * Deliberately NOT falling back to `DATA_ENCRYPTION_KEY_PREVIOUS`: the two
 * rotations are now independent events, and conflating them would make a KEK
 * rotation silently start producing a second set of candidate hashes.
 */
function getPreviousLookupKeyMaterial(): string | null {
    const previous = process.env.LOOKUP_HMAC_KEY_PREVIOUS;
    if (!previous || previous.length < 32) return null;
    return previous;
}

/** HKDF the per-kind lookup key, caching per (material, kind). */
function lookupKeyFor(kind: LookupKind, material: string, previous: boolean): Buffer {
    const slot = previous ? _lookupPreviousKeyCache : _lookupKeyCache;
    if (slot && slot.material === material) {
        const hit = slot.keys[kind];
        if (hit) return hit;
        const derived = deriveKey(material, LOOKUP_INFO[kind]);
        slot.keys[kind] = derived;
        return derived;
    }
    const derived = deriveKey(material, LOOKUP_INFO[kind]);
    const fresh: LookupKeyCache = { material, keys: { [kind]: derived } };
    if (previous) _lookupPreviousKeyCache = fresh;
    else _lookupKeyCache = fresh;
    return derived;
}

/**
 * Gets the HMAC key for deterministic lookup hashes.
 *
 * `_cachedHmacKey` is no longer consulted: it is keyed on the KEK's material,
 * which is exactly the coupling this removes. The constant is still populated
 * by `getEncryptionKey()` and still read by nothing else, left in place so this
 * diff does not also reshape the encryption-key cache.
 */
function getHmacKey(kind: LookupKind = 'email'): Buffer {
    return lookupKeyFor(kind, getLookupKeyMaterial(), false);
}

/** The outgoing lookup key for `kind`, or null when no rotation is in flight. */
function getPreviousHmacKey(kind: LookupKind = 'email'): Buffer | null {
    const material = getPreviousLookupKeyMaterial();
    if (material === null) {
        // Rotation either has not started or has finished — drop the cache so
        // the next generation starts clean, mirroring the KEK's behaviour.
        _lookupPreviousKeyCache = null;
        return null;
    }
    return lookupKeyFor(kind, material, true);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt (can be empty, but not null/undefined)
 * @returns Versioned ciphertext: "v1:base64(iv ∥ ciphertext ∥ tag)"
 *
 * @example
 * const encrypted = encryptField('user@example.com');
 * // "v1:dGVzdC..." (opaque, variable length)
 */
export function encryptField(plaintext: string): string {
    if (plaintext === null || plaintext === undefined) {
        throw new Error('encryptField: plaintext must not be null or undefined');
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // iv (12) + ciphertext (variable) + tag (16)
    const combined = Buffer.concat([iv, encrypted, tag]);
    return VERSION_PREFIX + combined.toString('base64');
}

/**
 * Decrypts a v1 ciphertext blob (iv ∥ ct ∥ tag) with the given key.
 * The version prefix has already been stripped by the caller.
 * Throws on AES-GCM auth failure or structural corruption.
 */
function decryptV1Payload(key: Buffer, payload: string): string {
    const combined = Buffer.from(payload, 'base64');
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('decryptField: ciphertext too short (truncated?)');
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(
        IV_LENGTH,
        combined.length - AUTH_TAG_LENGTH,
    );
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}

/**
 * Decrypts an encrypted field back to plaintext.
 *
 * Epic B.3 dual-KEK behaviour: tries the primary KEK first. On
 * AES-GCM auth failure, if `DATA_ENCRYPTION_KEY_PREVIOUS` is
 * configured, retries with the previous KEK. This lets in-flight
 * rotation read ciphertext written under either key without
 * downtime. The original primary-key error is re-thrown if both
 * attempts fail, so corruption/tamper cases still surface clearly.
 *
 * @param ciphertext - Versioned ciphertext from encryptField()
 * @returns Decrypted plaintext string
 * @throws Error if ciphertext is tampered, truncated, uses unknown
 *         version, OR neither the primary nor the previous KEK can
 *         decrypt it.
 *
 * @example
 * const email = decryptField(record.emailEncrypted);
 */
export function decryptField(ciphertext: string): string {
    if (!ciphertext || !ciphertext.startsWith(VERSION_PREFIX)) {
        throw new Error(
            'decryptField: invalid ciphertext format. Expected version prefix "v1:"'
        );
    }

    const payload = ciphertext.slice(VERSION_PREFIX.length);

    // Primary KEK first. If the auth tag matches, we're done —
    // overwhelmingly the common case.
    try {
        return decryptV1Payload(getEncryptionKey(), payload);
    } catch (primaryErr) {
        // Fall back to previous KEK during rotation. A missing
        // previous key means we're not in rotation; rethrow the
        // primary failure unchanged so the caller sees "tampered /
        // corrupt / key mismatch" with the same shape as before.
        const previous = getPreviousEncryptionKey();
        if (!previous) throw primaryErr;
        try {
            return decryptV1Payload(previous, payload);
        } catch {
            // Both keys rejected. Surface the primary error (the
            // caller's mental model is "my current key doesn't fit");
            // ops sees both failures via structured logs upstream.
            throw primaryErr;
        }
    }
}

/**
 * Is this `v1:` ciphertext readable under the CURRENT primary KEK alone?
 *
 * ── why this has to exist ──
 *
 * `encryptField` always emits a `v1:` envelope, so RE-ENCRYPTING a v1 value
 * under a new KEK produces another v1 value. The envelope version therefore
 * cannot distinguish a row that has been migrated from one that has not, and
 * `WHERE "col" LIKE 'v1:%'` selects both. `key-rotation.ts`'s docblock claims
 * "rows already processed in a prior run are skipped by the SELECT" — that is
 * false, and it is why "remove `DATA_ENCRYPTION_KEY_PREVIOUS` once every tenant
 * reports zero v1 rows" was not a measurable instruction: the count it names
 * never reaches zero.
 *
 * `decryptField` cannot answer it either. It tries the primary, falls back to
 * the previous, and returns the plaintext without saying which key worked — by
 * design, because every other caller only wants the value.
 *
 * So the predicate is spelled out here: a successful decrypt under the PRIMARY
 * key means the row is already on the new key. That makes rotation progress
 * observable, and `_PREVIOUS` safely retirable, for the first time.
 *
 * ── what `false` means ──
 *
 * Either "needs the previous key" or "corrupt". Those are different problems
 * and this cannot tell them apart; a caller that goes on to decrypt will find
 * out, because a corrupt value fails under both keys. Callers that only need
 * "is there work left" may treat them alike — both need attention.
 *
 * THROWS on a non-`v1:` input rather than returning false. A `v2:` ciphertext
 * is wrapped under a per-tenant DEK and the question is not meaningful for it;
 * answering `false` would tell a sweep to migrate something it must not touch.
 */
export function isV1UnderPrimaryKey(ciphertext: string): boolean {
    if (!ciphertext || !ciphertext.startsWith(VERSION_PREFIX_V1)) {
        throw new Error(
            'isV1UnderPrimaryKey: expected a v1: ciphertext. A v2: value is ' +
                'wrapped under a per-tenant DEK and is not a master-KEK question.',
        );
    }
    try {
        decryptV1Payload(getEncryptionKey(), ciphertext.slice(VERSION_PREFIX_V1.length));
        return true;
    } catch {
        return false;
    }
}

/**
 * Is a master-KEK rotation currently in flight?
 *
 * True exactly when `DATA_ENCRYPTION_KEY_PREVIOUS` is configured and usable.
 * The global sweep reports it, because a sweep run with NO previous key
 * configured cannot migrate anything off an old key — it re-encrypts values
 * under the key they already carry, and would report a rewritten count that
 * reads like progress.
 */
export function kekRotationInFlight(): boolean {
    return getPreviousEncryptionKey() !== null;
}

/**
 * Produces a deterministic HMAC-SHA256 hash for indexed lookups.
 *
 * Use this to populate `<field>Hash` columns so you can do:
 *   WHERE emailHash = hashForLookup('user@example.com')
 * without decrypting every row.
 *
 * The input is normalised (lowercased, trimmed) before hashing to ensure
 * consistent lookups regardless of casing.
 *
 * @param value - The plaintext value to hash
 * @returns Hex-encoded HMAC-SHA256 hash (64 characters)
 *
 * @example
 * const hash = hashForLookup('User@Example.com');
 * // Same as hashForLookup('user@example.com')
 */
/**
 * ⚠️ THIS FUNCTION IS WHY `DATA_ENCRYPTION_KEY` CANNOT BE ROTATED YET.
 *
 * The HMAC key comes from the CURRENT master KEK and nothing else. Unlike
 * `decryptField`, there is no previous-key fallback here and there cannot
 * usefully be one: a hash has no auth failure to trigger a retry, so a key change
 * does not error — the lookup just misses.
 *
 * And nothing rehashes. `src/app-layer/jobs/key-rotation.ts` re-wraps the tenant
 * DEK and re-encrypts `v1:` ciphertexts; it contains zero references to this
 * function or to `emailHash` (verified 2026-10-01).
 *
 * So after a master-KEK rotation every stored `emailHash` is unreachable, and the
 * worst consequence is not that sign-in fails — it is that REGISTRATION SUCCEEDS
 * and writes a duplicate `User`, because its uniqueness check is this same hash.
 * Silent corruption rather than an outage.
 *
 * P1.1 moves this onto a separate `LOOKUP_HMAC_KEY` (+ `_PREVIOUS`), bootstrapped
 * to today's derived bytes so no existing hash changes. See the rotation banner in
 * CLAUDE.md before touching either key.
 */
export function hashForLookup(value: string, kind: LookupKind = 'email'): string {
    if (value === null || value === undefined) {
        throw new Error('hashForLookup: value must not be null or undefined');
    }

    const normalised = value.toLowerCase().trim();
    const key = getHmacKey(kind);
    return crypto.createHmac('sha256', key)
        .update(normalised, 'utf8')
        .digest('hex');
}

/**
 * Every hash `value` could currently be stored under — primary first.
 *
 * ── why a lookup hash needs this and a ciphertext does not ──
 *
 * `decryptField` can TRY the previous key and know whether it worked, because
 * AES-GCM authenticates: a wrong key raises. A hash has no such signal. Under
 * the wrong key `hashForLookup` returns a perfectly well-formed hex string that
 * simply matches no row, so a read cannot detect the miss and retry — the
 * caller just sees "no such user". The only way to express "either key" is to
 * widen the QUERY, which is why this returns a list and why
 * `pii-middleware` emits `{ in: [...] }` during a rotation.
 *
 * One element in the steady state, so the common path is unchanged: a single
 * candidate keeps `findUnique` a `findUnique`.
 */
export function hashForLookupCandidates(value: string, kind: LookupKind = 'email'): string[] {
    const primary = hashForLookup(value, kind);
    const previousKey = getPreviousHmacKey(kind);
    if (!previousKey) return [primary];

    const normalised = value.toLowerCase().trim();
    const previous = crypto.createHmac('sha256', previousKey)
        .update(normalised, 'utf8')
        .digest('hex');
    // Identical material in both variables is an operator mistake rather than
    // an error, and collapsing it keeps a pointless `{ in: [x, x] }` — and the
    // findUnique→findFirst downgrade that comes with it — out of every query.
    return previous === primary ? [primary] : [primary, previous];
}

/**
 * Checks whether a string looks like an encrypted field (has a
 * recognised version prefix — v1 or v2).
 *
 * Accepts both envelopes so idempotency gates and manifest
 * traversal don't need to know which key model produced the
 * ciphertext.
 */
export function isEncryptedValue(value: string | null | undefined): boolean {
    if (typeof value !== 'string') return false;
    return (
        value.startsWith(VERSION_PREFIX_V1) ||
        value.startsWith(VERSION_PREFIX_V2)
    );
}

/**
 * Return the envelope version for a ciphertext, or null if the input
 * is not a recognised encrypted value. The encryption middleware
 * dispatches on this to route each ciphertext to the right key.
 */
export function getCiphertextVersion(
    value: string | null | undefined,
): 'v1' | 'v2' | null {
    if (typeof value !== 'string') return null;
    if (value.startsWith(VERSION_PREFIX_V1)) return 'v1';
    if (value.startsWith(VERSION_PREFIX_V2)) return 'v2';
    return null;
}

// ─── Per-tenant (v2) primitives ──────────────────────────────────────
//
// Epic B.2 — encrypt/decrypt with an explicit key (the tenant DEK).
// These mirror `encryptField` / `decryptField` but take the key as an
// argument instead of deriving it from the global master material.
// Same AES-256-GCM, same IV length, same tag length — only the key
// and envelope prefix change.
//
// **Never** pass the global KEK through these functions. Their
// version prefix declares "tenant DEK"; mixing would make rotation
// and key-purpose separation meaningless. The middleware is the
// single call site that picks the right primitive based on context.

/**
 * Validate that a buffer is usable as an AES-256 key. 32 bytes
 * exactly, not empty. Centralised so callers can't slip a shorter
 * key past the type system.
 */
function assertAesKey(key: Buffer, where: string): void {
    if (!Buffer.isBuffer(key)) {
        throw new Error(`${where}: key must be a Buffer`);
    }
    if (key.length !== KEY_LENGTH) {
        throw new Error(
            `${where}: key must be exactly ${KEY_LENGTH} bytes (got ${key.length})`,
        );
    }
}

/**
 * Encrypt a plaintext using the provided AES-256 key (the caller's
 * tenant DEK). Returns a `v2:` envelope — the middleware and
 * `getCiphertextVersion()` dispatch on this prefix to pick the right
 * key path on decryption.
 *
 * Same AES-256-GCM + fresh random 96-bit IV + 128-bit auth tag as
 * `encryptField`. Do NOT reuse keys across tenants; the per-tenant
 * isolation guarantee is that each tenant's ciphertexts are only
 * decryptable with that tenant's DEK.
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
    assertAesKey(key, 'encryptWithKey');
    if (plaintext === null || plaintext === undefined) {
        throw new Error(
            'encryptWithKey: plaintext must not be null or undefined',
        );
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, encrypted, tag]);
    return VERSION_PREFIX_V2 + combined.toString('base64');
}

/**
 * Decrypt a `v2:` envelope with the provided AES-256 key. Rejects
 * `v1:` envelopes with a clear error message — the global-KEK path
 * is `decryptField`, not this function. Splitting the API prevents
 * a caller from accidentally trying tenant DEKs against global-KEK
 * ciphertexts and silently getting a GCM auth failure for the wrong
 * reason.
 */
export function decryptWithKey(key: Buffer, ciphertext: string): string {
    assertAesKey(key, 'decryptWithKey');
    if (!ciphertext || !ciphertext.startsWith(VERSION_PREFIX_V2)) {
        throw new Error(
            'decryptWithKey: expected a v2: ciphertext. v1: ciphertexts ' +
                'must be decrypted with `decryptField` (global KEK).',
        );
    }
    const payload = ciphertext.slice(VERSION_PREFIX_V2.length);
    const combined = Buffer.from(payload, 'base64');
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('decryptWithKey: ciphertext too short (truncated?)');
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(
        IV_LENGTH,
        combined.length - AUTH_TAG_LENGTH,
    );
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
}

/**
 * Decrypt a `v2:` envelope, falling back to a previous tenant DEK on
 * AES-GCM auth failure. Mirrors the dual-KEK behaviour of
 * `decryptField` (which falls back to `DATA_ENCRYPTION_KEY_PREVIOUS`
 * for v1) — but at the per-tenant DEK granularity needed by
 * `rotateTenantDek`.
 *
 * Behaviour:
 *   - Try `primary` first. Auth-tag match → done.
 *   - On any failure AND `previous` is non-null → retry with `previous`.
 *   - If both keys reject (or `previous` is null) → re-throw the
 *     PRIMARY error so the caller sees "current key doesn't fit", not
 *     "previous key didn't either" (which would be misleading after
 *     the rotation completes and the previous slot is cleared).
 *
 * The middleware uses this on every v2 read while
 * `Tenant.previousEncryptedDek` is non-null. The re-encrypt job that
 * walks v2 ciphertexts under the previous DEK and rewrites them under
 * the new primary calls `decryptWithKey(previous, ...)` directly —
 * deliberate, because if a row is supposed to be under the previous
 * DEK and the primary somehow decrypts it, that's a state we want to
 * surface as a hard error in the job, not silently accept.
 */
export function decryptWithKeyOrPrevious(
    primary: Buffer,
    previous: Buffer | null,
    ciphertext: string,
): string {
    try {
        return decryptWithKey(primary, ciphertext);
    } catch (primaryErr) {
        if (!previous) throw primaryErr;
        try {
            return decryptWithKey(previous, ciphertext);
        } catch {
            throw primaryErr;
        }
    }
}

/**
 * Clears the cached keys. Useful in tests to simulate key rotation.
 * @internal
 */
export function _resetKeyCache(): void {
    _cachedEncryptKey = null;
    _cachedHmacKey = null;
    _lastKeySource = null;
    _cachedPreviousEncryptKey = null;
    _lastPreviousKeySource = undefined;
    // P1.1 — the lookup keys cache independently of the KEK, so a test that
    // swapped LOOKUP_HMAC_KEY and called this hook would otherwise keep
    // hashing under the old material and quietly prove nothing.
    _lookupKeyCache = null;
    _lookupPreviousKeyCache = null;
}
