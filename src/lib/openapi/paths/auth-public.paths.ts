/**
 * Public auth surfaces — what a client may read BEFORE it holds a credential.
 *
 * Separate from `auth-native.paths.ts` on purpose. That module documents the
 * handshake and the token lifecycle: every route in it is a step a client takes
 * to obtain or keep a credential. This one holds the routes a client reads
 * before it can offer a sign-in method at all, which is a different question
 * with a different audience — a login SCREEN, not a token exchange.
 *
 * It opens a seam rather than filling one. Around ten `/api/auth/*` routes are
 * still on `tests/guards/openapi-undocumented-baseline.json` — logout, register,
 * the password-reset pair, the verify-email pair, the SSO start/callback
 * quartet. Every one of them is a public auth surface and belongs here when it
 * is described, so the next entry to come off that baseline has an obvious home
 * and does not have to invent one or get filed under "native" for want of a
 * better place.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

/** Read before any credential exists — there is nothing to authenticate with yet. */
const NO_AUTH: Array<Record<string, string[]>> = [];

export function registerAuthPublicPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/auth/register/start',
        operationId: 'registerStart',
        summary: 'Begin registration: create an unverified account and email a 6-digit code',
        description:
            'Step 1 of registration v2. Creates an account whose email is NOT yet verified and emails a 6-digit code. It creates no farm — the email is proven first, and the farm is created afterwards by `POST /api/me/farms`.' +
            '\n\n**Every outcome returns the same 200 body.** A new address, an address part-way through signing up, and an address that already has a full account are indistinguishable in the response — deliberately, because the route it replaces answered `409 Email already registered` and was therefore a working account-enumeration oracle. The difference lands in the mailbox instead: a code for the first two cases, a "you already have an account" notice for the third. So a client must NOT infer anything about the address from a success, and must not tell the user "account created" — the honest message is "check your email".' +
            '\n\nThe password is hashed on every path, including the ones that discard it, so the request takes the same time whether or not the address is known. A client that times this endpoint learns nothing.' +
            '\n\nAn existing password is never overwritten by this call. Calling it again for an address that is already part-way through signing up reissues the CODE only.' +
            '\n\n400 means the REQUEST was wrong — a malformed body, a password failing policy, a password found in a breach corpus, or a refused Turnstile challenge (`turnstile_failed`, carrying Cloudflare error codes so a client can reset the widget; a token is single-use, so a blind retry always fails). Those say nothing about any address, which is why they are distinguishable from the uniform 200.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z.object({
            email: z.string().min(1).max(320).openapi({ example: 'ivan@example.bg' }),
            password: z.string().min(8).openapi({
                description:
                    'Checked against the password policy and against Have I Been Pwned. The HIBP screen fails OPEN: an outage there must not block signups, so a breached password may occasionally be accepted when the service is unreachable.',
            }),
            name: z.string().min(1).max(200).openapi({ example: 'Иван Иванов' }),
            turnstileToken: z.string().max(2048).optional().openapi({
                description:
                    'Cloudflare Turnstile token (P3.5c). OPTIONAL in the schema and REQUIRED at runtime whenever the deployment has a Turnstile secret configured — the two are not in conflict: a deployment with no secret renders no widget and has no token to send, so a required field would break signup for exactly the configuration that is live today. A missing token is refused once configured, never treated as a skip. Read the sitekey from /api/auth/ui-config to decide whether to render the widget at all; a null sitekey means render nothing.',
            }),
        }),
        success: {
            status: 200,
            description:
                'Always this, for every address. Means "we have done whatever was appropriate and sent an email" — NOT "an account was created".',
            schema: z
                .object({ ok: z.literal(true) })
                .openapi('RegisterStartResult', {
                    description:
                        'Intentionally carries no information about the address. Adding a field here that varied with account state would re-open the enumeration oracle this shape exists to close.',
                }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/register/verify',
        operationId: 'registerVerify',
        summary: 'Finish email verification with the 6-digit code',
        description:
            'Step 2 of registration v2. On success the email is verified; the farm is still to be created via `POST /api/me/farms`, and a verified user with no farm is a normal state.' +
            '\n\n**All failures return one `400 {error: "invalid_code"}`.** Wrong, expired, and too-many-attempts are deliberately indistinguishable: "expired" can only be returned when a code exists for that address, so separating them would tell an attacker which addresses recently started signing up. Nothing is lost — the next action for the user is "request a new code" in every case.' +
            '\n\n**The code allows a small number of wrong guesses and is then destroyed**, which forces a fresh email rather than letting a guesser top up their budget. A client should surface "request a new code" rather than inviting repeated attempts.' +
            '\n\nVerifying twice is safe and does not move the recorded verification time.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z.object({
            email: z.string().min(1).max(320).openapi({ example: 'ivan@example.bg' }),
            code: z.string().openapi({
                description:
                    'Exactly 6 digits, as a STRING. It must stay a string end to end: `012345` is a valid code, and a JSON number silently makes it `12345`, which then fails for one user in ten with nothing to show why.',
                example: '048212',
            }),
        }),
        success: {
            status: 200,
            description: 'The email is verified. Proceed to create or join a farm.',
            schema: z
                .object({ ok: z.literal(true), verified: z.literal(true) })
                .openapi('RegisterVerifyResult'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/ui-config',
        operationId: 'getAuthUiConfig',
        summary: 'Which sign-in methods the login screen should offer',
        description:
            'Read this on mount, before drawing a login screen. It answers which auth affordances to render — currently one flag. ' +
            '\n\nIt is a RUNTIME route rather than a build-time constant for a deployment reason worth knowing: a `NEXT_PUBLIC_*` value is inlined at `next build`, so flipping one would need a rebuild, an image push and a rollout. Reading `process.env` per request lets an operator change the flag with an env edit and a container recreate. A client must therefore treat the answer as CURRENT, not fixed for the life of its build, and re-read it rather than caching it across sessions. ' +
            '\n\nIt carries no secrets and needs no credential — it exposes only what the browser would otherwise have learned at build time.',
        tags: ['Auth'],
        security: NO_AUTH,
        success: {
            status: 200,
            description: 'The flags. Absent keys are not a contract — read each one explicitly.',
            schema: z
                .object({
                    credentialsFormHidden: z.boolean().openapi({
                        description:
                            'True means do NOT offer the email/password form. It is a UI instruction, not a capability statement: the Credentials provider stays registered server-side and the backend remains reachable for API clients and tests. A client that reads this as "credentials are disabled" will report the wrong reason when a sign-in fails.',
                    }),
                })
                .openapi('AuthUiConfig', {
                    description:
                        'Deliberately additive — flags are expected to be added here. Treat an unknown key as ignorable and a missing key as "use the built-in default", never as false.',
                }),
        },
    });
}
