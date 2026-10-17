/**
 * Every surface that stores user-supplied bytes strips image metadata first
 * — P6.3 (#1812).
 *
 * ── Why a guard and not three call sites ────────────────────────────
 *
 * The owner's ruling of 2026-10-16 is that EXIF/GPS stripping applies to ALL
 * uploads, public and private. Three call sites satisfy that today. The
 * fourth, added in six months by someone who has never read this, is the one
 * the ruling is actually about — and a missing strip call fails in the
 * invisible direction: the upload works, the photo displays, and the parcel's
 * GPS coordinates sit in the stored file.
 *
 * ── Why the population is DERIVED from the scanner ──────────────────
 *
 * The honest definition of "user-supplied bytes" is "bytes we felt the need
 * to run an AV scan over". So the population is every file that calls
 * `scanUploadedBuffer` or `scanOrRefuse` AND writes through the storage
 * provider — not a list of upload surfaces somebody maintains.
 *
 * #2030 is the cautionary tale: CLAUDE.md asserts `ingestUploadedFile` is
 * "the choke point every record-backed upload reaches", and it is reached by
 * one of five. A guard keyed to that claim would have inherited the same
 * blind spot. A guard keyed to the scanner cannot, because a new upload
 * surface that skips the scanner has a much louder problem than EXIF.
 *
 * ── The exemptions are a PARTITION, each with a reason ──────────────
 *
 * Two surfaces stage archives rather than photographs, and their `mimeType`
 * is what the client DECLARED rather than what the bytes sniffed as. Calling
 * the stripper there would pass a declared type into a function whose
 * contract requires a resolved one, which is how you get a privacy measure
 * an attacker opts out of by setting a header. So they are exempt, and the
 * exemption says why — the same shape as `NOT_HIDEABLE` in the public-profile
 * allowlist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Marks a file as handling bytes a caller supplied. */
const SCANNER = /\bscanUploadedBuffer\s*\(|\bscanOrRefuse\s*\(/;
/** Marks a file as persisting those bytes. */
const WRITER = /\bstorage\s*\.\s*write\s*\(|getStorageProvider\(\)\s*\.\s*write\s*\(/;
/** The measure itself. */
const STRIPPER = /\bstripImageMetadata\s*\(/;

/**
 * Surfaces that store user bytes and deliberately do NOT strip, with the
 * reason. A bare entry is not accepted — the test asserts each reason is
 * substantial, because "exempt" with no argument is indistinguishable from an
 * oversight.
 */
const DELIBERATELY_UNSTRIPPED: ReadonlyArray<[file: string, why: string]> = [
    [
        'src/app-layer/usecases/spatial-import.ts',
        'Stages a shapefile/KML/GeoJSON bundle, not a photograph, and its '
            + '`mimeType` is `file.mimeType || application/octet-stream` — the '
            + 'DECLARED type. `stripImageMetadata` requires the RESOLVED type, '
            + 'because a caller who can opt out of stripping by lying about the '
            + 'content type defeats the measure entirely.',
    ],
    [
        'src/app/api/t/[tenantSlug]/evidence/imports/route.ts',
        'Stages a zip archive for later parsing, with `file.type || '
            + 'application/zip` — again the declared type. Images INSIDE the '
            + 'archive reach storage through `evidence.ts`, which does strip, so '
            + 'the bytes a visitor can eventually see are covered.',
    ],
    [
        'src/lib/account/avatar.ts',
        'Strips by converting: `reencodeToWebp` decodes, rotates, resizes and '
            + 're-encodes to WebP, so metadata is gone by the same mechanism. It '
            + 'owns its storage key and serve route and wants one canonical '
            + 'format, which is why it does not share this module. '
            + '`tests/unit/account-avatar.test.ts` asserts the strip on its '
            + 'output bytes independently.',
    ],
];

const EXEMPT = new Map(DELIBERATELY_UNSTRIPPED);

function rel(abs: string): string {
    return abs.slice(REPO_ROOT.length + 1);
}

/** Files that take user bytes and persist them. */
function uploadWriters(): string[] {
    const out: string[] = [];
    for (const abs of collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'] })) {
        // Comments blanked, so a file that merely DISCUSSES the scanner (the
        // terms page explains the upload pipeline in prose) is not counted.
        const code = blankNonCode(readFileSync(abs, 'utf8'));
        if (SCANNER.test(code) && WRITER.test(code)) out.push(rel(abs));
    }
    return out.sort();
}

describe('every upload surface strips image metadata (#1812)', () => {
    const writers = uploadWriters();

    it('finds upload surfaces at all — the guard is not vacuously passing', () => {
        // A renamed scanner or a moved storage helper would empty the
        // population and make every assertion below pass over nothing. The
        // floor is the three stripping sites plus the three exemptions.
        expect({ count: writers.length, files: writers }).toEqual({
            count: writers.length,
            files: expect.arrayContaining([
                'src/lib/upload/ingest.ts',
                'src/app-layer/usecases/evidence.ts',
                'src/app-layer/usecases/journal.ts',
            ]),
        });
        expect(writers.length).toBeGreaterThanOrEqual(5);
    });

    it.each(writers)('%s strips, or is exempt with a reason', (file) => {
        const code = blankNonCode(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        const strips = STRIPPER.test(code);
        const why = EXEMPT.get(file);

        // One assertion carrying the file name, so the failure message names
        // the surface and what it needs rather than printing `false`.
        expect({
            file,
            covered: strips || Boolean(why),
        }).toEqual({ file, covered: true });

        // A surface cannot be BOTH, which would mean an exemption outlived
        // the reason for it.
        if (strips && why) {
            throw new Error(
                `${file} calls stripImageMetadata AND is listed in `
                    + `DELIBERATELY_UNSTRIPPED. Remove the exemption — a stale one `
                    + `excuses the next surface that forgets.`,
            );
        }
    });

    it.each(DELIBERATELY_UNSTRIPPED)('%s records a substantial reason', (file, why) => {
        // Length is a crude proxy, but it is the one that stops `'legacy'`
        // being accepted. The prose above is what a reviewer actually reads.
        expect({ file, long: why.length > 80 }).toEqual({ file, long: true });
    });

    it.each(DELIBERATELY_UNSTRIPPED)('%s is still in the population', (file) => {
        // An exemption for a file that no longer takes uploads is dead weight
        // that makes the list look more considered than it is.
        expect({ file, present: writers.includes(file) }).toEqual({ file, present: true });
    });

    it.each(writers.filter((f) => !EXEMPT.has(f)))(
        '%s scans BEFORE it strips, and strips BEFORE it writes',
        (file) => {
            // Order is the whole safety argument. Stripping DECODES caller
            // bytes with libvips, so the scan must precede it; and the write
            // must follow the strip or the unstripped bytes are what lands.
            const code = blankNonCode(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
            const scanAt = code.search(SCANNER);
            const stripAt = code.search(STRIPPER);
            const writeAt = code.search(WRITER);
            expect({
                file,
                scanBeforeStrip: scanAt < stripAt,
                stripBeforeWrite: stripAt < writeAt,
            }).toEqual({ file, scanBeforeStrip: true, stripBeforeWrite: true });
        },
    );
});
