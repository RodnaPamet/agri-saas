/**
 * Slow mode — a reduced mutation budget for accounts that have not yet earned
 * the full one (P5.5a, #1596).
 *
 * ## What puts an account in slow mode
 *
 * Unverified email **OR** younger than {@link SLOW_MODE_MAX_ACCOUNT_AGE_DAYS}.
 * Owner ruling 2026-10-10, and the OR is the whole point:
 *
 *   - **Age alone is the weakest signal** — an attacker waits. It costs them
 *     patience, which is free.
 *   - **Verification alone** lets a throwaway-but-confirmed mailbox reach the
 *     full budget on its first minute.
 *
 * Together, abusing the platform at full speed costs a real mailbox AND a
 * week. Either one on its own costs almost nothing.
 *
 * ## It is a reduced BUDGET, not a cooldown
 *
 * A per-action minimum interval is stricter and worse: it makes a legitimate
 * new farmer's first session feel broken, which is a retention cost paid
 * against a speculative attack. A smaller bucket degrades gracefully — a
 * person filling in forms never reaches it, and a script does.
 *
 * ## Age is computed HERE, not stamped at mint time
 *
 * The caller passes raw timestamps and this decides. A `slowMode: true` claim
 * baked into a JWT would go stale in the wrong direction: an account that
 * crossed the age threshold would stay throttled until its token was
 * re-minted, which is a real user penalised for a caching decision. Age is
 * time-dependent, so it is answered at the moment it is asked.
 *
 * Verification is the one input that can be stale, and only until the session
 * re-mints. That is the safe direction (a just-verified user keeps the reduced
 * budget briefly) and it is bounded by the session max age.
 *
 * ## An ABSENT claim means NOT slow, deliberately
 *
 * Every session minted before this ships carries neither timestamp. Reading
 * that as "slow" would throttle every logged-in user on deploy day. So absence
 * degrades to the previous behaviour until natural re-mint — the
 * `membershipsTruncated` precedent, where "an absent flag reads as false, so
 * old sessions behave exactly as before".
 *
 * This is the one place in the file where the fail direction is OPEN rather
 * than closed, and it is a deploy-safety choice rather than a security
 * judgement: the population it affects is existing, already-authenticated
 * users, and the window is one token lifetime.
 */

/** How long an account is "new". Seven days. */
export const SLOW_MODE_MAX_ACCOUNT_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The account facts slow mode is decided from. Both may be absent. */
export interface SlowModeInput {
    /**
     * `User.emailVerified` as epoch ms, or `null` when the address was never
     * confirmed. `undefined` means the session predates this feature.
     */
    readonly emailVerifiedAt?: number | null;
    /**
     * `User.createdAt` as epoch ms. `undefined` means the session predates
     * this feature.
     */
    readonly accountCreatedAt?: number;
    /** Injectable for tests. Defaults to now. */
    readonly now?: number;
}

/**
 * Whether this account should get the reduced budget.
 *
 * Returns `false` for an input carrying neither timestamp — see the
 * "ABSENT claim" note above.
 */
export function isSlowModeAccount(input: SlowModeInput): boolean {
    const { emailVerifiedAt, accountCreatedAt } = input;

    // A session minted before this feature existed. Not slow: see the docblock.
    if (emailVerifiedAt === undefined && accountCreatedAt === undefined) {
        return false;
    }

    // Unverified. `null` is the real answer "never confirmed"; `undefined`
    // here means the claim is missing while the other one is present, which
    // we do not read as unverified — only an explicit null does.
    if (emailVerifiedAt === null) return true;

    if (accountCreatedAt !== undefined) {
        const now = input.now ?? Date.now();
        const ageMs = now - accountCreatedAt;
        // `<` rather than `<=`: an account created exactly
        // SLOW_MODE_MAX_ACCOUNT_AGE_DAYS ago has served its week.
        //
        // A NEGATIVE age (a clock skew, or a createdAt in the future) is
        // treated as new, which is the strict direction — the alternative
        // would make a forward-dated timestamp a way out.
        if (ageMs < SLOW_MODE_MAX_ACCOUNT_AGE_DAYS * DAY_MS) return true;
    }

    return false;
}
