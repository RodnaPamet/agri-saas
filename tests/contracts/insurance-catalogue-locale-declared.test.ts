/**
 * The catalogue's `?locale=` must be DECLARED in the document, not only honoured
 * by the route.
 *
 * A generated client sends what the document names and nothing else. The
 * operation shipped with `tenantSlug` as its only parameter, so a client built
 * from the spec never asked for a language, fell through to the deliberate `en`
 * default, and was served English product names — as DATA, which is the one
 * route a client's own localisation guards cannot see.
 *
 * That is the same hole as `required: ['parcelId']` on the lead request: a
 * constraint the document does not carry is one every new client gets wrong, and
 * "we always send it" is luck rather than a contract. Both were reported by the
 * iOS client after building against the document rather than against prose — the
 * second one after the first had already been fixed, which is the point: closing
 * one door does not close the others.
 *
 * Asserted against the GENERATED spec, because that is the artefact a client
 * consumes. Checking the source that produces it would test my intent.
 */
import spec from '@/generated/openapi.json';
import { LOCALES } from '@/lib/i18n/locales';

const OPERATION = '/api/t/{tenantSlug}/insurance/products';

interface Param {
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: { enum?: string[] };
}

function parameters(): Param[] {
    const paths = (spec as unknown as { paths: Record<string, { get?: { parameters?: Param[] } }> }).paths;
    const op = paths[OPERATION]?.get;
    expect(op).toBeDefined();
    return op!.parameters ?? [];
}

describe('the catalogue operation declares its locale parameter', () => {
    it('is documented at all, which is the regression this exists for', () => {
        const locale = parameters().find((p) => p.name === 'locale');
        expect(locale).toBeDefined();
        expect(locale!.in).toBe('query');
    });

    it('offers exactly the locales the app supports, derived not restated', () => {
        // Derived from LOCALES, so adding a language cannot leave the document
        // describing a narrower set than the server accepts.
        const locale = parameters().find((p) => p.name === 'locale')!;
        expect(locale.schema?.enum?.slice().sort()).toEqual([...LOCALES].sort());
    });

    it('is optional, because the endpoint has a real fallback', () => {
        // Optional but declared: a client CAN omit it and get `en`. The defect
        // was never that it was required — it was that it was invisible.
        expect(parameters().find((p) => p.name === 'locale')!.required ?? false).toBe(false);
    });

    it('tells a client to send it rather than rely on the fallback', () => {
        // The description is the only place a human learns that
        // `Accept-Language` is ignored on purpose.
        const d = parameters().find((p) => p.name === 'locale')!.description ?? '';
        expect(d).toMatch(/Accept-Language/);
        expect(d.length).toBeGreaterThan(40);
    });

    it('is not vacuous — the operation really is the one with the tenant path param', () => {
        // If the path key were wrong every assertion above would fail rather
        // than pass, but pin the shape so a rename is loud instead of silent.
        expect(parameters().some((p) => p.name === 'tenantSlug' && p.in === 'path')).toBe(true);
    });
});
