/**
 * Email copy cannot use ICU plurals, because the server-side translator does
 * not implement them.
 *
 * `translateFor` (src/lib/i18n/server-messages.ts) resolves a key and then runs
 * `interpolate`, which is a plain `/\{(\w+)\}/` replacement. A message written
 * as `{count, plural, one {# parcel} other {# parcels}}` therefore reaches the
 * recipient's INBOX as that literal text — and an outbox row stores RENDERED
 * copy, so there is no later chance to fix it.
 *
 * Nothing reported this. The i18n parity checker compares placeholder SETS
 * between locales, so an ICU plural present in both languages looks perfectly
 * healthy; `no-hardcoded-ui-strings` walks components, not `messages/`. The
 * failure is visible only to whoever opens the mail.
 *
 * It first happened in #1121, on `insuranceLead.scopeParcels`. The fix is two
 * keys and a branch in code — see `buildInsuranceLeadEmail`.
 *
 * The RENDERED UI is a different story and deliberately out of scope: next-intl
 * runs full ICU there, so `ag.risk.quote.instalmentsOption` is correct.
 */
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

/** Namespaces rendered through `translateFor`, i.e. into email/outbox text. */
const SERVER_RENDERED_NAMESPACES = ['notificationEmail'] as const;

type Json = Record<string, unknown>;

function leafStrings(node: unknown, path: string): Array<[string, string]> {
    if (typeof node === 'string') return [[path, node]];
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
    return Object.entries(node as Json).flatMap(([k, v]) =>
        leafStrings(v, path ? `${path}.${k}` : k),
    );
}

// `, plural,` / `, select,` / `, selectordinal,` — the ICU argument forms that
// `interpolate` cannot evaluate. A bare `{name}` is fine; that it DOES handle.
const ICU_ARGUMENT = /\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/;

describe('server-rendered copy stays within what `interpolate` can render', () => {
    it.each([
        ['en', en],
        ['bg', bg],
    ])('%s: no ICU plural/select under the email namespaces', (_lang, catalogue) => {
        const offenders: string[] = [];
        for (const ns of SERVER_RENDERED_NAMESPACES) {
            const subtree = (catalogue as unknown as Json)[ns];
            for (const [path, value] of leafStrings(subtree, ns)) {
                if (ICU_ARGUMENT.test(value)) offenders.push(`${path}: ${value.slice(0, 80)}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('is not vacuous — the namespace exists and carries copy to check', () => {
        // Without this, deleting `notificationEmail` would make the guard green.
        for (const ns of SERVER_RENDERED_NAMESPACES) {
            const leaves = leafStrings((en as unknown as Json)[ns], ns);
            expect(leaves.length).toBeGreaterThan(20);
        }
    });

    it('detects an ICU plural when one is present', () => {
        // A positive control on the matcher itself, so a regex that silently
        // stopped matching could not pass this file.
        expect(ICU_ARGUMENT.test('{count, plural, one {# parcel} other {# parcels}}')).toBe(true);
        expect(ICU_ARGUMENT.test('{kind, select, a {A} other {B}}')).toBe(true);
        // …and leaves the interpolation the translator DOES support alone.
        expect(ICU_ARGUMENT.test('{count} {product} parcels')).toBe(false);
        expect(ICU_ARGUMENT.test('Area: {dca} dca')).toBe(false);
    });
});
