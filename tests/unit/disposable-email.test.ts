/**
 * Disposable-email detection (P3.5).
 *
 * The cases that matter are the two directions of being wrong. Refusing a real
 * farmer their real address is the expensive failure; letting a throwaway
 * through is the cheap one, because email verification catches it anyway. So
 * the suite is weighted towards proving it does NOT over-block.
 */
import {
    isDisposableEmail,
    emailDomain,
    DISPOSABLE_DOMAIN_COUNT,
} from '@/lib/auth/disposable-email';

describe('the list is real', () => {
    it('is not empty — an empty set would silently allow everything', () => {
        // Without this, deleting the list's contents leaves every assertion
        // below that expects `false` passing, and the two that expect `true`
        // are the only thing standing between this and a no-op.
        expect(DISPOSABLE_DOMAIN_COUNT).toBeGreaterThan(20);
    });
});

describe('known providers are refused', () => {
    it.each([
        'someone@mailinator.com',
        'x@guerrillamail.com',
        'a@yopmail.com',
        'b@10minutemail.com',
        'c@sharklasers.com',
        'd@temp-mail.org',
    ])('%s', (email) => {
        expect(isDisposableEmail(email)).toBe(true);
    });

    it('catches ARBITRARY subdomains — the part an exact match misses', () => {
        // Mailinator and several others deliver to any subdomain, all reaching
        // the same public inbox. An exact-domain check blocks the provider's
        // front page and none of its actual traffic.
        expect(isDisposableEmail('x@anything.mailinator.com')).toBe(true);
        expect(isDisposableEmail('x@a.b.c.mailinator.com')).toBe(true);
        expect(isDisposableEmail('x@inbox.guerrillamail.com')).toBe(true);
    });

    it('is case- and trailing-dot-insensitive', () => {
        // `user@MAILINATOR.COM.` is the same mailbox. A set lookup on the raw
        // string matches neither.
        expect(isDisposableEmail('X@MAILINATOR.COM')).toBe(true);
        expect(isDisposableEmail('x@mailinator.com.')).toBe(true);
        expect(isDisposableEmail('x@MailInAtOr.CoM')).toBe(true);
    });
});

describe('real addresses are left alone — the expensive direction', () => {
    it.each([
        'ivan@abv.bg',
        'maria@gmail.com',
        'office@zk-pobeda.bg',
        'farm@agro.example',
        'a@mail.bg',
        'b@dir.bg',
        // Contains a listed name as a SUBSTRING but is a different domain.
        'c@mailinator-is-not-us.bg',
        'd@notmailinator.com',
        'e@mailinator.com.bg',
    ])('%s is allowed', (email) => {
        expect(isDisposableEmail(email)).toBe(false);
    });

    it('a listed domain as a PARENT of a real one does not match', () => {
        // `mailinator.com.bg` is a `.bg` domain that merely starts with the
        // same labels. Walking suffixes must not match a prefix.
        expect(isDisposableEmail('x@mailinator.com.bg')).toBe(false);
    });
});

describe('it fails OPEN', () => {
    it.each(['', 'no-at-sign', '@leading', 'trailing@', 'a@', '@'])(
        'allows the unparseable %p rather than refusing it',
        (email) => {
            // Address validity is checked elsewhere. If this threw or returned
            // true, a malformed address would be reported to the user as
            // "disposable", which is both wrong and confusing.
            expect(isDisposableEmail(email)).toBe(false);
        },
    );

    it('never throws', () => {
        for (const v of ['', '@@@', 'a@b@c', '  ', 'x@.', 'x@..']) {
            expect(() => isDisposableEmail(v)).not.toThrow();
        }
    });
});

describe('emailDomain', () => {
    it('takes the LAST @, so a quoted local part cannot shift the domain', () => {
        expect(emailDomain('a@b@mailinator.com')).toBe('mailinator.com');
    });

    it.each([
        ['x@Example.COM', 'example.com'],
        ['x@example.com.', 'example.com'],
        ['x@example.com', 'example.com'],
    ])('%p → %p', (input, expected) => {
        expect(emailDomain(input)).toBe(expected);
    });

    it('returns null when there is no domain', () => {
        for (const v of ['', 'nope', '@x', 'x@', '@']) expect(emailDomain(v)).toBeNull();
    });
});
