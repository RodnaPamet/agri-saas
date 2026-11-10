/**
 * Translate a message for an EXPLICIT locale, outside any request scope.
 *
 * Why this exists: `Notification` stores literal `title` / `message` strings —
 * there is no key + params column, so the text is frozen in whatever language
 * the writer used. Every writer today hardcodes English, which is how a
 * Bulgarian farmer ends up with English notifications. next-intl's hooks and
 * `getTranslations()` resolve the locale from the REQUEST (the `NEXT_LOCALE`
 * cookie), which is the wrong source here: a notification is addressed to a
 * specific recipient, whose language is their persisted `User.uiLanguage` —
 * not the locale of whoever happened to trigger the write.
 *
 * So: caller passes the recipient's locale, we return the string in it.
 *
 * ## Scope / limits
 *
 * Interpolation covers next-intl's simple `{param}` placeholders only — NOT
 * ICU plural/select (`{n, plural, ...}`). That is deliberate: notification
 * copy is short and parameterised by names and counts already formatted by
 * the caller. If a message ever needs real ICU, render it through next-intl
 * at display time instead of reaching for this.
 *
 * Missing key or missing locale file falls back to {@link DEFAULT_LOCALE} and
 * finally to the key itself — a wrong-looking string in the UI is strictly
 * better than a thrown error inside a fail-open notification path.
 *
 * ## BOTH DEGRADATIONS ARE REPORTED, since #2958
 *
 * That fallback chain was entirely SILENT: no throw, no log, no metric. Two
 * different failures came out of it looking like success.
 *
 * P9.3d is what it cost. A new `ModerationActionKind` shipped with no
 * `statementOfReasons.action.<KIND>` entry, so `composeStatementBody` returned
 * the KEY, and the first Art 17 statements queued carried an action line
 * reading `statementOfReasons.action.CONTENT_AUTO_HIDDEN` — delivered, to the
 * author, as the artefact a regulator reads. Three gates were individually
 * fine and the gap sat between them: key parity compares the two catalogues to
 * EACH OTHER, so a key missing from both is perfectly balanced; the copy
 * assertion covered one hardcoded kind; and the COUNTS matched, six values
 * against six keys, one of them dead.
 *
 * So:
 *
 *   - **falling back off the requested locale is a `warn`.** A Bulgarian
 *     recipient receiving English copy is a real defect and was invisible,
 *     because the English string looks like a successful translation. `bg` is
 *     also the fallback for a recipient whose preference never loaded, so this
 *     is the common case rather than an edge one.
 *   - **returning the key is an `error`.** The reader gets a dotted path where
 *     a sentence belongs.
 *
 * **No behaviour changes.** A missing string still renders exactly as it did;
 * what is new is that it stops being silent. One change covers all ~92
 * dynamic-key call sites and every future one, with no population to maintain
 * — which is why this was chosen over a derived guard whose population cannot
 * be inferred from the key string (`${key}` says nothing about what `key`
 * ranges over).
 *
 * Deduped per `(locale, key)` per process, because a hot path with one missing
 * string would otherwise log on every render. Same shape as the
 * `AUDIT_FAIL_CLOSED_ENABLED` once-per-process warning.
 */
import { logger } from '@/lib/observability/logger';

import { DEFAULT_LOCALE, type Locale } from './locales';
import { bundleFiles } from './bundles';

type MessageTree = { [key: string]: string | MessageTree };

/** Parsed message files are immutable per process — load each at most once. */
const cache = new Map<Locale, MessageTree>();

/**
 * The parsed catalogue for one locale, or `null` if it will not load.
 *
 * Exported for `lib/errors/localize.ts` (#1677 stage 2), which renders ICU
 * through `next-intl`'s `createTranslator` and therefore needs the whole tree
 * rather than one key. Sharing this function shares the CACHE — a second
 * dynamic `import()` of the same JSON would be a second copy of ~5600 keys per
 * locale in memory, and two caches that can disagree after a hot reload.
 *
 * `translateFor` below stays as it is: simple `{param}` interpolation for
 * notification copy, exactly as its docblock scopes it.
 */
export async function loadMessagesFor(locale: Locale): Promise<MessageTree | null> {
    return loadMessages(locale);
}

async function loadMessages(locale: Locale): Promise<MessageTree | null> {
    const hit = cache.get(locale);
    if (hit) return hit;
    try {
        // Every bundle, merged (#1813). This path serves NOTIFICATIONS in a
        // recipient's language, which can name any namespace — so unlike
        // `src/i18n.ts` it has no request to narrow by and must load the lot.
        const parts = await Promise.all(
            bundleFiles().map(
                (bundle) =>
                    import(`../../../messages/${locale}/${bundle}.json`) as Promise<{
                        default: MessageTree;
                    }>,
            ),
        );
        const merged = Object.assign({}, ...parts.map((m) => m.default)) as MessageTree;
        cache.set(locale, merged);
        return merged;
    } catch {
        return null;
    }
}

/** Resolve a dotted key (`ag.offers.leadNotification.title`) to a string. */
function lookup(messages: MessageTree, key: string): string | undefined {
    let node: string | MessageTree | undefined = messages;
    for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null) return undefined;
        node = node[part];
    }
    return typeof node === 'string' ? node : undefined;
}

/** Replace `{name}` placeholders. Unknown placeholders are left verbatim. */
function interpolate(
    template: string,
    params?: Record<string, string | number>,
): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in params ? String(params[name]) : whole,
    );
}

/**
 * `(locale, key)` pairs already reported, so one missing string in a hot path
 * logs once rather than per render.
 *
 * Unbounded by design: the population is the set of BROKEN keys, which is
 * small and ought to be zero. A cap would silently stop reporting exactly when
 * a release broke many at once, which is the moment the signal matters most.
 */
const reported = new Set<string>();

/** Report at most once per `(locale, key)`, and NEVER throw. */
function reportOnce(
    level: 'warn' | 'error',
    event: string,
    locale: Locale,
    key: string,
    extra?: Record<string, unknown>,
): void {
    const seen = `${level}:${locale}:${key}`;
    if (reported.has(seen)) return;
    reported.add(seen);
    try {
        // The KEY is logged, never the resolved string: a translated value can
        // carry interpolated personal data (a name, an address), and a key is
        // a constant from the catalogue.
        logger[level](event, { component: 'i18n', locale, key, ...extra });
    } catch {
        // A missing translation must not become a thrown error because the
        // telemetry about it broke. This is the audit extension's rule, and
        // the whole point of the fallback chain below is that this path is
        // fail-open.
    }
}

export async function translateFor(
    locale: Locale,
    key: string,
    params?: Record<string, string | number>,
): Promise<string> {
    const chain = locale === DEFAULT_LOCALE ? [locale] : [locale, DEFAULT_LOCALE];
    for (const candidate of chain) {
        const messages = await loadMessages(candidate);
        const found = messages ? lookup(messages, key) : undefined;
        if (found !== undefined) {
            if (candidate !== locale) {
                // Resolved, but NOT in the language asked for. The string that
                // comes back looks like a successful translation, which is
                // precisely why this needed a log rather than a test.
                reportOnce('warn', 'i18n.locale_fallback', locale, key, {
                    servedLocale: candidate,
                });
            }
            return interpolate(found, params);
        }
    }
    // Present in NO catalogue in the chain: the caller is about to render a
    // dotted path where a sentence belongs.
    reportOnce('error', 'i18n.key_missing', locale, key, { chain });
    return key;
}
