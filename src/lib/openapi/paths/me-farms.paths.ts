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
 * ── the flag gate is per-FILE, not per-handler ──
 *
 * `src/app/api/me/**` is classified SOCIAL by
 * `tests/guards/social-routes-are-flag-gated.test.ts`, which reads the FILE and
 * asserts it contains a gate call. So the gate is satisfied once per file, and
 * the two handlers here differ deliberately:
 *
 *   POST  gated on `social.farm-registration` — 404s while off
 *   GET   UNGATED — switching between farms you already hold must keep working
 *                   even when adding one is switched off
 *
 * That asymmetry is the agreed behaviour, and it means the guard cannot be
 * relied on to prove a particular handler is gated — only that the file
 * mentions the gate somewhere. Anyone adding a third handler here has to decide
 * for it explicitly; a silent omission passes.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';
import { CreateFarmSchema } from '@/lib/schemas';

export function registerMeFarmsPaths(registry: OpenAPIRegistry): void {
    

    op(registry, {
        method: 'get',
        path: '/api/me/farms',
        operationId: 'listMyFarms',
        summary: "The farms the caller belongs to",
        description:
            'Every farm the caller is an ACTIVE member of, for a farm switcher. Authenticated, no tenant context.' +
            '\n\n**Ordered by membership age, oldest first, and that is a contract rather than a convenience.** `farms[0]` is the same farm `GET /api/auth/me` names in its `tenant` field, so a client can reconcile this list against the farm it opens on a fresh install.' +
            '\n\n**Removed farms are excluded.** Soft-deleting a tenant sets only `deletedAt` and deliberately leaves memberships active, so a removed farm still has live memberships pointing at it — those are filtered here, as they are by the tenant picker, the JWT claims and the tenant resolver. A farm absent from this list is unreachable, not merely unlisted.' +
            '\n\n**UNGATED, unlike `POST`.** Adding a farm follows the `social.farm-registration` flag; moving between farms you already belong to does not. Being unable to reach a farm you are a member of is a worse failure than being unable to create one.' +
            '\n\nNot read from the JWT: `session.user.memberships` is capped at `MAX_JWT_MEMBERSHIPS` for cookie-size safety, and a switcher that silently dropped a farm past the cap would be worse than no switcher. This is a database read every time.' +
            '\n\nAn empty array means the caller belongs to no farm — not an error. That is the state the registration wizard exists for.',
        tags: ['Account'],
        success: {
            status: 200,
            description:
                'The caller\'s farms, oldest membership first. Empty when they belong to none.',
            schema: z
                .object({
                    farms: z.array(
                        z.object({
                            id: z.string(),
                            slug: z.string().openapi({
                                description:
                                    'Use this for navigation. Server-generated and stable.',
                                example: 'zk-pobeda-9f3a1c20',
                            }),
                            name: z.string().openapi({ example: 'ЗК ПОБЕДА' }),
                            role: z.string().openapi({
                                description:
                                    "The caller's role IN THAT FARM: `OWNER`, `ADMIN`, `EDITOR`, `READER`, `AUDITOR` or `MECHANISATOR`. A growing union — treat an unrecognised value as the least privilege rather than as an error.",
                                example: 'OWNER',
                            }),
                        }),
                    ),
                })
                .openapi('MyFarms'),
        },
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
        body: CreateFarmSchema,
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
