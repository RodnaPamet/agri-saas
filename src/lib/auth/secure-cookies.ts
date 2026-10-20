import { env } from '@/env';

/**
 * Whether next-auth v4 uses the `__Secure-` cookie prefix, and therefore
 * whether its cookies carry `Secure`.
 *
 * Derived from `NEXTAUTH_URL` exactly as `next-auth/jwt` and
 * `core/lib/cookie.js` do — NOT from `NODE_ENV`. The reader and the writer
 * have to agree, and only one of them is ours.
 *
 * NOT named `useSecureCookies` (next-auth's own name for this option): the
 * `use*` prefix made `react-hooks/rules-of-hooks` report violations in the
 * server modules that call it, which is part of why that rule sat at `warn`
 * over the crash it was supposed to catch (#874). Do not rename it back for
 * parity with next-auth.
 *
 * A LEAF module on purpose. This lived in `sso-session.ts`, which imports
 * `buildSessionClaims` from `@/auth` — so `auth.ts` could not read it without
 * a cycle, and `auth.ts` needs it to decide the Apple cookie policy (#2096).
 * Copying three lines instead is how the reader and the writer come to
 * disagree about the one thing this exists to keep identical.
 */
export function secureCookiesEnabled(): boolean {
    const url = env.NEXTAUTH_URL ?? env.AUTH_URL ?? '';
    return url.startsWith('https://');
}
