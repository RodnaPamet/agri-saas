/**
 * Bulgarian copy that `agrent-ios` duplicates verbatim, pinned.
 *
 * ## The dependency, and the drift that proves it
 *
 * 133 strings in `messages/bg.json` are COMPILED INTO the iOS app. The phone
 * has no translator and never reads `messages/*.json` at runtime — every
 * string it shows is a Swift literal. For most of them that is fine, but for
 * these 133 the phone deliberately repeats the web's wording so the two
 * surfaces say the same thing about the same object.
 *
 * Nothing linked the two. `admin.farmProfile.fields.urn` had already drifted
 * when `agrent-ios` enumerated the list:
 *
 *     web   «УРН в ИСАК (ДФЗ)»
 *     phone «УРН (регистрационен номер на стопанина)»
 *
 * under a Swift comment still claiming the string was verbatim. Neither repo
 * could have noticed: web-side i18n reports `missing=0 orphan=0 drift=0
 * untranslated=0` because both catalogues agree with each other, and
 * `drift` there means en-vs-bg key parity, not web-vs-phone wording.
 *
 * ## What this can and cannot do
 *
 * It CANNOT verify the phone — that source is another repository. What it does
 * is make the dependency visible at the only moment it matters: when somebody
 * rewords one of these strings. The failure names the Swift file that repeats
 * it, so the author learns there is a second copy before merging rather than
 * after a farmer sees two different sentences.
 *
 * Updating the fixture is the correct response to a deliberate reword. The
 * point is not to freeze the copy — it is that the update is a conscious step
 * with a note attached, instead of silence.
 *
 * ## Why a fixture rather than inline expectations
 *
 * 133 strings inline would bury the mechanism, and a reviewer cannot diff
 * prose embedded in assertions. In a JSON file a reword shows up as a
 * one-line diff next to the phone file that mirrors it.
 *
 * ## Not pinned, on purpose
 *
 * - `privacy.*` — the phone's deletion explanation is ADAPTED to a phone's
 *   length rather than copied, so a reword there breaks nothing.
 * - The farm-profile paragraph at `admin/farm-profile/page.tsx` is a literal
 *   in the page, not a catalogue entry, so there is no key to pin. Recorded in
 *   the issue instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();

/** `{ "<phone file under Agrent/>": { "<key>": "<expected bg text>" } }` */
type Pins = Record<string, Record<string, string>>;

const pins = JSON.parse(
    readFileSync(join(REPO, 'tests/guards/ios-mirrored-copy.json'), 'utf8'),
) as Pins;

function loadCatalogue(locale: 'bg' | 'en'): Record<string, string> {
    const raw = JSON.parse(
        readFileSync(join(REPO, `messages/${locale}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const out: Record<string, string> = {};
    const walk = (node: Record<string, unknown>, prefix: string): void => {
        for (const [k, v] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                walk(v as Record<string, unknown>, path);
            } else if (typeof v === 'string') {
                out[path] = v;
            }
        }
    };
    walk(raw, '');
    return out;
}

const bg = loadCatalogue('bg');
const en = loadCatalogue('en');

const allPinned = Object.entries(pins).flatMap(([file, keys]) =>
    Object.entries(keys).map(([key, text]) => ({ file, key, text })),
);

describe('copy agrent-ios duplicates verbatim', () => {
    it('pins a real population — the denominator', () => {
        // Without this the suite passes on an emptied fixture, which is the
        // same failure the thing it guards against: silence that looks like
        // agreement.
        expect(Object.keys(pins).length).toBeGreaterThanOrEqual(12);
        expect(allPinned.length).toBeGreaterThanOrEqual(130);
    });

    it('every pinned key still exists in bg.json', () => {
        // A DELETED key is drift too, and the louder kind: the phone keeps
        // showing a string the web no longer has anywhere.
        const gone = allPinned.filter(({ key }) => bg[key] === undefined);
        if (gone.length > 0) {
            throw new Error(
                [
                    'These keys are copied verbatim in agrent-ios and no longer exist in bg.json:',
                    ...gone.map(({ file, key }) => `  ${key}  →  Agrent/${file}`),
                    '',
                    'The phone still shows its copy. Either restore the key or tell',
                    'that session the string is gone so it can stop claiming it is verbatim.',
                ].join('\n'),
            );
        }
    });

    it('every pinned key still exists in en.json — parity', () => {
        // bg and en are kept at identical key sets by `i18n-diff.mjs`; a pin
        // present in one and not the other means this fixture is out of step
        // with the catalogues rather than with the phone.
        const missing = allPinned.filter(({ key }) => en[key] === undefined);
        expect(missing.map((m) => m.key)).toEqual([]);
    });

    it('no pinned string has been reworded', () => {
        const drifted = allPinned.filter(
            ({ key, text }) => bg[key] !== undefined && bg[key] !== text,
        );
        if (drifted.length > 0) {
            throw new Error(
                [
                    'These strings are copied VERBATIM into agrent-ios and have changed:',
                    '',
                    ...drifted.flatMap(({ file, key, text }) => [
                        `  ${key}`,
                        `    pinned : ${JSON.stringify(text)}`,
                        `    now    : ${JSON.stringify(bg[key])}`,
                        `    copied in: Agrent/${file}`,
                        '',
                    ]),
                    'If the reword is deliberate: tell the agrent-ios session, then update',
                    'tests/guards/ios-mirrored-copy.json in the same commit. The phone',
                    'compiles its strings in, so it cannot pick this up on its own and',
                    'nothing else in either repo would notice the two drifting apart.',
                ].join('\n'),
            );
        }
    });

    it('names a phone file for every pin — the failure has to be actionable', () => {
        // A pin whose family is empty, or whose file is blank, produces a
        // failure message that says a string changed and not where the other
        // copy lives — which is the only thing the reader needs.
        for (const [file, keys] of Object.entries(pins)) {
            expect(file).toMatch(/^[A-Za-z]/);
            expect(Object.keys(keys).length).toBeGreaterThan(0);
        }
    });
});
