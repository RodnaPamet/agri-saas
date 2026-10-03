/**
 * #1274 — is any `v2:` row encrypted under the WRONG tenant's DEK?
 *
 * READ-ONLY. Issues `SELECT` only, and prints COUNTS and ids — never a
 * decrypted value, never a key, never the raw envelope.
 *
 * ## Why this is self-contained rather than importing the app's modules
 *
 * It has to run where the master KEK lives, which is the production container,
 * and the runtime image ships no `tsx` and no `scripts/` tree (devDependencies
 * are pruned before the runner stage). So it re-implements the derive + decrypt
 * path in ~40 lines and is run with `node -e` / `node <file>` against the
 * container's own env.
 *
 * **A re-implementation that is subtly wrong reports every row as
 * undecryptable, which is indistinguishable from the defect it hunts.** That is
 * why `tests/integration/dek-attribution-detector.test.ts` exists: it runs this
 * exact logic against rows whose correct answer is known — one written normally,
 * one deliberately encrypted under another tenant's DEK — and asserts the
 * detector agrees with the real `getTenantDek` / `decryptWithKey` AND separates
 * the two cases. Do not trust a run of this script that is not backed by that
 * test passing on the same commit.
 *
 * ## What the four outcomes mean
 *
 *   ok            decrypts with its own tenant's DEK — fine
 *   wrong-tenant  decrypts with ANOTHER tenant's DEK — misattributed (#1259)
 *   orphan        `v2:` and no tenant DEK opens it — unreadable; the owning
 *                 DEK may have been rotated since
 *   v1            global-KEK envelope — readable, not this defect
 *
 * Usage (production):
 *   gcloud compute ssh agrent --zone europe-west1-b --command \
 *     "sudo docker compose -f /opt/agrent/docker-compose.vm.yml exec -T app \
 *        node /tmp/audit-dek-attribution.cjs"
 */
const crypto = require('node:crypto');

const SALT = Buffer.from('inflect-data-protection-salt-v1', 'utf8');
const ENCRYPT_INFO = 'inflect-data-encryption';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH_BYTES = 32;

/** The app's HKDF-shaped derivation, reproduced exactly. */
function deriveKey(rawMaterial, info) {
    const prk = crypto.createHmac('sha256', SALT).update(Buffer.from(rawMaterial, 'utf8')).digest();
    return crypto
        .createHmac('sha256', prk)
        .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])]))
        .digest();
}

/** AES-256-GCM over base64(iv ‖ ciphertext ‖ tag). Throws on a key mismatch. */
function gcmDecrypt(key, payloadB64) {
    const combined = Buffer.from(payloadB64, 'base64');
    if (combined.length < IV_LENGTH + TAG_LENGTH) throw new Error('ciphertext too short');
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - TAG_LENGTH);
    const body = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
    const d = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/**
 * The master KEK, derived the way the app derives it.
 *
 * This exists because the mutation sweep caught the alternative: when the
 * `info` string was supplied by the CALLER, `ENCRYPT_INFO` was dead code in
 * this file and mutating it changed nothing the detector's test could see. A
 * wrong info string derives a wrong master key, every DEK unwrap fails, and the
 * production sweep reports every row as an orphan — the defect's own signature.
 * Owning the derivation here puts it inside the tested unit.
 *
 * Mirrors `getRawKeyMaterial()`: the env var is used only when it is at least
 * 32 characters, otherwise the caller's dev fallback.
 */
function masterKeyFromEnv(env, devFallback) {
    const fromEnv = env && env.DATA_ENCRYPTION_KEY;
    const raw = fromEnv && fromEnv.length >= 32 ? fromEnv : devFallback;
    if (!raw) {
        throw new Error(
            'masterKeyFromEnv: DATA_ENCRYPTION_KEY is absent or under 32 chars and no ' +
                'dev fallback was supplied — refusing to derive a key from nothing, because ' +
                'that would report every row as an orphan.',
        );
    }
    return deriveKey(raw, ENCRYPT_INFO);
}

/** Unwrap `Tenant.encryptedDek` (a `v1:` envelope) with the master KEK. */
function unwrapDek(masterKey, wrapped) {
    if (!wrapped || !wrapped.startsWith('v1:')) throw new Error('encryptedDek is not a v1 envelope');
    const dek = Buffer.from(gcmDecrypt(masterKey, wrapped.slice(3)), 'base64');
    if (dek.length !== DEK_LENGTH_BYTES) throw new Error(`DEK length ${dek.length}, expected ${DEK_LENGTH_BYTES}`);
    return dek;
}

/**
 * Classify one ciphertext against the DEK map.
 * Returns { state, owner } — `owner` is the tenant whose DEK opened it.
 */
function classify(ciphertext, ownTenantId, deks) {
    if (!ciphertext) return { state: 'null', owner: null };
    if (ciphertext.startsWith('v1:')) return { state: 'v1', owner: null };
    if (!ciphertext.startsWith('v2:')) return { state: 'plaintext', owner: null };
    const payload = ciphertext.slice(3);
    const own = deks.get(ownTenantId);
    if (own) {
        try { gcmDecrypt(own, payload); return { state: 'ok', owner: ownTenantId }; } catch { /* keep looking */ }
    }
    for (const [tid, key] of deks) {
        if (tid === ownTenantId) continue;
        try { gcmDecrypt(key, payload); return { state: 'wrong-tenant', owner: tid }; } catch { /* next */ }
    }
    return { state: 'orphan', owner: null };
}

/** (model, field) pairs to sweep, derived from the caller rather than hardcoded. */
async function auditPairs(client, masterKey, pairs) {
    const tenants = await client.query('SELECT id, "encryptedDek" FROM "Tenant" WHERE "encryptedDek" IS NOT NULL');
    const deks = new Map();
    let unwrapFailures = 0;
    for (const t of tenants.rows) {
        try { deks.set(t.id, unwrapDek(masterKey, t.encryptedDek)); } catch { unwrapFailures++; }
    }

    const results = [];
    for (const { model, field } of pairs) {
        const tally = { model, field, rows: 0, null: 0, plaintext: 0, v1: 0, ok: 0, 'wrong-tenant': 0, orphan: 0, offenders: [] };
        let rows;
        try {
            rows = await client.query(
                `SELECT id, "tenantId", "${field}" AS v FROM "${model}" WHERE "${field}" IS NOT NULL`,
            );
        } catch (err) {
            results.push({ ...tally, error: String(err.message).slice(0, 90) });
            continue;
        }
        for (const r of rows.rows) {
            tally.rows++;
            const { state, owner } = classify(r.v, r.tenantId, deks);
            tally[state] = (tally[state] ?? 0) + 1;
            // Ids only — never the value.
            if (state === 'wrong-tenant' || state === 'orphan') {
                if (tally.offenders.length < 25) {
                    tally.offenders.push({ id: r.id, ownedBy: r.tenantId, opensWith: owner });
                }
            }
        }
        results.push(tally);
    }
    return { deks: deks.size, unwrapFailures, results };
}

module.exports = { deriveKey, masterKeyFromEnv, gcmDecrypt, unwrapDek, classify, auditPairs };
