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
