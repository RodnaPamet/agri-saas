/**
 * Onboarding Automation Service
 *
 * Wires wizard step completions to real product actions.
 * All actions are idempotent — re-running a step never duplicates data.
 *
 * Strategy:
 * - Framework install → retired with the control-template library
 * - Asset creation → upserts by name (idempotent by tenant+name uniqueness)
 * - Risk generation → deterministic rules, checks existing risks by title before creating
 * - Task/team setup → creates starter tasks only if none exist for onboarding
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { OnboardingRepository } from '../repositories/OnboardingRepository';
import type { AssetType, WorkItemType } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StepData = Record<string, any>;

// ─── Pack key mapping ───

// ─── Asset type inference ───

const ASSET_TYPE_KEYWORDS: Record<string, string[]> = {
    TRACTOR: ['tractor'],
    HARVESTER: ['harvester', 'combine', 'forager'],
    IMPLEMENT: ['plough', 'plow', 'seeder', 'planter', 'sprayer', 'mower', 'baler', 'tiller', 'cultivator', 'harrow', 'implement', 'spreader'],
    VEHICLE: ['truck', 'pickup', 'trailer', 'van', 'vehicle', 'loader', 'telehandler', 'utv', 'atv', 'quad'],
    IRRIGATION: ['irrigation', 'pump', 'pivot', 'drip', 'sprinkler'],
    BUILDING: ['barn', 'shed', 'silo', 'warehouse', 'greenhouse', 'building', 'stable', 'workshop'],
    STORAGE: ['tank', 'bin', 'storage', 'granary', 'store'],
    LIVESTOCK_EQUIPMENT: ['feeder', 'milking', 'livestock', 'trough', 'parlour', 'parlor'],
    TOOL: ['tool', 'chainsaw', 'drill', 'generator', 'welder'],
};

function inferAssetType(name: string): string {
    const lower = name.toLowerCase();
    for (const [type, keywords] of Object.entries(ASSET_TYPE_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) return type;
    }
    return 'OTHER'; // sensible default
}

// ─── Risk catalog (deterministic rules) ───

interface StarterRisk {
    title: string;
    category: string;
    threat: string;
    vulnerability: string;
    likelihood: number;
    impact: number;
    assetTypes: string[];
    frameworks: string[];
}

const STARTER_RISKS: StarterRisk[] = [
    // APPLICATION risks
    { title: 'Unauthorized Access to Application', category: 'Access Control', threat: 'Unauthorized user access', vulnerability: 'Weak authentication or authorization', likelihood: 3, impact: 4, assetTypes: ['APPLICATION'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Application Vulnerability Exploitation', category: 'Vulnerability Management', threat: 'Exploitation of software vulnerabilities', vulnerability: 'Unpatched application dependencies', likelihood: 3, impact: 4, assetTypes: ['APPLICATION'], frameworks: ['iso27001'] },
    { title: 'Insufficient Application Logging', category: 'Logging & Monitoring', threat: 'Undetected security incidents', vulnerability: 'Inadequate log collection and monitoring', likelihood: 2, impact: 3, assetTypes: ['APPLICATION'], frameworks: ['iso27001'] },
    { title: 'Application Availability Disruption', category: 'Availability', threat: 'Service outage or degraded performance', vulnerability: 'Single point of failure in architecture', likelihood: 2, impact: 4, assetTypes: ['APPLICATION'], frameworks: ['iso27001', 'nis2'] },

    // DATASTORE risks
    { title: 'Data Backup Failure', category: 'Business Continuity', threat: 'Data loss due to backup failure', vulnerability: 'Untested or misconfigured backup procedures', likelihood: 2, impact: 5, assetTypes: ['DATASTORE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Data Confidentiality Breach', category: 'Confidentiality', threat: 'Unauthorized data access or exfiltration', vulnerability: 'Insufficient encryption or access controls', likelihood: 3, impact: 5, assetTypes: ['DATASTORE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Data Integrity Compromise', category: 'Data Integrity', threat: 'Unauthorized data modification', vulnerability: 'Lack of integrity verification mechanisms', likelihood: 2, impact: 4, assetTypes: ['DATASTORE'], frameworks: ['iso27001'] },

    // INFRASTRUCTURE risks
    { title: 'Network Perimeter Breach', category: 'Network Security', threat: 'External network attack', vulnerability: 'Misconfigured firewall or security groups', likelihood: 3, impact: 4, assetTypes: ['INFRASTRUCTURE'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Cloud Misconfiguration', category: 'Cloud Security', threat: 'Exposure of cloud resources', vulnerability: 'Misconfigured IAM policies or public buckets', likelihood: 3, impact: 4, assetTypes: ['INFRASTRUCTURE'], frameworks: ['iso27001'] },

    // VENDOR risks
    { title: 'Third-Party Data Processing Risk', category: 'Vendor Management', threat: 'Vendor data breach or misuse', vulnerability: 'Insufficient vendor due diligence or contracts', likelihood: 2, impact: 4, assetTypes: ['VENDOR'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Supply Chain Dependency Risk', category: 'Supply Chain', threat: 'Disruption from vendor failure', vulnerability: 'Over-reliance on single vendor', likelihood: 2, impact: 3, assetTypes: ['VENDOR'], frameworks: ['nis2'] },

    // PROCESS risks
    { title: 'Insider Threat', category: 'Human Resources', threat: 'Malicious or negligent insider activity', vulnerability: 'Insufficient access controls and monitoring', likelihood: 2, impact: 4, assetTypes: ['PROCESS'], frameworks: ['iso27001', 'nis2'] },
    { title: 'Incident Response Failure', category: 'Incident Management', threat: 'Inadequate incident response', vulnerability: 'No incident response plan or training', likelihood: 2, impact: 4, assetTypes: ['PROCESS'], frameworks: ['iso27001', 'nis2'] },

    // General risks (any framework)
    { title: 'Regulatory Non-Compliance', category: 'Compliance', threat: 'Regulatory penalties or sanctions', vulnerability: 'Insufficient compliance monitoring', likelihood: 2, impact: 4, assetTypes: [], frameworks: ['iso27001', 'nis2'] },
    { title: 'Physical Security Breach', category: 'Physical Security', threat: 'Unauthorized physical access', vulnerability: 'Weak physical access controls', likelihood: 1, impact: 3, assetTypes: [], frameworks: ['iso27001'] },
];

// ─── Run Step Action ───

export interface StepActionResult {
    action: string;
    created: number;
    skipped: number;
    details: string;
}

/**
 * Executes the real product action for a completed onboarding step.
 * Called after step completion — all actions are idempotent.
 */
export async function runStepAction(
    ctx: RequestContext,
    step: string,
    stepData: StepData,
    allData: StepData,
): Promise<StepActionResult | null> {
    switch (step) {
        case 'FRAMEWORK_SELECTION':
            return executeFrameworkInstall(ctx, allData);
        case 'ASSET_SETUP':
            return executeAssetCreation(ctx, allData);
        case 'CONTROL_BASELINE_INSTALL':
            return executeControlInstall(ctx, allData);
        case 'INITIAL_RISK_REGISTER':
            return executeRiskGeneration(ctx, allData);
        case 'TEAM_SETUP':
            return executeTeamSetup(ctx, allData);
        default:
            return null; // COMPANY_PROFILE and REVIEW_AND_FINISH have no automation
    }
}

// ─── Framework Install ───

async function executeFrameworkInstall(ctx: RequestContext, allData: StepData): Promise<StepActionResult> {
    // `installPack` materialised a framework's control templates into tenant
    // Control rows. The template library was removed with the compliance
    // uproot, so there is nothing to install — the step reports every
    // selection as skipped rather than pretending to have done work.
    const selectedFrameworks: string[] = allData['FRAMEWORK_SELECTION']?.selectedFrameworks || [];
    return {
        action: 'FRAMEWORK_INSTALL',
        created: 0,
        skipped: selectedFrameworks.length,
        details: selectedFrameworks.length
            ? `Framework install retired: ${selectedFrameworks.join(', ')}`
            : '',
    };
}

// ─── Asset Creation (idempotent by name) ───

async function executeAssetCreation(ctx: RequestContext, allData: StepData): Promise<StepActionResult> {
    const assetNames: string[] = allData['ASSET_SETUP']?.assets || [];
    let created = 0;
    let skipped = 0;

    await runInTenantContext(ctx, async (db) => {
        for (const name of assetNames) {
            // Idempotent: check if asset already exists by name
            const existing = await db.asset.findFirst({
                where: { tenantId: ctx.tenantId, name },
            });
            if (existing) {
                skipped++;
                continue;
            }

            const type = inferAssetType(name) as AssetType;
            await db.asset.create({
                data: {
                    tenantId: ctx.tenantId,
                    name,
                    type,
                },
            });
            created++;
        }

        if (created > 0) {
            await logEvent(db, ctx, {
                action: 'ONBOARDING_ASSETS_CREATED',
                entityType: 'Asset',
                entityId: ctx.tenantId,
                details: `Onboarding created ${created} assets (${skipped} already existed)`,
                detailsJson: {
                    category: 'custom',
                    event: 'onboarding_assets_created',
                    created,
                    skipped,
                    assetNames,
                },
                metadata: { created, skipped, assetNames },
            });
        }
    });

    return { action: 'ASSET_CREATION', created, skipped, details: `${created} assets created, ${skipped} already existed` };
}

// ─── Control Baseline Install ───

async function executeControlInstall(ctx: RequestContext, allData: StepData): Promise<StepActionResult> {
    const confirmed = allData['CONTROL_BASELINE_INSTALL']?.confirmed;
    if (!confirmed) {
        return { action: 'CONTROL_INSTALL', created: 0, skipped: 0, details: 'User did not confirm control installation' };
    }

    // Re-run framework install to ensure controls exist (idempotent)
    return executeFrameworkInstall(ctx, allData);
}

// ─── Risk Register Generation (deterministic) ───

async function executeRiskGeneration(ctx: RequestContext, allData: StepData): Promise<StepActionResult> {
    const generate = allData['INITIAL_RISK_REGISTER']?.generate;
    if (generate === false) {
        return { action: 'RISK_GENERATION', created: 0, skipped: 0, details: 'User opted out of risk generation' };
    }

    const selectedFrameworks: string[] = allData['FRAMEWORK_SELECTION']?.selectedFrameworks || [];
    const assetNames: string[] = allData['ASSET_SETUP']?.assets || [];

    // Infer asset types from names
    const assetTypes = new Set(assetNames.map(n => inferAssetType(n)));
    // If no assets, use general risks
    if (assetTypes.size === 0) assetTypes.add('APPLICATION');

    // Select applicable risks
    const applicableRisks = STARTER_RISKS.filter(risk => {
        // Framework match: if risk specifies frameworks, at least one must be selected
        const fwMatch = risk.frameworks.length === 0 || risk.frameworks.some(fw => selectedFrameworks.includes(fw));
        // Asset type match: if risk specifies asset types, at least one must exist
        const typeMatch = risk.assetTypes.length === 0 || risk.assetTypes.some(at => assetTypes.has(at));
        return fwMatch && typeMatch;
    });

    let created = 0;
    let skipped = 0;

    await runInTenantContext(ctx, async (db) => {
        // Tenant table is global (no RLS) but accessible via the scoped client
        const tenant = await db.tenant.findUnique({ where: { id: ctx.tenantId } });
        const maxScale = tenant?.maxRiskScale || 5;

        for (const risk of applicableRisks) {
            // Idempotent: check existing by title
            const existing = await db.risk.findFirst({
                where: { tenantId: ctx.tenantId, title: risk.title },
            });
            if (existing) {
                skipped++;
                continue;
            }

            const score = Math.round((risk.likelihood / maxScale) * (risk.impact / maxScale) * maxScale * maxScale);
            await db.risk.create({
                data: {
                    tenantId: ctx.tenantId,
                    title: risk.title,
                    category: risk.category,
                    threat: risk.threat,
                    vulnerability: risk.vulnerability,
                    likelihood: risk.likelihood,
                    impact: risk.impact,
                    score,
                    inherentScore: score,
                    status: 'OPEN',
                    createdByUserId: ctx.userId,
                },
            });
            created++;
        }

        if (created > 0) {
            await logEvent(db, ctx, {
                action: 'ONBOARDING_RISKS_GENERATED',
                entityType: 'Risk',
                entityId: ctx.tenantId,
                details: `Onboarding generated ${created} starter risks (${skipped} already existed)`,
                detailsJson: {
                    category: 'custom',
                    event: 'onboarding_risks_generated',
                    created,
                    skipped,
                    selectedFrameworks,
                    assetTypes: [...assetTypes],
                },
                metadata: { created, skipped, selectedFrameworks, assetTypes: [...assetTypes] },
            });
        }
    });

    return { action: 'RISK_GENERATION', created, skipped, details: `${created} risks generated, ${skipped} already existed` };
}

// ─── Team Setup / Starter Tasks ───

async function executeTeamSetup(ctx: RequestContext, allData: StepData): Promise<StepActionResult> {
    let created = 0;
    let skipped = 0;

    const starterTasks = [
        { title: 'Review and assign control owners', description: 'Go through the control register and assign owners to each control. This ensures accountability.', type: 'TASK' },
        { title: 'Schedule evidence collection cadence', description: 'Set up recurring evidence collection for key controls. Quarterly or monthly depending on control frequency.', type: 'TASK' },
        { title: 'Complete risk assessment review', description: 'Review the generated risk register and validate risk ratings. Adjust likelihood and impact as needed.', type: 'TASK' },
        { title: 'Define incident response procedure', description: 'Document your incident response plan including detection, containment, eradication, and recovery steps.', type: 'TASK' },
        { title: 'Set up vendor due diligence process', description: 'Establish the process for evaluating and monitoring third-party vendors for compliance.', type: 'TASK' },
    ];

    await runInTenantContext(ctx, async (db) => {
        for (const task of starterTasks) {
            // Idempotent: check if task with this exact title already exists
            const existing = await db.task.findFirst({
                where: { tenantId: ctx.tenantId, title: task.title },
            });
            if (existing) {
                skipped++;
                continue;
            }

            await db.task.create({
                data: {
                    tenantId: ctx.tenantId,
                    title: task.title,
                    description: task.description,
                    type: task.type as WorkItemType,
                    status: 'OPEN',
                    createdByUserId: ctx.userId,
                    assigneeUserId: ctx.userId,
                },
            });
            created++;
        }

        if (created > 0) {
            await logEvent(db, ctx, {
                action: 'ONBOARDING_TASKS_CREATED',
                entityType: 'Task',
                entityId: ctx.tenantId,
                details: `Onboarding created ${created} starter tasks (${skipped} already existed)`,
                detailsJson: {
                    category: 'custom',
                    event: 'onboarding_tasks_created',
                    created,
                    skipped,
                },
                metadata: { created, skipped },
            });
        }
    });

    return { action: 'TEAM_SETUP', created, skipped, details: `${created} starter tasks created, ${skipped} already existed` };
}

// ─── Store automation results ───

export async function storeActionResult(ctx: RequestContext, step: string, result: StepActionResult) {
    await runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentData = (existing.stepData as Record<string, any>) || {};
        const actionResults = currentData._actionResults || {};
        actionResults[step] = result;

        // Store via saveStepData under the _actionResults key
        await OnboardingRepository.saveStepData(db, ctx, '_actionResults', actionResults);
    });
}
