/**
 * Policy Templates — ORIGINAL content. NOT ISO/IEC standard text.
 * These are starter templates for common information security policies.
 */
export interface PolicyTemplate {
    title: string;
    content: string;
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
    {
        title: 'Information Security Policy',
        content: `# Information Security Policy

## 1. Purpose
This policy defines the organization's approach to protecting information assets and ensuring confidentiality, integrity, and availability of data.

## 2. Scope
This policy applies to all employees, contractors, and third parties who access organizational information and systems.

## 3. Policy Statements

### 3.1 Information Protection
- All information assets shall be classified according to their sensitivity and business value.
- Appropriate protective measures shall be applied based on classification level.
- Information shall be protected throughout its lifecycle from creation to disposal.

### 3.2 Access Control
- Access to information shall be granted on a need-to-know and least-privilege basis.
- All users must authenticate before accessing organizational systems.
- Access rights shall be reviewed periodically and revoked when no longer required.

### 3.3 Risk Management
- Information security risks shall be identified, assessed, and treated as part of a structured risk management process.
- Risk acceptance decisions must be approved by designated risk owners.
- Risk assessments shall be performed at least annually or upon significant change.

### 3.4 Incident Management
- Security incidents shall be reported promptly through established channels.
- All incidents shall be investigated and documented.
- Lessons learned shall be incorporated into security improvement plans.

### 3.5 Compliance
- The organization shall comply with all applicable legal, regulatory, and contractual requirements.
- Compliance status shall be monitored and reviewed periodically.

## 4. Responsibilities
- **Senior Management**: Overall accountability for information security.
- **Security Team**: Day-to-day implementation and monitoring of this policy.
- **All Staff**: Compliance with this policy and reporting of security concerns.

## 5. Review
This policy shall be reviewed at least annually and updated as necessary.`,
    },
    {
        title: 'Access Control Policy',
        content: `# Access Control Policy

## 1. Purpose
To establish rules governing access to organizational information systems, applications, and data to prevent unauthorized access.

## 2. Scope
Applies to all users, systems, applications, and network resources.

## 3. Policy Statements

### 3.1 Access Management Principles
- Follow least-privilege: users receive minimum access required for their role.
- Implement separation of duties where sensitive functions are involved.
- All access must be formally authorized before provisioning.

### 3.2 User Registration and De-registration
- A formal process shall exist for granting and revoking access.
- Unique user IDs shall be assigned; shared accounts are prohibited unless specifically authorized.
- Access shall be revoked immediately upon termination of employment or contract.

### 3.3 Authentication
- Strong passwords are required (minimum 12 characters, complexity enforced).
- Multi-factor authentication is required for privileged accounts and remote access.
- Authentication credentials shall not be shared or stored in plaintext.

### 3.4 Privileged Access
- Privileged accounts shall be separate from normal user accounts.
- Use of privileged access shall be logged and monitored.
- Privileged access rights shall be reviewed quarterly.

### 3.5 Access Review
- User access rights shall be reviewed at least every six months.
- Managers must certify the continued need for their team members' access.
- Orphaned accounts shall be disabled or removed.

## 4. Responsibilities
- **IT Administration**: Provisioning and de-provisioning access.
- **Managers**: Approving access requests for their team members.
- **Users**: Protecting their credentials and reporting suspicious access.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Incident Response Policy',
        content: `# Incident Response Policy

## 1. Purpose
To provide a structured approach for detecting, reporting, assessing, responding to, and learning from information security incidents.

## 2. Scope
Covers all information security events and incidents affecting organizational assets.

## 3. Policy Statements

### 3.1 Incident Classification
- **Event**: An observed occurrence that may indicate a security incident.
- **Incident**: A confirmed event that may harm confidentiality, integrity, or availability.
- Incidents shall be categorized by severity: Low, Medium, High, Critical.

### 3.2 Reporting
- All personnel must report suspected security events immediately.
- Reports shall be submitted through the designated incident management system.
- External reporting obligations shall be met within required timeframes.

### 3.3 Response Process
1. **Detect**: Monitor systems and environments for anomalous activity.
2. **Triage**: Assess the scope, impact, and severity of the incident.
3. **Contain**: Take immediate steps to limit damage and prevent spread.
4. **Eradicate**: Identify and remove the root cause.
5. **Recover**: Restore affected systems to normal operation.
6. **Review**: Conduct a post-incident review and document lessons learned.

### 3.4 Evidence Preservation
- Preserve evidence for potential forensic investigation or legal proceedings.
- Maintain chain of custody documentation for all collected evidence.

### 3.5 Communication
- Internal stakeholders shall be informed based on incident severity.
- External communication shall be coordinated through designated spokespersons.

## 4. Responsibilities
- **Incident Response Team**: Leading incident investigation and response.
- **All Staff**: Reporting events promptly.
- **Management**: Providing resources and making decisions on significant incidents.

## 5. Review
This policy shall be reviewed annually and after every major incident.`,
    },
    {
        title: 'Acceptable Use Policy',
        content: `# Acceptable Use Policy

## 1. Purpose
To define acceptable and unacceptable use of organizational information systems and assets by all users.

## 2. Scope
Applies to all employees, contractors, and third parties using organizational resources.

## 3. Policy Statements

### 3.1 General Use
- Organizational systems are provided primarily for business purposes.
- Limited personal use is permitted if it does not interfere with work duties or violate this policy.
- Users are responsible for the security of their assigned devices and accounts.

### 3.2 Prohibited Activities
- Accessing, downloading, or distributing illegal or offensive material.
- Attempting to gain unauthorized access to systems, accounts, or data.
- Installing unapproved software or circumventing security practices.
- Sharing credentials or allowing others to use your accounts.
- Using organizational resources for personal commercial activities.

### 3.3 Email and Communications
- Business communication tools shall be used responsibly and professionally.
- Suspicious emails shall be reported, not forwarded or opened.
- Confidential information shall not be sent via unencrypted channels.

### 3.4 Remote and Mobile Working
- Devices used for remote work must meet organizational security requirements.
- Public Wi-Fi shall not be used for sensitive business activities without a VPN.
- Devices shall be physically secured and screens locked when unattended.

### 3.5 Data Handling
- Information shall be handled according to its classification level.
- Sensitive information shall not be stored on personal devices without authorization.
- Data shall be disposed of securely when no longer needed.

## 4. Enforcement
Violations may result in disciplinary action, up to and including termination.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Supplier Security Policy',
        content: `# Supplier Security Policy

## 1. Purpose
To establish requirements for managing information security risks associated with suppliers and third-party service providers.

## 2. Scope
Applies to all third parties that access, process, store, or transmit organizational information.

## 3. Policy Statements

### 3.1 Supplier Assessment
- Suppliers shall be assessed for security capability before engagement.
- Assessment rigor shall be proportionate to the sensitivity of information involved.
- Critical suppliers shall undergo annual security reviews.

### 3.2 Contractual Requirements
- Agreements shall include security obligations, data protection clauses, and right-to-audit provisions.
- Suppliers must agree to report security incidents that may affect the organization.
- Confidentiality agreements shall be executed before information is shared.

### 3.3 Ongoing Monitoring
- Supplier security performance shall be monitored throughout the relationship.
- Changes to supplier security posture shall be assessed for impact.
- Non-compliance with security requirements shall be escalated and remediated.

### 3.4 Termination
- Information access shall be revoked upon termination of the supplier relationship.
- Return or secure destruction of organizational data shall be confirmed.

## 4. Responsibilities
- **Procurement**: Ensuring security requirements are included in contracts.
- **Security Team**: Conducting and reviewing supplier assessments.
- **Relationship Owners**: Monitoring ongoing supplier compliance.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Backup & Recovery Policy',
        content: `# Backup & Recovery Policy

## 1. Purpose
To ensure that organizational information and systems can be recovered in the event of data loss, corruption, or disaster.

## 2. Scope
Applies to all critical information systems, databases, and applications.

## 3. Policy Statements

### 3.1 Backup Requirements
- Critical data shall be backed up according to a defined schedule.
- Backup frequency shall be determined by Recovery Point Objective (RPO) for each system.
- Backups shall include system configurations, application data, and databases.

### 3.2 Backup Storage
- Backups shall be stored in a separate location from primary systems.
- At least one backup copy shall be stored offsite or in a different cloud region.
- Backup media and storage shall be protected with encryption.

### 3.3 Testing and Verification
- Backup restoration shall be tested at least quarterly.
- Test results shall be documented and any failures remediated promptly.
- Recovery Time Objectives (RTO) shall be validated through testing.

### 3.4 Recovery Procedures
- Documented recovery procedures shall exist for all critical systems.
- Recovery procedures shall be accessible during an incident.
- Recovery priorities shall be aligned with business impact assessments.

## 4. Responsibilities
- **IT Operations**: Executing and monitoring backup processes.
- **System Owners**: Defining RPO and RTO for their systems.
- **Security Team**: Ensuring backup security requirements are met.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Change Management Policy',
        content: `# Change Management Policy

## 1. Purpose
To ensure that changes to information systems are managed in a controlled manner to minimize risk of disruption or security compromise.

## 2. Scope
Applies to all changes to production systems, infrastructure, applications, and network configurations.

## 3. Policy Statements

### 3.1 Change Process
- All changes must follow a formal change management process.
- Changes shall be categorized as Standard, Normal, or Emergency.
- A Change Advisory Board (CAB) shall review and approve Normal and Emergency changes.

### 3.2 Change Records
- A record shall be maintained for every change including description, justification, risk assessment, and approval.
- Changes must have a documented rollback plan before implementation.
- Test evidence shall be recorded for all changes.

### 3.3 Testing and Validation
- Changes shall be tested in a non-production environment before deployment.
- Security impact of changes shall be assessed as part of the change process.
- Post-implementation reviews shall confirm successful deployment.

### 3.4 Emergency Changes
- Emergency changes may bypass normal approvals but must be documented retroactively.
- Emergency changes shall be reviewed by the CAB within the next business day.

## 4. Responsibilities
- **Change Manager**: Overseeing the change process and maintaining the change log.
- **Change Requestors**: Submitting complete change requests with risk assessments.
- **CAB**: Reviewing and approving changes.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Cryptography & Key Management Policy',
        content: `# Cryptography & Key Management Policy

## 1. Purpose
To establish guidelines for the use of cryptographic practices and management of cryptographic keys to protect information.

## 2. Scope
Applies to all systems and processes that use cryptography for data protection.

## 3. Policy Statements

### 3.1 Cryptographic Use
- Data classified as confidential or higher shall be encrypted at rest and in transit.
- Industry-standard, vetted cryptographic algorithms shall be used (e.g., AES-256, RSA-2048+).
- Custom or proprietary encryption algorithms are prohibited.

### 3.2 Key Management
- Cryptographic keys shall be generated using secure, random methods.
- Keys shall be stored securely, separate from the data they protect.
- Key rotation schedules shall be defined based on algorithm and risk level.

### 3.3 Key Lifecycle
- Generation, distribution, storage, rotation, revocation, and destruction of keys shall be managed formally.
- Compromised keys shall be revoked and replaced immediately.
- Retired keys shall be securely destroyed.

### 3.4 Certificate Management
- Digital certificates shall be obtained from trusted certificate authorities.
- Certificate expiry shall be monitored and renewals planned in advance.

## 4. Responsibilities
- **Security Team**: Defining cryptographic standards and overseeing key management.
- **System Administrators**: Implementing and maintaining cryptographic practices.
- **Developers**: Following cryptographic coding standards.

## 5. Review
This policy shall be reviewed annually.`,
    },
    {
        title: 'Logging & Monitoring Standard',
        content: `# Logging & Monitoring Standard

## 1. Purpose
To define requirements for logging, monitoring, and alerting to detect security events and support incident investigation.

## 2. Scope
Applies to all systems, applications, and network devices in the organizational environment.

## 3. Requirements

### 3.1 Logging
- Authentication events (success and failure) shall be logged.
- Privileged operations shall be logged with user identity and timestamp.
- Changes to critical configurations shall be logged.
- Access to sensitive data shall be logged.
- Logs shall include: timestamp, source, user identity, event type, and outcome.

### 3.2 Log Protection
- Logs shall be protected from unauthorized access and tampering.
- Log data shall be transmitted securely to centralized log management.
- Log retention shall meet compliance and operational requirements (minimum 12 months).

### 3.3 Monitoring
- Automated monitoring shall be in place for security-relevant events.
- Alert thresholds shall be defined for common attack patterns.
- Monitoring coverage shall include network, endpoint, and application layers.

### 3.4 Review and Analysis
- Logs shall be reviewed regularly for anomalies and indicators of compromise.
- Review frequency shall be proportionate to system criticality.
- Findings from log reviews shall be documented and escalated as needed.

## 4. Responsibilities
- **Security Operations**: Operating monitoring tools and responding to alerts.
- **IT Teams**: Ensuring logging is properly configured on their systems.
- **Management**: Providing resources for monitoring capabilities.

## 5. Review
This standard shall be reviewed annually.`,
    },
];
