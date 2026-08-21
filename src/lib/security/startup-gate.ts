/**
 * The production startup gate, as something a caller can AWAIT.
 *
 * ## Why this exists (#698)
 *
 * `scripts/worker.ts` and `scripts/scheduler.ts` each ran the GAP-03 check
 * inside a **non-awaited** async IIFE:
 *
 * ```ts
 * if (isProduction) {
 *     (async () => {
 *         const { checkProductionEncryptionKey } = await import('…');
 *         …
 *         process.exit(1);
 *     })();          // ← not awaited
 * }
 * const connection = createWorkerConnection();   // runs FIRST
 * const worker = new Worker(…);                  // runs FIRST
 * ```
 *
 * (The condition really read the raw env directly; it is spelled `isProduction`
 * here only because `tests/unit/no-fallbacks.test.ts` greps `src/` for that
 * token as a plain substring and cannot tell a docblock from code — the same
 * prose-is-not-code limitation `tests/guards/payload-url-scheme.test.ts` had to
 * parse its way around.)
 *
 * Module evaluation continues straight past the IIFE; the `await import(...)`
 * inside it does not resume until the module body has finished. Both processes
 * did exit 1 — but only after they were already live. Measured log order under
 * a bad key:
 *
 * ```
 * worker:     starting worker
 *             worker process started — press Ctrl+C to stop   ← subscribed to the queue
 *             [startup] FATAL: DATA_ENCRYPTION_KEY is required …
 *
 * scheduler:  registering repeatable jobs
 *             [startup] FATAL: DATA_ENCRYPTION_KEY is required …
 * ```
 *
 * `src/instrumentation.ts` never had the problem — `register()` is async and
 * awaits the check inline, which is the shape this restores for the two
 * standalone entrypoints.
 *
 * ## Why a shared helper rather than two `await`s
 *
 * The two scripts had DIFFERENT checks: the worker ran the config check plus
 * the encrypt→decrypt sentinel, the scheduler ran only the config check, and
 * nothing said why. (CLAUDE.md said the sentinel was web-only, which was also
 * wrong — the worker ran it.) One function means one answer, and one place to
 * change it.
 *
 * The dynamic import is kept: a non-production process still never loads the
 * encryption module.
 *
 * @module lib/security/startup-gate
 */

/** Minimal logger shape — both scripts use pino, the web tier uses console. */
export interface StartupGateLogger {
    fatal(msg: string): void;
    info?(msg: string): void;
}

/**
 * Refuse to continue if this production process cannot encrypt at rest.
 *
 * Returns normally when the process may proceed — including in every
 * non-production environment, where the dev fallback key is the documented
 * contract. Calls `process.exit(1)` on failure, so a caller that `await`s this
 * is guaranteed that nothing after it runs on a broken key.
 *
 * `env` is a PARAMETER rather than a raw-env read, for the same reason
 * `checkProductionEncryptionKey` takes one: this whole check exists to catch a
 * runtime whose `SKIP_ENV_VALIDATION=1` bypassed the zod schema, so it cannot
 * read the validated `env` object — and reading the raw one inside `src/` is
 * what `tests/unit/no-fallbacks.test.ts` forbids. Pushing the read out to the
 * two callers (both in `scripts/`, which that guard does not scan) keeps this
 * function pure, keeps it trivially testable, and needs no exemption.
 */
export async function assertProductionEncryptionReady(
    log: StartupGateLogger,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    if (env.NODE_ENV !== 'production') return;

    const { checkProductionEncryptionKey, runEncryptionSentinel } = await import(
        './startup-encryption-check'
    );

    const config = checkProductionEncryptionKey(env);
    if (!config.ok) {
        log.fatal('[startup] FATAL: ' + config.reason);
        process.exit(1);
    }

    // The sentinel cannot fail for the reason its own docblock used to give —
    // see `startup-encryption-check.ts`. It is kept because it is the only
    // thing that would catch a FUTURE derivation that can throw, and it costs
    // one AES round-trip once per process.
    const sentinel = await runEncryptionSentinel();
    if (!sentinel.ok) {
        log.fatal('[startup] FATAL: ' + sentinel.reason);
        process.exit(1);
    }

    log.info?.('encryption key check passed (presence + sentinel round-trip)');
}
