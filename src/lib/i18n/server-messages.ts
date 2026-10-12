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
 */
import { DEFAULT_LOCALE, type Locale } from './locales';

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
        const mod = (await import(`../../../messages/${locale}.json`)) as {
            default: MessageTree;
        };
        cache.set(locale, mod.default);
        return mod.default;
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

export async function translateFor(
    locale: Locale,
    key: string,
    params?: Record<string, string | number>,
): Promise<string> {
    for (const candidate of locale === DEFAULT_LOCALE ? [locale] : [locale, DEFAULT_LOCALE]) {
        const messages = await loadMessages(candidate);
        const found = messages ? lookup(messages, key) : undefined;
        if (found !== undefined) return interpolate(found, params);
    }
    return key;
}
