/**
 * `deriveTags` — several tags per article, crops from one vocabulary.
 *
 * ## What it is for (#231)
 *
 * `categorize` is exclusive and priority-ordered: policy beats market, because
 * one column forced a choice. Tags remove the forcing, so a subsidy story
 * about wheat carries BOTH `subsidies` and `wheat` and there is no precedence
 * to apply. That inclusiveness is the whole feature, and the first case below
 * is the one that would fail if someone reintroduced an early return.
 *
 * ## The matcher is PREFIX-OF-WORD, and that is not a detail
 *
 * Substring matching fires mid-word in both languages — `dryer` contains
 * `rye`, `словесен` contains `овес` — and would tag a story about a grain
 * dryer as being about rye. Prefix matching cannot, while still catching every
 * Bulgarian inflection, because Bulgarian inflects by SUFFIX: `пшеницата`,
 * `пшеници` and `пшеницата` all begin with `пшеница`.
 *
 * What it cannot prevent is a longer word that genuinely begins with a stem
 * (`wheatear` would tag wheat). That is the same mechanism inflection relies
 * on, so it is a trade rather than a bug — and the cases below pin the class
 * it DOES eliminate, so a regression to substring matching reddens here.
 *
 * `categorize` keeps its own substring matcher, unchanged. Its stems are
 * deliberately truncated (`субсиди`, `цен на`) and some contain spaces, so
 * substring is right for them. Two vocabularies, two rules, and the reason is
 * in the source.
 */
import { deriveTags, categorize } from '@/lib/news/categorize';
import { COMMODITY_ALIASES } from '@/lib/market/commodity-vocabulary';

describe('tags are inclusive, not a choice', () => {
    it('a subsidy story about wheat carries BOTH tags', () => {
        // The feature in one assertion. `categorize` must pick one; this must
        // not.
        expect(deriveTags('Нови субсидии за производителите на пшеница', null)).toEqual([
            'subsidies',
            'wheat',
        ]);
    });

    it('control: `categorize` on the same text picks exactly ONE bucket', () => {
        // Proves the two functions really differ rather than one delegating to
        // the other — and that the fixture reaches both vocabularies.
        expect(categorize('Нови субсидии за производителите на пшеница', null, 'general')).toBe(
            'policy',
        );
    });

    it('several crops and several topics at once', () => {
        const tags = deriveTags(
            'Цените на царевица и слънчоглед се повишиха след градушката',
            'Производителите очакват нови субсидии.',
        );
        expect(tags).toEqual(['maize', 'prices', 'subsidies', 'sunflower', 'weather']);
    });

    it('returns [] rather than a fallback when nothing matches', () => {
        // Empty is the honest answer and what the «Всички» switch keeps
        // reachable. A default tag would make every article look classified.
        expect(deriveTags('Общо събрание на кооперацията', 'Дневен ред и протокол.')).toEqual([]);
    });

    it('is sorted and deduplicated', () => {
        // `wheat` has six spellings; a story using three of them must tag once.
        const tags = deriveTags('Пшеница, пшеницата и durum wheat', null);
        expect(tags).toEqual(['wheat']);
    });
});

describe('Bulgarian inflection is caught; mid-word matches are not', () => {
    it.each([
        ['пшеница', 'wheat'],
        ['пшеницата', 'wheat'],
        ['пшеници', 'wheat'],
        ['царевицата', 'maize'],
        ['слънчогледът', 'sunflower'],
        ['рапицата', 'rapeseed'],
        ['ечемикът', 'barley'],
    ])('«%s» tags %s', (word, slug) => {
        expect(deriveTags(`Реколтата от ${word} е прибрана`, null)).toContain(slug);
    });

    it.each([
        ['центърът на града', 'prices'],
        ['директорът на фирмата', 'inputs'],
        ['изпълнителният фактор', 'inputs'],
        ['scorn and derision', 'maize'],
    ])('«%s» does NOT tag %s', (text, slug) => {
        // The class prefix matching eliminates. Each of these CONTAINS a stem
        // mid-word — `цен` in център, `тор` in директор and фактор, `corn` in
        // scorn — and a substring matcher would tag all four.
        expect(deriveTags(text, null)).not.toContain(slug);
    });

    it('soybean is NOT a news crop tag, so «соя» tags nothing', () => {
        // Written at agrent backend-2's suggestion to pin the «социален»
        // collision the stem floor was supposed to prevent. It does not exist:
        // soybean is in COMMODITY_ALIASES but NOT in the five crops this
        // module tags, so `соя` is never consulted and `со` can never be
        // derived from it.
        //
        // Keeping the case because the absence is worth asserting. If soybean
        // is ever added to CROP_TAGS, the first two assertions below start
        // exercising the floor for real, and the third will fail and have to
        // be flipped — which is the signal that the floor has become
        // load-bearing rather than defensive.
        expect(deriveTags('Социален доклад за селските райони', null)).not.toContain('soybean');
        expect(deriveTags('Цената на солта', null)).not.toContain('soybean');
        expect(deriveTags('Реколтата от соя', null)).toEqual([]);
    });

    it('the floor is exercised by `maize`, which is the only tagged alias it floors', () => {
        // `maize` (5) would trim to `maiz` (4) and the floor keeps it whole.
        // That is the one place the bound currently fires, and `maiz` would
        // collide with nothing — so the floor fires without preventing a live
        // collision. Asserted so the claim in the source is checkable rather
        // than asserted: maize must still tag, trimmed or not.
        expect(deriveTags('Цената на царевица и maize futures', null)).toContain('maize');
        expect(deriveTags('MAIZE prices', null)).toContain('maize');
    });

    it('control: those stems really are present mid-word', () => {
        // Otherwise the cases above pass against text containing nothing,
        // proving nothing about prefix-versus-substring.
        expect('центърът'.includes('цен')).toBe(true);
        expect('директорът'.includes('тор')).toBe(true);
        expect('scorn'.includes('corn')).toBe(true);
    });
});

describe('crop tags come from the commodity vocabulary, not a second list', () => {
    it('every crop tag is a slug the alias table maps to', () => {
        // The reuse property. If someone added a crop keyword list here, a tag
        // could exist that the vocabulary does not know — and it would be
        // findable in news and not in Борса search.
        const slugs = new Set(Object.values(COMMODITY_ALIASES));
        for (const crop of ['wheat', 'maize', 'sunflower', 'rapeseed', 'barley']) {
            expect(slugs.has(crop as never)).toBe(true);
        }
    });

    it('an ENGLISH alias from the table tags the same slug as the Bulgarian one', () => {
        // `canola` is in the table as an alias of rapeseed and appears in no
        // keyword list in this module. It can only work through the table.
        expect(deriveTags('Canola futures rose', null)).toContain('rapeseed');
        expect(deriveTags('Цените на рапицата се повишиха', null)).toContain('rapeseed');
    });

    it('refuses an INPUT commodity as a crop tag', () => {
        // `дизел` and `diesel` are in the alias table, mapping to an input.
        // The exchange does not trade them and the news feed does not tag
        // them — only the five crops are tagged.
        expect(deriveTags('Цената на дизела се повиши', null)).not.toContain('diesel');
        expect(deriveTags('Diesel prices rose', null)).not.toContain('diesel');
    });
});

describe('`prices` is narrower than the market category, deliberately', () => {
    it('a harvest story gets its crop but NOT a price tag', () => {
        // A documented departure from the contract, which called `prices` a
        // near-duplicate of MARKET_KEYWORDS. Those include `реколт`, `износ`
        // and `добив`, so a farmer opting into «Цени» would receive every
        // harvest story. `market` is still expressible as a union of tags;
        // `prices` now means what its label says.
        const tags = deriveTags('Реколтата от ечемик надхвърли очакванията', null);
        expect(tags).toContain('barley');
        expect(tags).not.toContain('prices');
    });

    it('control: `categorize` DOES call that same story `market`', () => {
        // Pins the divergence as real rather than asserted. If this ever
        // returns something else, the two vocabularies have been merged and
        // the case above stops meaning anything.
        expect(categorize('Реколтата от ечемик надхвърли очакванията', null, 'general')).toBe(
            'market',
        );
    });

    it('a genuine price story does get the tag', () => {
        expect(deriveTags('Цената на тон пшеница на борсата', null)).toContain('prices');
    });
});
