/**
 * `instantTimestamp()` — the machine-facing timestamp validator (#1539).
 *
 * Executing, not structural. The claim is about which strings a device feed
 * accepts, and that is provable only by feeding it strings.
 *
 * Two things make this worth its own file rather than a case in
 * `request-timestamp.test.ts`:
 *
 *  1. The two helpers deliberately DISAGREE. `requestTimestamp()` accepts a
 *     date-only value and a space-separated datetime because a date picker
 *     sends them; this one refuses both because a sensor does not have a date
 *     picker and a mis-zoned reading is silent corruption. Tests that pin both
 *     behaviours next to each other make the disagreement legible instead of
 *     looking like one of them is wrong.
 *  2. The reason #1539 was mis-filed is that the same property name is
 *     declared twice for the same resource in opposite directions. The last
 *     block below pins the REQUEST and RESPONSE sides as distinct subjects so
 *     a future reader cannot repeat the confusion by reading one and believing
 *     the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { instantTimestamp, requestTimestamp } from '@/lib/schemas/timestamp';

interface SchemaNode {
    type?: string;
    format?: string;
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
}

const Required = z.object({ at: instantTimestamp() });
const Loose = z.object({ at: requestTimestamp() });

describe('instantTimestamp() (#1539)', () => {
    it('parses to a STRING, not a Date — IngestReading.recordedAt is declared string', () => {
        // `data-stream.ts:241` does `new Date(r.recordedAt)` and
        // `IngestReading.recordedAt: string`. A transform here changes the
        // parsed type and breaks that boundary — which is not hypothetical:
        // it is what a `z.coerce.date()` did to six route handlers on #1540.
        const { at } = Required.parse({ at: '2026-10-08T14:00:00Z' });
        expect(typeof at).toBe('string');
        expect(at).toBe('2026-10-08T14:00:00Z');
    });

    describe('accepts a real RFC 3339 instant', () => {
        it.each([
            ['UTC with Z', '2026-10-08T14:00:00Z'],
            ['a positive offset — Bulgarian local time', '2026-10-08T14:00:00+03:00'],
            ['a negative offset', '2026-10-08T14:00:00-05:00'],
            ['fractional seconds', '2026-10-08T14:00:00.123Z'],
        ])('%s', (_label, input) => {
            expect(Required.safeParse({ at: input }).success).toBe(true);
        });

        it('the offset is what `format: date-time` MEANS, and bare .datetime() refuses it', () => {
            // The whole reason for `{ offset: true }`. OpenAPI's
            // `format: date-time` is RFC 3339, which permits an offset, so
            // bare `.datetime()` publishes a contract wider than it enforces.
            // This control pins that the default really is narrower — so a
            // future "simplify to .datetime()" fails here with the reason.
            const bare = z.object({ at: z.string().datetime() });
            expect(bare.safeParse({ at: '2026-10-08T14:00:00+03:00' }).success).toBe(false);
            expect(Required.safeParse({ at: '2026-10-08T14:00:00+03:00' }).success).toBe(true);
        });
    });

    describe('rejects the shapes that silently corrupt a reading', () => {
        it('a space-separated datetime — the timezone-ambiguous one', () => {
            expect(Required.safeParse({ at: '2026-10-08 14:00:00' }).success).toBe(false);
        });

        it('and that form really is read in the SERVER timezone — why it is refused', () => {
            // No `T`, no offset, so `new Date` applies the server's zone. The
            // stored instant then depends on where the server runs. Guarded by
            // the offset check because a UTC CI box would make the assertion
            // vacuous rather than wrong.
            if (new Date().getTimezoneOffset() !== 0) {
                expect(new Date('2026-10-08 14:00:00').toISOString()).not.toBe(
                    '2026-10-08T14:00:00.000Z',
                );
            }
        });

        it('a date-only value — an instant nobody measured', () => {
            expect(Required.safeParse({ at: '2026-10-08' }).success).toBe(false);
            // It would have become midnight UTC downstream.
            expect(new Date('2026-10-08').toISOString()).toBe('2026-10-08T00:00:00.000Z');
        });

        it('a naked local datetime with no zone at all', () => {
            expect(Required.safeParse({ at: '2026-10-08T14:00:00' }).success).toBe(false);
        });
    });

    describe('turns a 500 into a 400 — the defect #1539 actually names', () => {
        it.each(['abcd', 'not-a-date', '', '2026-13-45', 'yesterday', '   '])('%p', (input) => {
            expect(Required.safeParse({ at: input }).success).toBe(false);
        });

        it('the old bound ACCEPTED garbage, which then reached Prisma as an Invalid Date', () => {
            // The control for the whole change. The route previously declared
            // `z.string().min(4).max(40)`, so 'abcd' passed the boundary,
            // `new Date('abcd')` produced an Invalid Date, `createMany`
            // rejected it, and the route's catch handles only
            // DataStreamAccessDenied and rethrows the rest — a 500 on a
            // request the contract says is a 400.
            const old = z.object({ at: z.string().min(4).max(40) });
            expect(old.safeParse({ at: 'abcd' }).success).toBe(true);
            expect(new Date('abcd').getTime()).toBeNaN();
            expect(Required.safeParse({ at: 'abcd' }).success).toBe(false);
        });

        it('rejects a number — no epoch-millis widening', () => {
            // `z.coerce.date()` would accept these. `z.string()` did not, and
            // a change meant to tighten must not widen on another axis.
            for (const n of [0, 1760000000000, -1]) {
                expect(Required.safeParse({ at: n }).success).toBe(false);
            }
        });
    });

    describe('the two helpers disagree ON PURPOSE', () => {
        // Pinned as a pair so neither looks like a bug from the other's side.
        // `requestTimestamp()` guards human-entered fields behind a date
        // picker; refusing a date-only `dueAt` there would break a working UI.
        it.each(['2026-10-08', '2026-10-08 14:00:00'])(
            '%p — loose for a human field, refused for a device feed',
            (input) => {
                expect(Loose.safeParse({ at: input }).success).toBe(true);
                expect(Required.safeParse({ at: input }).success).toBe(false);
            },
        );

        it('both still refuse outright garbage', () => {
            expect(Loose.safeParse({ at: 'abcd' }).success).toBe(false);
            expect(Required.safeParse({ at: 'abcd' }).success).toBe(false);
        });
    });

    describe('the request and the response are DISTINCT subjects (#1539 was mis-filed on this)', () => {
        // I cited the response schema's line as the request's and filed an
        // issue on a divergence that did not exist. The two declarations use
        // the same property name for the same resource in opposite
        // directions, 33 lines apart in one file. Pinned here by the names
        // they are REGISTERED under, which is the thing that actually
        // distinguishes them.
        const spec = JSON.parse(
            readFileSync(join(process.cwd(), 'src/generated/openapi.json'), 'utf8'),
        ) as { components: { schemas: Record<string, SchemaNode> } };

        it('both exist, and they are different schemas — the denominator', () => {
            // Without this, every assertion below is satisfied by a renamed
            // or absent schema, which is how a formatless field would read as
            // clean.
            expect(Object.keys(spec.components.schemas)).toContain('IngestReadings');
            expect(Object.keys(spec.components.schemas)).toContain('DataStreamReading');
        });

        it('the REQUEST declares format: date-time — what this change added', () => {
            const node =
                spec.components.schemas.IngestReadings.properties?.readings?.items?.properties
                    ?.recordedAt;
            expect(node).toEqual({ type: 'string', format: 'date-time' });
        });

        it('the RESPONSE declares it too, and always did — not the thing that was broken', () => {
            const node = spec.components.schemas.DataStreamReading.properties?.recordedAt;
            expect(node).toEqual({ type: 'string', format: 'date-time' });
        });

        it('the published format and the executing check now describe the same strings', () => {
            // The property this change is really for: `format: date-time` is
            // RFC 3339, and `{ offset: true }` is its exact Zod expression. An
            // offset is in the format, so it must be accepted; a
            // space-separated value is not, so it must be refused.
            expect(Required.safeParse({ at: '2026-10-08T14:00:00+03:00' }).success).toBe(true);
            expect(Required.safeParse({ at: '2026-10-08 14:00:00' }).success).toBe(false);
        });
    });
});
