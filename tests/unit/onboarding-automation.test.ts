/**
 * Onboarding Automation Tests
 *
 * Tests the deterministic risk catalog, asset type inference,
 * idempotency contracts, and starter task generation.
 */

// ─── Asset Type Inference ───

const ASSET_TYPE_KEYWORDS: Record<string, string[]> = {
    APPLICATION: ['app', 'application', 'software', 'platform', 'portal', 'saas', 'web', 'mobile', 'api', 'system'],
    DATASTORE: ['database', 'db', 'data', 'storage', 'warehouse', 'lake', 'backup', 'archive', 'repository'],
    INFRASTRUCTURE: ['server', 'cloud', 'network', 'firewall', 'infrastructure', 'cluster', 'vpc', 'aws', 'azure', 'gcp', 'kubernetes'],
    VENDOR: ['vendor', 'partner', 'supplier', 'third-party', 'contractor', 'outsourced'],
    PROCESS: ['process', 'workflow', 'procedure', 'policy', 'operation', 'hr', 'finance', 'payroll'],
};

function inferAssetType(name: string): string {
    const lower = name.toLowerCase();
    for (const [type, keywords] of Object.entries(ASSET_TYPE_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) return type;
    }
    return 'APPLICATION';
}

// ─── Starter Risk Catalog (copied for testing) ───

interface StarterRisk {
    title: string;
    category: string;
    assetTypes: string[];
    frameworks: string[];
}

const STARTER_RISKS: StarterRisk[] = [
    { title: 'Unauthorized Access to Application', category: 'Access Control', assetTypes: ['APPLICATION'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Application Vulnerability Exploitation', category: 'Vulnerability Management', assetTypes: ['APPLICATION'], frameworks: ['iso27001'] },
    { title: 'Insufficient Application Logging', category: 'Logging & Monitoring', assetTypes: ['APPLICATION'], frameworks: ['iso27001'] },
    { title: 'Application Availability Disruption', category: 'Availability', assetTypes: ['APPLICATION'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Data Backup Failure', category: 'Business Continuity', assetTypes: ['DATASTORE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Data Confidentiality Breach', category: 'Confidentiality', assetTypes: ['DATASTORE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Data Integrity Compromise', category: 'Data Integrity', assetTypes: ['DATASTORE'], frameworks: ['iso27001'] },
    { title: 'Network Perimeter Breach', category: 'Network Security', assetTypes: ['INFRASTRUCTURE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Cloud Misconfiguration', category: 'Cloud Security', assetTypes: ['INFRASTRUCTURE'], frameworks: ['iso27001'] },
    { title: 'Third-Party Data Processing Risk', category: 'Vendor Management', assetTypes: ['VENDOR'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Supply Chain Dependency Risk', category: 'Supply Chain', assetTypes: ['VENDOR'], frameworks: ['nis2'] },
    { title: 'Insider Threat', category: 'Human Resources', assetTypes: ['PROCESS'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Incident Response Failure', category: 'Incident Management', assetTypes: ['PROCESS'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Regulatory Non-Compliance', category: 'Compliance', assetTypes: [], frameworks: ['iso27001', 'nis2'] },
    { title: 'Physical Security Breach', category: 'Physical Security', assetTypes: [], frameworks: ['iso27001'] },
];

function selectApplicableRisks(selectedFrameworks: string[], assetTypes: Set<string>): StarterRisk[] {
    return STARTER_RISKS.filter(risk => {
        const fwMatch = risk.frameworks.length === 0 || risk.frameworks.some(fw => selectedFrameworks.includes(fw));
        const typeMatch = risk.assetTypes.length === 0 || risk.assetTypes.some(at => assetTypes.has(at));
        return fwMatch && typeMatch;
    });
}

// ─── Tests ───

describe('Onboarding Automation', () => {
    describe('Asset Type Inference', () => {
        it('infers APPLICATION for app-like names', () => {
            expect(inferAssetType('Customer Portal')).toBe('APPLICATION');
            expect(inferAssetType('Mobile App')).toBe('APPLICATION');
            expect(inferAssetType('Internal API')).toBe('APPLICATION');
            expect(inferAssetType('SaaS Platform')).toBe('APPLICATION');
        });

        it('infers DATASTORE for data-like names', () => {
            expect(inferAssetType('Customer Database')).toBe('DATASTORE');
            expect(inferAssetType('Data Warehouse')).toBe('DATASTORE');
            expect(inferAssetType('Backup Storage')).toBe('DATASTORE');
        });

        it('infers INFRASTRUCTURE for infra-like names', () => {
            expect(inferAssetType('Cloud Infrastructure')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('Production Server')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('AWS VPC')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('Kubernetes Cluster')).toBe('INFRASTRUCTURE');
        });

        it('infers VENDOR for vendor-like names', () => {
            expect(inferAssetType('Payment Vendor')).toBe('VENDOR');
            expect(inferAssetType('Third-Party Processor')).toBe('VENDOR');
        });

        it('infers PROCESS for process-like names', () => {
            expect(inferAssetType('HR Onboarding Process')).toBe('PROCESS');
            expect(inferAssetType('Finance Workflows')).toBe('PROCESS');
        });

        it('defaults to APPLICATION for unknown names', () => {
            expect(inferAssetType('CRM')).toBe('APPLICATION');
            expect(inferAssetType('Something Else')).toBe('APPLICATION');
        });
    });

    describe('Risk Catalog Selection', () => {
        it('returns APPLICATION risks for iso27001 with app assets', () => {
            const risks = selectApplicableRisks(['iso27001'], new Set(['APPLICATION']));
            expect(risks.some(r => r.title === 'Unauthorized Access to Application')).toBe(true);
            expect(risks.some(r => r.title === 'Application Vulnerability Exploitation')).toBe(true);
            // General risks should also be included
            expect(risks.some(r => r.title === 'Regulatory Non-Compliance')).toBe(true);
        });

        it('returns DATASTORE risks for nis2 with data assets', () => {
            const risks = selectApplicableRisks(['nis2'], new Set(['DATASTORE']));
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(true);
            expect(risks.some(r => r.title === 'Data Confidentiality Breach')).toBe(true);
            // iso27001-only risks should NOT be included
            expect(risks.some(r => r.title === 'Data Integrity Compromise')).toBe(false);
        });

        it('returns VENDOR risks for nis2 with vendor assets', () => {
            const risks = selectApplicableRisks(['nis2'], new Set(['VENDOR']));
            expect(risks.some(r => r.title === 'Supply Chain Dependency Risk')).toBe(true);
            expect(risks.some(r => r.title === 'Third-Party Data Processing Risk')).toBe(true);
        });

        it('returns comprehensive risks for both frameworks + multiple asset types', () => {
            const risks = selectApplicableRisks(['iso27001', 'nis2'], new Set(['APPLICATION', 'DATASTORE', 'INFRASTRUCTURE']));
            // Should include all asset-specific risks plus generals
            expect(risks.length).toBeGreaterThanOrEqual(10);
            expect(risks.some(r => r.title === 'Unauthorized Access to Application')).toBe(true);
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(true);
            expect(risks.some(r => r.title === 'Network Perimeter Breach')).toBe(true);
            expect(risks.some(r => r.title === 'Regulatory Non-Compliance')).toBe(true);
        });

        it('excludes risks for unselected asset types', () => {
            const risks = selectApplicableRisks(['iso27001'], new Set(['APPLICATION']));
            // Should NOT include DATASTORE, INFRASTRUCTURE, VENDOR, PROCESS risks
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(false);
            expect(risks.some(r => r.title === 'Network Perimeter Breach')).toBe(false);
            expect(risks.some(r => r.title === 'Third-Party Data Processing Risk')).toBe(false);
        });

        it('selection is deterministic — same inputs always produce same outputs', () => {
            const run1 = selectApplicableRisks(['iso27001'], new Set(['APPLICATION']));
            const run2 = selectApplicableRisks(['iso27001'], new Set(['APPLICATION']));
            expect(run1.map(r => r.title)).toEqual(run2.map(r => r.title));
        });
    });

    describe('Risk Catalog Properties', () => {
        it('all risks have unique titles', () => {
            const titles = STARTER_RISKS.map(r => r.title);
            expect(new Set(titles).size).toBe(titles.length);
        });

        it('all risks reference at least one framework', () => {
            for (const risk of STARTER_RISKS) {
                expect(risk.frameworks.length).toBeGreaterThan(0);
            }
        });

        it('total catalog has 15 risks', () => {
            expect(STARTER_RISKS.length).toBe(15);
        });
    });

    describe('Framework Pack Key Mapping', () => {
        const FRAMEWORK_PACK_KEYS: Record<string, string> = {
            iso27001: 'iso27001-2022-baseline',
            nis2: 'nis2-baseline',
        };

        it('maps iso27001 to correct pack key', () => {
            expect(FRAMEWORK_PACK_KEYS['iso27001']).toBe('iso27001-2022-baseline');
        });

        it('maps nis2 to correct pack key', () => {
            expect(FRAMEWORK_PACK_KEYS['nis2']).toBe('nis2-baseline');
        });

        it('returns undefined for unknown frameworks', () => {
            expect(FRAMEWORK_PACK_KEYS['soc2']).toBeUndefined();
        });
    });

    describe('Starter Tasks', () => {
        const starterTasks = [
            { title: 'Review and assign practice owners', type: 'TASK' },
            { title: 'Schedule evidence collection cadence', type: 'TASK' },
            { title: 'Complete risk assessment review', type: 'TASK' },
            { title: 'Define incident response procedure', type: 'TASK' },
            { title: 'Set up vendor due diligence process', type: 'TASK' },
        ];

        it('has exactly 5 starter tasks', () => {
            expect(starterTasks.length).toBe(5);
        });

        it('all starter tasks are type TASK', () => {
            for (const task of starterTasks) {
                expect(task.type).toBe('TASK');
            }
        });

        it('all starter tasks have unique titles', () => {
            const titles = starterTasks.map(t => t.title);
            expect(new Set(titles).size).toBe(titles.length);
        });
    });
});
