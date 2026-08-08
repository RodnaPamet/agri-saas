/**
 * Guardrail: PR 4/5 task C6 — the dose / PHI / REI structural gate.
 *
 * The product's hard rule (the user's own words): "a dose rate, PHI, or
 * re-entry interval may appear in an article ONLY with a БАБХ
 * registration number attached." This repository has no licensed БАБХ
 * registration dataset, so NONE of the authored content should ever
 * carry a dose/PHI/REI without one.
 *
 * Three things this file proves, none of which is "an assertion that
 * cannot fail":
 *
 *   1. STRUCTURAL — the actual shipped content (`GLOBAL_CORPUS` +
 *      `ALL_SEED_ARTICLES`, i.e. `GROWING_GUIDES` + `SATELLITE_GUIDES`)
 *      is scanned with the real detector and must come
 *      back clean. This is what makes the gate "catch content you did
 *      not write" — any future addition to either array is scanned by
 *      this same test, not just at ingest time against a live database.
 *   2. MUTATION PROOF (negative) — synthetic fixtures shaped like real
 *      Bulgarian dose/PHI/REI text (both languages, both unit systems:
 *      л/дка as well as l/ha) MUST be rejected. If a future edit
 *      weakens a pattern (e.g. drops the дка branch), one of these
 *      fixtures starts passing and this suite goes red.
 *   3. MUTATION PROOF (positive) — a fixture carrying a БАБХ
 *      registration number alongside a dose is accepted (proves the
 *      escape hatch works and the detector isn't just refusing
 *      everything), and realistic non-regulated agronomy text (scouting
 *      counts, BBCH numbers, harvest moisture percentages) is accepted
 *      too (proves the detector doesn't crush the very content this PR
 *      needs to ship).
 */
import {
    scanForUnregisteredRegulatedContent,
    assertNoUnregisteredRegulatedContent,
} from '../../scripts/rag/dose-phi-guard';
import { GLOBAL_CORPUS } from '../../scripts/rag/corpus';
import { ALL_SEED_ARTICLES } from '../../scripts/import-knowledge';

describe('dose/PHI/REI structural gate', () => {
    // ── 1. Structural: the real shipped content is clean ──────────────
    describe('shipped content carries no unregistered dose/PHI/REI', () => {
        it.each(GLOBAL_CORPUS.map((e) => [e.sourceRef, e.text] as const))(
            'GLOBAL_CORPUS entry "%s"',
            (sourceRef, text) => {
                expect(scanForUnregisteredRegulatedContent(text)).toEqual([]);
                expect(() => assertNoUnregisteredRegulatedContent(text, sourceRef)).not.toThrow();
            },
        );

        it.each(
            ALL_SEED_ARTICLES.map((g) => [g.slug, `${g.title} ${g.summary} ${g.content}`] as const),
        )('ALL_SEED_ARTICLES entry "%s"', (slug, text) => {
            expect(scanForUnregisteredRegulatedContent(text)).toEqual([]);
            expect(() => assertNoUnregisteredRegulatedContent(text, slug)).not.toThrow();
        });

        it('GLOBAL_CORPUS actually has substantial Bulgarian-first agronomy content', () => {
            // Guards against someone "fixing" a false positive by deleting content
            // instead of rewriting it — the gate should stay non-trivially
            // exercised, not empty.
            expect(GLOBAL_CORPUS.length).toBeGreaterThanOrEqual(30);
            const bgEntries = GLOBAL_CORPUS.filter((e) => e.language === 'bg');
            expect(bgEntries.length).toBeGreaterThanOrEqual(GLOBAL_CORPUS.length / 2);
        });
    });

    // ── 2. Mutation proof — violations MUST be caught ──────────────────
    describe('rejects dose rates without a БАБХ registration number', () => {
        const violatingDoses = [
            ['Bulgarian, л/дка', 'Приложете 2 л/дка от разтвора върху посева при поява на неприятеля.'],
            ['Bulgarian, кг/дка', 'Нормата на внасяне е 0.5 кг/дка, разпределени равномерно.'],
            ['Bulgarian, мл/дка', 'Дозата е 150 мл/дка, разредени в достатъчно количество вода.'],
            ['English, l/ha', 'Apply 2 l/ha of the product once the pest threshold is reached.'],
            ['English, g/ha', 'Use a rate of 400 g/ha for effective control.'],
            ['English, ml/dka', 'The label rate is 150 ml/dka for this crop.'],
            ['% working solution, Bulgarian', 'Пригответе 0.2% работен разтвор преди третиране.'],
            ['% solution, English', 'Mix a 0.5% spray solution before application.'],
        ];

        it.each(violatingDoses)('%s', (_label, text) => {
            const violations = scanForUnregisteredRegulatedContent(text);
            expect(violations.length).toBeGreaterThan(0);
            expect(violations.some((v) => v.kind === 'dose')).toBe(true);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).toThrow(/REFUSED/);
        });
    });

    describe('rejects PHI (pre-harvest interval) without a БАБХ registration number', () => {
        const violatingPhi = [
            ['Bulgarian, карантинен срок', 'Спазвайте карантинен срок от 14 дни преди прибиране на реколтата.'],
            ['Bulgarian, дни преди прибиране', 'Третирането трябва да приключи поне 10 дни преди прибиране.'],
            ['English, PHI acronym', 'The PHI for this product is 14 days.'],
            ['English, pre-harvest interval', 'Respect the pre-harvest interval before combining the field.'],
            ['English, days before harvest', 'Do not treat within 7 days before harvest.'],
        ];

        it.each(violatingPhi)('%s', (_label, text) => {
            const violations = scanForUnregisteredRegulatedContent(text);
            expect(violations.length).toBeGreaterThan(0);
            expect(violations.some((v) => v.kind === 'phi')).toBe(true);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).toThrow(/REFUSED/);
        });
    });

    describe('rejects re-entry intervals without a БАБХ registration number', () => {
        const violatingRei = [
            ['Bulgarian, възстановителен период (correct spelling)', 'Спазвайте възстановителен период от 24 часа преди повторно влизане.'],
            ['Bulgarian, въстановителен (brief\'s own spelling)', 'Изчакайте въстановителен период от 48 часа.'],
            ['Bulgarian, влизане в третираната площ', 'Не допускайте влизане в третираната площ преди изсъхване на разтвора.'],
            ['English, REI acronym', 'The REI for this product is 24 hours.'],
            ['English, re-entry interval', 'Observe the re-entry interval before returning to the field.'],
        ];

        it.each(violatingRei)('%s', (_label, text) => {
            const violations = scanForUnregisteredRegulatedContent(text);
            expect(violations.length).toBeGreaterThan(0);
            expect(violations.some((v) => v.kind === 'rei')).toBe(true);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).toThrow(/REFUSED/);
        });
    });

    // ── 3. Mutation proof — the escape hatch + false-positive guard ────
    describe('accepts a dose alongside a real БАБХ registration number', () => {
        const registered = [
            [
                'БАБХ ... № before the number',
                'Приложете 2 л/дка съгласно регистрация БАБХ № 01-1234/15.03.2024.',
            ],
            [
                'registration number before БАБХ',
                'Използвайте продукт с № 01-5678/2023, регистриран от БАБХ, при 400 g/ha.',
            ],
            [
                'generic "рег. №" marker',
                'Дозата от 0.5 кг/дка е валидна само за продукт с рег. № 02-9999/2022.',
            ],
            [
                'generic "registration no." marker (English)',
                'Apply 2 l/ha only for a product carrying registration no. 01-1234/2024.',
            ],
        ];

        it.each(registered)('%s', (_label, text) => {
            expect(scanForUnregisteredRegulatedContent(text)).toEqual([]);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).not.toThrow();
        });
    });

    // Found while authoring this PR's own content: a bare mention of the
    // WORD "registration number" (no actual digits) must NOT be treated as
    // an escape hatch — `[\w./-]+` alone happily matched "from" in
    // "...registration number from the official register", handing every
    // PHI/REI mention a free pass. Regression-locks the fix (the token
    // after №/no./number must contain a digit).
    describe('a bare "registration number" mention with no digits is not an escape hatch', () => {
        const bareFixtures = [
            [
                'English, "registration number" with no digits nearby',
                'Respect the pre-harvest interval — a specific product carries a registration number from the official register, so check it.',
            ],
            [
                'Bulgarian, "регистрационен номер" with no digits nearby',
                'Спазвайте карантинен срок — всеки продукт има регистрационен номер в официалния регистър, който трябва да проверите.',
            ],
        ];

        it.each(bareFixtures)('%s', (_label, text) => {
            const violations = scanForUnregisteredRegulatedContent(text);
            expect(violations.length).toBeGreaterThan(0);
            expect(violations.some((v) => v.kind === 'phi')).toBe(true);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).toThrow(/REFUSED/);
        });
    });

    describe('does not false-positive on legitimate agronomy content', () => {
        const legitimate = [
            ['scouting threshold (count per stem, no unit/area)', 'Threshold: an average of 5 aphids per stem during stem elongation.'],
            ['scouting threshold (Bulgarian)', 'Праг: средно 5 въшки на стъбло по време на вретенене.'],
            ['BBCH stage numbers', 'BBCH 30-39 stem elongation; BBCH 51-59 heading.'],
            ['harvest moisture percentage', 'Harvest typically happens around 12-14% grain moisture.'],
            ['harvest moisture percentage (Bulgarian)', 'Прибирането става при влажност около 12-14% на зърното.'],
            ['seeding rate without area unit', 'Increase seeding density by roughly 10% on heavier soils.'],
            ['pointer to the official register (no numbers stated)', 'Check the official БАБХ register before any treatment decision.'],
        ];

        it.each(legitimate)('%s', (_label, text) => {
            expect(scanForUnregisteredRegulatedContent(text)).toEqual([]);
            expect(() => assertNoUnregisteredRegulatedContent(text, 'fixture')).not.toThrow();
        });
    });

    // ── Error message legibility ────────────────────────────────────
    it('names the offending context + kind in the thrown error', () => {
        expect(() =>
            assertNoUnregisteredRegulatedContent('Apply 2 l/ha of the product.', 'bg-example-slug'),
        ).toThrow(/bg-example-slug/);
        expect(() =>
            assertNoUnregisteredRegulatedContent('Apply 2 l/ha of the product.', 'bg-example-slug'),
        ).toThrow(/DOSE/);
    });
});
