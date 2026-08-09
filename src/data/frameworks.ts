/**
 * @deprecated — LEGACY HARDCODED FRAMEWORK DATA
 *
 * This file is retained as a fallback for the YAML-backed framework library system.
 * New code should use `@/app-layer/libraries` (framework-provider) instead.
 *
 * Migration status:
 * - SOC2_REQUIREMENTS: Available via getSOC2Requirements() from YAML-backed provider
 * - NIS2_REQUIREMENTS: Still hardcoded (NIS2 YAML library pending)
 * - FRAMEWORK_MAPPINGS: Still hardcoded (cross-framework YAML mappings pending)
 *
 * This file will be removed once all frameworks and mappings are in YAML.
 *
 * Original description:
 * SOC 2 Trust Services Categories and NIS2 Requirement Areas
 * All descriptions are ORIGINAL paraphrases — not verbatim standard text.
 * These are guidance mappings, not guarantees of compliance.
 */

export interface FrameworkInfo {
    code: string;
    title: string;
    description: string;
    category: string;
}

// ─── SOC 2 Trust Services Criteria (paraphrased) ───
export const SOC2_REQUIREMENTS: FrameworkInfo[] = [
    { code: 'CC1', title: 'Practice Environment', description: 'The organization demonstrates commitment to integrity and ethical values, exercises oversight, establishes structures and authority, and attracts and develops competent individuals. (Paraphrase)', category: 'Security' },
    { code: 'CC2', title: 'Communication & Information', description: 'The organization generates and uses quality information, communicates internally and externally about the functioning of practices. (Paraphrase)', category: 'Security' },
    { code: 'CC3', title: 'Risk Assessment', description: 'The organization identifies and assesses risks to achieving its objectives, including fraud risk and changes that could impact internal practices. (Paraphrase)', category: 'Security' },
    { code: 'CC4', title: 'Monitoring Activities', description: 'The organization selects, develops, and performs evaluations to check whether practices are present and functioning effectively. (Paraphrase)', category: 'Security' },
    { code: 'CC5', title: 'Practice Activities', description: 'The organization selects and develops practice activities that mitigate risks, including technology practices and policy deployment. (Paraphrase)', category: 'Security' },
    { code: 'CC6', title: 'Logical & Physical Access', description: 'The organization restricts logical and physical access to systems and data, manages credentials, and protects against unauthorized access. (Paraphrase)', category: 'Security' },
    { code: 'CC7', title: 'System Operations', description: 'The organization detects and monitors for anomalies and events that represent actual or potential compromises, and responds to incidents. (Paraphrase)', category: 'Security' },
    { code: 'CC8', title: 'Change Management', description: 'The organization manages authorization, design, development, configuration, testing, and approval of changes to infrastructure and software. (Paraphrase)', category: 'Security' },
    { code: 'CC9', title: 'Risk Mitigation', description: 'The organization identifies, selects, and develops risk mitigation activities for risks from business processes and the use of vendors. (Paraphrase)', category: 'Security' },
    { code: 'A1', title: 'Availability', description: 'The organization maintains infrastructure, software, and procedures to support system availability for operation and use as committed. (Paraphrase)', category: 'Availability' },
    { code: 'C1', title: 'Confidentiality', description: 'The organization identifies confidential information, protects it during processing and storage, and destroys it securely when no longer needed. (Paraphrase)', category: 'Confidentiality' },
    { code: 'PI1', title: 'Processing Integrity', description: 'The organization ensures that system processing is complete, valid, accurate, timely, and authorized to meet its objectives. (Paraphrase)', category: 'Processing Integrity' },
    { code: 'P1', title: 'Privacy', description: 'The organization collects, uses, retains, discloses, and disposes of personal information in conformity with its privacy commitments and criteria. (Paraphrase)', category: 'Privacy' },
];

// ─── NIS2 High-Level Requirement Areas (paraphrased) ───
export const NIS2_REQUIREMENTS: FrameworkInfo[] = [
    { code: 'NIS2-RM', title: 'Risk Management Measures', description: 'Entities must take appropriate technical, operational, and organizational measures to manage cybersecurity risks to network and information systems. (Paraphrase)', category: 'Risk Management' },
    { code: 'NIS2-IR', title: 'Incident Handling', description: 'Establish processes to prevent, detect, and respond to cybersecurity incidents, including clear escalation and notification procedures. (Paraphrase)', category: 'Incident Response' },
    { code: 'NIS2-BC', title: 'Business Continuity', description: 'Ensure continuity of essential services including backup management, disaster recovery, and crisis management. (Paraphrase)', category: 'Business Continuity' },
    { code: 'NIS2-SC', title: 'Supply Chain Security', description: 'Address security aspects of relationships with direct suppliers and service providers, including supply chain risk assessments. (Paraphrase)', category: 'Supply Chain' },
    { code: 'NIS2-SD', title: 'Secure Development', description: 'Apply security in the acquisition, development, and maintenance of network and information systems, including vulnerability handling and disclosure. (Paraphrase)', category: 'Development' },
    { code: 'NIS2-AS', title: 'Security Assessment', description: 'Implement policies and procedures to assess the effectiveness of cybersecurity risk management measures. (Paraphrase)', category: 'Assessment' },
    { code: 'NIS2-CH', title: 'Cyber Hygiene & Training', description: 'Establish basic cyber hygiene practices and security awareness training for all personnel. (Paraphrase)', category: 'Training' },
    { code: 'NIS2-CR', title: 'Cryptography', description: 'Apply policies and procedures for the use of cryptography and, where appropriate, encryption to protect information. (Paraphrase)', category: 'Cryptography' },
    { code: 'NIS2-HR', title: 'Human Resources Security', description: 'Apply appropriate security measures for human resources including access control policies and asset management. (Paraphrase)', category: 'HR Security' },
    { code: 'NIS2-AM', title: 'Authentication & Access Management', description: 'Use multi-factor authentication, secure communication, and identity management solutions as appropriate. (Paraphrase)', category: 'Access Management' },
    { code: 'NIS2-RE', title: 'Reporting & Notification', description: 'Report significant incidents to the relevant authority promptly: early warning within 24 hours, full notification within 72 hours. (Paraphrase)', category: 'Reporting' },
    { code: 'NIS2-GOV', title: 'Governance & Accountability', description: 'Management bodies must approve cybersecurity measures, oversee implementation, and can be held liable for infringements. (Paraphrase)', category: 'Governance' },
];

/**
 * Guidance mappings from ISO 27001 Annex A practices to SOC 2 Trust Services Categories and NIS2 Areas.
 * These are approximate guidance mappings — NOT guarantees of compliance.
 */
export interface GuidanceMapping {
    isoControlId: string;
    soc2Codes: string[];
    nis2Codes: string[];
    rationale: string;
}

export const FRAMEWORK_MAPPINGS: GuidanceMapping[] = [
    { isoControlId: 'A.5.1', soc2Codes: ['CC1', 'CC5'], nis2Codes: ['NIS2-GOV'], rationale: 'Security policies form the foundation for SOC 2 practice environment and NIS2 governance requirements. (Guidance)' },
    { isoControlId: 'A.5.2', soc2Codes: ['CC1'], nis2Codes: ['NIS2-GOV'], rationale: 'Role assignments support organizational structure requirements in SOC 2 and NIS2 governance accountability. (Guidance)' },
    { isoControlId: 'A.5.3', soc2Codes: ['CC5', 'CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Segregation of duties is a core practice activity in SOC 2 and supports NIS2 access management. (Guidance)' },
    { isoControlId: 'A.5.7', soc2Codes: ['CC3', 'CC7'], nis2Codes: ['NIS2-RM'], rationale: 'Threat intelligence feeds into risk assessment and system monitoring activities. (Guidance)' },
    { isoControlId: 'A.5.9', soc2Codes: ['CC6', 'C1'], nis2Codes: ['NIS2-RM'], rationale: 'Asset inventory is foundational for logical access controls and risk management. (Guidance)' },
    { isoControlId: 'A.5.12', soc2Codes: ['C1'], nis2Codes: ['NIS2-RM'], rationale: 'Information classification directly supports confidentiality practices. (Guidance)' },
    { isoControlId: 'A.5.14', soc2Codes: ['CC6', 'C1'], nis2Codes: ['NIS2-CR'], rationale: 'Secure information transfer addresses confidentiality and logical access controls. (Guidance)' },
    { isoControlId: 'A.5.15', soc2Codes: ['CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Access Control is a primary SOC 2 and NIS2 security requirement. (Guidance)' },
    { isoControlId: 'A.5.17', soc2Codes: ['CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Authentication management directly maps to access security practices. (Guidance)' },
    { isoControlId: 'A.5.19', soc2Codes: ['CC9'], nis2Codes: ['NIS2-SC'], rationale: 'Supplier management aligns with risk mitigation and supply chain security. (Guidance)' },
    { isoControlId: 'A.5.20', soc2Codes: ['CC9'], nis2Codes: ['NIS2-SC'], rationale: 'Supplier agreements address vendor risk management requirements. (Guidance)' },
    { isoControlId: 'A.5.23', soc2Codes: ['CC6', 'CC9'], nis2Codes: ['NIS2-SC'], rationale: 'Cloud service security addresses both access control and supply chain concerns. (Guidance)' },
    { isoControlId: 'A.5.24', soc2Codes: ['CC7'], nis2Codes: ['NIS2-IR'], rationale: 'Incident management planning maps to system operations and NIS2 incident handling. (Guidance)' },
    { isoControlId: 'A.5.26', soc2Codes: ['CC7'], nis2Codes: ['NIS2-IR', 'NIS2-RE'], rationale: 'Incident response addresses both SOC 2 system operations and NIS2 notification obligations. (Guidance)' },
    { isoControlId: 'A.5.29', soc2Codes: ['A1'], nis2Codes: ['NIS2-BC'], rationale: 'Disruption preparedness supports availability and business continuity requirements. (Guidance)' },
    { isoControlId: 'A.5.30', soc2Codes: ['A1'], nis2Codes: ['NIS2-BC'], rationale: 'ICT readiness for continuity directly addresses availability commitments. (Guidance)' },
    { isoControlId: 'A.5.34', soc2Codes: ['P1'], nis2Codes: ['NIS2-GOV'], rationale: 'Privacy and PII protection maps to SOC 2 privacy criteria. (Guidance)' },
    { isoControlId: 'A.6.3', soc2Codes: ['CC1'], nis2Codes: ['NIS2-CH'], rationale: 'Security awareness training supports practice environment and cyber hygiene. (Guidance)' },
    { isoControlId: 'A.7.1', soc2Codes: ['CC6'], nis2Codes: ['NIS2-RM'], rationale: 'Physical security perimeters support logical and physical access controls. (Guidance)' },
    { isoControlId: 'A.8.1', soc2Codes: ['CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Endpoint device security is part of access control and authentication. (Guidance)' },
    { isoControlId: 'A.8.2', soc2Codes: ['CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Privileged access management is a key access control requirement. (Guidance)' },
    { isoControlId: 'A.8.5', soc2Codes: ['CC6'], nis2Codes: ['NIS2-AM'], rationale: 'Secure authentication directly supports access management. (Guidance)' },
    { isoControlId: 'A.8.7', soc2Codes: ['CC7'], nis2Codes: ['NIS2-RM'], rationale: 'Malware protection supports system operations monitoring. (Guidance)' },
    { isoControlId: 'A.8.8', soc2Codes: ['CC7', 'CC8'], nis2Codes: ['NIS2-SD'], rationale: 'Vulnerability management addresses system operations and change management. (Guidance)' },
    { isoControlId: 'A.8.13', soc2Codes: ['A1'], nis2Codes: ['NIS2-BC'], rationale: 'Backup management directly supports availability and continuity. (Guidance)' },
    { isoControlId: 'A.8.15', soc2Codes: ['CC4', 'CC7'], nis2Codes: ['NIS2-AS'], rationale: 'Logging supports monitoring activities and security assessment. (Guidance)' },
    { isoControlId: 'A.8.24', soc2Codes: ['CC6', 'C1'], nis2Codes: ['NIS2-CR'], rationale: 'Cryptography use addresses access control, confidentiality, and NIS2 encryption requirements. (Guidance)' },
    { isoControlId: 'A.8.25', soc2Codes: ['CC8'], nis2Codes: ['NIS2-SD'], rationale: 'Secure development lifecycle maps to change management and secure development. (Guidance)' },
    { isoControlId: 'A.8.32', soc2Codes: ['CC8'], nis2Codes: ['NIS2-SD'], rationale: 'Change management is a direct SOC 2 requirement and supports NIS2 secure development. (Guidance)' },
];
