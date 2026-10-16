/**
 * A registered OAuth provider must be reachable from the login page (#1673).
 *
 * ## The gap
 *
 * `src/auth.ts` registers Sign in with Apple as soon as the four `APPLE_*`
 * variables are set, and `/api/auth/providers` duly listed `apple` on
 * production. **No user could reach it**: `src/app/login/page.tsx` hardcodes
 * its buttons, and there was no Apple one.
 *
 * So the server offered a sign-in method the UI never rendered — `wired is not
 * delivered`, with a specific victim: an iOS user who signed in with Hide My
 * Email has a `@privaterelay.appleid.com` address that no other provider can
 * match, making Apple-on-web their ONLY route to their account from a browser.
 *
 * It surfaced because the owner looked at the login screen, not because
 * anything failed. Both halves were individually correct: the provider
 * registers, the page renders what it lists.
 *
 * ## What this checks, and the one thing it deliberately does not
 *
 * Every provider `src/auth.ts` can register must have a call site on the login
 * page. That is a SOURCE check: the registration is env-gated and the button
 * is state-gated, so neither side can be evaluated here — but "there exists a
 * way to reach this provider" is exactly the property that was missing, and it
 * is visible in the text.
 *
 * It does NOT check that the button renders for a given env. `appleAvailable`
 * comes from `getProviders()` at runtime, and a rendered test would need the
 * whole page's effect chain; the honest statement is that the wiring exists.
 */
import { readCatalogue } from '../helpers/catalogue';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const AUTH = readFileSync(join(ROOT, 'src/auth.ts'), 'utf8');
const LOGIN = readFileSync(join(ROOT, 'src/app/login/page.tsx'), 'utf8');

/**
 * Provider ids `src/auth.ts` can register, with how the login page reaches
 * each. `credentials` is excluded: it is the email/password form, not an OAuth
 * button, and it has its own `credentialsEnabled` gate.
 */
const OAUTH_PROVIDERS = ['google', 'microsoft-entra-id', 'apple'] as const;

/**
 * How each id is REGISTERED, which is not how it is CALLED.
 *
 * `auth.ts` imports provider factories (`Google`, `Apple`, `AzureAD`) and the
 * id is implicit in the module path — only `microsoft-entra-id` appears as a
 * string literal, because v5 renamed `azure-ad` and the id is overridden to
 * match. So a control grepping for `'google'` in `auth.ts` finds nothing and
 * reports the opposite of the truth; this maps each id to the import that
 * registers it. Found by that control failing, which is what it is for.
 */
const REGISTERED_VIA: Record<(typeof OAUTH_PROVIDERS)[number], RegExp> = {
    google: /from 'next-auth\/providers\/google'/,
    'microsoft-entra-id': /from 'next-auth\/providers\/azure-ad'/,
    apple: /from 'next-auth\/providers\/apple'/,
};

describe('every registerable OAuth provider is reachable from /login', () => {
    it('each provider is genuinely registerable in auth.ts', () => {
        // Positive control. If `auth.ts` stopped importing one of these the
        // assertions below would hold a button to a provider that cannot
        // exist — and if the import paths move, this fails rather than
        // silently passing over an empty population.
        const missing = OAUTH_PROVIDERS.filter((p) => !REGISTERED_VIA[p].test(AUTH));
        expect(missing).toEqual([]);
    });

    it.each(OAUTH_PROVIDERS)('the login page can sign in with %s', (provider) => {
        // THE #1673 ASSERTION. `apple` failed this: registered server-side,
        // absent from the page.
        expect(LOGIN).toContain(`handleOAuthSignIn('${provider}')`);
    });

    it('Apple is gated on ACTUAL registration, not assumed present', () => {
        // Unlike its two neighbours, Apple's config is optional — the provider
        // registers only when all four `APPLE_*` vars are set. A hardcoded
        // button would offer a sign-in that cannot complete on any deployment
        // without them, which is the failure mode this whole issue is about,
        // inverted.
        expect(LOGIN).toContain('appleAvailable');
        expect(LOGIN).toMatch(/setAppleAvailable\(Boolean\(providers\?\.apple\)\)/);
    });

    it('that gate is read BEFORE the credentials-hidden early return', () => {
        // Measured on production: `/api/auth/ui-config` returns
        // `credentialsFormHidden: true`, so the early return DOES fire there.
        // Setting `appleAvailable` after it would hide the button on exactly
        // the deployment where sign-in is OAuth-only — the same trap the
        // `registrationOpen` comment beside it already records.
        const gate = LOGIN.indexOf('setAppleAvailable(');
        const earlyReturn = LOGIN.indexOf('credentialsFormHidden === true');
        expect(gate).toBeGreaterThan(-1);
        expect(earlyReturn).toBeGreaterThan(-1);
        expect({ gateBeforeReturn: gate < earlyReturn }).toEqual({ gateBeforeReturn: true });
    });

    it('the Apple label exists in BOTH locales', () => {
        for (const loc of ['en', 'bg']) {
            const messages = readCatalogue(loc);
            expect({ loc, label: typeof messages.login?.continueWithApple })
                .toEqual({ loc, label: 'string' });
        }
    });
});
