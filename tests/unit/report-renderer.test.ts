/**
 * RQ-10 — report renderers + schedule cadence (pure). No DB.
 */

const data: ReportData = {
    title: 'Portfolio Risk Summary',
    tenantName: 'Acme',
    generatedAt: '2026-06-10T00:00:00.000Z',
    totals: { totalRiskCount: 5, quantifiedCount: 3, totalAle: 1_500_000, avgAle: 500_000, maxAle: 800_000 },
    var: { mean: 1_440_000, p95: 2_810_000, p99: 3_920_000 },
    appetite: { status: 'BREACHED', portfolioAle: 1_500_000 },
    topRisks: [
        // RQ3-4 — one row with tail data, one without (mean-only).
        { title: 'Data breach', category: 'Technical', ale: 800_000, aleP90: 2_400_000 },
        { title: 'Ransomware', category: null, ale: 700_000, aleP90: null },
    ],
    bia: { withRto: 2, withRpo: 1, totalRevenueAtRisk: 3_000_000 },
};

describe('renderCsv', () => {
    const csv = renderCsv(data).toString('utf8');
    it('produces a non-empty buffer', () => expect(renderCsv(data).length).toBeGreaterThan(0));
    it('includes the KPI + top-risk headers', () => {
        expect(csv).toContain('Metric,Value');
        expect(csv).toContain('Total ALE,1500000');
        expect(csv).toContain('VaR-95,2810000');
        expect(csv).toContain('Risk,Category,ALE,Bad year (P90)');
        // RQ3-4 — tail row carries the raw P90; the mean-only row's
        // bad-year cell is empty, never a duplicated mean.
        expect(csv).toContain('Data breach,Technical,800000,2400000');
        expect(csv).toContain('Ransomware,,700000,');
    });
    it('quotes a value containing a comma', () => {
        const d = { ...data, topRisks: [{ title: 'Breach, major', category: 'X', ale: 1, aleP90: null }] };
        expect(renderCsv(d).toString('utf8')).toContain('"Breach, major",X,1');
    });
});

describe('PPTX export wiring', () => {
    // pptxgenjs's write() lazy-imports jszip via a native dynamic import, which
    // Jest's CJS VM can't execute ("dynamic import callback without
    // --experimental-vm-modules"). The actual zip is produced in the Node/Next
    // runtime; here we lock the wiring + format contract.
    it('renderPptx is exported', () => {
        expect(typeof renderPptx).toBe('function');
    });
    it('FORMAT_META.PPTX carries the OOXML mime + ext', () => {
        expect(FORMAT_META.PPTX).toEqual({
            ext: 'pptx',
            mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        });
    });
});

describe('computeNextRun', () => {
    const from = new Date('2026-06-10T00:00:00.000Z');
    it('WEEKLY → +7 days', () => expect(computeNextRun('WEEKLY', from).toISOString()).toBe('2026-06-17T00:00:00.000Z'));
    it('MONTHLY → +1 month', () => expect(computeNextRun('MONTHLY', from).toISOString()).toBe('2026-07-10T00:00:00.000Z'));
    it('QUARTERLY → +3 months', () => expect(computeNextRun('QUARTERLY', from).toISOString()).toBe('2026-09-10T00:00:00.000Z'));
});
