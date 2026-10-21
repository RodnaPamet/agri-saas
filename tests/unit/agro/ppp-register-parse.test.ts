/**
 * #2077 — the БАБХ register parser.
 *
 * The cases here are not hypotheticals. Each one is a shape a Bulgarian
 * agricultural spreadsheet actually takes, and each would, if mishandled,
 * produce a WRONG NUMBER rather than an error — which is the only failure mode
 * that matters for a figure a farmer may copy onto a regulated document.
 */
import {
    parsePppRegisterText,
    parsePppRegisterXlsx,
    parseDose,
    bgDecimal,
    isWithdrawn,
    splitPests,
    splitDelimited,
    sniffDelimiter,
    PppRegisterParseError,
    MAX_HEADER_SCAN_ROWS,
} from '@/lib/agro/ppp-register-parse';
import { makeWorkbook } from '../../helpers/xlsx-workbook';

const HEADER = 'Култура;Продукт;Рег. №;Вредител;Доза;Карантинен срок;Статус';

function csv(...rows: string[]): string {
    return [HEADER, ...rows].join('\n');
}

describe('column binding', () => {
    it('binds Bulgarian headers regardless of order', () => {
        const out = parsePppRegisterText(
            ['Доза;Продукт;Култура', '1,5 л/дка;Карате Зеон;Пшеница'].join('\n'),
        );
        expect(out.entries).toEqual([
            expect.objectContaining({
                crop: 'Пшеница',
                productName: 'Карате Зеон',
                doseMin: 1.5,
                doseMax: 1.5,
                doseUnit: 'л/дка',
            }),
        ]);
    });

    it('refuses a file it cannot bind, naming what it found and what it wants', () => {
        expect(() => parsePppRegisterText('Име;Цена\nнещо;5')).toThrow(PppRegisterParseError);
        // The message IS the operator's whole debugging aid, so assert its parts.
        let message = '';
        try {
            parsePppRegisterText('Име;Цена\nнещо;5');
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('crop');
        expect(message).toContain('productName');
        expect(message).toContain('Име | Цена');
        expect(message).toContain('култура');
    });

    it('finds a header below a title row', () => {
        const out = parsePppRegisterText(
            [
                'РЕГИСТЪР НА РАЗРЕШЕНИТЕ ЗА УПОТРЕБА ПРЗ',
                'Заповед РД 11-1234/01.03.2026',
                '',
                HEADER,
                'Пшеница;Карате Зеон;1234-ПРЗ;Листни въшки;1,5 л/дка;30;разрешен',
            ].join('\n'),
        );
        // Binding on row 1 would have THROWN, so one entry and nothing
        // skipped is the proof it scanned down to the real header.
        expect(out.entries).toHaveLength(1);
        expect(out.skippedRows).toBe(0);
        expect(out.headers).toContain('Култура');
    });

    it('does not scan past the bound, so a stray keyword deep in the file cannot become the header', () => {
        const preamble = Array.from({ length: MAX_HEADER_SCAN_ROWS + 2 }, (_, i) => `ред ${i}`);
        expect(() => parsePppRegisterText([...preamble, HEADER, 'Пшеница;X'].join('\n'))).toThrow(
            /in the first 10 row\(s\)/,
        );
    });

    it('takes the unit from the header when the cells are bare numbers', () => {
        const out = parsePppRegisterText(
            ['Култура;Продукт;Доза (мл/дка;Статус', 'Пшеница;X;200;разрешен'].join('\n'),
        );
        // NB the header's parenthetical is unclosed above by accident of the
        // delimiter — the closed form is the real case:
        const closed = parsePppRegisterText(
            ['Култура;Продукт;"Доза (мл/дка)"', 'Пшеница;X;200'].join('\n'),
        );
        expect(closed.entries[0]).toMatchObject({ doseMin: 200, doseMax: 200, doseUnit: 'мл/дка' });
        expect(out.entries).toHaveLength(1);
    });
});

describe('dose parsing', () => {
    it('reads a Bulgarian decimal comma', () => {
        expect(bgDecimal('0,15')).toBe(0.15);
        expect(bgDecimal('0.15')).toBe(0.15);
        expect(bgDecimal('1 500')).toBe(1500);
        expect(bgDecimal('—')).toBeNull();
        expect(bgDecimal('')).toBeNull();
    });

    it('reads a range, in either dash', () => {
        expect(parseDose('1,5 - 2,0 л/дка')).toMatchObject({ min: 1.5, max: 2, unit: 'л/дка' });
        expect(parseDose('150–200 мл/дка')).toMatchObject({ min: 150, max: 200 });
        expect(parseDose('150 ÷ 200')).toMatchObject({ min: 150, max: 200 });
        expect(parseDose('200 до 150')).toMatchObject({ min: 150, max: 200 });
    });

    it('stores a single value as both bounds', () => {
        expect(parseDose('200 мл/дка')).toMatchObject({ min: 200, max: 200, unit: 'мл/дка' });
    });

    it('does NOT invent a floor for an upper bound', () => {
        expect(parseDose('до 200 мл/дка')).toMatchObject({ min: null, max: 200 });
    });

    it('never takes a number out of the UNIT as the range top', () => {
        // The regression this parser was anchored for: a scan for "all the
        // numbers" reads 100 as the upper bound — a thousandfold error that
        // renders exactly like a correct one.
        expect(parseDose('0,1 л/100 л вода')).toMatchObject({
            min: 0.1,
            max: 0.1,
            unit: 'л/100 л вода',
        });
    });

    it('marks a dose it cannot read, rather than guessing', () => {
        expect(parseDose('по указание на производителя')).toMatchObject({
            min: null,
            max: null,
            unparsed: true,
        });
        // An EMPTY cell is not an unparsed one — nothing was stated.
        expect(parseDose('')).toMatchObject({ unparsed: false });
        expect(parseDose(null)).toMatchObject({ unparsed: false });
    });

    it('keeps the row and counts the dose when a dose is unreadable', () => {
        const out = parsePppRegisterText(
            csv('Пшеница;X;1;Листни въшки;по указание;30;разрешен'),
        );
        expect(out.unparsedDoses).toBe(1);
        expect(out.entries).toHaveLength(1);
        expect(out.entries[0]).toMatchObject({ doseMin: null, quarantinePeriodDays: 30 });
    });
});

describe('withdrawal', () => {
    it('reads a status word', () => {
        expect(isWithdrawn('отнето разрешение')).toBe(true);
        expect(isWithdrawn('заличен')).toBe(true);
        expect(isWithdrawn('прекратена употреба')).toBe(true);
        expect(isWithdrawn('разрешен')).toBe(false);
        expect(isWithdrawn('')).toBe(false);
        expect(isWithdrawn(null)).toBe(false);
    });

    it('reads a yes/no flag', () => {
        expect(isWithdrawn('да')).toBe(true);
        expect(isWithdrawn('X')).toBe(true);
        expect(isWithdrawn('не')).toBe(false);
    });
});

describe('pests', () => {
    it('splits, trims and de-duplicates', () => {
        expect(splitPests('Листни въшки, трипс; листни въшки')).toEqual([
            'Листни въшки',
            'трипс',
            'листни въшки',
        ]);
        expect(splitPests(null)).toEqual([]);
    });
});

describe('delimited text', () => {
    it('sniffs the delimiter, because a bg-BG Excel writes semicolons', () => {
        expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
        expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
        expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    });

    it('sniffs past a preamble that contains no delimiter at all', () => {
        // The first line decided it before, which silently collapsed a
        // semicolon file to one column and reported it as a missing header.
        expect(sniffDelimiter('РЕГИСТЪР НА ПРЗ\n\na;b;c;d\n1;2;3;4')).toBe(';');
        // And one comma in a title does not outvote the header's semicolons.
        expect(sniffDelimiter('РЕГИСТЪР, ЧАСТ 1\na;b;c;d\n1;2;3;4')).toBe(';');
    });

    it('honours quotes, doubled quotes and embedded newlines', () => {
        expect(splitDelimited('a,"b,c","d""e"\n1,2,3', ',')).toEqual([
            ['a', 'b,c', 'd"e'],
            ['1', '2', '3'],
        ]);
        expect(splitDelimited('a,"two\nlines",c', ',')).toEqual([['a', 'two\nlines', 'c']]);
    });

    it('strips a BOM so the FIRST header still binds', () => {
        const out = parsePppRegisterText(`﻿${csv('Пшеница;X;1;въшки;1 л/дка;30;разрешен')}`);
        expect(out.entries[0]?.crop).toBe('Пшеница');
    });

    it('skips rows with no crop or no product, and counts them', () => {
        const out = parsePppRegisterText(
            csv(
                'Пшеница;Карате Зеон;1234;Листни въшки;1,5 л/дка;30;разрешен',
                ';;;;;;',
                'Ечемик;;;;;;',
                ';Нещо;;;;;',
                'Слънчоглед;Пулсар;999;Плевели;1,2 л/дка;60;отнет',
            ),
        );
        expect(out.entries.map((e) => e.crop)).toEqual(['Пшеница', 'Слънчоглед']);
        // TWO, not three: the wholly blank `;;;;;;` row is a blank LINE and is
        // dropped before the entry loop. Counting it would inflate the one
        // number an operator reads to judge whether the binding went wrong.
        expect(out.skippedRows).toBe(2);
        expect(out.entries[1]).toMatchObject({ withdrawn: true, quarantinePeriodDays: 60 });
        expect(out.entries[0]).toMatchObject({ withdrawn: false, pests: ['Листни въшки'] });
    });

    it('refuses an empty file', () => {
        expect(() => parsePppRegisterText('   \n\n')).toThrow(/empty/i);
    });
});

describe('quarantine period', () => {
    it('reads a whole number of days', () => {
        const out = parsePppRegisterText(csv('Пшеница;X;1;въшки;1 л/дка;30;разрешен'));
        expect(out.entries[0]?.quarantinePeriodDays).toBe(30);
    });

    it('reads a fractional or negative cell as ABSENT, not as a rounded figure', () => {
        const half = parsePppRegisterText(csv('Пшеница;X;1;въшки;1 л/дка;1,5;разрешен'));
        expect(half.entries[0]?.quarantinePeriodDays).toBeNull();
        const neg = parsePppRegisterText(csv('Пшеница;X;1;въшки;1 л/дка;-3;разрешен'));
        expect(neg.entries[0]?.quarantinePeriodDays).toBeNull();
    });
});

describe('XLSX', () => {
    it('reaches the same binding and coercion as the text path', async () => {
        const bytes = await makeWorkbook([
            {
                name: 'Регистър',
                rows: [
                    ['Култура', 'Продукт', 'Доза (л/дка)', 'Карантинен срок', 'Статус'],
                    ['Пшеница', 'Карате Зеон', 1.5, 30, 'разрешен'],
                    ['Слънчоглед', 'Пулсар', '1,2 - 2,0', 60, 'отнет'],
                ],
            },
        ]);
        const out = await parsePppRegisterXlsx(bytes, 'Регистър');
        expect(out.entries).toEqual([
            expect.objectContaining({
                crop: 'Пшеница',
                doseMin: 1.5,
                doseMax: 1.5,
                // Numeric cell, so the unit can only come from the header.
                doseUnit: 'л/дка',
                quarantinePeriodDays: 30,
                withdrawn: false,
            }),
            expect.objectContaining({
                crop: 'Слънчоглед',
                doseMin: 1.2,
                doseMax: 2,
                doseUnit: 'л/дка',
                withdrawn: true,
            }),
        ]);
    });

    it('refuses an empty sheet', async () => {
        const bytes = await makeWorkbook([{ name: 'S', rows: [] }]);
        await expect(parsePppRegisterXlsx(bytes, 'S')).rejects.toThrow(/empty/i);
    });
});
