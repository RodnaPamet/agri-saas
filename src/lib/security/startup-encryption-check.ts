/**
 * GAP-03 — Production startup checks for DATA_ENCRYPTION_KEY.
 *
 * Two helpers used by `src/instrumentation.ts`, `scripts/worker.ts`
 * and `scripts/scheduler.ts` to enforce that no production process
 * serves traffic with encryption-at-rest broken or absent. (The
 * scheduler calls only the first — see CLAUDE.md.) Defense-in-depth alongside the schema-level check in
 * `src/env.ts`:
 *
 *   1. `checkProductionEncryptionKey(env)` — synchronous config
 *      validation. Asserts presence + length + not-equal-to the
 *      documented dev fallback. Catches the case where the schema
 *      check is bypassed via `SKIP_ENV_VALIDATION=1` leaking into
 *      the runtime container.
 *
 *   2. `runEncryptionSentinel()` — async functional pre-flight.
 *      Encrypts and decrypts a fixed plaintext, asserts the round-
 *      trip matches.
 *
 *      WHAT IT CAN ACTUALLY CATCH, measured (#674). This docblock used
 *      to claim it catches "a key that's structurally valid (32+
 *      chars, not the fallback) but breaks under HKDF/AES-GCM (e.g. a
 *      binary blob written to env)". No such key exists. `deriveKey`
 *      is HMAC-SHA256 over `Buffer.from(raw, 'utf8')`, and
 *      `Buffer.from` never throws on a JS string — a lone surrogate
 *      becomes U+FFFD. Every input clearing the length floor
 *      round-trips: high bytes, lone surrogates, astral-plane
 *      characters, pure whitespace. Measured in
 *      `tests/unit/security/startup-fail-fast-execution.test.ts`.
 *
 *      Its one reachable failure is a key below the floor, which
 *      check 1 rejects one line earlier at every call site. So the
 *      sentinel's real value is FORWARD-LOOKING: it is the only thing
 *      that would catch a future derivation which CAN throw — a real
 *      `crypto.hkdfSync`, a base64 decode of the key material, a KMS
 *      fetch. Keep it, but do not count it as live defence today.
 *
 * Both return a discriminated union so each hook can uniformly map
 * failure → log + process.exit(1), and tests can assert the LOGIC
 * without spawning child processes that literally exit.
 *
 * That factoring was right, and it left a gap: nothing exercised the
 * half that turns a failed check into a dead process. It does now —
 * `tests/unit/security/startup-fail-fast-execution.test.ts` boots all
 * three surfaces for real and watches them refuse.
 */

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from './encryption-constants';

export type StartupCheckOutcome =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Synchronous config check. Returns ok=true for any non-production
 * environment so dev/test ergonomics are preserved.
 *
 * @param env Caller passes `process.env` (or a synthetic record in
 *            tests) so the function is pure and trivially mockable.
 */
export function checkProductionEncryptionKey(
    env: NodeJS.ProcessEnv,
): StartupCheckOutcome {
    if (env.NODE_ENV !== 'production') return { ok: true };

    const key = env.DATA_ENCRYPTION_KEY;
    if (!key || key.length < 32) {
        return {
            ok: false,
            reason:
                'DATA_ENCRYPTION_KEY is required in production and must be ' +
                'at least 32 characters. Generate with: openssl rand -base64 48',
        };
    }
    if (key === DEV_FALLBACK_DATA_ENCRYPTION_KEY) {
        return {
            ok: false,
            reason:
                'DATA_ENCRYPTION_KEY equals the documented dev fallback. ' +
                'Refusing to boot — generate a real key with: ' +
                'openssl rand -base64 48',
        };
    }
    return { ok: true };
}

/**
 * Functional pre-flight. Imports the encryption module and rounds a
 * fixed plaintext through encrypt → decrypt. Any failure path
 * (HKDF derive throw, AES-GCM auth failure, mismatch) returns
 * ok=false with the underlying error captured in `reason`.
 *
 * Never logs the plaintext or any portion of the key. The reason
 * string is operator-facing — it carries the failure class, never
 * secret material.
 */
export async function runEncryptionSentinel(): Promise<StartupCheckOutcome> {
    const sentinel = 'inflect-startup-sentinel';
    try {
        const { encryptField, decryptField } = await import('./encryption');
        const round = decryptField(encryptField(sentinel));
        if (round !== sentinel) {
            return {
                ok: false,
                reason: 'encryption sentinel: round-trip mismatch',
            };
        }
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            reason:
                'encryption sentinel: ' +
                (err instanceof Error ? err.message : String(err)),
        };
    }
}
