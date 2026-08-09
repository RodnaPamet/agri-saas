/**
 * Production-safe catalog seed.
 *
 * Populates only GLOBAL reference data: Framework, FrameworkRequirement,
 * PracticeTemplate, PracticeTemplateTask, PracticeTemplateRequirementLink,
 * FrameworkPack, PackTemplateLink.
 *
 * Intentionally does NOT create any Tenant, User, TenantMembership, or
 * demo per-tenant fixtures — unlike `prisma/seed.ts` which is for dev/E2E.
 *
 * Idempotent: every insert is an upsert (or findUnique-then-create),
 * so re-running is safe.
 *
 * Run locally:   npx tsx prisma/seed-catalog.ts
 * Run on VM:     docker exec -it inflect-app-1 npx tsx /app/prisma/seed-catalog.ts
 */
const { PrismaClient } = require('@prisma/client');
// Granular ISO 27001 domain taxonomy — the SAME module the Practices
// "Browse" rail derives categories from at runtime, so the persisted
// FrameworkRequirement / PracticeTemplate categories never drift from
// what the UI shows. The module is dependency-free, so a relative
// require resolves cleanly under tsx.
const { iso27001Domain } = require('../src/lib/practices/practice-taxonomy');

const prisma = new PrismaClient();

const defaultTasks = [
    { title: 'Define practice owner and scope', description: 'Assign an owner and define the scope of this practice within the organization.' },
    { title: 'Document procedure or policy', description: 'Create or reference the policy/procedure that implements this practice.' },
    { title: 'Implement technical or operational measure', description: 'Put the practice into practice — deploy tooling, configure settings, or establish processes.' },
    { title: 'Collect evidence of implementation', description: 'Gather evidence demonstrating the practice is operating effectively.' },
    { title: 'Review effectiveness', description: 'Periodically review and assess whether the practice meets its objectives.' },
];

async function main() {
    console.log('🌱 Seeding global catalog (frameworks, requirements, practice templates, packs)…');

    // ── ISO 27001:2022 ───────────────────────────────────────────
    const annexAData = require('./fixtures/iso27001_2022_annexA.json') as Array<{
        key: string; theme: string; themeNumber: number; sortOrder: number; title: string; summary?: string;
    }>;
    const iso27001 = await prisma.framework.upsert({
        where: { key: 'ISO27001' },
        update: { name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
        create: { key: 'ISO27001', name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
    });
    const requirementMap: Record<string, string> = {};
    for (const req of annexAData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso27001.id, code: req.key } },
            update: { title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
            create: { frameworkId: iso27001.id, code: req.key, title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
        });
        requirementMap[req.key] = r.id;
    }
    console.log(`✅ ISO 27001:2022 + ${annexAData.length} Annex A requirements`);

    // ── SOC 2 ────────────────────────────────────────────────────
    const soc2 = await prisma.framework.upsert({
        where: { key: 'SOC2' },
        update: { name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
        create: { key: 'SOC2', name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
    });
    const soc2Reqs = [
        { code: 'CC1.1', title: 'COSO principle 1 — Integrity and ethical values', category: 'Practice Environment' },
        { code: 'CC2.1', title: 'Information for internal practices', category: 'Communication' },
        { code: 'CC3.1', title: 'Specifies objectives', category: 'Risk Assessment' },
        { code: 'CC5.1', title: 'Selects and develops practice activities', category: 'Practice Activities' },
        { code: 'CC6.1', title: 'Logical and physical access controls', category: 'Logical Access' },
        { code: 'CC7.1', title: 'System operations monitoring', category: 'System Operations' },
        { code: 'CC8.1', title: 'Change management', category: 'Change Management' },
    ];
    for (let i = 0; i < soc2Reqs.length; i++) {
        const req = soc2Reqs[i];
        await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: soc2.id, code: req.code } },
            update: {},
            create: { frameworkId: soc2.id, code: req.code, title: req.title, category: req.category, sortOrder: i },
        });
    }
    console.log(`✅ SOC 2 + ${soc2Reqs.length} requirements`);

    // ── NIS2 ─────────────────────────────────────────────────────
    const nis2Data = require('./fixtures/nis2_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const nis2 = await prisma.framework.upsert({
        where: { key_version: { key: 'NIS2', version: '2022/2555' } },
        update: { name: 'NIS2 Directive', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
        create: { key: 'NIS2', name: 'NIS2 Directive', version: '2022/2555', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
    });
    const nis2ReqMap: Record<string, string> = {};
    for (const req of nis2Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nis2.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nis2.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nis2ReqMap[req.key] = r.id;
    }
    console.log(`✅ NIS2 + ${nis2Data.length} requirements`);

    // ── ISO 9001:2015 ────────────────────────────────────────────
    const iso9001Data = require('./fixtures/iso9001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso9001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO9001', version: '2015' } },
        update: { name: 'ISO 9001', description: 'ISO 9001:2015 Quality Management Systems' },
        create: { key: 'ISO9001', name: 'ISO 9001', version: '2015', kind: 'ISO_STANDARD', description: 'ISO 9001:2015 Quality Management Systems' },
    });
    const iso9001ReqMap: Record<string, string> = {};
    for (const req of iso9001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso9001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso9001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso9001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 9001 + ${iso9001Data.length} requirements`);

    // ── ISO 28000:2022 ───────────────────────────────────────────
    const iso28000Data = require('./fixtures/iso28000_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso28000 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO28000', version: '2022' } },
        update: { name: 'ISO 28000', description: 'ISO 28000:2022 Supply Chain Security Management' },
        create: { key: 'ISO28000', name: 'ISO 28000', version: '2022', kind: 'ISO_STANDARD', description: 'ISO 28000:2022 Supply Chain Security Management' },
    });
    const iso28000ReqMap: Record<string, string> = {};
    for (const req of iso28000Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso28000.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso28000.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso28000ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 28000 + ${iso28000Data.length} requirements`);

    // ── ISO 39001:2012 ───────────────────────────────────────────
    const iso39001Data = require('./fixtures/iso39001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso39001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO39001', version: '2012' } },
        update: { name: 'ISO 39001', description: 'ISO 39001:2012 Road Traffic Safety Management' },
        create: { key: 'ISO39001', name: 'ISO 39001', version: '2012', kind: 'ISO_STANDARD', description: 'ISO 39001:2012 Road Traffic Safety Management' },
    });
    const iso39001ReqMap: Record<string, string> = {};
    for (const req of iso39001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso39001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso39001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso39001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 39001 + ${iso39001Data.length} requirements`);

    // ── ISO 27001:2022 Practice Templates (one per Annex A) ───────
    let templatesCreated = 0;
    for (const req of annexAData) {
        const code = `A-${req.key}`;
        const existing = await prisma.practiceTemplate.findUnique({ where: { code } });
        if (!existing) {
            const template = await prisma.practiceTemplate.create({
                data: { code, title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.practiceTemplateTask.create({ data: { templateId: template.id, title: task.title, description: task.description } });
            }
            await prisma.practiceTemplateRequirementLink.create({
                data: { templateId: template.id, requirementId: requirementMap[req.key] },
            });
            templatesCreated++;
        }
    }
    console.log(`✅ ISO 27001 practice templates (${templatesCreated} new)`);

    // ── NIS2 Practice Templates ───────────────────────────────────
    const nis2Templates = [
        { code: 'NIS2-RA', title: 'Risk analysis and information security policies', reqs: ['Art.21(2)(a)'] },
        { code: 'NIS2-IH', title: 'Incident handling procedures', reqs: ['Art.21(2)(b)'] },
        { code: 'NIS2-BC', title: 'Business continuity and crisis management', reqs: ['Art.21(2)(c)'] },
        { code: 'NIS2-SC', title: 'Supply chain security management', reqs: ['Art.21(2)(d)'] },
        { code: 'NIS2-NS', title: 'Network and information system security', reqs: ['Art.21(2)(e)'] },
        { code: 'NIS2-EF', title: 'Effectiveness assessment of cybersecurity measures', reqs: ['Art.21(2)(f)'] },
        { code: 'NIS2-CH', title: 'Cyber hygiene and security training', reqs: ['Art.21(2)(g)'] },
        { code: 'NIS2-CR', title: 'Cryptography and encryption policies', reqs: ['Art.21(2)(h)'] },
        { code: 'NIS2-HR', title: 'HR security and access control', reqs: ['Art.21(2)(i)'] },
        { code: 'NIS2-MFA', title: 'Multi-factor authentication and secured communications', reqs: ['Art.21(2)(j)'] },
        { code: 'NIS2-EW', title: 'Early warning notification (24h)', reqs: ['Art.23(1)'] },
        { code: 'NIS2-IN', title: 'Incident notification (72h)', reqs: ['Art.23(2)'] },
        { code: 'NIS2-FR', title: 'Final incident report (1 month)', reqs: ['Art.23(3)'] },
        { code: 'NIS2-GO', title: 'Management body cybersecurity oversight', reqs: ['Art.20(1)'] },
        { code: 'NIS2-TR', title: 'Management cybersecurity training', reqs: ['Art.20(2)'] },
        { code: 'NIS2-CE', title: 'Cybersecurity certification schemes', reqs: ['Art.24(1)'] },
        { code: 'NIS2-ST', title: 'Standards and technical specifications', reqs: ['Art.25'] },
        { code: 'NIS2-DN', title: 'Domain name registration accuracy', reqs: ['Art.28(1)'] },
        { code: 'NIS2-IS', title: 'Information sharing arrangements', reqs: ['Art.29(1)'] },
        { code: 'NIS2-NS2', title: 'National cybersecurity strategy compliance', reqs: ['Art.7(1)'] },
    ];
    for (const t of nis2Templates) {
        const existing = await prisma.practiceTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.practiceTemplate.create({
                data: { code: t.code, title: t.title, category: 'NIS2', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.practiceTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (nis2ReqMap[rk]) {
                    await prisma.practiceTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nis2ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ NIS2 practice templates');

    // ── ISO 9001 Practice Templates ───────────────────────────────
    const iso9001Templates = [
        { code: 'QMS-CTX', title: 'Organizational context determination', reqs: ['4.1', '4.2'] },
        { code: 'QMS-SCP', title: 'QMS scope definition', reqs: ['4.3'] },
        { code: 'QMS-PRC', title: 'QMS process management', reqs: ['4.4'] },
        { code: 'QMS-LDR', title: 'Leadership commitment and customer focus', reqs: ['5.1', '5.1.2'] },
        { code: 'QMS-POL', title: 'Quality policy establishment', reqs: ['5.2'] },
        { code: 'QMS-ROL', title: 'Roles and responsibilities assignment', reqs: ['5.3'] },
        { code: 'QMS-RSK', title: 'Risk and opportunity management', reqs: ['6.1'] },
        { code: 'QMS-OBJ', title: 'Quality objectives planning', reqs: ['6.2'] },
        { code: 'QMS-CHG', title: 'Change planning', reqs: ['6.3'] },
        { code: 'QMS-RES', title: 'Resource management', reqs: ['7.1', '7.1.5', '7.1.6'] },
        { code: 'QMS-CMP', title: 'Competence and awareness', reqs: ['7.2', '7.3'] },
        { code: 'QMS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'QMS-DOC', title: 'Documented information practice', reqs: ['7.5'] },
        { code: 'QMS-OPC', title: 'Operational planning and practice', reqs: ['8.1'] },
        { code: 'QMS-REQ', title: 'Product/service requirements', reqs: ['8.2'] },
        { code: 'QMS-DES', title: 'Design and development practice', reqs: ['8.3'] },
        { code: 'QMS-EXT', title: 'External provider practice', reqs: ['8.4'] },
        { code: 'QMS-PRD', title: 'Production and service provision', reqs: ['8.5', '8.5.1', '8.6', '8.7'] },
        { code: 'QMS-MON', title: 'Performance monitoring and evaluation', reqs: ['9.1', '9.1.2', '9.1.3'] },
        { code: 'QMS-AUD', title: 'Internal audit program', reqs: ['9.2'] },
        { code: 'QMS-MGR', title: 'Management review', reqs: ['9.3'] },
        { code: 'QMS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2', '10.3'] },
    ];
    for (const t of iso9001Templates) {
        const existing = await prisma.practiceTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.practiceTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO9001', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.practiceTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso9001ReqMap[rk]) {
                    await prisma.practiceTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso9001ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 9001 practice templates');

    // ── ISO 28000 Practice Templates ──────────────────────────────
    const iso28000Templates = [
        { code: 'SCS-CTX', title: 'Supply chain context determination', reqs: ['4.1', '4.2'] },
        { code: 'SCS-SCP', title: 'Security management system scope', reqs: ['4.3', '4.4'] },
        { code: 'SCS-LDR', title: 'Leadership and security policy', reqs: ['5.1', '5.2'] },
        { code: 'SCS-ROL', title: 'Security roles and authorities', reqs: ['5.3'] },
        { code: 'SCS-RSK', title: 'Security risk assessment and treatment', reqs: ['6.1', '8.2', '8.3'] },
        { code: 'SCS-OBJ', title: 'Security objectives planning', reqs: ['6.2'] },
        { code: 'SCS-RES', title: 'Resource and competence management', reqs: ['7.1', '7.2', '7.3'] },
        { code: 'SCS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'SCS-DOC', title: 'Documented information', reqs: ['7.5'] },
        { code: 'SCS-OPC', title: 'Operational practice', reqs: ['8.1'] },
        { code: 'SCS-SUP', title: 'Supply chain security management', reqs: ['8.4'] },
        { code: 'SCS-MON', title: 'Performance monitoring', reqs: ['9.1'] },
        { code: 'SCS-AUD', title: 'Internal audit program', reqs: ['9.2'] },
        { code: 'SCS-MGR', title: 'Management review', reqs: ['9.3'] },
        { code: 'SCS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2'] },
    ];
    for (const t of iso28000Templates) {
        const existing = await prisma.practiceTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.practiceTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO28000', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.practiceTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso28000ReqMap[rk]) {
                    await prisma.practiceTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso28000ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 28000 practice templates');

    // ── ISO 39001 Practice Templates ──────────────────────────────
    const iso39001Templates = [
        { code: 'RTS-CTX', title: 'Organization context and interested parties', reqs: ['4.1', '4.2'] },
        { code: 'RTS-SCP', title: 'RTS management system scope', reqs: ['4.3', '4.4'] },
        { code: 'RTS-LDR', title: 'Leadership and RTS policy', reqs: ['5.1', '5.2'] },
        { code: 'RTS-ROL', title: 'RTS roles and authorities', reqs: ['5.3'] },
        { code: 'RTS-RSK', title: 'RTS risk and opportunity management', reqs: ['6.1'] },
        { code: 'RTS-OBJ', title: 'RTS performance factors and objectives', reqs: ['6.2'] },
        { code: 'RTS-CHG', title: 'RTS change planning', reqs: ['6.3'] },
        { code: 'RTS-RES', title: 'Resource and competence management', reqs: ['7.1', '7.2', '7.3'] },
        { code: 'RTS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'RTS-DOC', title: 'Documented information', reqs: ['7.5'] },
        { code: 'RTS-OPC', title: 'Operational planning and practice', reqs: ['8.1'] },
        { code: 'RTS-EMR', title: 'Emergency preparedness and response', reqs: ['8.2'] },
        { code: 'RTS-MON', title: 'Performance monitoring and evaluation', reqs: ['9.1'] },
        { code: 'RTS-INV', title: 'Crash and incident investigation', reqs: ['9.2'] },
        { code: 'RTS-AUD', title: 'Internal audit program', reqs: ['9.3'] },
        { code: 'RTS-MGR', title: 'Management review', reqs: ['9.4'] },
        { code: 'RTS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2'] },
    ];
    for (const t of iso39001Templates) {
        const existing = await prisma.practiceTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.practiceTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO39001', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.practiceTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso39001ReqMap[rk]) {
                    await prisma.practiceTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso39001ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 39001 practice templates');

    // ── Framework Packs ──────────────────────────────────────────
    const allIsoTemplates = await prisma.practiceTemplate.findMany({ where: { code: { startsWith: 'A-' } } });
    const pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO27001_2022_BASE' },
        update: { name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022' },
        create: { key: 'ISO27001_2022_BASE', name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022', description: 'Full Annex A practice set with default implementation tasks.' },
    });
    for (const tmpl of allIsoTemplates) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: pack.id, templateId: tmpl.id } },
            create: { packId: pack.id, templateId: tmpl.id }, update: {},
        });
    }

    const nis2Tmpls = await prisma.practiceTemplate.findMany({ where: { code: { startsWith: 'NIS2-' } } });
    const nis2Pack = await prisma.frameworkPack.upsert({
        where: { key: 'NIS2_BASELINE' },
        update: { name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555' },
        create: { key: 'NIS2_BASELINE', name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555', description: 'NIS2 directive security measures baseline.' },
    });
    for (const tmpl of nis2Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: nis2Pack.id, templateId: tmpl.id } },
            create: { packId: nis2Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    const iso9001Tmpls = await prisma.practiceTemplate.findMany({ where: { code: { startsWith: 'QMS-' } } });
    const iso9001Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO9001_CORE' },
        update: { name: 'ISO 9001 Core Pack', frameworkId: iso9001.id, version: '2015' },
        create: { key: 'ISO9001_CORE', name: 'ISO 9001 Core Pack', frameworkId: iso9001.id, version: '2015', description: 'ISO 9001 quality management core practices.' },
    });
    for (const tmpl of iso9001Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso9001Pack.id, templateId: tmpl.id } },
            create: { packId: iso9001Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    const iso28000Tmpls = await prisma.practiceTemplate.findMany({ where: { code: { startsWith: 'SCS-' } } });
    const iso28000Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO28000_CORE' },
        update: { name: 'ISO 28000 Core Pack', frameworkId: iso28000.id, version: '2022' },
        create: { key: 'ISO28000_CORE', name: 'ISO 28000 Core Pack', frameworkId: iso28000.id, version: '2022', description: 'ISO 28000 supply chain security core practices.' },
    });
    for (const tmpl of iso28000Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso28000Pack.id, templateId: tmpl.id } },
            create: { packId: iso28000Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    const iso39001Tmpls = await prisma.practiceTemplate.findMany({ where: { code: { startsWith: 'RTS-' } } });
    const iso39001Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO39001_CORE' },
        update: { name: 'ISO 39001 Core Pack', frameworkId: iso39001.id, version: '2012' },
        create: { key: 'ISO39001_CORE', name: 'ISO 39001 Core Pack', frameworkId: iso39001.id, version: '2012', description: 'ISO 39001 road traffic safety core practices.' },
    });
    for (const tmpl of iso39001Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso39001Pack.id, templateId: tmpl.id } },
            create: { packId: iso39001Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    console.log('✅ Framework Packs');

    const counts = await Promise.all([
        prisma.framework.count(),
        prisma.frameworkRequirement.count(),
        prisma.practiceTemplate.count(),
        prisma.frameworkPack.count(),
    ]);
    console.log(`\n📊 Final counts — frameworks: ${counts[0]}, requirements: ${counts[1]}, practice templates: ${counts[2]}, packs: ${counts[3]}`);
}

main()
    .then(() => prisma.$disconnect())
    .catch((err: unknown) => {
        console.error('❌ Seed failed:', err);
        prisma.$disconnect();
        process.exit(1);
    });
