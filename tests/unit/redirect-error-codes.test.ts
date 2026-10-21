/**
 * `/login` renders a message for a redirect-borne auth failure, and renders
 * OUR copy rather than the query string (#2135).
 *
 * The mapping lives in its own module precisely so this can be asserted
 * without mounting the login page, next-auth and next-intl to find out.
 */
import {
    REDIRECT_ERROR_CODES,
    SPECIFIC_ERROR_CODE,
    asRedirectErrorCode,
    messageKeyForErrorParam,
} from '@/lib/auth/redirect-error-codes';

describe('redirect error codes', () => {
    it('control: the list is non-trivial and contains the generic bucket', () => {
        // If `Callback` ever leaves next-auth's vocabulary the rest of this
        // file is answering about a code nobody sends.
        expect(REDIRECT_ERROR_CODES.length).toBeGreaterThanOrEqual(10);
        expect(REDIRECT_ERROR_CODES).toContain('Callback');
        expect(REDIRECT_ERROR_CODES).toContain(SPECIFIC_ERROR_CODE);
    });

    it('recognises every code it lists', () => {
        for (const code of REDIRECT_ERROR_CODES) {
            expect(asRedirectErrorCode(code)).toBe(code);
        }
    });

    it('maps the account-link refusal to its own copy', () => {
        expect(messageKeyForErrorParam(SPECIFIC_ERROR_CODE)).toBe('oauthAccountNotLinked');
    });

    it('maps every OTHER recognised code to the generic copy', () => {
        for (const code of REDIRECT_ERROR_CODES) {
            if (code === SPECIFIC_ERROR_CODE) continue;
            expect(messageKeyForErrorParam(code)).toBe('signInErrorGeneric');
        }
    });

    it('renders nothing when there is no error parameter', () => {
        expect(messageKeyForErrorParam(null)).toBeNull();
        expect(messageKeyForErrorParam(undefined)).toBeNull();
        expect(messageKeyForErrorParam('')).toBeNull();
    });

    // The one that matters. Two of next-auth's redirects interpolate a raw
    // thrown message into the query string, so `?error=` is attacker-
    // authorable. The function must classify it, never pass it through —
    // otherwise a crafted link puts any sentence inside our own error
    // styling, on our domain, next to a password field.
    it('never returns attacker-supplied text, only one of its own keys', () => {
        const hostile = [
            'Your session expired — re-enter your card details to continue',
            '<img src=x onerror=alert(1)>',
            'OAuthAccountNotLinked ',       // trailing space: not the code
            'oauthaccountnotlinked',        // wrong case: not the code
            'AccessDenied; please call +1-555-0100',
            '../../etc/passwd',
            'Callback\nSet-Cookie: a=b',
        ];
        for (const raw of hostile) {
            const key = messageKeyForErrorParam(raw);
            // Reported, not echoed: a failure is never silent...
            expect(key).toBe('signInErrorGeneric');
            // ...and the returned value is a key, never the input.
            expect(key).not.toBe(raw);
            expect(asRedirectErrorCode(raw)).toBeNull();
        }
    });

    it('is case- and whitespace-exact, so near-misses fall back rather than match', () => {
        // Documents the choice above: a near-miss is treated as unrecognised.
        // Being lenient here would mean accepting input shapes we have not
        // enumerated, which is how a whitelist stops being one.
        expect(asRedirectErrorCode('callback')).toBeNull();
        expect(asRedirectErrorCode(' Callback')).toBeNull();
    });
});
