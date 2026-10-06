import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { isValidEik, classifyEikInput } from '@/lib/bg-identifiers';
import { lookupRegisteredName } from '@/lib/bg-company-registry';
import { PUBLIC_READ_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

/**
 * `GET /api/public/eik-check?eik=…` — is this a well-formed ЕИК, and if it is a
 * legal entity, what is it called? (P3.7)
 *
 * Public and unauthenticated, because it runs while someone is typing their ЕИК
 * into the registration form and has no account yet.
 *
 * ── it answers deliberately little ──
 *
 * `{ valid, registryName }` and nothing else. Not the address, not the status,
 * not the directors — the register publishes those and this endpoint is not a
 * proxy for it. Every extra field is one more thing an unauthenticated caller
 * can harvest at our expense and under our rate limit.
 *
 * `registryName` is `null` for a natural person or sole trader, and also `null`
 * when the ЕИК is simply absent from the register. See
 * `@/lib/bg-company-registry` — ADR 0002 OD2 records that a 9-digit БУЛСТАТ can
 * itself be personal data for 300,000-plus self-insured farmers, so a public
 * ЕИК → name map would be a walkable index of natural persons. The same rule
 * this repo already applies to cadastre ownership.
 *
 * ── on uniformity, and why it does NOT apply here ──
 *
 * `FarmIdentityClaim` (P3.4) must answer identically whatever a claim's state
 * is, so the endpoint cannot be used to discover which farms are claimed. The
 * argument runs the other way for this one: distinguishing "well-formed" from
 * "not well-formed" IS the feature — it is why the field can tell a typo from
 * an unregistered company before anyone submits.
 *
 * So the protection here is the rate limit rather than uniformity, and the
 * response is kept thin so that what a determined caller can harvest is only
 * what the checksum already tells them for free.
 */
const Query = z.object({
    eik: z.string().trim().min(1).max(32),
});

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const parsed = Query.safeParse({
            eik: req.nextUrl.searchParams.get('eik') ?? '',
        });
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const { eik } = parsed.data;

        // Named separately from `valid` so the form can tell someone they have
        // typed an ЕГН — a sole trader reaching for the number they know —
        // rather than the useless "that is not an ЕИК". The value itself is
        // never echoed, logged or stored; see `looksLikeEgn`'s docblock.
        const verdict = classifyEikInput(eik);

        if (!isValidEik(eik)) {
            return jsonResponse({
                valid: false,
                looksLikeEgn: verdict === 'LOOKS_LIKE_EGN',
                registryName: null,
            });
        }

        // The checksum runs BEFORE any registry work, so a number that cannot
        // exist never reaches a lookup. That matters more once a provider is
        // wired: it keeps the expensive path off the keyspace that a walker
        // would try first.
        const registryName = await lookupRegisteredName(eik);

        return jsonResponse({ valid: true, looksLikeEgn: false, registryName });
    },
    {
        // Unauthenticated and enumerable by construction — the rate limit is
        // the control, since uniformity cannot be (see the docblock).
        rateLimit: { config: PUBLIC_READ_LIMIT, scope: 'public-eik-check' },
    },
);
