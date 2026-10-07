/**
 * `/api/public/*` — routes that answer before any credential exists.
 *
 * Distinct from `auth-public.paths.ts`, which documents what a client reads to
 * DRAW a login screen. These answer a question about the outside world: is
 * this a real company number, and whose. A client calls them while a person is
 * still filling in a form, with nothing to authenticate as.
 *
 * ── the property that makes this prefix its own module ──
 *
 * Everything under `/api/public/` is unauthenticated and therefore ENUMERABLE
 * by construction. There is no credential to scope a result to, so the only
 * controls available are a rate limit and a deliberately uniform response
 * shape. Keeping them together means the next `/api/public/` route is written
 * next to that reasoning rather than discovering it afterwards — and it makes
 * the set auditable in one read, which a reviewer asking "what can an
 * anonymous caller reach" actually needs.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

/** Nothing to authenticate with — that is the point of the prefix. */
const NO_AUTH: Array<Record<string, string[]>> = [];

export function registerPublicRegistryPaths(registry: OpenAPIRegistry): void {
    // Shared between the two methods so one description cannot drift from the
    // other. The GET and the POST answer identically — they differ only in
    // where the value travels.
    const EikCheckQuery = z.object({
        eik: z
            .string()
            .trim()
            .min(1)
            .max(32)
            .openapi({
                description:
                    'The number to check, 9 or 13 digits. Accepted with surrounding whitespace. Longer input is rejected as a bad request rather than truncated — truncating would silently validate a DIFFERENT number than the one submitted.',
                example: '831641791',
            }),
    });

    op(registry, {
        method: 'post',
        path: '/api/public/eik-check',
        operationId: 'checkEikPost',
        summary: 'Validate an ЕИК with the value in the request BODY (preferred)',
        description:
            'Identical to the GET in every respect but one: the number travels in the body rather than the query string. **Prefer this method.**' +
            '\n\n**Why it exists.** Every request to this endpoint is potentially an ЕГН — a personal identity number — because that is what the endpoint is for: a sole trader reaching for "the number I know" types theirs into the ЕИК box, which is exactly what `looksLikeEgn` detects. A query string is logged in places a body is not: iOS CFNetwork records the full request URL unsuppressably, and a GET URL also reaches browser history and can leak through `Referer`. The server side is clean (no access log, and the request logger uses the path only), so this is a CLIENT-side exposure — which makes it no less real for the person whose device is doing the logging.' +
            '\n\nThe GET form remains for compatibility and is tracked for removal once nothing calls it.' +
            '\n\nSame rate-limit budget as the GET, deliberately: alternating methods must not double a caller allowance.',
        tags: ['Public'],
        security: NO_AUTH,
        body: EikCheckQuery,
        success: {
            status: 200,
            description:
                'The verdict. 200 means the check RAN, not that the number is good — read `valid`. A malformed body is a 400.',
            schema: z.object({
                valid: z.boolean(),
                looksLikeEgn: z.boolean(),
                registryName: z.string().nullable(),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/public/eik-check',
        operationId: 'checkEik',
        summary: 'Validate an ЕИК and, where known, return the registered company name',
        description:
            'Checks a Bulgarian ЕИК (unified identification code) for structural validity and, when a registry provider is configured, returns the name it is registered under. Intended for the registration form, so a farmer learns their number is mistyped before they finish signing up rather than after.' +
            '\n\n**The checksum runs before any registry lookup.** A number that cannot exist never reaches a provider. This is a deliberate ordering, not an optimisation: it keeps the expensive path off exactly the keyspace an enumerator would walk first.' +
            '\n\n**`looksLikeEgn` exists because of who gets this wrong.** A sole trader reaching for "the number I know" often types their ЕГН — a personal identity number. Telling them "that is not a valid ЕИК" is useless; telling them they have typed an ЕГН is actionable. The submitted value is never echoed back, logged, or stored, so a flag is the whole answer. Treat it as a hint for the FORM, never as a statement about a person — and do not place the submitted value in a URL you log, because the query string is recorded in places the body is not.' +
            '\n\n**This endpoint is enumerable and is rate-limited rather than hidden.** It is unauthenticated, so there is no credential to scope an answer to. Expect 429 under load and back off; do not retry tightly.',
        tags: ['Public'],
        security: NO_AUTH,
        query: z.object({
            eik: z
                .string()
                .trim()
                .min(1)
                .max(32)
                .openapi({
                    description:
                        'The number to check, 9 or 13 digits. Accepted with surrounding whitespace. Longer input is rejected as a bad request rather than truncated — truncating would silently validate a DIFFERENT number than the one submitted.',
                    example: '831641791',
                }),
        }),
        success: {
            status: 200,
            description:
                'The verdict. 200 means the check RAN, not that the number is good — read `valid`. A malformed query (missing or over-long `eik`) is a 400.',
            schema: z
                .object({
                    valid: z.boolean().openapi({
                        description:
                            'True when the input is a structurally valid ЕИК: 9 digits with a correct checksum, or 13 digits whose leading 9 are themselves valid. Structure only — it does NOT mean the company exists, is active, or is in the register.',
                    }),
                    looksLikeEgn: z.boolean().openapi({
                        description:
                            'True when the input fails as an ЕИК but passes as an ЕГН — both the checksum and a decodable date of birth. Always false when `valid` is true. Use it to change the MESSAGE, not the outcome.',
                    }),
                    registryName: z.string().nullable().openapi({
                        description:
                            'The registered company name, or null.\n\n**`null` deliberately conflates three different situations** and a client must not distinguish them: no registry provider is configured in this deployment, the provider was asked and had no entry, or the entry carries no name. They are merged because telling an anonymous caller WHICH applies turns this endpoint into a probe for which numbers exist in the register — a distinction worth more to an enumerator than to the form it serves. So render null as "we could not confirm the name", never as "this company does not exist".',
                    }),
                })
                .openapi('EikCheckResult', {
                    description:
                        'The shape is identical for every outcome — valid, invalid, found, not found. That uniformity IS the control: a response whose size or field set varied with what the register holds would leak the register to anyone willing to iterate.',
                }),
        },
    });
}
