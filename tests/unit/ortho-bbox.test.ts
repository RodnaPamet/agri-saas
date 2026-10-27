/**
 * The ortho bbox parser — #2421.
 *
 * The client's own discipline is to ask for blocks only below 0.12°, or 0.3°
 * for the farm's own bounds. These cases exist because that is a convention,
 * not a bound: without a server-side limit one `bbox=19,41,29,45` asks the
 * Ministry for every physical block in Bulgaria, and the downstream feature
 * cap makes the answer look reasonable.
 */
import { ORTHO_BBOX_MAX_SPAN_DEG, bboxTouchesBulgaria, parseLonLatBbox } from '@/lib/geo/ortho-bbox';

describe('parseLonLatBbox accepts what the phone sends (#2421)', () => {
    it('reads lon first, which is the GeoJSON order', () => {
        // The WFS wants lat first and that flip happens in ONE place,
        // `latLonBboxParam`. If it happened here too the two would cancel and
        // every query would silently land in the Indian Ocean.
        expect(parseLonLatBbox('24.39,43.07,24.41,43.09')).toEqual({
            west: 24.39,
            south: 43.07,
            east: 24.41,
            north: 43.09,
        });
    });

    it('tolerates the whitespace a hand-built query string carries', () => {
        expect(parseLonLatBbox(' 24.39 , 43.07 , 24.41 , 43.09 ')).toEqual({
            west: 24.39,
            south: 43.07,
            east: 24.41,
            north: 43.09,
        });
    });

    it('accepts the client’s largest honest request', () => {
        // 0.3° is the farm-bounds case, and it must not be refused.
        expect(() => parseLonLatBbox('24.0,43.0,24.3,43.3')).not.toThrow();
    });
});

describe('parseLonLatBbox refuses the rest, with ONE code (#2421)', () => {
    it.each([
        ['', 'empty'],
        ['24.39,43.07,24.41', 'three numbers'],
        ['24.39,43.07,24.41,43.09,extra', 'five numbers'],
        ['24.39,,24.41,43.09', 'an empty field'],
        ['a,b,c,d', 'not numbers'],
        ['24.39,43.07,200,43.09', 'outside the world'],
        ['24.41,43.07,24.39,43.09', 'inverted east/west'],
        ['24.39,43.09,24.41,43.07', 'inverted north/south'],
        ['24.39,43.07,24.39,43.09', 'zero width'],
        ['19,41,29,45', 'the whole country'],
    ])('refuses %s (%s)', (raw) => {
        expect(() => parseLonLatBbox(raw)).toThrow(
            expect.objectContaining({ code: 'ORTHO_BBOX_INVALID' }),
        );
    });

    it('the empty field is why finiteness is checked, not just NaN', () => {
        // `Number('')` is 0, not NaN — so an empty field would silently become
        // the equator rather than an error.
        expect(Number('')).toBe(0);
        expect(() => parseLonLatBbox('24.39,,24.41,43.09')).toThrow();
    });

    it('names the span in the message, so a client author can see the limit', () => {
        // One code for every way a bbox can be wrong, distinguished in the
        // MESSAGE: all of them are the same thing to the only caller that can
        // hit them, and none is actionable by a farmer.
        expect(() => parseLonLatBbox('19,41,29,45')).toThrow(
            new RegExp(String(ORTHO_BBOX_MAX_SPAN_DEG)),
        );
    });
});

describe('outside Bulgaria is an ANSWER, not an error (#2421)', () => {
    it('does not refuse a well-formed box over the Aegean', () => {
        // A farmer panning too far has done nothing wrong, and refusing would
        // turn a shrug into an error dialog.
        expect(() => parseLonLatBbox('25.0,37.0,25.1,37.1')).not.toThrow();
        expect(bboxTouchesBulgaria(parseLonLatBbox('25.0,37.0,25.1,37.1'))).toBe(false);
    });

    it('recognises a box inside Bulgaria, and one that merely overlaps', () => {
        expect(bboxTouchesBulgaria(parseLonLatBbox('24.39,43.07,24.41,43.09'))).toBe(true);
        // Straddling the southern border still touches.
        expect(bboxTouchesBulgaria({ west: 24.0, south: 40.9, east: 24.2, north: 41.3 })).toBe(true);
    });
});
