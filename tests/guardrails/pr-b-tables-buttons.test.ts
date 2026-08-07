/**
 * PR-B — Table & button hygiene ratchet.
 *
 *   1. Tests rollup table splits Name + Status into separate
 *      columns (no longer stacked inside one cell).
 *
 *   2. Risk gains a `key` column ('RSK-N') generated atomically
 *      via `RiskKeySequence.upsert`. The Risk list page leads
 *      with the new Code column.
 *
 *   3. The shared `<Button>` centres its content unit
 *      `[icon][gap][label]` (justify-center + hug-content) so
 *      "+ Create X" reads as a tidy, balanced control. (The original
 *      "icon-balance ghost" was reverted 2026-05-31 — see the
 *      describe block below.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-B — table & button hygiene', () => {

    describe('Risk Code column + RSK-N key generation', () => {
        const schema = read('prisma/schema/compliance.prisma');
        const migration = read(
            'prisma/migrations/20260524200000_pr_b_risk_key/migration.sql',
        );
        const repo = read('src/app-layer/repositories/RiskRepository.ts');
        const ui = read(
            'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
        );

        it('Risk schema declares the key field + RiskKeySequence model', () => {
            // The Risk block must carry a nullable `key String?`
            // field with the `@@unique([tenantId, key])` index.
            const riskBlock = schema.slice(
                schema.indexOf('model Risk {'),
                schema.indexOf('model RiskTemplate {'),
            );
            expect(riskBlock).toMatch(/^\s*key\s+String\?/m);
            expect(riskBlock).toMatch(
                /@@unique\(\[tenantId,\s*key\]\)/,
            );
            // Counter table declared.
            expect(schema).toMatch(/model RiskKeySequence/);
        });

        it('migration adds the column + counter table + RLS policies', () => {
            expect(migration).toMatch(/ALTER TABLE "Risk" ADD COLUMN "key"/);
            expect(migration).toMatch(/CREATE TABLE "RiskKeySequence"/);
            // Class A RLS pattern present.
            expect(migration).toMatch(
                /CREATE POLICY tenant_isolation ON "RiskKeySequence"/,
            );
            expect(migration).toMatch(
                /FORCE ROW LEVEL SECURITY/,
            );
            // Backfill seeds the counter from existing RSK-N keys.
            expect(migration).toMatch(
                /SUBSTRING\("key" FROM '\^RSK-\(\[0-9\]\+\)\$'\)/,
            );
        });

        it('RiskRepository.create mints from riskKeySequence.upsert', () => {
            expect(repo).toMatch(/riskKeySequence\.upsert/);
            expect(repo).toMatch(/`RSK-\$\{seq\.lastValue\}`/);
            // The mint guards on caller-supplied key (backfill path).
            expect(repo).toMatch(/if\s*\(!key\)\s*\{/);
        });

        it('RiskRepository list select includes key', () => {
            // Anchor on the riskListSelect const + the `key: true` line
            // INSIDE its body.
            expect(repo).toMatch(
                /const riskListSelect[\s\S]{0,400}key:\s*true/,
            );
        });

        it('Risks list page renders the Code column FIRST', () => {
            // The Code column declaration must appear before the
            // title column (column order = JSX order).
            const codeIdx = ui.indexOf("id: 'code'");
            const titleIdx = ui.indexOf("accessorKey: 'title'");
            expect(codeIdx).toBeGreaterThan(0);
            expect(titleIdx).toBeGreaterThan(codeIdx);
            // Header label is "Code" — i18n (T06): resolved via next-intl.
            expect(ui).toMatch(
                /id:\s*['"]code['"],\s*header:\s*(?:['"]Code['"]|tm\('colCode'\))/,
            );
        });
    });

    describe('"+ Create X" button alignment — centred content unit', () => {
        // 2026-05-31: the original PR-B "icon-balance ghost" (an
        // invisible mirror of the icon on the trailing edge that
        // centred the LABEL alone) was reverted on user feedback. The
        // ghost widened buttons with one-sided blank space and the
        // `+ word` unit didn't read as centred. The button now centres
        // the WHOLE content unit `[icon][gap][label]` via
        // justify-center + hug-content, so `+ Asset` reads as a tidy
        // centred unit. The canonical lock now lives in
        // tests/guards/button-label-centering.test.ts +
        // tests/rendered/button-label-centering.test.tsx.
        const src = read('src/components/ui/button.tsx');

        it('no longer renders a balance ghost (centres the content unit instead)', () => {
            expect(src).not.toMatch(/data-icon-balance-ghost/);
            expect(src).not.toMatch(/data-right-balance-ghost/);
        });

        it('centres the content unit via justify-center', () => {
            const variants = read('src/components/ui/button-variants.ts');
            expect(variants).toMatch(/inline-flex items-center justify-center/);
        });
    });

    describe('first-column registry — Risks adoption refreshed', () => {
        const src = read('tests/guards/table-unification.test.ts');

        it('Risks registry entry declares firstColumnId="code"', () => {
            // Anchor on the file path so a future entry shuffle still
            // hits the right slot.
            const risksEntry = src.slice(
                src.indexOf('risks/RisksClient.tsx'),
                src.indexOf('risks/RisksClient.tsx') + 600,
            );
            expect(risksEntry).toMatch(/firstColumnId:\s*['"]code['"]/);
            expect(risksEntry).toMatch(/adopted:\s*true/);
        });
    });
});
