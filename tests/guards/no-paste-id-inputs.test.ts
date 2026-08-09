/**
 * Ratchet: no "paste an entity ID here" free-text inputs.
 *
 * Linking a task/evidence/etc. to a practice/risk/asset/vendor must go
 * through a typeahead picker (`<EntityPicker>` / `<Combobox>` /
 * `<UserCombobox>`), never a free-text box that asks the operator to
 * paste a cuid by hand — users never know their cuids. Several legacy
 * forms did this ("Paste practice ID to link"); they've been migrated.
 *
 * This guard fails if a new free-text entity-id box reappears: a
 * placeholder of the shape "Paste <thing> ID …" anywhere under
 * src/app. (The SSO "IdP Entity ID" field is an EXTERNAL SAML
 * identifier the admin copies from their identity provider — a genuine
 * free-text string, not an internal entity reference — and uses no such
 * placeholder, so it doesn't trip this check.)
 */
import { readFileSync } from 'fs';
import path from 'path';
import { globSync } from 'glob';

const ROOT = path.join(__dirname, '..', '..');

// "Paste … ID" placeholders that ask for an internal entity cuid.
const PASTE_ID_PLACEHOLDER =
    /placeholder=\s*["'`][^"'`]*paste[^"'`]*\bid\b[^"'`]*["'`]/i;

describe('no free-text "paste an entity ID" inputs', () => {
    const files = globSync('src/app/**/*.tsx', { cwd: ROOT, absolute: true });

    it('scans a non-trivial number of app files', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    it('no app file uses a "Paste … ID" placeholder (use EntityPicker)', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            if (PASTE_ID_PLACEHOLDER.test(src)) {
                offenders.push(path.relative(ROOT, file));
            }
        }
        expect(offenders).toEqual([]);
    });
});
