/**
 * A guard whose selecting happens INLINE inside `it()`, used as the second
 * self-test fixture for `scripts/selector-teeth.mjs`.
 *
 * There is no module-level function here, so the tool has nothing to gut —
 * it deliberately never mutates functions declared inside `it()` / `describe()`,
 * because those are assertions rather than population selectors.
 *
 * That makes this the shape the tool CANNOT audit, and until the `candidates`
 * count existed it reported `all selectors have teeth` for a file like this:
 * a clean bill of health from a run that examined nothing. 188 of 617 guard
 * files are this shape. The companion is `selector-teeth-selftest.test.ts`,
 * which carries a deliberately toothless module-level selector.
 *
 * NOT under tests/guards, so the suite never runs it as a real guard.
 */
describe('selector-teeth inline-only fixture', () => {
    it('selects inside the assertion, where the tool cannot reach', () => {
        const haystack = ['ok_one', 'ok_two'];
        // The selection and the assertion are the same expression. Nothing at
        // module scope can be gutted to make this pass vacuously — which is
        // exactly why the tool has no purchase on it.
        expect(haystack.filter((h) => h.startsWith('BAD_'))).toEqual([]);
    });
});
