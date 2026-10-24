/**
 * `resolveTranslationCalls` — the contract, pinned (#2226).
 *
 * The resolver moved out of `tests/guards/i18n-key-exists.test.ts` so
 * `destructive-vocabulary` could reuse it. Two suites now depend on its scope
 * handling, and the precedent for pinning a shared helper's contract is
 * `blank-non-code-contract.test.ts`, written after two inputs broke that one in
 * 13 of 2,223 source files.
 *
 * The cases below are the ones that have ALREADY been wrong in this repo, not
 * imagined ones:
 *
 *   · a file binding `const t` to two different namespaces in two scopes —
 *     the reason a file-global map is wrong;
 *   · `const [t, tc] = await Promise.all([...])`, which bound nothing for `t`
 *     and silently skipped 56 literal calls in four page files (#1703);
 *   · a parameter named `t`, which must SHADOW an outer binding rather than
 *     inherit it.
 *
 * A fixture suite, not a sweep: each case is a shape somebody wrote on
 * purpose, where `blank-non-code`'s breakages were accidents nobody would
 * author. The real-file coverage is `i18n-key-exists` itself, which runs the
 * resolver over `src/app`, `src/components` and `src/lib` and asserts the
 * resolved count.
 */
import { resolveTranslationCalls, keyInRange } from './i18n-key-resolver';

/** Resolve a fixture without writing it to disk. */
function keys(src: string): string[] {
    return resolveTranslationCalls('fixture.tsx', src).calls.map((c) => c.key);
}

describe('the namespace comes from the binding IN SCOPE', () => {
    it('prefixes a literal key with its binding namespace', () => {
        expect(keys("const t = useTranslations('grain'); t('title');")).toEqual(['grain.title']);
    });

    it('reads a namespace per SCOPE, not per file', () => {
        // The case a file-global name→namespace map gets wrong, and this repo
        // has real files shaped like it.
        const src = `
            function A() { const t = useTranslations('alpha'); return t('x'); }
            function B() { const t = useTranslations('beta');  return t('x'); }
        `;
        expect(keys(src).sort()).toEqual(['alpha.x', 'beta.x']);
    });

    it('treats a no-argument binder as absolute keys', () => {
        expect(keys("const t = useTranslations(); t('a.b.c');")).toEqual(['a.b.c']);
    });

    it('reads the object form of getTranslations', () => {
        expect(keys("const t = await getTranslations({ locale: 'bg', namespace: 'ns' }); t('k');"))
            .toEqual(['ns.k']);
    });

    it('resolves the keyed members too', () => {
        const src = "const t = useTranslations('ns'); t.rich('a'); t.raw('b'); t.has('c');";
        expect(keys(src).sort()).toEqual(['ns.a', 'ns.b', 'ns.c']);
    });
});

describe('shadowing — an outer binding must not answer for an inner name', () => {
    it('a PARAMETER named t shadows the binding', () => {
        const src = `
            const t = useTranslations('ns');
            items.map((t) => t('inner'));
        `;
        // `t('inner')` resolves through the parameter, which is not a
        // translator — so it is not reported at all.
        expect(keys(src)).toEqual([]);
    });

    it('a non-translator declaration shadows it', () => {
        const src = `
            const t = useTranslations('ns');
            { const t = somethingElse(); t('inner'); }
        `;
        expect(keys(src)).toEqual([]);
    });

    it('a destructured binding shadows rather than inheriting', () => {
        // `const [t] = pair()` used to leave an enclosing `t` answering for it.
        const src = `
            const t = useTranslations('ns');
            function inner() { const [t] = pair(); return t('x'); }
        `;
        expect(keys(src)).toEqual([]);
    });
});

describe('positional Promise.all destructuring (#1703)', () => {
    it('pairs each binding with its own factory BY POSITION', () => {
        const src = `
            const [t, tc, ctx] = await Promise.all([
                getTranslations('evidence'),
                getTranslations('common'),
                getTenantCtx({ tenantSlug }),
            ]);
            t('a'); tc('b');
        `;
        expect(keys(src).sort()).toEqual(['common.b', 'evidence.a']);
    });

    it('a position that is NOT a translator binds nothing resolvable', () => {
        const src = `
            const [ctx, t] = await Promise.all([getTenantCtx(), getTranslations('ns')]);
            ctx('a'); t('b');
        `;
        // `ctx` is position 0 — not a translator — so only `t` resolves.
        expect(keys(src)).toEqual(['ns.b']);
    });
});

describe('what it refuses to guess', () => {
    it('counts a dynamic KEY instead of resolving it', () => {
        const r = resolveTranslationCalls('f.tsx', "const t = useTranslations('ns'); t(someVar);");
        expect(r.calls).toEqual([]);
        expect(r.counts.dynamicCalls).toBe(1);
        expect(r.counts.staticCalls).toBe(0);
    });

    it('counts a template key as dynamic, not as its raw text', () => {
        const r = resolveTranslationCalls('f.tsx', "const t = useTranslations('ns'); t(`a.${b}`);");
        expect(r.calls).toEqual([]);
        expect(r.counts.dynamicCalls).toBe(1);
    });

    it('skips every call through a dynamic NAMESPACE', () => {
        const r = resolveTranslationCalls('f.tsx', "const t = useTranslations(someVar); t('x');");
        expect(r.calls).toEqual([]);
        // Not counted as dynamic either: the binding never resolved, so the
        // call was never attributed to a namespace to begin with.
        expect(r.counts.dynamicCalls).toBe(0);
    });

    it('ignores a call through no binding at all', () => {
        expect(keys("somethingUnrelated('x');")).toEqual([]);
    });
});

describe('positions, which is what the JSX caller needs', () => {
    it('reports the CALL EXPRESSION span, so an attribute range contains it', () => {
        const src = `const t = useTranslations('ns');\nconst el = <Dialog confirmLabel={t('del')} />;`;
        const { calls } = resolveTranslationCalls('f.tsx', src);
        const call = calls.find((c) => c.literal === 'del')!;
        expect(src.slice(call.start, call.end)).toBe("t('del')");
    });

    it('keyInRange finds the one key inside a span', () => {
        const src = `const t = useTranslations('ns');\nconst el = <D confirmLabel={t('del')} />;`;
        const { calls } = resolveTranslationCalls('f.tsx', src);
        const attr = src.indexOf('confirmLabel');
        const found = keyInRange(calls, attr, src.indexOf('/>'));
        expect(found?.key).toBe('ns.del');
    });

    it('keyInRange returns null for TWO keys in one span — a guess would be worse', () => {
        const src = `const t = useTranslations('ns');\nconst el = <D label={cond ? t('a') : t('b')} />;`;
        const { calls } = resolveTranslationCalls('f.tsx', src);
        expect(keyInRange(calls, src.indexOf('label='), src.indexOf('/>'))).toBeNull();
    });

    it('keyInRange returns null for a span with no key', () => {
        const src = `const t = useTranslations('ns');\nconst el = <D label="literal" />;\nt('elsewhere');`;
        const { calls } = resolveTranslationCalls('f.tsx', src);
        expect(keyInRange(calls, src.indexOf('label='), src.indexOf('/>'))).toBeNull();
    });

    it('reports a 1-based line a person can open', () => {
        const src = `const t = useTranslations('ns');\n\n\nt('third');`;
        const { calls } = resolveTranslationCalls('f.tsx', src);
        expect(calls.find((c) => c.literal === 'third')?.line).toBe(4);
    });
});
