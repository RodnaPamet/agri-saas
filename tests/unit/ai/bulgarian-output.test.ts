import fs from 'node:fs';
import path from 'node:path';

import {
    RUSSIAN_ORTHOGRAPHY,
    findRussianLeakage,
    hasRussianOrthography,
} from '@/app-layer/ai/bulgarian-output';

const ROOT = path.resolve(__dirname, '../../..');

/** Every Bulgarian catalogue file, from the filesystem. */
function bgCatalogueFiles(dir = path.join(ROOT, 'messages'), acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) bgCatalogueFiles(full, acc);
        else if (e.name.endsWith('.json') && /(^|[/\\])bg/.test(full)) acc.push(full);
    }
    return acc;
}

function stringsIn(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') acc.push(value);
    else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, acc));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, acc));
    return acc;
}

describe('Russian orthography in Bulgarian model output (#493-adjacent, owner report 2026-11-01)', () => {
    it('FIRES on the text the owner was actually shown', () => {
        // The verbatim phrase from «Сателитно обобщение»: «проверь» is the
        // Russian imperative, Bulgarian is «провери».
        expect(hasRussianOrthography('Преоцени поливния график и проверь влажността на почвата')).toBe(true);
        expect(hasRussianOrthography('Проверь поливната система за течи')).toBe(true);
        // Other Russian letters Bulgarian simply does not have.
        expect(hasRussianOrthography('ещё')).toBe(true);
        expect(hasRussianOrthography('язык')).toBe(true);
        expect(hasRussianOrthography('это')).toBe(true);

        // «Ньютон» is the RUSSIAN spelling of Newton; Bulgarian is «Нютон»,
        // with no ь at all. It started life in the negative list below on my
        // assumption that any ь-word was Bulgarian, and the detector refused
        // it — correctly. Kept here because a transliterated proper noun is
        // exactly the shape a model drifting toward Russian produces, and it
        // would read as legitimate to anyone skimming.
        expect(hasRussianOrthography('Ньютон')).toBe(true);
        expect(hasRussianOrthography('Нютон')).toBe(false);
    });

    it('STAYS SILENT on correct Bulgarian, including the legitimate ьо digraph', () => {
        // The other half. A detector that fires on everything would satisfy the
        // test above while making the product unable to render a briefing.
        expect(hasRussianOrthography('Преоцени поливния график и провери влажността на почвата')).toBe(false);
        // «ь» is legal in Bulgarian — but only before «о».
        for (const w of ['шофьор', 'актьор', 'бельо', 'сьомга']) {
            expect(hasRussianOrthography(w)).toBe(false);
        }
    });

    it('does not fire on ANY string in the shipped Bulgarian catalogue', () => {
        // The denominator that makes this detector safe to act on: if it fired
        // even once here, wiring it to suppress output would start hiding
        // legitimate briefings.
        const files = bgCatalogueFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);

        const strings = files.flatMap((f) => stringsIn(JSON.parse(fs.readFileSync(f, 'utf8'))));
        const chars = strings.reduce((n, s) => n + s.length, 0);
        const hits = strings.filter(hasRussianOrthography);

        console.log(
            `[bulgarian-orthography] files=${files.length} strings=${strings.length} chars=${chars} hits=${hits.length}`,
        );
        // Floors, because an empty scan satisfies `hits === 0` perfectly.
        expect(strings.length).toBeGreaterThanOrEqual(5000);
        expect(chars).toBeGreaterThanOrEqual(100_000);
        expect(hits).toEqual([]);
    });

    it('finds leaks anywhere in a parsed briefing, with their path', () => {
        const briefing = {
            summary: 'Добър ден',
            recommendations: [
                { title: 'Поливане', body: 'Проверь влажността' },
                { title: 'Торене', body: 'Провери нормата' },
            ],
        };
        const leaks = findRussianLeakage(briefing);
        expect(leaks).toHaveLength(1);
        expect(leaks[0]).toContain('recommendations[0].body');
        expect(leaks[0]).toContain('Проверь');
    });

    it('returns nothing for a clean briefing, and ignores non-strings', () => {
        expect(findRussianLeakage({ summary: 'Провери влажността', n: 42, ok: true, nope: null })).toEqual([]);
    });

    it('the regex itself is not a catch-all or a no-op', () => {
        // Mutation proof for the pattern: it must discriminate on a single
        // character, which is the whole claim.
        expect(RUSSIAN_ORTHOGRAPHY.test('ь')).toBe(true);
        expect(RUSSIAN_ORTHOGRAPHY.test('ьо')).toBe(false);
        expect(RUSSIAN_ORTHOGRAPHY.test('а')).toBe(false);
        expect(RUSSIAN_ORTHOGRAPHY.test('')).toBe(false);
        expect(RUSSIAN_ORTHOGRAPHY.test('plain ascii')).toBe(false);
    });
});
