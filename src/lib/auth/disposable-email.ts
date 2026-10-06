/**
 * Disposable-email detection for registration (P3.5).
 *
 * ── what this is, and what it is not ──
 *
 * It is a **speed bump**, not a wall. New disposable domains appear daily and
 * no bundled list can keep up; anyone determined to use one will. The wall is
 * email verification, which already exists — a throwaway address that cannot
 * receive the code gets no farm.
 *
 * What a list buys is the volume case: the handful of providers that account
 * for most casual throwaway signups, refused at the point of entry with copy
 * that tells the person what to do, rather than silently accepted and then
 * swept seven days later as unverified.
 *
 * Because it is a speed bump, it **fails open**. An unknown domain is allowed.
 * The cost of a false positive — refusing a real farmer their real address —
 * is far higher than the cost of a false negative, which verification catches
 * anyway.
 *
 * ── subdomains are the part people miss ──
 *
 * Mailinator and several others accept mail at ARBITRARY subdomains:
 * `anything.mailinator.com` reaches the same public inbox. A check that
 * compares the domain exactly lets every one of those through while appearing
 * to block the provider. So matching is on the domain AND any parent of it.
 */

/**
 * Well-known disposable providers.
 *
 * Deliberately short and deliberately not exhaustive — a 100,000-entry list
 * vendored into the repo would go stale, bloat every bundle that imports it,
 * and still not be complete. These are the high-volume ones; the list is a
 * `Set` so adding to it is a one-line change with no structure to get wrong.
 *
 * Entries are registrable domains. Subdomains match automatically.
 */
const DISPOSABLE_DOMAINS = new Set([
    '10minutemail.com',
    'dispostable.com',
    'discard.email',
    'emailondeck.com',
    'fakeinbox.com',
    'getnada.com',
    'grr.la',
    'guerrillamail.com',
    'guerrillamail.net',
    'guerrillamail.org',
    'inboxkitten.com',
    'maildrop.cc',
    'mailcatch.com',
    'mailinator.com',
    'mailnesia.com',
    'mintemail.com',
    'mohmal.com',
    'moakt.com',
    'sharklasers.com',
    'spam4.me',
    'temp-mail.org',
    'tempinbox.com',
    'tempmail.com',
    'tempr.email',
    'throwawaymail.com',
    'trashmail.com',
    'yopmail.com',
]);

/** The domain part of an address, lower-cased. `null` if there isn't one. */
export function emailDomain(email: string): string | null {
    const at = email.lastIndexOf('@');
    if (at < 1 || at === email.length - 1) return null;
    const domain = email.slice(at + 1).trim().toLowerCase();
    // A trailing dot is legal in a FQDN and would defeat an exact-match set.
    const normalised = domain.replace(/\.$/, '');
    return normalised.length > 0 ? normalised : null;
}

/**
 * Is this address at a known disposable provider?
 *
 * Matches the domain and every parent of it, so `a.b.mailinator.com` is caught
 * by the `mailinator.com` entry — those providers accept mail at arbitrary
 * subdomains, and an exact-match check would block none of it.
 *
 * Fails OPEN: an unparseable address or an unknown domain returns `false`.
 * Address *validity* is not this function's job and is checked elsewhere.
 */
export function isDisposableEmail(email: string): boolean {
    const domain = emailDomain(email);
    if (domain === null) return false;

    const labels = domain.split('.');
    // `a.b.mailinator.com` → check `a.b.mailinator.com`, `b.mailinator.com`,
    // `mailinator.com`, `com`. Stops at two labels; a single label is never a
    // registrable domain and matching `com` against the set would be wrong
    // anyway, but the loop bound makes that explicit rather than incidental.
    for (let i = 0; i + 1 < labels.length; i++) {
        if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true;
    }
    return false;
}

/** Exposed so a test can assert the list is non-empty and well-formed. */
export const DISPOSABLE_DOMAIN_COUNT = DISPOSABLE_DOMAINS.size;
