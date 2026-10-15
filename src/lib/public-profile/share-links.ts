/**
 * The links a farmer shares — P6.7 (#1816).
 *
 * One module because the three surfaces must agree on the SAME url. A QR code
 * printed on an A6 card, a Viber forward and a copied link that resolved
 * differently would be three ways to reach a farm and two of them wrong — and
 * the printed one is the one nobody can correct.
 *
 * ## What is NOT here
 *
 * `/go`. The owner dropped it on #1623: *"An AASA is a published claim that a
 * path opens the app, and a path with no defined meaning cannot open
 * anything."* The surviving scheme is two paths, `/f/[handle]` and `/m`, and
 * the AASA already serves exactly that (#1786). So shares point at
 * `/f/{handle}` directly.
 *
 * ## Why the Viber link cannot be verified end to end
 *
 * `viber://` is a scheme handled by an installed app, so no server test can
 * confirm a forward actually opens. What IS testable is the composition: that
 * a Cyrillic farm name survives percent-encoding intact, which is the half
 * that breaks silently. A mis-encoded name does not fail — it forwards
 * mojibake, and the farmer sees it only after sending.
 */
/**
 * Where a handle is served. The ONE definition every share surface uses.
 *
 * Takes `baseUrl` rather than calling `getAppBaseUrl()`, and that is a
 * BUNDLING constraint, not a preference. This module is imported by the
 * editor, which is a client component; `getAppBaseUrl` reaches `logger`,
 * which reaches `node:async_hooks`, and webpack cannot bundle that for a
 * browser:
 *
 *     UnhandledSchemeError: Reading from "node:async_hooks" is not handled
 *     ./src/lib/public-profile/share-links.ts
 *     ./src/app/.../admin/public-profile/PublicProfileClient.tsx
 *
 * `tsc` cannot see that — the types are fine and the import is legal — so it
 * surfaced only in `next build`. Server callers pass `getAppBaseUrl()`; the
 * editor receives the value as a prop from its server page.
 *
 * The side benefit is that these functions are now pure, so their tests need
 * no env mock at all.
 */
export function publicProfileUrl(handle: string, baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    // The handle is already normalised to a lower-case ASCII slug by
    // `checkHandleShape`, so it needs no encoding — and encoding it would be
    // the kind of defensive call that hides a handle that should have been
    // refused at the point of choice.
    return `${base}/f/${handle}`;
}

/**
 * A Viber forward intent.
 *
 * `viber://forward?text=` is the documented share entry point; it opens the
 * contact picker with the text prefilled rather than sending anything, so the
 * farmer still chooses the recipient. That matters for a link to their own
 * page: a share that sent on tap would be a share they did not consent to.
 */
export function viberForwardUrl(text: string): string {
    return `viber://forward?text=${encodeURIComponent(text)}`;
}

export interface ShareKit {
    /** The canonical public url. */
    readonly url: string;
    /** `viber://forward` with the message prefilled. */
    readonly viber: string;
    /** What the QR encodes — the url, never the message. */
    readonly qrValue: string;
    /** The prefilled message, exposed so a copy-to-clipboard matches Viber. */
    readonly message: string;
}

/**
 * Everything the share sheet needs, composed once.
 *
 * `qrValue` is the bare url rather than the message, deliberately: a QR is
 * scanned by a camera that opens what it finds, and a scanner handed
 * `Стопанство Победа — https://…` either opens nothing or searches for the
 * whole string. The message is for Viber and for the clipboard, where a
 * human reads it.
 */
export function shareKit(handle: string, displayName: string, baseUrl: string): ShareKit {
    const url = publicProfileUrl(handle, baseUrl);
    // Name then url, with an em dash. The url goes LAST because Viber and
    // most chat clients link-preview the final url in a message, and a
    // preview of the farm's own page is the point of sharing it.
    const message = `${displayName} — ${url}`;
    return { url, viber: viberForwardUrl(message), qrValue: url, message };
}
