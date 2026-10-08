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
const Body = z.object({
    eik: z.string().trim().min(1).max(32),
});

/**
 * The answer, shared by both handlers so there is one to maintain.
 *
 * Takes the value and returns the response — it persists nothing, logs
 * nothing, and echoes nothing back. That is the property P3.10 asks for a
 * test of ("a test proves ЕГН is never persisted"), and it is why this
 * function has no `prisma`, no `logger` and no parameter it could leak
 * through: the absence is structural rather than careful.
 */
async function answerEikCheck(eik: string) {
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
}


/**
 * `POST /api/public/eik-check` — the same check, with the value in the BODY.
 *
 * ── why a POST exists for a read (P3.10) ──
 *
 * Every request to this endpoint is POTENTIALLY an ЕГН. That is not a remote
 * possibility, it is the endpoint's purpose: `looksLikeEgn` exists because a
 * sole trader reaching for "the number I know" types their personal identity
 * number into the ЕИК box. So the transport has to be safe for an ЕГН on
 * every call, not just the ones that turn out to be company numbers.
 *
 * A query string is not. Measured on the live stack, the SERVER side is clean
 * — `deploy/Caddyfile` has no `log` directive, and `lib/errors/api.ts` logs
 * `req.nextUrl.pathname`, which excludes the query. But the CLIENT is not:
 * iOS CFNetwork logs the full request URL including its query string,
 * unsuppressably, and a GET URL also lands in browser history and can leak
 * through `Referer`. A request body is logged by none of those.
 *
 * So POST is the path a client should use, and the one the wizard (P3.8) and
 * the iOS client are told to call. The GET above is kept because removing a
 * published method is a breaking change the contract gate has no waiver for —
 * but it is the lesser option, and removing it once nothing calls it is
 * tracked in #1356.
 *
 * #1356 — THE GET IS GONE, and the quoted reasoning above turned out to be
 * wrong about the obstacle. Removing a method is not a class
 * `scripts/openapi-breaking.ts` scores at all; what the gate actually caught
 * was a `schema-removed`, because `EikCheckResult` was `$ref`-ed exactly once
 * — by the GET's own response — so deleting the method took the component with
 * it. Pointing the POST at the same component (it had been describing the
 * identical three fields as an anonymous inline object) anchors the component
 * to the surviving method, and the removal then scores clean. No contract bump
 * and no sign-off were needed. The paragraph is left standing because the
 * mistaken inference is the interesting part: the gate named a symptom, and
 * reading it as a verdict on "methods cannot be removed" deferred the fix.
 *
 * Both callers were measured first, not assumed: the web wizard POSTs
 * (`FarmWizard.tsx`), and agrent-ios POSTs only — it has never shipped a build
 * that sent the GET form, so no installed phone can send one either.
 */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        return answerEikCheck(parsed.data.eik);
    },
    {
        // Scope kept as `public-eik-check` across the GET's removal: changing
        // it would hand every caller a fresh budget at deploy.
        rateLimit: { config: PUBLIC_READ_LIMIT, scope: 'public-eik-check' },
    },
);
