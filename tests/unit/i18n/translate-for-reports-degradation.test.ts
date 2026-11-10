/**
 * `translateFor` reports both of its silent degradations — #2958.
 *
 * ## What was silent, and what it cost
 *
 * The fallback chain is `[requested, DEFAULT_LOCALE]` and then `return key`:
 * no throw, no log, no metric. Two different failures came out of it looking
 * like success.
 *
 * P9.3d is the instance. A new `ModerationActionKind` shipped with no
 * `statementOfReasons.action.<KIND>` entry, so `composeStatementBody` returned
 * the key and the first Art 17 statements queued carried an action line
 * reading `statementOfReasons.action.CONTENT_AUTO_HIDDEN` — delivered, to the
 * author, as the artefact a regulator reads. Key parity could not see it
 * (it compares the two catalogues to EACH OTHER, so a key missing from both is
 * balanced), the copy assertion covered one hardcoded kind, and the counts
 * matched.
 *
 * ## Two levels, because they are different defects
 *
 * A total miss renders a dotted path where a sentence belongs — `error`.
 * Falling back off the requested locale renders a perfectly good ENGLISH
 * sentence to a Bulgarian recipient — `warn`, and the harder of the two to
 * notice precisely because the output looks right.
 *
 * ## The mock is the real logger's shape, asserted by FIELD
 *
 * Asserting the message string alone would pass for a log that named the wrong
 * key, which is the one field a reader needs. And the resolved VALUE must
 * never be logged: a translated string can carry interpolated personal data,
 * while a key is a constant.
 */
const warn = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        error: (...a: unknown[]) => error(...a),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

describe('translateFor reports its degradations (#2958)', () => {
    let translateFor: typeof import('@/lib/i18n/server-messages').translateFor;

    beforeEach(async () => {
        warn.mockClear();
        error.mockClear();
        // RE-IMPORTED per test, because the dedup Set is module state: a second
        // test asserting the same `(locale, key)` would see nothing and read as
        // "the report was dropped".
        jest.resetModules();
        ({ translateFor } = await import('@/lib/i18n/server-messages'));
    });

    it('a key present in NEITHER catalogue logs an ERROR and returns the key', async () => {
        const key = 'nonsense.absent.everywhere';
        const out = await translateFor('bg', key);

        expect(out).toBe(key);
        expect(error).toHaveBeenCalledTimes(1);
        const [event, fields] = error.mock.calls[0]!;
        expect(event).toBe('i18n.key_missing');
        expect(fields).toMatchObject({ component: 'i18n', locale: 'bg', key });
        // Not a fallback: nothing resolved, so claiming a served locale would
        // be false.
        expect(warn).not.toHaveBeenCalled();
    });

    it('a key present only in `en` logs a WARN naming both locales', async () => {
        // THE HARD CASE. The caller gets a correct English sentence, so the
        // output carries no evidence that anything went wrong — which is why
        // this needed a log and could not be left to a test of the return
        // value.
        const en = await import('../../../messages/en/app.json');
        const bg = await import('../../../messages/bg/app.json');
        const tree = (en as unknown as { default: Record<string, unknown> }).default;
        const bgTree = (bg as unknown as { default: Record<string, unknown> }).default;
        // Find a REAL key that exists in en and not in bg. If the catalogues
        // are in parity there is none — which is the normal state — so the
        // case is driven through a locale with no catalogue at all instead.
        const enOnly = Object.keys(tree).find((k) => !(k in bgTree));
        expect(enOnly).toBeUndefined(); // the catalogues ARE in parity

        // `de` has no bundle, so every lookup falls through to `en`.
        const out = await translateFor('de' as never, 'errors.CHANNEL_NOT_FOUND');
        expect(typeof out).toBe('string');
        expect(out).not.toBe('errors.CHANNEL_NOT_FOUND');

        expect(warn).toHaveBeenCalledTimes(1);
        const [event, fields] = warn.mock.calls[0]!;
        expect(event).toBe('i18n.locale_fallback');
        expect(fields).toMatchObject({
            component: 'i18n',
            locale: 'de',
            servedLocale: 'en',
            key: 'errors.CHANNEL_NOT_FOUND',
        });
        expect(error).not.toHaveBeenCalled();
    });

    it('a key resolved in the REQUESTED locale logs NOTHING', async () => {
        // THE CONTROL. Without it every assertion above would pass for an
        // implementation that logged on every call, and the signal would be
        // noise within a day.
        const out = await translateFor('bg', 'errors.CHANNEL_NOT_FOUND');
        expect(out).toBe('Такъв канал не съществува.');
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it('DEDUPES per (locale, key) — a hot path logs once, not per render', async () => {
        const key = 'nonsense.repeated.key';
        for (let i = 0; i < 5; i += 1) await translateFor('bg', key);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('a DIFFERENT key is reported even after one has been', async () => {
        // The other half of dedup, and the direction that fails dangerously:
        // a Set keyed too coarsely (on the locale alone, say) would report the
        // first broken key of a release and swallow every other.
        await translateFor('bg', 'nonsense.first');
        await translateFor('bg', 'nonsense.second');
        expect(error).toHaveBeenCalledTimes(2);
        expect(error.mock.calls.map((c) => (c[1] as { key: string }).key))
            .toEqual(['nonsense.first', 'nonsense.second']);
    });

    it('NEVER logs the resolved string', async () => {
        // A translated value can carry interpolated personal data — a name, an
        // address — and the log is a different retention domain from the row.
        // The key is a catalogue constant and is safe.
        //
        // THE RESOLVED VALUE IS READ FROM THE CALL, not written as a literal.
        // The first draft asserted `not.toContain('Такава публикация не
        // съществува.')` — a string this key never returns, so the negation
        // passed over nothing and would have passed with the value logged. An
        // absence is only evidence when the thing absent is the thing that
        // would be there.
        const out = await translateFor('de' as never, 'errors.CHANNEL_NOT_FOUND');
        expect(out).toBe('That channel does not exist.');

        const fields = warn.mock.calls[0]![1] as Record<string, unknown>;
        expect(JSON.stringify(fields)).not.toContain(out);
        // And the KEY is present, so the log is useful rather than merely
        // harmless — a report naming no key would also satisfy the line above.
        expect(fields).toMatchObject({ key: 'errors.CHANNEL_NOT_FOUND' });
    });

    it('a throwing logger does not break the translation', async () => {
        // The fallback chain exists so a missing string never throws inside a
        // fail-open notification path. Telemetry about the failure must not
        // reintroduce the throw — the audit extension's rule.
        error.mockImplementation(() => {
            throw new Error('transport down');
        });
        await expect(translateFor('bg', 'nonsense.logger.throws'))
            .resolves.toBe('nonsense.logger.throws');
    });
});
