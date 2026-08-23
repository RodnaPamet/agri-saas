/**
 * Is this an installed web app, and is this iOS?
 *
 * Extracted from `InstallPrompt` so the offline surfaces can ask the same
 * question without a second spelling. It became load-bearing beyond the install
 * prompt once the durability measurement came back split: on a physical iPhone
 * mobile Safari REFUSES `navigator.storage.persist()` while the installed Home
 * Screen app GRANTS it, so "iOS and not installed" is exactly the population
 * whose queued work the browser may reclaim at will.
 *
 * See docs/implementation-notes/2026-08-19-outbox-durability.md.
 */

/** Running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    return (
        window.matchMedia?.('(display-mode: standalone)').matches === true ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
}

/**
 * iOS Safari specifically — Chrome and Firefox on iOS are excluded because
 * their Add-to-Home-Screen story differs and the Share-sheet instruction we
 * give would be wrong for them.
 */
export function isIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
}

/**
 * Would installing this app change whether the browser keeps unsent work?
 *
 * True only for un-installed iOS Safari — measured as the one configuration
 * where the answer is known to flip. Deliberately NOT "any browser that refused
 * persistence": on Chromium a refusal reflects low engagement and installing is
 * not the documented remedy, so advising it there would be a guess wearing the
 * clothes of a measurement.
 */
export function installingWouldPersist(): boolean {
    return isIos() && !isStandalone();
}
