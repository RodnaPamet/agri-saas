/**
 * P5.5a — the slow-mode policy itself (#1596).
 *
 * `isSlowModeAccount` is a pure function, so this is where the OWNER'S RULING
 * is pinned rather than inferred from behaviour three layers up: unverified
 * email OR younger than seven days, as an OR, because either half alone costs
 * an attacker almost nothing.
 *
 * The case worth the most care is the one with no security content at all: an
 * input carrying NEITHER timestamp must read as NOT slow. Every session minted
 * before P5.5a is in exactly that shape, and reading it as slow would throttle
 * every logged-in user on deploy day.
 */
import {
    isSlowModeAccount,
    SLOW_MODE_MAX_ACCOUNT_AGE_DAYS,
} from '@/lib/security/slow-mode';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** An account old enough to be established, by this policy. */
const ESTABLISHED = NOW - (SLOW_MODE_MAX_ACCOUNT_AGE_DAYS + 1) * DAY;

describe('isSlowModeAccount — the OR, both halves load-bearing', () => {
    it('is NOT slow when verified AND established', () => {
        expect(isSlowModeAccount({
            emailVerifiedAt: ESTABLISHED,
            accountCreatedAt: ESTABLISHED,
            now: NOW,
        })).toBe(false);
    });

    it('IS slow when unverified, however old the account', () => {
        // The half that age alone would miss. An attacker who waits out a
        // seven-day window still has not proved a mailbox.
        expect(isSlowModeAccount({
            emailVerifiedAt: null,
            accountCreatedAt: NOW - 400 * DAY,
            now: NOW,
        })).toBe(true);
    });

    it('IS slow when new, even with a verified address', () => {
        // The half that verification alone would miss. A throwaway-but-
        // confirmed mailbox is cheap; a week is not.
        expect(isSlowModeAccount({
            emailVerifiedAt: NOW - DAY,
            accountCreatedAt: NOW - DAY,
            now: NOW,
        })).toBe(true);
    });
});

describe('isSlowModeAccount — the age boundary', () => {
    it('leaves slow mode exactly AT the threshold, not a day later', () => {
        const exactly = NOW - SLOW_MODE_MAX_ACCOUNT_AGE_DAYS * DAY;
        // `<` not `<=`: an account created exactly seven days ago has served
        // its week. A boundary off by one here is a whole extra day of
        // throttling for every new farmer, which is a product cost.
        expect(isSlowModeAccount({
            emailVerifiedAt: exactly, accountCreatedAt: exactly, now: NOW,
        })).toBe(false);
    });

    it('is still slow one millisecond before the threshold', () => {
        const justUnder = NOW - SLOW_MODE_MAX_ACCOUNT_AGE_DAYS * DAY + 1;
        expect(isSlowModeAccount({
            emailVerifiedAt: justUnder, accountCreatedAt: justUnder, now: NOW,
        })).toBe(true);
    });

    it('treats a FUTURE createdAt as new, not as established', () => {
        // Clock skew, or a forward-dated row. The strict direction is the only
        // safe one: the alternative makes a future timestamp a way out.
        expect(isSlowModeAccount({
            emailVerifiedAt: NOW, accountCreatedAt: NOW + 30 * DAY, now: NOW,
        })).toBe(true);
    });

    it('recomputes as time passes rather than freezing a verdict', () => {
        const created = NOW - 3 * DAY;
        const account = { emailVerifiedAt: created, accountCreatedAt: created };
        // Same account, two different moments. This is why the claim is a
        // TIMESTAMP and not a `slowMode` boolean: a baked verdict would keep
        // this account throttled past the threshold until its token re-minted.
        expect(isSlowModeAccount({ ...account, now: NOW })).toBe(true);
        expect(isSlowModeAccount({ ...account, now: NOW + 10 * DAY })).toBe(false);
    });
});

describe('isSlowModeAccount — a session that predates the feature', () => {
    it('reads an input with NEITHER timestamp as NOT slow', () => {
        // The deploy-day case. Every existing session carries no such claims,
        // and the population affected is already-authenticated users — so this
        // degrades to the previous behaviour until natural re-mint, which is
        // the `membershipsTruncated` precedent.
        expect(isSlowModeAccount({ now: NOW })).toBe(false);
        expect(isSlowModeAccount({
            emailVerifiedAt: undefined, accountCreatedAt: undefined, now: NOW,
        })).toBe(false);
    });

    it('distinguishes an ABSENT verification claim from an explicit null', () => {
        // Only `null` means "never confirmed". Collapsing the two would make
        // every pre-P5.5a session look unverified — the same deploy-day
        // throttle by a different route.
        expect(isSlowModeAccount({
            emailVerifiedAt: undefined, accountCreatedAt: ESTABLISHED, now: NOW,
        })).toBe(false);
        expect(isSlowModeAccount({
            emailVerifiedAt: null, accountCreatedAt: ESTABLISHED, now: NOW,
        })).toBe(true);
    });

    it('still applies the age rule when only createdAt is present', () => {
        // A partial claim set is not a free pass: what IS known is used.
        expect(isSlowModeAccount({ accountCreatedAt: NOW - DAY, now: NOW })).toBe(true);
        expect(isSlowModeAccount({ accountCreatedAt: ESTABLISHED, now: NOW })).toBe(false);
    });
});
