/**
 * Put a refusal's `message` into the reader's language (#1677).
 *
 * ## The decision this implements
 *
 * Owner ruling on #1677: the SERVER resolves the locale and sends `message`
 * already translated, so neither client needs a code catalogue.
 *
 * That was chosen over two alternatives, and the measurements are on the
 * issue: 130 of 138 literal `coded*()` messages were English prose, the web
 * renders `message` directly in 37 components and reads the error `code`
 * NOWHERE, and the phone shows `message` verbatim for any code it has no
 * sentence for. So the field is displayed copy on both clients, and the two
 * wanted opposite conventions for it. One server-side catalogue is the only
 * answer that needs nothing from either client.
 *
 * ## Absent key => unchanged message, and that is the whole migration strategy
 *
 * `translateFor` returns the KEY when it finds no entry, which this uses as
 * the detector: a code with no catalogue entry keeps the message it has today,
 * byte for byte. So the 100 codes still carrying English prose are untouched
 * and can be migrated a family at a time, each family a small reviewable diff,
 * with nothing half-migrated in between.
 *
 * The alternative — translate everything at once — would be 100 judgement
 * calls about Bulgarian legal and agricultural phrasing in one PR, which is
 * the shape of change nobody can review.
 *
 * ## ICU, via `next-intl` — and why not `translateFor`
 *
 * Stage 1 rendered through `translateFor`, which supports simple `{param}`
 * only and says so deliberately. `agrent-ios` then reviewed the Bulgarian and
 * three of five sentences needed **plural agreement**: after a numeral,
 * Bulgarian differs by gender (1 локация / 5 локации, 1 потребител /
 * 5 потребителя). Those sentences through `translateFor` would have put
 * literal `{limit, plural, …}` braces in a farmer's message.
 *
 * `server-messages.ts` pointed at the fix in its own docblock — "if a message
 * ever needs real ICU, render it through next-intl at display time instead of
 * reaching for this" — so this uses `createTranslator`. `translateFor` keeps
 * its scope for notification copy.
 *
 * String params pluralise correctly (`{ limit: '5' }` → «5 локации»), measured
 * rather than assumed, so `ErrorParams`' string values need no coercion.
 *
 * ## A code may vary by a DISCRIMINATOR param
 *
 * `errors.<CODE>.<value>` is tried before `errors.<CODE>`, for each param in
 * `DISCRIMINATORS`. Two codes need it and they use different params:
 *
 *   `PLAN_LIMIT_EXCEEDED`  by `resource` — the noun has to be translated and
 *                          declined, so «обяви в Борсата» and «локации» are
 *                          separate sentences rather than one with the wire
 *                          identifier interpolated.
 *   `MODULE_DISABLED`      by `reason` — the remedy differs by which half of a
 *                          conjunction failed, and naming a farm administrator
 *                          when the PLAN excludes the module is the
 *                          agrent-ios#241 defect.
 *   `ADMIN_FORBIDDEN_FOR_ROLE` and `AUDIT_FORBIDDEN_FOR_ROLE`
 *                          by `role` — added for #1919, which caught the
 *                          rule below being broken by the very change that
 *                          wrote it down. Those two shipped with `({role})`
 *                          interpolated, so a Bulgarian farmer read «Вашата
 *                          роля в това стопанство (EDITOR) не позволява…» —
 *                          a Bulgarian sentence with an English enum inside
 *                          it. Worse, the test asserted `toContain('EDITOR')`
 *                          and locked it in.
 *
 * Separate keys rather than one ICU `select`, because a translator editing
 * Bulgarian should see whole sentences, not a nested selector.
 *
 * The rule those two cases taught, from `agrent-ios` and now applied to the
 * remaining codes: **a `{param}` belongs in a sentence only if it is a NUMBER
 * or a NAME THE PERSON TYPED.** An enum value on the wire — `resource`,
 * `tier`, `ceiling`, `module`, `plan` — gets a translated table or stays out.
 *
 * ## Why here and not inside `toApiErrorResponse`
 *
 * That function is synchronous and deliberately Edge-safe — it detects Prisma
 * errors by shape rather than importing Prisma. Loading a message catalogue is
 * neither. So the sync mapper keeps its contract and this async step runs at
 * the one production call site, inside `withApiErrorHandling`'s catch.
 *
 * ## Never throws
 *
 * A refusal that failed to translate is still a refusal. Falling back to the
 * untranslated message is always correct; failing the response to localise it
 * would be the tail wagging the dog.
 */
import { createTranslator } from 'next-intl';

import type { ApiErrorResponse } from './types';
import { loadMessagesFor } from '@/lib/i18n/server-messages';
import { resolveRequestLocale } from '@/lib/i18n/request-locale';
import { logger } from '@/lib/observability/logger';

/** The catalogue namespace. `errors.PLAN_LIMIT_EXCEEDED`, and so on. */
const NS = 'errors';

/**
 * Params that may select a sentence variant, most specific first.
 *
 * `resource` before `reason` because no code carries both today and the order
 * has to be defined rather than incidental: if one ever does, the subject of
 * the refusal is the more specific discriminator.
 *
 * `role` LAST, by the same reasoning taken one step further: `resource` and
 * `reason` describe the SUBJECT of the refusal, `role` describes the CALLER,
 * and the subject is the more specific fact about a refusal. No code carries
 * `role` alongside either today.
 */
const DISCRIMINATORS = ['resource', 'reason', 'role'] as const;

/** `createTranslator`'s surface, with keys known only at runtime. */
interface DynamicTranslator {
    (key: string, values?: Record<string, string | number>): string;
    has(key: string): boolean;
}

/**
 * Replace `payload.error.message` with the catalogue's sentence for its code,
 * in the request's locale, when there is one. Mutates in place and resolves to
 * nothing — the caller already holds the payload.
 */
export async function localizeErrorPayload(payload: ApiErrorResponse): Promise<void> {
    try {
        const { code, params } = payload.error;
        if (!code) return;

        const locale = resolveRequestLocale();
        const messages = await loadMessagesFor(locale);
        if (!messages) return;

        // `onError` swallowed: a missing key is how absence is DETECTED here,
        // not a fault, and next-intl's default handler logs every miss at
        // error level. `t.has` is the signal instead.
        // Cast to a dynamic-key signature. `createTranslator` types `t`
        // against the SHAPE of the messages it was given, so a key that is
        // only known at runtime — an error code — resolves to `never`. That
        // typing is right for a component with literal keys and cannot
        // express this caller, so the cast is the narrow, honest escape rather
        // than widening the catalogue's type everywhere.
        const t = createTranslator({
            locale,
            messages: messages as Record<string, unknown>,
            onError: () => {},
        }) as unknown as DynamicTranslator;

        // Most specific first. A variant that does not exist falls through to
        // the plain code, so adding a discriminator param to an error never
        // breaks its message.
        const keys = [
            ...DISCRIMINATORS.flatMap((name) => {
                const v = params?.[name];
                return typeof v === 'string' && v ? [`${NS}.${code}.${v}`] : [];
            }),
            // The variant table's own fallback, for a discriminator value with
            // no sentence — an unknown `GatedResource`, say. Named rather than
            // positional so a translator editing the file can see what it is.
            `${NS}.${code}.default`,
            // A code whose entry is a flat string.
            `${NS}.${code}`,
        ];

        for (const key of keys) {
            // BOTH checks, and the second is not redundant.
            //
            // `t.has('errors.PLAN_LIMIT_EXCEEDED')` returns TRUE for that
            // code, because its entry is a variant TABLE and `has` answers for
            // a namespace node. `t()` on a namespace then returns the KEY
            // itself — so a `has`-only detector would put the literal string
            // `errors.PLAN_LIMIT_EXCEEDED` in front of a farmer, which is the
            // exact failure `never leaves a KEY where a sentence belongs`
            // exists to catch. Measured against next-intl, not assumed.
            if (!t.has(key)) continue;
            const text = t(key, params);
            if (text === key) continue;
            payload.error.message = text;
            return;
        }
    } catch (err) {
        // The log is itself in a try/catch, and that is NOT belt-and-braces.
        // `logger` enriches every line from `getRequestContext()` — the very
        // thing this handler may be here because it failed to read. So logging
        // the failure can reproduce it, and an error handler that throws turns
        // a 403 into a 500: the refusal is lost to the attempt to explain why
        // it could not be translated.
        //
        // Found by the "never throws" test, which asserted the promise
        // resolves. It rejected.
        try {
            logger.warn('errors.localize_failed', {
                component: 'error-localize',
                errorCode: payload.error.code,
                error: err instanceof Error ? err.message : String(err),
            });
        } catch {
            // Nothing left to do: the message stays as it was, which is the
            // correct outcome and the one the caller already has.
        }
    }
}
