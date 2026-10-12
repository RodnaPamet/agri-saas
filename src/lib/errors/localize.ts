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
 * ## A code may vary by its `reason`
 *
 * `errors.<CODE>.<reason>` is tried before `errors.<CODE>` when the error
 * carries a `reason` param. `MODULE_DISABLED` needs it: the remedy differs by
 * which half of a conjunction failed, and naming a farm administrator when the
 * PLAN is what excludes the module is the agrent-ios#241 defect — a farmer
 * sent to somebody who cannot help.
 *
 * Two keys rather than ICU `select`, because `translateFor` deliberately
 * supports only simple `{param}` placeholders and says so.
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
import type { ApiErrorResponse } from './types';
import { translateFor } from '@/lib/i18n/server-messages';
import { resolveRequestLocale } from '@/lib/i18n/request-locale';
import { logger } from '@/lib/observability/logger';

/** The catalogue namespace. `errors.PLAN_LIMIT_EXCEEDED`, and so on. */
const NS = 'errors';

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
        const reason = typeof params?.reason === 'string' ? params.reason : null;

        // Most specific first. A `reason` variant that does not exist falls
        // through to the plain code, so adding `reason` to an error never
        // breaks its message.
        for (const key of reason ? [`${NS}.${code}.${reason}`, `${NS}.${code}`] : [`${NS}.${code}`]) {
            const text = await translateFor(locale, key, params);
            // `translateFor` returns the key verbatim when it finds no entry.
            // That is the documented behaviour and the only absence signal it
            // offers, so comparing against the key is the detector rather than
            // a second "does this key exist" lookup that could disagree.
            if (text !== key) {
                payload.error.message = text;
                return;
            }
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
