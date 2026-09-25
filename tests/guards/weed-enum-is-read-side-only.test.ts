/**
 * The weed enum belongs on the READ side and must not reach the write.
 *
 * `weedKeys` in a response is catalogue values only — the server matched them
 * against its own vocabulary — so publishing the set lets a client offer a
 * verifiable picker instead of a list it invented. That was the gap: thirteen
 * values the server splits against, exposed nowhere, so a farmer who typed one
 * with a letter wrong dropped silently out of the reportable half.
 *
 * But `weeds` on the REQUEST accepts catalogue values AND free text in one
 * array, and the server splits them. Constraining that side would forbid the
 * free text the split exists to handle — the feature, not a loophole. The
 * obvious implementation of "publish the catalogue" puts the enum on the write
 * field and breaks recording a weed the catalogue does not know, which is the
 * case a farmer in a field is most likely to hit.
 *
 * So this pins the asymmetry in both directions, because either half alone
 * reads as reasonable.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

describe('the weed catalogue is published for reads, not enforced on writes', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as {
        components: { schemas: Record<string, { properties?: Record<string, { items?: { enum?: string[] } }> }> };
    };
    const schemas = spec.components.schemas;

    it('the READ side publishes the catalogue', () => {
        const items = schemas.ParcelWeedObservation?.properties?.weedKeys?.items;
        expect(items?.enum).toBeDefined();
        // A floor rather than an exact count: the catalogue may grow, and a
        // guard that has to be edited to add a weed is one that gets edited
        // without being read.
        expect((items?.enum ?? []).length).toBeGreaterThanOrEqual(13);
        expect(items?.enum).toContain('Sorghum halepense');
    });

    it('the WRITE side does NOT constrain to it', () => {
        const items = schemas.CreateParcelWeedObservation?.properties?.weeds?.items;
        // Present, so the assertion is about this field and not about a typo.
        expect(items).toBeDefined();
        expect(items?.enum).toBeUndefined();
    });
});
