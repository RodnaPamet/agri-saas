/**
 * The leaflet read offers the model NO slot for a ПРЗ registration number
 * (#2664).
 *
 * `Promotion.pppRegistrationNo` decides whether Reg. (EC) 1107/2009 Art 66
 * applies to a promotion — prescribed safety wording, prohibited claim types —
 * so it decides which legal regime the thing is advertised under. Its own
 * schema docblock is explicit that it is "set by the owner at REVIEW time,
 * resolved against `PppRegisterEntry`" and "deliberately not derived from the
 * AI read of a supplier leaflet: a misread registration number would silently
 * reclassify a pesticide as a fertiliser, which is the one error in this
 * feature that matters."
 *
 * A model cannot report a value there is no slot for. That is a guarantee;
 * "we don't read that field" is a convention somebody can tidy away, and
 * adding the field would look like an improvement — the read already sees the
 * leaflet, so why not let it fill one more box.
 *
 * ## It asserts on the SERIALISED schema, not this repo's source text
 *
 * `z.toJSONSchema` output is what the model is actually offered. A field added
 * through a nested object, a `.extend()`, or a differently-spelled key
 * (`pppNo`, `registrationNumber`) would satisfy a source grep for
 * `pppRegistrationNo` and still reach the model. So the check walks the
 * generated document and matches a FAMILY of spellings at any depth.
 */
import { z } from 'zod';

import { LeafletReadSchema } from '@/app-layer/ai/promotion-leaflet-reader';

/** Keys that would hand the model the ПРЗ classification, however spelled. */
const FORBIDDEN_KEY = /ppp|plantprotection|registrationno|registrationnumber|babh|prz/i;

/** Every property name in a JSON Schema document, at any depth. */
export function propertyNames(node: unknown, out: string[] = []): string[] {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) propertyNames(item, out);
        return out;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            out.push(...Object.keys(value as Record<string, unknown>));
        }
        propertyNames(value, out);
    }
    return out;
}

describe('#2664 — the leaflet read cannot propose a ПРЗ registration number', () => {
    const json = z.toJSONSchema(LeafletReadSchema, { target: 'draft-7', io: 'input' });
    const names = propertyNames(json);

    it('the generated schema has properties at all — the control', () => {
        // Without this, an extractor that walked nothing would report no
        // forbidden keys and pass for ever.
        expect(names).toContain('isLeaflet');
        expect(names).toContain('offers');
        expect(names).toContain('productName');
        expect(names.length).toBeGreaterThanOrEqual(6);
    });

    it('offers the model no plant-protection field, under any spelling', () => {
        expect(names.filter((n) => FORBIDDEN_KEY.test(n))).toEqual([]);
    });

    it('the walker finds a nested property — so the absence above means something', () => {
        // `productName` is inside `offers.items.properties`, two levels down.
        // A walker that only read the top level would miss a field added
        // there, which is the likeliest place one would be added.
        const nested = z.toJSONSchema(
            z.object({ outer: z.array(z.object({ pppRegistrationNo: z.string() })) }),
            { target: 'draft-7', io: 'input' },
        );
        expect(propertyNames(nested)).toContain('pppRegistrationNo');
        expect(propertyNames(nested).filter((n) => FORBIDDEN_KEY.test(n))).toHaveLength(1);
    });

    it('matches the spellings somebody would actually reach for', () => {
        for (const k of ['pppRegistrationNo', 'pppNo', 'registrationNumber', 'babhNumber', 'przCode']) {
            expect(FORBIDDEN_KEY.test(k)).toBe(true);
        }
        // And not the legitimate ones, or the guard would block the real read.
        for (const k of ['productName', 'priceText', 'companyName', 'validityText', 'note']) {
            expect(FORBIDDEN_KEY.test(k)).toBe(false);
        }
    });
});
