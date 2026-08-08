/**
 * polish #6 — one compact-currency formatter, period.
 *
 * The dashboard's old `formatMoney` was a parallel implementation
 * that drifted on currency symbol ($) and rounding ($1.25M vs
 * €1.3M). It's gone; this ratchet stops it (or any other
 * one-off compact-currency function) from creeping back.
 */
import { execSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

describe('polish #6 — single compact-currency formatter', () => {
    test('no parallel currency formatter is declared anywhere in src/', () => {
        // Any `function|const formatMoney|formatCurrency|formatCompactCurrency`
        // declaration outside the canonical home is the regression class.
        const out = execSync(
            `grep -rnE "(function|const)\\s+(formatMoney|formatCurrency)\\b" src --include="*.ts" --include="*.tsx" || true`,
            { encoding: 'utf-8', cwd: ROOT },
        ).trim();
        expect(out).toBe('');
    });

    test('formatCompactCurrency is declared once (the canonical home in format-currency.ts)', () => {
        // Moved out of `risk-coherence.ts` by the risk-quantification
        // uproot — the formatter is money, not risk, so it outlived the
        // FAIR/ALE module it happened to live in.
        const out = execSync(
            `grep -rln "export function formatCompactCurrency" src --include="*.ts"`,
            { encoding: 'utf-8', cwd: ROOT },
        ).trim().split('\n');
        expect(out).toEqual(['src/lib/format-currency.ts']);
    });
});
