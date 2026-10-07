/**
 * Bulgarian Cyrillic → Latin (P3.3).
 *
 * ── these vectors are externally verifiable, and that is the point ──
 *
 * `bg-identifiers.test.ts` has a circularity problem: every ЕИК vector it can
 * produce comes from the algorithm under test. This file does not, because the
 * Streamlined System is the transliteration on Bulgarian passports and road
 * signs, so the expected spellings below can be checked against a physical
 * object by anyone who doubts them. «Търговище» is `Targovishte` on the sign at
 * the edge of the town.
 *
 * That makes these real test vectors rather than derived ones, and it is the
 * reason to prefer place names over invented strings here.
 */
import { transliterate, toSlug, MAX_SLUG_LENGTH } from '@/lib/bg-transliterate';

describe('the Streamlined System, against spellings you can go and look at', () => {
    it.each([
        ['София', 'Sofia'],
        ['Пловдив', 'Plovdiv'],
        ['Варна', 'Varna'],
        ['Бургас', 'Burgas'],
        ['Търговище', 'Targovishte'],
        ['Велико Търново', 'Veliko Tarnovo'],
        ['Пазарджик', 'Pazardzhik'],
        ['Кърджали', 'Kardzhali'],
        ['Хасково', 'Haskovo'],
        ['Ямбол', 'Yambol'],
        ['Шумен', 'Shumen'],
        ['Разград', 'Razgrad'],
    ])('%s → %s', (cyr, latin) => {
        expect(transliterate(cyr)).toBe(latin);
    });
});

describe('the two rules a hand-rolled table gets wrong', () => {
    it('ъ is "a", not "u" — Targovishte, not Turgovishte', () => {
        // The instinct to write `u` comes from older ad-hoc schemes and
        // disagrees with the passport in the user's pocket.
        expect(transliterate('Търговище')).toBe('Targovishte');
        expect(transliterate('ъ')).toBe('a');
    });

    it('«България» transliterates to Balgaria — "Bulgaria" is the EXONYM', () => {
        // Caught by this test failing on my own wrong expectation. The English
        // name of the country is not its transliteration: Б-ъ-л-г-а-р-ия gives
        // Balgaria, and that is what a Bulgarian passport says. Anyone reading
        // this module will reach for "Bulgaria" and conclude the table is
        // broken, so the case is kept to say otherwise.
        expect(transliterate('България')).toBe('Balgaria');
    });

    it('a word ending in -ия is -ia, not -iya', () => {
        expect(transliterate('София')).toBe('Sofia');
        expect(transliterate('Бразилия')).toBe('Brazilia');
    });

    it('…but only at a word boundary', () => {
        // Mid-word `ия` keeps the ordinary mapping, so the exception cannot
        // quietly rewrite the middle of a name.
        expect(transliterate('Мияне')).toBe('Miyane');
        expect(transliterate('Иван')).toBe('Ivan');
    });

    it('applies the -ия rule across several words', () => {
        expect(transliterate('София и Бразилия')).toBe('Sofia i Brazilia');
    });
});

describe('case, across multi-character mappings', () => {
    it.each([
        ['Жельо', 'Zhelyo'],
        ['Щъркел', 'Shtarkel'],
        ['Чавдар', 'Chavdar'],
        ['Цветан', 'Tsvetan'],
        ['Юлия', 'Yulia'],
    ])('%s → %s — only the first letter capitalises', (cyr, latin) => {
        // `Ж` must become `Zh`, never `ZH`. The latter is what a naive
        // `toUpperCase()` on the whole mapping produces, and it looks wrong in
        // a name — which is where these mostly appear.
        expect(transliterate(cyr)).toBe(latin);
    });

    it('all-caps input: only the first letter of each mapping capitalises', () => {
        // `ЖЕЛЬО` → `ZhELYO`, not `ZHELYO`. The rule is applied per character
        // with no notion of an all-caps RUN, which looks odd here — but every
        // consumer of this is `toSlug`, which lowercases anyway, so the oddity
        // never reaches a user. Asserted as the actual behaviour rather than
        // left to be discovered.
        expect(transliterate('ЖЕЛЬО')).toBe('ZhELYO');
    });
});

describe('Latin input is left alone', () => {
    it.each(['AgroTech', 'Farm 2000', 'ABV-1', 'José'])('%s passes through', (v) => {
        expect(transliterate(v)).toBe(v);
    });
});

describe('toSlug', () => {
    it.each([
        ['ЗК Победа', 'zk-pobeda'],
        ['Агро Търговище ЕООД', 'agro-targovishte-eood'],
        ['AgroTech', 'agrotech'],
        ['Ферма „Слънце"', 'ferma-slantse'],
        ['  Пловдив  ', 'plovdiv'],
        ['Farm---2000', 'farm-2000'],
    ])('%p → %p', (name, slug) => {
        expect(toSlug(name)).toBe(slug);
    });

    it('strips diacritics that survive Latin input', () => {
        expect(toSlug('Café Ferme')).toBe('cafe-ferme');
    });

    it('returns null when nothing usable survives', () => {
        // Deliberately not a generated fallback like `farm-1`: that would put a
        // name in a URL the owner never chose and would not recognise. The
        // caller has to decide.
        expect(toSlug('!!!')).toBeNull();
        expect(toSlug('   ')).toBeNull();
        expect(toSlug('')).toBeNull();
    });

    it('caps length and never ends on a hyphen', () => {
        // The trailing hyphen can REAPPEAR after the slice, which is why it is
        // stripped twice. A slug ending in `-` is a different string from the
        // one the uniqueness check will later look for.
        const long = 'Търговище '.repeat(20);
        const slug = toSlug(long)!;
        expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
        expect(slug.endsWith('-')).toBe(false);
        expect(slug).toMatch(/^[a-z0-9-]+$/);

        // The input above does NOT land the cut on a separator, so it never
        // exercised the second strip — removing that line left this case green,
        // which mutation testing is for. `'abcd '` is five characters per unit,
        // so an 80-character slice ends exactly on the 16th hyphen.
        const onTheCut = toSlug('abcd '.repeat(20))!;
        expect(onTheCut.length).toBe(MAX_SLUG_LENGTH - 1);
        expect(onTheCut.endsWith('-')).toBe(false);
        expect(onTheCut.endsWith('abcd')).toBe(true);
    });

    it('emits only characters a URL and the admin route both accept', () => {
        // `src/app/api/admin/tenants/route.ts` validates `^[a-z0-9-]+$`, so a
        // slug this produces must satisfy that or the two disagree about what a
        // legal slug is.
        for (const n of ['ЗК Победа', 'Ферма №1', 'Агро & Син ООД', 'Щъркел']) {
            const s = toSlug(n);
            if (s !== null) expect(s).toMatch(/^[a-z0-9-]+$/);
        }
    });
});
