/**
 * Guard: a printed register never puts a raw `Parcel.cropType` on the page.
 *
 * ## What went wrong
 *
 * `Parcel.cropType` stores a catalogue KEY — `'Wheat'`, `'Sunflower'` — and
 * each client translates it for display. The web does, through `cropLabel()`
 * against the `crops` namespace. The report writers did not, so «ДНЕВНИК НА
 * РАСТИТЕЛНАТА ЗАЩИТА» and «Дневник на стопанството» printed «Wheat» in the
 * crop column of forms submitted to a Bulgarian authority. Owner-reported.
 *
 * Nothing failed, because a key is a perfectly valid string: the PDF rendered,
 * the column was populated, and only a reader of the finished document could
 * tell.
 *
 * ## Why a guard, and why DERIVED
 *
 * The fix is two lines at two sites. The risk is the third site: a new
 * register, or a new column on an existing one, reading `parcel.cropType`
 * straight into a row. That reads fine in review and is invisible in CI.
 *
 * So the population is every file under `src/app-layer/reports/` — not a list
 * of the two that were wrong. A new report is covered the moment it exists.
 *
 * ## What is deliberately NOT a finding
 *
 * `CropPlan.cropType.name` is a farm-authored name on the tenant's own
 * `CropType` row, not a catalogue key, and prints as written. The matcher
 * therefore keys on a `cropType` read that is NOT followed by `.name`, which
 * is what separates the two sources. «Предшественик» comes exclusively from
 * that relation, which is why it needs no resolution and must not be flagged.
 *
 * Prisma `select`/`where` clauses are also not findings: selecting the column
 * is how the data arrives, and the question is only what reaches the page.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT_REL = 'src/app-layer/reports';
const ROOT = path.resolve(__dirname, '../..', ROOT_REL);

/**
 * Through `collectSourceFiles`, not a hand-rolled walk —
 * `file-collection-is-not-silently-empty`'s rule: a private collector can be
 * gutted to `[]` while every assertion built on it stays green, and the floor
 * is what distinguishes "no register prints a raw key" from "no register was
 * read".
 */
function walk(): string[] {
    return collectSourceFiles({ roots: [ROOT_REL], extensions: ['.ts'], floor: 5 });
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * A `cropType` VALUE read — `x.cropType` / `x?.cropType` — excluding:
 *   - `.cropType.name` and `.cropType?.name`, the farm-authored relation
 *   - `cropType:` as an object KEY, which is a Prisma select or a field write
 */
const RAW_READ = /\??\.cropType\b(?!\s*\??\s*\.\s*name)(?!\s*:)/g;

function rawReads(src: string): string[] {
    const clean = stripComments(src);
    return clean
        .split('\n')
        .filter((line) => {
            const hits = [...line.matchAll(RAW_READ)];
            if (hits.length === 0) return false;
            // Routed through the resolver on the same line is the fix.
            return !line.includes('cropLabelForDocument');
        })
        .map((l) => l.trim());
}

describe('printed registers label their crop types', () => {
    const files = walk();

    it('reports the population it graded', () => {
        const withCrops = files.filter((f) => /\.cropType\b/.test(fs.readFileSync(f, 'utf8')));
        console.log(
            `[report-crop-labels] graded ${files.length} file(s) under src/app-layer/reports; ` +
                `${withCrops.length} mention cropType`,
        );
        // A walker that returned [] would pass every assertion below.
        expect(files.length).toBeGreaterThanOrEqual(5);
        expect(withCrops.length).toBeGreaterThanOrEqual(2);
    });

    it.each(walk().map((f) => [path.relative(ROOT, f), f] as const))(
        '%s routes every cropType value through cropLabelForDocument',
        (_rel, abs) => {
            expect(rawReads(fs.readFileSync(abs, 'utf8'))).toEqual([]);
        },
    );
});

describe('the detector can express each failure', () => {
    it('flags a raw value read', () => {
        expect(rawReads('const c = parcel.cropType ?? null;')).toHaveLength(1);
        expect(rawReads('cropName: l.parcel?.cropType ?? null,')).toHaveLength(1);
    });

    it('does not flag the farm-authored relation', () => {
        expect(rawReads('const n = current?.cropPlan?.cropType?.name ?? null;')).toEqual([]);
        expect(rawReads('const n = plan.cropType.name;')).toEqual([]);
    });

    it('does not flag a Prisma select or a field write', () => {
        expect(rawReads('select: { name: true, cropType: true, areaHa: true },')).toEqual([]);
        expect(rawReads('data: { cropType: value },')).toEqual([]);
    });

    it('does not flag a read that IS routed', () => {
        expect(rawReads('cropName: cropLabelForDocument(labels, l.parcel?.cropType),')).toEqual([]);
    });

    it('does not flag prose in a comment', () => {
        expect(rawReads('// prints parcel.cropType raw, which was the bug\nconst x = 1;')).toEqual([]);
    });
});
