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
        // «Соята в България» rather than «Реколтата от соя», and the swap is
        // the point of this comment. The original fixture asserted `toEqual([])`
        // — the whole tag set is empty — on a sentence whose SUBJECT is soy but
        // which also says «Реколтата». When «Пазар» was added on the owner's
        // definition ("harvest, export, import and yield news"), `реколт`
        // started matching and this went red.
        //
        // The test was right and its fixture was not: it grades "soybean is not
        // a crop tag", and `toEqual([])` grades the entire sentence. So the
        // strong assertion moves to a sentence that can carry it, and the
        // harvest sentence keeps the assertion this test is actually about —
        // plus the `trade` it now correctly earns, so the interaction is
        // recorded rather than rediscovered.
        expect(deriveTags('Соята в България', null)).toEqual([]);
        expect(deriveTags('Реколтата от соя', null)).not.toContain('soybean');
        expect(deriveTags('Реколтата от соя', null)).toEqual(['trade']);
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

describe('the livestock topic uses the ordinary words, not only the formal ones (#1486)', () => {
    it('«добитък» and its inflections tag livestock', () => {
        // Every Bulgarian stem in this topic was the sector noun
        // («животновъдство») or a species («говеда», «свине», «овце»). The word
        // a farmer and a headline actually use was absent, so this tagged
        // NOTHING and never reached a reader who had selected «Животновъдство».
        expect(deriveTags('Добитъкът в стопанството е здрав', null)).toContain('livestock');
        expect(deriveTags('Добитъка изведоха на паша', null)).toContain('livestock');
        // The plural replaces the final consonant cluster, which is why the
        // stem is `добитъ` rather than `добитък` — the latter misses this.
        expect(deriveTags('Цените на добитъците падат', null)).toContain('livestock');
    });

    it('«крави» tags livestock, where «говеда» is the formal register', () => {
        expect(deriveTags('Кравите дават повече мляко', null)).toContain('livestock');
        expect(deriveTags('Кравата се разболя', null)).toContain('livestock');
    });

    it('«добив» stays a TRADE story and never becomes livestock', () => {
        // The boundary that makes the stem length load-bearing. «добив» (yield)
        // and «добитък» (livestock) diverge at the FIFTH character, в against
        // т, so any stem shorter than five merges the two topics and tags every
        // yield story as livestock. Checked rather than reasoned about.
        for (const yieldStory of [
            'Добивите от пшеница са по-високи',
            'Добив на зърно',
        ]) {
            expect(deriveTags(yieldStory, null)).toContain('trade');
            expect(deriveTags(yieldStory, null)).not.toContain('livestock');
        }
    });

    it('the PAST PARTICIPLE of «добивам» is not livestock', () => {
        // The case that caught a defect in the first version of this fix, and
        // the reason the stems end in consonants.
        //
        // `добитъ` looked safe and was not: `ъ` is in TRAILING_VOWEL, so
        // `matchesWordPrefix` ran `stemOf` over it and silently trimmed it to
        // `добит` — the past participle of «добивам». So «добитото зърно», the
        // HARVESTED grain, tagged livestock: a yield story filed under animals,
        // invisible to anyone reading either topic.
        //
        // It is exactly the trap `categorize.ts` already warns about for
        // `износа`, two changes later and in the other direction.
        expect(deriveTags('Добитото зърно е на склад', null)).not.toContain('livestock');
        expect(deriveTags('Добитата продукция', null)).not.toContain('livestock');
    });

    it('CONTROL: other добр-/доба- words are not livestock either', () => {
        // `добитъ` is six characters precisely so it cannot reach these. Without
        // the control, a shortened stem would pass every case above while
        // tagging «доброто време» and «добавката към фуража» as livestock —
        // and a weather story filed under animals is invisible to both.
        expect(deriveTags('Доброто време помага', null)).not.toContain('livestock');
        expect(deriveTags('Добавката към фуража', null)).not.toContain('livestock');
        // And the weather story still gets its own tag, so the control is not
        // passing because the tagger stopped working.
        expect(deriveTags('Доброто време помага', null)).toContain('weather');
    });
});
