/**
 * A guard with a DELIBERATELY toothless selector, used as the self-test for
 * `scripts/selector-teeth.mjs`.
 *
 * `pick()` can be gutted to `return []` and the assertion below still passes,
 * because `toEqual([])` is satisfied by an empty selection. That is the defect
 * the tool exists to find, so the tool must find it here on every run —
 * otherwise a CI job that reports "no dead selectors" is indistinguishable from
 * one whose detector is broken.
 *
 * NOT under tests/guards, so the suite never runs it as a real guard.
 */
export function pick(haystack: string[]): string[] {
    return haystack.filter((h) => h.startsWith('BAD_'));
}

describe('selector-teeth self-test fixture', () => {
    it('has no offenders — and cannot tell that from having no selector', () => {
        expect(pick(['ok_one', 'ok_two'])).toEqual([]);
    });
});
