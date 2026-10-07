/**
 * `/api/me/farms` — what the signed-in person does before they have a farm.
 *
 * Its own module rather than an addition to `account.paths.ts`, which documents
 * preferences on an account that already exists (display name, avatar,
 * language). This answers a different question: a person may hold SEVERAL farms
 * (owner ruling 2026-10-06), so "which farms are mine, and add another" is a
 * relationship to tenants rather than a property of the account.
 *
 * ── the property that makes this prefix its own module ──
 *
 * Everything here runs with NO tenant context. There is no `[tenantSlug]` to
 * scope to and no `requirePermission` to apply, so the only authority is the
 * session — and the subject is always the session user, never an id in the
 * body. Keeping these together means the next `/api/me/` route is written
 * beside that reasoning instead of rediscovering it, and it makes the set
 * auditable in one read for a reviewer asking what a signed-in person with no
 * farm can reach.
 *
 * Note for anyone adding here: `src/app/api/me/**` is classified SOCIAL by
 * `tests/guards/social-routes-are-flag-gated.test.ts`, so every route in this
 * prefix must call the feature gate and will 404 until its flag is on.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

export function registerMeFarmsPaths(registry: OpenAPIRegistry): void {
    const CreateFarmRequest = z
        .object({
            name: z.string().trim().min(1).max(120).openapi({
                description:
                    'The farm name as the farmer writes it, Cyrillic included. The web address is derived from it by transliteration and is NOT this value — read `farm.slug` from the response rather than deriving one.',
                example: 'ЗК ПОБЕДА',
            }),
            eik: z
                .string()
                .trim()
                .max(13)
                .nullable()
                .optional()
                .openapi({
                    description:
                        'The farm\'s ЕИК, 9 or 13 digits. OMIT it for «Земеделски стопанин — физическо лице», who has none. Two refusals are specific and worth handling in the form: `EIK_LOOKS_LIKE_EGN` (a personal identity number was typed — say so, do not say "invalid") and `EIK_INVALID` (checksum). Both are decided before the value is hashed or stored, so a number that cannot exist leaves no trace.',
                    example: '831641791',
                }),
        })
        .openapi('CreateFarmRequest', {
            description:
                'Create a farm owned by the caller. The owner is taken from the session and can never be named in the body.',
        });

    op(registry, {
        method: 'post',
        path: '/api/me/farms',
        operationId: 'createMyFarm',
        summary: 'Create a farm owned by the caller',
        description:
            'The final step of the registration wizard, and the "add another farm" action afterwards. The caller becomes the farm\'s OWNER.' +
            '\n\n**This is not a way to join an existing farm.** Memberships are invite-only: the only route into a farm somebody else owns is an invite its owner or an admin issues. There is no join request, and no endpoint that turns a farm identifier into membership — a typed ЕИК never grants access to anything.' +
            '\n\n**`identityVerification` deliberately tells you nothing about whether the ЕИК was free.** When an ЕИК is supplied the value is `pending_review` — unconditionally, including when another farm already holds that number as a verified claim. An ЕИК is public (it is in the Търговски регистър), so the secret is not the number but whether that farm is already in Agrent, and a response that varied would be exactly the oracle this avoids. Do NOT render a success state implying the claim was accepted, and do not poll this endpoint for a verdict: the real state is readable only from inside the farm, where row-level security scopes it to the people who belong there.' +
            '\n\n**A second farm is not a conflict.** One person may hold several; expect no 409 on the second call.' +
            '\n\nDark-launched behind the `social.farm-registration` feature flag, which 404s while off — so a 404 here means "not enabled", not "wrong URL".',
        tags: ['Account'],
        body: CreateFarmRequest,
        success: {
            status: 201,
            description:
                'The farm exists and the caller owns it. 201 is about the FARM — it says nothing about the ЕИК, which is what `identityVerification` is for.',
            schema: z
                .object({
                    farm: z.object({
                        id: z.string(),
                        slug: z.string().openapi({
                            description:
                                'Server-generated, transliterated, and carrying a uniqueness suffix. Use it for the redirect; two farms with the same name get different slugs.',
                            example: 'zk-pobeda-9f3a1c20',
                        }),
                        name: z.string(),
                    }),
                    identityVerification: z
                        .enum(['not_requested', 'pending_review', 'deferred'])
                        .openapi({
                            description:
                                '`not_requested` — no ЕИК was supplied. `pending_review` — a claim was recorded and a human will look at it; this is the value for BOTH a free and an already-taken ЕИК, by design. `deferred` — the farm was created but the claim could not be recorded, so the ЕИК is not yet on file and can be added from farm settings. Never treat `pending_review` as acceptance.',
                        }),
                })
                .openapi('CreateFarmResponse'),
        },
    });
}
