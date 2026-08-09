/**
 * @deprecated — LEGACY HARDCODED CLAUSE DATA
 *
 * This file is retained as a fallback for the YAML-backed framework library system.
 * New code should use `getISO27001Clauses()` from `@/app-layer/libraries` instead.
 *
 * Note: This file contains enriched fields (artifacts, checklist) not yet in the
 * YAML schema. It will be removed once the YAML schema supports extended fields.
 *
 * Original description:
 * ISO 27001:2022 Clauses 4–10 — Original paraphrases (NOT verbatim ISO text).
 * These provide user-friendly guidance for each clause requirement.
 */
export interface ClauseInfo {
    number: string;
    title: string;
    description: string;
    artifacts: string;
    checklist: string[];
}

export const CLAUSES: ClauseInfo[] = [
    {
        number: '4',
        title: 'Context of the Organization',
        description:
            'Understand your organization\'s environment: identify external and internal factors that affect your information security objectives, understand what stakeholders expect, and define the boundaries and applicability of your ISMS. (Paraphrase — not ISO text)',
        artifacts: 'Context analysis document, Interested parties register, ISMS scope statement',
        checklist: [
            'Identify external issues (regulatory, market, technology trends)',
            'Identify internal issues (culture, structure, capabilities)',
            'List interested parties and their requirements',
            'Define ISMS scope boundaries',
            'Document scope exclusions with justification',
            'Establish the ISMS scope statement',
        ],
    },
    {
        number: '5',
        title: 'Leadership',
        description:
            'Top management must demonstrate commitment to the ISMS by establishing a security policy, defining roles and responsibilities, ensuring adequate resources, and promoting continual improvement. (Paraphrase)',
        artifacts: 'Information security policy, Roles & responsibilities matrix, Management commitment evidence',
        checklist: [
            'Draft and approve information security policy',
            'Assign ISMS roles and responsibilities',
            'Ensure top management commitment is documented',
            'Communicate the policy across the organization',
            'Integrate ISMS requirements into business processes',
        ],
    },
    {
        number: '6',
        title: 'Planning',
        description:
            'Plan how to address risks and opportunities, set information security objectives that are measurable and consistent with the policy, and plan changes to the ISMS in a controlled manner. (Paraphrase)',
        artifacts: 'Risk assessment methodology, Risk register, Risk treatment plan, Security objectives document',
        checklist: [
            'Define risk assessment methodology',
            'Identify information security risks',
            'Analyze and evaluate risks',
            'Define risk treatment options',
            'Create risk treatment plan',
            'Set measurable security objectives',
            'Plan for achieving objectives',
        ],
    },
    {
        number: '7',
        title: 'Support',
        description:
            'Ensure the ISMS has the resources, competencies, awareness, communication channels, and documented information it needs to operate effectively. (Paraphrase)',
        artifacts: 'Competency matrix, Training records, Communication plan, Document practice procedure',
        checklist: [
            'Determine and provide necessary resources',
            'Define competency requirements for ISMS roles',
            'Conduct security awareness training',
            'Establish internal and external communication processes',
            'Define documented information requirements',
            'Implement document practice procedures',
        ],
    },
    {
        number: '8',
        title: 'Operation',
        description:
            'Execute the plans and processes needed to meet security requirements: perform risk assessments, implement risk treatment plans, and manage operational practices. (Paraphrase)',
        artifacts: 'Operational procedures, Risk assessment results, Risk treatment implementation records',
        checklist: [
            'Implement operational planning and practice processes',
            'Perform risk assessments at planned intervals',
            'Implement risk treatment plan',
            'Practice outsourced processes',
            'Retain documented results of risk assessments',
            'Manage changes that affect the ISMS',
        ],
    },
    {
        number: '9',
        title: 'Performance Evaluation',
        description:
            'Monitor, measure, analyze, and evaluate the ISMS performance. Conduct internal audits and management reviews at planned intervals to ensure the ISMS remains effective. (Paraphrase)',
        artifacts: 'Monitoring & measurement procedures, Internal audit program, Management review minutes',
        checklist: [
            'Define what needs to be monitored and measured',
            'Determine monitoring and measurement methods',
            'Plan and conduct internal audits',
            'Report audit results to management',
            'Conduct management reviews at planned intervals',
            'Document management review outputs and decisions',
        ],
    },
    {
        number: '10',
        title: 'Improvement',
        description:
            'React to nonconformities with corrective actions, and continually improve the suitability, adequacy, and effectiveness of the ISMS. (Paraphrase)',
        artifacts: 'Nonconformity register, Corrective action records, Continual improvement log',
        checklist: [
            'Establish a process for nonconformity and corrective action',
            'Investigate root causes of nonconformities',
            'Implement corrective actions',
            'Review effectiveness of corrective actions',
            'Identify opportunities for continual improvement',
            'Document improvement actions and outcomes',
        ],
    },
];
