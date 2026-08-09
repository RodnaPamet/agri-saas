/**
 * @deprecated — LEGACY HARDCODED ANNEX A DATA
 *
 * This file is retained as reference data. The primary source for Annex A controls
 * is now the YAML library at `src/data/libraries/iso27001-2022.yaml`.
 *
 * New code should use `getLibraryByRefId('ISO27001-2022')` from `@/app-layer/libraries`.
 *
 * This file is NOT imported by any runtime consumer and can be safely removed
 * once migration validation is complete.
 *
 * Original description:
 * ISO 27001:2022 Annex A Control Library — ORIGINAL paraphrases.
 * IDs follow the standard numbering; descriptions are NOT verbatim ISO text.
 */
export interface AnnexAControl {
    annexId: string;
    name: string;
    intent: string;
    category: string;
}

export const ANNEX_A_CONTROLS: AnnexAControl[] = [
    // A.5 — Organizational controls
    { annexId: 'A.5.1', name: 'Information Security Policies', intent: 'Establish and maintain a set of policies for information security, approved by management and communicated to relevant parties. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.2', name: 'Information Security Roles', intent: 'Define and assign information security roles and responsibilities to ensure accountability. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.3', name: 'Segregation of Duties', intent: 'Separate conflicting duties to reduce unauthorized or unintended modification or misuse of assets. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.4', name: 'Management Responsibilities', intent: 'Ensure management requires personnel to apply information security in accordance with established policies. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.5', name: 'Contact with Authorities', intent: 'Maintain appropriate contacts with relevant authorities for incident response and legal obligations. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.6', name: 'Contact with Special Interest Groups', intent: 'Maintain contacts with security forums and professional associations for threat intelligence. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.7', name: 'Threat Intelligence', intent: 'Collect and analyze information about threats to produce actionable intelligence. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.8', name: 'Info Security in Project Management', intent: 'Integrate information security into project management processes regardless of project type. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.9', name: 'Inventory of Information Assets', intent: 'Identify, classify, and maintain an inventory of information and associated assets. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.10', name: 'Acceptable Use of Assets', intent: 'Define and communicate rules for the acceptable use of information and related assets. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.11', name: 'Return of Assets', intent: 'Ensure personnel and external parties return organizational assets upon termination of engagement. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.12', name: 'Classification of Information', intent: 'Classify information according to its sensitivity and criticality to the organization. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.13', name: 'Labelling of Information', intent: 'Develop procedures for labelling information in line with the classification scheme. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.14', name: 'Information Transfer', intent: 'Protect information during transfer between entities using appropriate security measures. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.15', name: 'Access Control', intent: 'Establish and enforce rules to control logical and physical access to information. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.16', name: 'Identity Management', intent: 'Manage the full lifecycle of identities to ensure proper access. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.17', name: 'Authentication Information', intent: 'Control the allocation and management of authentication credentials. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.18', name: 'Access Rights', intent: 'Provision, review, and revoke access rights in accordance with policy. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.19', name: 'Supplier Relationships Security', intent: 'Define and implement processes to manage security risks from supplier relationships. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.20', name: 'Supplier Agreements Security', intent: 'Include relevant security requirements in agreements with suppliers. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.21', name: 'ICT Supply Chain Security', intent: 'Manage information security risks in the ICT products and services supply chain. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.22', name: 'Supplier Service Monitoring', intent: 'Monitor, review, and manage changes in supplier service delivery and security practices. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.23', name: 'Cloud Services Security', intent: 'Manage information security for the acquisition and use of cloud services. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.24', name: 'Incident Management Planning', intent: 'Plan and prepare for managing information security incidents effectively. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.25', name: 'Incident Assessment & Decision', intent: 'Assess security events and decide whether to classify them as incidents. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.26', name: 'Incident Response', intent: 'Respond to information security incidents according to documented procedures. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.27', name: 'Learning from Incidents', intent: 'Use knowledge gained from incidents to strengthen security controls. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.28', name: 'Evidence Collection', intent: 'Establish procedures for collecting and preserving evidence related to incidents. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.29', name: 'Disruption Preparedness', intent: 'Plan for maintaining information security during disruptions to business operations. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.30', name: 'ICT Readiness for Business Continuity', intent: 'Ensure ICT readiness to support business operations during and after disruption. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.31', name: 'Legal & Regulatory Requirements', intent: 'Identify and comply with legal, regulatory, and contractual requirements for information security. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.32', name: 'Intellectual Property', intent: 'Implement procedures to protect intellectual property rights. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.33', name: 'Records Protection', intent: 'Protect records from loss, destruction, falsification, and unauthorized access. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.34', name: 'Privacy & PII Protection', intent: 'Ensure privacy and protection of personally identifiable information as required by law. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.35', name: 'Independent Review of Infosec', intent: 'Conduct independent reviews of information security approach and implementation at planned intervals. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.36', name: 'Compliance with Policies & Standards', intent: 'Ensure compliance with established information security policies, rules, and standards. (Paraphrase)', category: 'Organizational' },
    { annexId: 'A.5.37', name: 'Documented Operating Procedures', intent: 'Document and make available operating procedures for information processing facilities. (Paraphrase)', category: 'Organizational' },

    // A.6 — People controls
    { annexId: 'A.6.1', name: 'Screening', intent: 'Conduct background verification checks on personnel before and during employment. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.2', name: 'Terms of Employment', intent: 'Include information security responsibilities in employment agreements. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.3', name: 'Security Awareness & Training', intent: 'Ensure personnel receive appropriate awareness education and training on security policies. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.4', name: 'Disciplinary Process', intent: 'Establish a formal disciplinary process for information security violations. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.5', name: 'Post-Employment Responsibilities', intent: 'Define and communicate information security responsibilities that remain after termination. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.6', name: 'Confidentiality Agreements', intent: 'Establish confidentiality or non-disclosure agreements reflecting protection needs. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.7', name: 'Remote Working', intent: 'Implement security measures for persons working remotely to protect information. (Paraphrase)', category: 'People' },
    { annexId: 'A.6.8', name: 'Security Event Reporting', intent: 'Provide a mechanism for personnel to report observed security events and weaknesses. (Paraphrase)', category: 'People' },

    // A.7 — Physical controls
    { annexId: 'A.7.1', name: 'Physical Security Perimeters', intent: 'Define and use security perimeters to protect areas containing information and assets. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.2', name: 'Physical Entry Controls', intent: 'Protect secure areas with appropriate entry controls to allow only authorized access. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.3', name: 'Securing Offices & Facilities', intent: 'Design and apply physical security for offices, rooms, and facilities. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.4', name: 'Physical Security Monitoring', intent: 'Continuously monitor premises for unauthorized physical access. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.5', name: 'Environmental Threats Protection', intent: 'Design protection against natural disasters and physical environmental threats. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.6', name: 'Working in Secure Areas', intent: 'Define and apply security measures for working in secure areas. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.7', name: 'Clear Desk and Clear Screen', intent: 'Enforce rules for clearing desks and screens to protect sensitive information. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.8', name: 'Equipment Siting and Protection', intent: 'Site and protect equipment to reduce environmental risks and unauthorized access. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.9', name: 'Off-Premises Asset Security', intent: 'Apply security measures to assets used outside organizational premises. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.10', name: 'Storage Media', intent: 'Manage storage media throughout their lifecycle including disposal. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.11', name: 'Supporting Utilities', intent: 'Protect information processing facilities from power failures and utility disruptions. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.12', name: 'Cabling Security', intent: 'Protect power and telecommunications cabling from interception or damage. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.13', name: 'Equipment Maintenance', intent: 'Maintain equipment correctly to ensure continued availability and integrity. (Paraphrase)', category: 'Physical' },
    { annexId: 'A.7.14', name: 'Secure Equipment Disposal', intent: 'Securely dispose of or re-use equipment containing storage media. (Paraphrase)', category: 'Physical' },

    // A.8 — Technological controls
    { annexId: 'A.8.1', name: 'User Endpoint Devices', intent: 'Protect information stored on, processed by, or accessible via user endpoint devices. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.2', name: 'Privileged Access Rights', intent: 'Restrict and manage the allocation and use of privileged access rights. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.3', name: 'Information Access Restriction', intent: 'Restrict access to information and application functions in accordance with access control policy. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.4', name: 'Source Code Access', intent: 'Manage access to source code, development tools, and software libraries appropriately. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.5', name: 'Secure Authentication', intent: 'Implement secure authentication technologies and procedures. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.6', name: 'Capacity Management', intent: 'Monitor and adjust resource usage to ensure required system capacity. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.7', name: 'Malware Protection', intent: 'Implement detection, prevention, and recovery controls for malware. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.8', name: 'Technical Vulnerability Management', intent: 'Obtain information about technical vulnerabilities and take appropriate remediation actions. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.9', name: 'Configuration Management', intent: 'Establish, document, implement, and review security configurations for hardware, software, and networks. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.10', name: 'Information Deletion', intent: 'Delete information stored in systems and devices when no longer required. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.11', name: 'Data Masking', intent: 'Use data masking consistent with access control policies and business requirements. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.12', name: 'Data Leakage Prevention', intent: 'Apply data leakage prevention measures to systems and networks holding sensitive information. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.13', name: 'Information Backup', intent: 'Maintain and regularly test backup copies of information, software, and systems. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.14', name: 'Redundancy of Information Processing', intent: 'Implement sufficient redundancy to meet availability requirements. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.15', name: 'Logging', intent: 'Produce, store, protect, and analyze logs recording activities and security events. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.16', name: 'Monitoring Activities', intent: 'Monitor networks, systems, and applications for anomalous behavior and take appropriate action. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.17', name: 'Clock Synchronization', intent: 'Synchronize clocks of information processing systems to approved time sources. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.18', name: 'Privileged Utility Programs', intent: 'Restrict and tightly control the use of utility programs that can override system controls. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.19', name: 'Software Installation on Operational Systems', intent: 'Control the installation of software on operational systems with appropriate procedures. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.20', name: 'Networks Security', intent: 'Manage and control network infrastructure to protect information in systems and applications. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.21', name: 'Web Services Security', intent: 'Secure web-based services to protect against attacks and unauthorized access. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.22', name: 'Network Segregation', intent: 'Segregate networks into groups of information services, users, and systems as appropriate. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.23', name: 'Web Filtering', intent: 'Filter access to external websites to reduce exposure to malicious content. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.24', name: 'Use of Cryptography', intent: 'Define and implement rules for the effective use of cryptography including key management. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.25', name: 'Secure Development Life Cycle', intent: 'Establish and apply rules for the secure development of software and systems. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.26', name: 'Application Security Requirements', intent: 'Identify, specify, and approve security requirements for application development and acquisition. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.27', name: 'Secure System Architecture', intent: 'Establish principles for designing secure system architectures. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.28', name: 'Secure Coding', intent: 'Apply secure coding principles to software development activities. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.29', name: 'Security Testing in Development', intent: 'Define and implement security testing processes in the development lifecycle. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.30', name: 'Outsourced Development', intent: 'Direct, monitor, and review outsourced system development activities. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.31', name: 'Separation of Environments', intent: 'Separate development, testing, and production environments to reduce risk. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.32', name: 'Change Management', intent: 'Subject changes to information processing facilities and systems to change management. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.33', name: 'Test Information', intent: 'Appropriately select, protect, and manage information used for testing. (Paraphrase)', category: 'Technological' },
    { annexId: 'A.8.34', name: 'Audit System Protection', intent: 'Plan and agree upon audit tests and activities to minimize disruption to business processes. (Paraphrase)', category: 'Technological' },
];
