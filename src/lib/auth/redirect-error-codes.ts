/**
 * The auth failures that arrive as a REDIRECT rather than as the return value
 * of a client-side `signIn()` call.
 *
 * next-auth sends these to `pages.error`, which `src/auth.ts` configures as
 * `/login`. That page read no `?error=` at all, so every one of them rendered
 * nothing and the person simply arrived back at a clean form (#2135).
 *
 * ## Why this is a whitelist and not a passthrough
 *
 * Two of next-auth's redirects interpolate a RAW thrown message into the
 * query string (`next-auth/core/routes/callback.js`, the `catch` around each
 * `callbacks.signIn` call). `?error=` is therefore attacker-authorable text:
 * anyone can send a link carrying any sentence. Rendering it would put that
 * sentence inside our own error styling, on our own domain, in a login form
 * — which is a phishing surface rather than an error message.
 *
 * So the parameter is classified, never echoed. A recognised code maps to our
 * copy; anything else is reported with the generic message, because an
 * unrecognised value still means the sign-in failed and silence was the bug.
 */

/** Every code next-auth can redirect to `pages.error` with. */
export const REDIRECT_ERROR_CODES = [
    'AccessDenied',
    'Callback',
    'configuration',
    'EmailCreateAccount',
    'EmailSignin',
    'OAuthAccountNotLinked',
    'OAuthCallback',
    'OAuthCreateAccount',
    'OAuthSignin',
    'Verification',
] as const;

export type RedirectErrorCode = (typeof REDIRECT_ERROR_CODES)[number];

/**
 * The one code with its own copy.
 *
 * It is the only redirect failure that is deterministic AND actionable:
 * retrying cannot succeed, because the refusal is a decision rather than a
 * fault, and the person has to sign out before that identity can be used.
 * Everything else is transient or near-unreachable, where "try again" is the
 * only honest advice.
 */
export const SPECIFIC_ERROR_CODE: RedirectErrorCode = 'OAuthAccountNotLinked';

/** Narrow a query-string value to a code we recognise, or `null`. */
export function asRedirectErrorCode(raw: string | null | undefined): RedirectErrorCode | null {
    if (!raw) return null;
    return (REDIRECT_ERROR_CODES as readonly string[]).includes(raw)
        ? (raw as RedirectErrorCode)
        : null;
}

/**
 * Which message key a raw `?error=` value should render.
 *
 * `null` means render nothing — there was no error parameter at all. A
 * present-but-unrecognised value deliberately returns the generic key rather
 * than `null`, so a failure is never silent.
 */
export function messageKeyForErrorParam(
    raw: string | null | undefined,
): 'oauthAccountNotLinked' | 'signInErrorGeneric' | null {
    if (!raw) return null;
    return asRedirectErrorCode(raw) === SPECIFIC_ERROR_CODE
        ? 'oauthAccountNotLinked'
        : 'signInErrorGeneric';
}
