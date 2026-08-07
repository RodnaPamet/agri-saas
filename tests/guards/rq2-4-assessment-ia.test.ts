/**
 * RQ2-4 — guided-assessment IA ratchet.
 *
 * The risk detail page was rationalized from 10 tabs to 8, with a
 * new first-class Assessment surface. The regression classes this
 * guards:
 *
 *   - the Assessment tab silently disappearing (or the panel being
 *     replaced by a bare L/I modal again);
 *   - the demoted tabs creeping back as top-level tabs (the
 *     inherited mappings/tests panels belong under Traceability,
 *     beside the control links they derive from);
 *   - the panel drifting off the tenant's matrix language or the
 *     RQ2-2 "propose, don't overwrite" contract (accept POST must
 *     never carry score values).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const page = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const panel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');

describe('RQ2-4 — risk detail IA', () => {
    test('the 8-tab assessment-centric bar (and nothing demoted creeps back)', () => {
        const tabsBlock = page.slice(
            page.indexOf('const tabs:'),
            page.indexOf('];', page.indexOf('const tabs:')),
        );
        for (const key of [
            'overview',
            'assessment',
            'quantification',
            'bowtie',
            'history',
            'tasks',
            'evidence',
            'traceability',
        ]) {
            expect(tabsBlock).toMatch(new RegExp(`key: '${key}'`));
        }
        for (const demoted of ['mappings', 'activity', 'tests']) {
            expect(tabsBlock).not.toMatch(new RegExp(`key: '${demoted}'`));
        }
    });

    test('the page mounts the shell + assessment panel with both bridges', () => {
        expect(page).toMatch(/<EntityDetailLayout/);
        expect(page).toMatch(/<RiskAssessmentPanel/);
        // Quantify + link-controls bridges switch tabs in place.
        expect(page).toMatch(/onQuantify=\{\(\) => setActiveTab\('quantification'\)\}/);
        expect(page).toMatch(/onLinkControls=\{\(\) => setActiveTab\('traceability'\)\}/);
    });

    test('inherited mappings live under Traceability now', () => {
        const trace = page.slice(
            page.indexOf("activeTab === 'traceability'"),
            page.indexOf("activeTab === 'assessment'"),
        );
        expect(trace).toMatch(/InheritedMappingsPanel/);
        // InheritedTestPlansPanel went with the test-plan feature in the
        // compliance uproot; mappings are what Traceability still inherits.
    });

    test('the panel speaks the tenant matrix language', () => {
        // Levels are labelled from RiskMatrixConfig, bands resolved
        // via the canonical resolver — not hardcoded vocab.
        expect(panel).toMatch(/risk-matrix-config/);
        expect(panel).toMatch(/levelLabels/);
        expect(panel).toMatch(/resolveBandForScore/);
    });

    test('accept stays propose-don’t-overwrite: the POST body carries only a justification', () => {
        const acceptBlock = panel.slice(
            panel.indexOf('const acceptSuggestion'),
            panel.indexOf('const saveResidualOverride'),
        );
        expect(acceptBlock).toMatch(/JSON\.stringify\(\{ justification/);
        for (const banned of ['residualScore', 'residualLikelihood', 'residualImpact', 'effectiveness']) {
            expect(acceptBlock).not.toMatch(new RegExp(`${banned}\\s*:`));
        }
    });

    test('manual residual override sends decomposed dims + justification — never a rollup score', () => {
        const overrideBlock = panel.slice(
            panel.indexOf('const saveResidualOverride'),
            panel.indexOf('const participating'),
        );
        expect(overrideBlock).toMatch(/residualLikelihood,/);
        expect(overrideBlock).toMatch(/residualImpact,/);
        expect(overrideBlock).toMatch(/scoreJustification/);
        expect(overrideBlock).not.toMatch(/residualScore\s*:/);
    });
});
