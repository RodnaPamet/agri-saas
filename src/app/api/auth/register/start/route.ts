/**
 * `POST /api/auth/register/start` — step 1 of registration v2 (P3.5).
 *
 * Takes an email, a password and a name; creates an UNVERIFIED user and emails
 * a 6-digit code. It deliberately creates no farm: P3.5's whole point is that
 * the email is proven before a tenant, a DEK and an OWNER membership come into
 * existence. `POST /api/auth/register/verify` is step 2, and the farm is
 * created afterwards by P3.6's `POST /api/me/farms`.
 *
 * ── the response is the same for every address, which is the design ──
 *
 * The route this supersedes answers `409 Email already registered`. That is a
 * working account-enumeration oracle: anyone can test any address and be told
 * whether a person is a customer. For a product whose users are identifiable
 * farms, that is worth closing.
 *
 * So every outcome returns `200 {ok: true}`. The difference lands in the
 * MAILBOX instead, which only its owner can read — a code for a new or
 * unverified address, "you already have an account" for a verified one (see
 * `registration-emails.ts`). The caller learns nothing; the person learns
 * exactly what they need.
 *
 * ── timing is part of the response ──
 *
 * An identical body is not enough if the branches take different times to
 * produce. bcrypt is ~100ms and everything else here is single-digit
 * milliseconds, so hashing only on the create path would make "account
 * exists" measurable to anyone with a stopwatch — the oracle would move from
 * the status code to the clock. The password is therefore hashed on EVERY
 * branch, including the ones that discard the result. That discarded work is
 * the point, not waste.
 *
 * It also stays OUTSIDE any transaction. `tests/guards/
 * tenant-creation-is-converged.test.ts` asserts that ordering for the legacy
 * route, for a reason that applies identically here: a ~100ms CPU-bound hash
 * inside a transaction holds a PgBouncer connection for its whole duration.
 *
 * ── what this route will NOT do ──
 *
 * It never overwrites an existing user's password. A second `start` for an
 * address with an unverified account reissues the CODE only. Otherwise
 * "register again with someone else's pending address" would be a password
 * reset that skips proving you own the mailbox.
 *
 * The HIBP screen is inline here rather than extracted, per #1166: on
 * 2026-08-19 the reject branch was deleted from two routes by a PR about
 * Playwright apt stalls, and the `readFileSync`-plus-regex guardrail was
 * satisfied by the remains while both routes accepted breached passwords for
 * a day. `tests/unit/register-start-route.test.ts` asserts the rejection by
 * executing it.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import prisma from '@/lib/prisma';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/passwords';
import { isDisposableEmail } from '@/lib/auth/disposable-email';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { SIGNUP_LIMIT } from '@/lib/security/rate-limit';
import { verifyTurnstile } from '@/lib/security/turnstile';
import { getClientIp } from '@/lib/rate-limit/edge-bucket';
import { logger } from '@/lib/observability/logger';
import { issueEmailVerificationCode, normaliseEmail } from '@/lib/auth/email-verification-code';
import {
    sendVerificationCodeEmail,
    sendAlreadyRegisteredEmail,
} from '@/lib/auth/registration-emails';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';

export const runtime = 'nodejs';

/**
 * The single answer this route gives.
 *
 * A named constant rather than an inline literal at four return sites,
 * because "every branch answers identically" is a security property and four
 * separate literals are four chances for one of them to drift. A reviewer can
 * check the property by grepping for the constant.
 */
const SAME_ANSWER = { ok: true } as const;

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const {
            email: rawEmail,
            password,
            name,
            turnstileToken,
        } = (body ?? {}) as Record<string, unknown>;
        if (
            typeof rawEmail !== 'string' ||
            typeof password !== 'string' ||
            typeof name !== 'string' ||
            !rawEmail ||
            !password ||
            !name
        ) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        // Bot screening (P3.5c), FIRST — before the password is hashed, before
        // the address is looked up, before anything is written. A screen that
        // ran later would still refuse the signup but would already have paid
        // for it, and bcrypt is most of what a flood costs here.
        //
        // DORMANT until `TURNSTILE_SECRET_KEY` is set: with no secret this
        // returns `skipped` and warns once per process, so the log says
        // whether the control is live. Note the asymmetry with the uniform
        // 200s below — a refusal here is distinguishable on purpose. It is a
        // statement about the REQUEST (its challenge token), not about the
        // address, so it leaks nothing about who has an account, and the
        // client has to know to reset the widget: a token is single-use, so a
        // blind retry always fails.
        const turnstile = await verifyTurnstile(turnstileToken as string | undefined, getClientIp(req));
        if (!turnstile.ok) {
            return jsonResponse(
                { error: 'turnstile_failed', codes: turnstile.codes },
                { status: 400 },
            );
        }

        // Shape errors answer differently from account state ON PURPOSE. A 400
        // for a malformed body reveals nothing about any address — it is a
        // statement about the REQUEST. Collapsing it into the uniform 200
        // would hide real client bugs behind a success.
        const policy = validatePasswordPolicy(password);
        if (!policy.ok) {
            return jsonResponse(
                {
                    error:
                        policy.reason === 'too_short'
                            ? 'Password must be at least 8 characters'
                            : policy.reason === 'too_long'
                              ? 'Password is too long'
                              : 'Password is required',
                },
                { status: 400 },
            );
        }

        // Breached-password screening. Fails OPEN on a network error — a HIBP
        // outage must not brick signup — and never logs the password or hash.
        // Inline per #1166; see the file docblock.
        const hibp = await checkPasswordAgainstHIBP(password);
        if (hibp.breached) {
            return jsonResponse(
                {
                    error: 'This password appears in known data breaches. Please choose a different password.',
                },
                { status: 400 },
            );
        }

        const email = normaliseEmail(rawEmail);

        // Known-disposable domains (P3.5a), before the address is looked up.
        // Placed here for the same two reasons the legacy route gives: it is a
        // set lookup rather than a query, and answering "already registered"
        // for a throwaway domain would confirm which throwaway addresses are
        // in use. It FAILS OPEN — an unlisted domain is allowed, because the
        // wall is email verification itself, which this route exists to put
        // in front of farm creation.
        //
        // Distinguishable from the uniform 200 on purpose, like the password
        // checks above: it is a statement about the DOMAIN the caller just
        // typed, not about any account, so it leaks nothing a caller did not
        // already know.
        if (isDisposableEmail(email)) {
            return jsonResponse({ error: 'disposable_email' }, { status: 400 });
        }

        // Hashed BEFORE the branch, and on every path. See the docblock: this
        // is what keeps the clock from saying what the status code no longer
        // does.
        const passwordHash = await hashPassword(password);

        const existing = await prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true, emailVerified: true, uiLanguage: true },
        });

        if (existing?.emailVerified) {
            // Already a real account. Create nothing, change nothing, and tell
            // the OWNER someone tried — they are the only party entitled to
            // know. `passwordHash` above is deliberately discarded.
            await sendAlreadyRegisteredEmail(email, resolveRecipientLocale(existing.uiLanguage));
            logger.info('register-start.existing_verified', {
                component: 'auth',
                event: 'register_start_existing_verified',
                userId: existing.id,
            });
            return jsonResponse(SAME_ANSWER);
        }

        if (existing) {
            // Unverified account: a resumed signup, or a second attempt after
            // the code expired. Reissue the code and leave the credential
            // alone — see the docblock on why the password is not rewritten.
            const code = await issueEmailVerificationCode(email);
            await sendVerificationCodeEmail(email, code, resolveRecipientLocale(existing.uiLanguage));
            logger.info('register-start.code_reissued', {
                component: 'auth',
                event: 'register_start_code_reissued',
                userId: existing.id,
            });
            return jsonResponse(SAME_ANSWER);
        }

        const user = await prisma.user.create({
            data: {
                email,
                emailHash: hashForLookup(email),
                passwordHash,
                name,
                // Explicitly null: this is the state the whole phase turns on,
                // and P3.5e's sweep selects on it. Relying on the column
                // default would leave the most load-bearing field in this
                // insert invisible at the call site.
                emailVerified: null,
            },
            select: { id: true, uiLanguage: true },
        });

        const code = await issueEmailVerificationCode(email);
        await sendVerificationCodeEmail(email, code, resolveRecipientLocale(user.uiLanguage));

        logger.info('register-start.user_created_unverified', {
            component: 'auth',
            event: 'register_start_user_created',
            userId: user.id,
        });
        return jsonResponse(SAME_ANSWER);
    },
    {
        // Same tier as the legacy signup. This route both writes a row and
        // sends mail for an unauthenticated caller, so the limit is the only
        // thing standing between it and using someone else's mailbox as a
        // target — a uniform response does not help with volume.
        rateLimit: { config: SIGNUP_LIMIT, scope: 'register-start' },
    },
);
