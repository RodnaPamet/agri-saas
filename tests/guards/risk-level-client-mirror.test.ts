/**
 * The web client's `RiskLevel` must mirror the server's, and every member
 * must have a badge variant and a label in both locales.
 *
 * ## Why a guard and not a type
 *
 * `FarmRiskClient.tsx` declares its OWN copy of the union, and it has to:
 * importing from `@/app-layer/usecases/parcel-risk` would pull the usecase —
 * and Prisma — into a `'use client'` bundle. So the duplication is deliberate
 * and `tsc` is blind to the drift: widening the server's union does not touch
 * that file, and nothing fails to compile.
 *
 * The first symptom is on screen. `LEVEL_VARIANT[level]` is `undefined` for a
 * member the client does not know, and `t('level.<member>')` renders the
 * missing-key fallback — a chip with no colour and a key for a label, on the
 * «Риск» screen, in production.
 *
 * Measured 2026-11-08: adding `notAssessed` to the server's union left
 * `npm run typecheck` at exit 0 with the client unchanged. That is the hole.
 *
 * ## Not a "no duplicate types" rule
 *
 * The copy stays. What this file asserts is that the two agree — the same
 * bargain `tests/guards/outbox-completion-mirrors-the-sw.test.ts` strikes for
 * `public/sw.js`, which cannot import from `src/` either.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { readCatalogue } from '../helpers/catalogue';

const SERVER_REL = 'src/app-layer/usecases/parcel-risk.ts';
const CLIENT_REL = 'src/app/t/[tenantSlug]/(app)/farm-risk/FarmRiskClient.tsx';

const read = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8'));

/**
 * The members of a `type RiskLevel = 'a' | 'b'` declaration.
 *
 * Module-level so `selector-teeth` can audit it, and it carries its own
 * control below: an extraction that returned `[]` would make the comparison
 * `[] vs []` and pass for any pair of files.
 */
function riskLevelMembers(source: string): string[] {
    const m = source.match(/type RiskLevel\s*=\s*([^;]+);/);
    if (!m) return [];
    return [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
}

const SERVER = riskLevelMembers(read(SERVER_REL));
const CLIENT = riskLevelMembers(read(CLIENT_REL));

describe('RiskLevel is mirrored in the client', () => {
    it('control: both unions were found and are non-trivial', () => {
        // Without this, an extraction that stopped matching would compare two
        // empty lists and report perfect agreement.
        // Denominator, collected into the CI step summary by the `[tag]`
        // reporter. No directive: `no-console` does not apply under `tests/`,
        // so one would be INERT and the lint ceiling counts inert directives.
        console.log(
            `[risk-level-mirror] server ${SERVER.length} member(s): ${SERVER.join(' ')} | ` +
                `client ${CLIENT.length}: ${CLIENT.join(' ')}`,
        );
        expect(SERVER.length).toBeGreaterThanOrEqual(4);
        expect(CLIENT.length).toBeGreaterThanOrEqual(4);
        expect(SERVER).toContain('good');
        expect(CLIENT).toContain('good');
    });

    it('the client knows exactly the members the server can send', () => {
        /*
         * Set equality, not containment, and in both directions. A client
         * MISSING a member renders an uncoloured chip with a key for a label;
         * a client with an EXTRA one has dead code that reads as support for
         * something the server never sends, which is how a reviewer concludes
         * a state is handled.
         */
        expect([...CLIENT].sort()).toEqual([...SERVER].sort());
    });

    it('every member has a badge variant in the client', () => {
        const variants = read(CLIENT_REL);
        const block = variants.slice(
            variants.indexOf('const LEVEL_VARIANT'),
            variants.indexOf('};', variants.indexOf('const LEVEL_VARIANT')),
        );
        expect(block.length).toBeGreaterThan(40);
        for (const member of SERVER) {
            if (!new RegExp(`\\b${member}\\s*:`).test(block)) {
                throw new Error(
                    `LEVEL_VARIANT in ${CLIENT_REL} has no entry for '${member}'.\n\n` +
                        'A missing entry is `undefined` at the lookup, which renders a chip ' +
                        'with no colour rather than failing.',
                );
            }
        }
    });

    it('every member has a label in BOTH catalogues', () => {
        /*
         * `levelLabel` is `t(`level.${l}`)`, so a member with no catalogue
         * entry renders the key itself. Both locales, because a `bg` gap ships
         * an English key to the operators who are 4-in-5 of this product's
         * users.
         */
        const en = readCatalogue('en') as unknown as {
            ag: { risk: { level: Record<string, string> } };
        };
        const bg = readCatalogue('bg') as unknown as {
            ag: { risk: { level: Record<string, string> } };
        };
        const missing: string[] = [];
        for (const member of SERVER) {
            if (!en.ag.risk.level[member]) missing.push(`en ag.risk.level.${member}`);
            if (!bg.ag.risk.level[member]) missing.push(`bg ag.risk.level.${member}`);
        }
        expect(missing).toEqual([]);

        // …and the two states a reader most easily conflates must not share a
        // label. `unknown` is "no usable imagery"; `notAssessed` is "imagery
        // fine, nothing to measure". Identical words would hide a real
        // difference behind a chip.
        if (SERVER.includes('notAssessed')) {
            expect(bg.ag.risk.level.notAssessed).not.toBe(bg.ag.risk.level.unknown);
            expect(en.ag.risk.level.notAssessed).not.toBe(en.ag.risk.level.unknown);
        }
    });
});
