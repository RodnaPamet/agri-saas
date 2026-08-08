/**
 * Control taxonomy — the single source of truth for "what category
 * does this control belong to, and which framework does that category
 * come from".
 *
 * The product groups controls by *framework-native category* in the
 * Controls "Browse" rail. A control's category is derived from its
 * framework + clause/code rather than stored as a single free-form
 * string, so:
 *
 *   - it works retroactively for controls that were created before any
 *     category was assigned (no migration / backfill needed);
 *   - the same control set can surface categories from MULTIPLE
 *     frameworks (each category carries its framework tag); and
 *   - the granular ISO 27001 domain taxonomy lives in ONE place that
 *     both the runtime rail and the catalog seed import.
 *
 * Deliberately DEPENDENCY-FREE (no `@/` imports, no React) so it can be
 * imported from the browser bundle, server usecases, AND the
 * `prisma/seed-catalog.ts` script (which runs under `tsx` and resolves
 * relative `require`s, not the `@/` path alias).
 */

export interface ControlCategory {
    /** Stable framework slug — used as the grouping key prefix. */
    frameworkKey: string;
    /** Human label shown as the category's framework tag (e.g. "ISO 27001"). */
    frameworkLabel: string;
    /** Granular control domain / category (e.g. "Access control"). */
    category: string;
}

/** Minimal shape the categorizer needs off a control row. */
export interface CategorizableControl {
    code?: string | null;
    category?: string | null;
}

// ─── ISO 27001:2022 Annex A granular domains ──────────────────────────
//
// ISO 27001:2022 reorganised the 114 legacy controls into 93 controls
// under four broad THEMES (Organizational / People / Physical /
// Technological). Those four themes are too coarse for a browse rail —
// the user wants the functional domains ("Access control", "Physical &
// environmental", "Cryptography", …) that practitioners actually reason
// in. The map below assigns every one of the 93 Annex A clauses to a
// granular domain following the ISO 27002:2022 functional grouping
// (and aligning with the classic ISO 27001:2013 Annex A domain names
// the user referenced).

export const ISO27001_DOMAIN = {
    GOVERNANCE: 'Governance & policies',
    ASSET_MGMT: 'Asset management',
    ACCESS_CONTROL: 'Access control',
    SUPPLIER: 'Supplier relationships',
    INCIDENT: 'Incident management',
    CONTINUITY: 'Business continuity',
    COMPLIANCE: 'Compliance & legal',
    HR_SECURITY: 'Human resource security',
    PHYSICAL: 'Physical & environmental security',
    THREAT_VULN: 'Threat & vulnerability management',
    OPERATIONS: 'Operations security',
    CRYPTO: 'Cryptography',
    NETWORK: 'Network security',
    SECURE_DEV: 'System development & secure coding',
    DATA_PROTECTION: 'Data protection',
} as const;

/** Stable display order for the ISO 27001 domains in the browse rail. */
export const ISO27001_DOMAIN_ORDER: string[] = [
    ISO27001_DOMAIN.GOVERNANCE,
    ISO27001_DOMAIN.ASSET_MGMT,
    ISO27001_DOMAIN.ACCESS_CONTROL,
    ISO27001_DOMAIN.HR_SECURITY,
    ISO27001_DOMAIN.PHYSICAL,
    ISO27001_DOMAIN.OPERATIONS,
    ISO27001_DOMAIN.NETWORK,
    ISO27001_DOMAIN.CRYPTO,
    ISO27001_DOMAIN.DATA_PROTECTION,
    ISO27001_DOMAIN.SECURE_DEV,
    ISO27001_DOMAIN.THREAT_VULN,
    ISO27001_DOMAIN.SUPPLIER,
    ISO27001_DOMAIN.INCIDENT,
    ISO27001_DOMAIN.CONTINUITY,
    ISO27001_DOMAIN.COMPLIANCE,
];

/** ISO 27001:2022 Annex A clause (e.g. "5.15") → granular domain. */
export const ISO27001_CLAUSE_DOMAIN: Record<string, string> = {
    // 5.x — Organizational
    '5.1': ISO27001_DOMAIN.GOVERNANCE, // Policies for information security
    '5.2': ISO27001_DOMAIN.GOVERNANCE, // Roles and responsibilities
    '5.3': ISO27001_DOMAIN.GOVERNANCE, // Segregation of duties
    '5.4': ISO27001_DOMAIN.GOVERNANCE, // Management responsibilities
    '5.5': ISO27001_DOMAIN.GOVERNANCE, // Contact with authorities
    '5.6': ISO27001_DOMAIN.GOVERNANCE, // Contact with special interest groups
    '5.7': ISO27001_DOMAIN.THREAT_VULN, // Threat intelligence
    '5.8': ISO27001_DOMAIN.GOVERNANCE, // ISMS in project management
    '5.9': ISO27001_DOMAIN.ASSET_MGMT, // Inventory of assets
    '5.10': ISO27001_DOMAIN.ASSET_MGMT, // Acceptable use of assets
    '5.11': ISO27001_DOMAIN.ASSET_MGMT, // Return of assets
    '5.12': ISO27001_DOMAIN.ASSET_MGMT, // Classification of information
    '5.13': ISO27001_DOMAIN.ASSET_MGMT, // Labelling of information
    '5.14': ISO27001_DOMAIN.ASSET_MGMT, // Information transfer
    '5.15': ISO27001_DOMAIN.ACCESS_CONTROL, // Access control
    '5.16': ISO27001_DOMAIN.ACCESS_CONTROL, // Identity management
    '5.17': ISO27001_DOMAIN.ACCESS_CONTROL, // Authentication information
    '5.18': ISO27001_DOMAIN.ACCESS_CONTROL, // Access rights
    '5.19': ISO27001_DOMAIN.SUPPLIER, // Supplier relationships
    '5.20': ISO27001_DOMAIN.SUPPLIER, // Supplier agreements
    '5.21': ISO27001_DOMAIN.SUPPLIER, // ICT supply chain
    '5.22': ISO27001_DOMAIN.SUPPLIER, // Monitoring supplier services
    '5.23': ISO27001_DOMAIN.SUPPLIER, // Cloud services
    '5.24': ISO27001_DOMAIN.INCIDENT, // Incident management planning
    '5.25': ISO27001_DOMAIN.INCIDENT, // Assessment of security events
    '5.26': ISO27001_DOMAIN.INCIDENT, // Response to incidents
    '5.27': ISO27001_DOMAIN.INCIDENT, // Learning from incidents
    '5.28': ISO27001_DOMAIN.INCIDENT, // Collection of evidence
    '5.29': ISO27001_DOMAIN.CONTINUITY, // Security during disruption
    '5.30': ISO27001_DOMAIN.CONTINUITY, // ICT readiness for continuity
    '5.31': ISO27001_DOMAIN.COMPLIANCE, // Legal/regulatory requirements
    '5.32': ISO27001_DOMAIN.COMPLIANCE, // Intellectual property rights
    '5.33': ISO27001_DOMAIN.COMPLIANCE, // Protection of records
    '5.34': ISO27001_DOMAIN.COMPLIANCE, // Privacy and PII
    '5.35': ISO27001_DOMAIN.GOVERNANCE, // Independent review
    '5.36': ISO27001_DOMAIN.COMPLIANCE, // Compliance with policies
    '5.37': ISO27001_DOMAIN.OPERATIONS, // Documented operating procedures
    // 6.x — People
    '6.1': ISO27001_DOMAIN.HR_SECURITY, // Screening
    '6.2': ISO27001_DOMAIN.HR_SECURITY, // Terms and conditions of employment
    '6.3': ISO27001_DOMAIN.HR_SECURITY, // Awareness, education and training
    '6.4': ISO27001_DOMAIN.HR_SECURITY, // Disciplinary process
    '6.5': ISO27001_DOMAIN.HR_SECURITY, // Responsibilities after termination
    '6.6': ISO27001_DOMAIN.HR_SECURITY, // Confidentiality / NDAs
    '6.7': ISO27001_DOMAIN.HR_SECURITY, // Remote working
    '6.8': ISO27001_DOMAIN.INCIDENT, // Security event reporting
    // 7.x — Physical
    '7.1': ISO27001_DOMAIN.PHYSICAL, // Physical security perimeters
    '7.2': ISO27001_DOMAIN.PHYSICAL, // Physical entry
    '7.3': ISO27001_DOMAIN.PHYSICAL, // Securing offices/rooms/facilities
    '7.4': ISO27001_DOMAIN.PHYSICAL, // Physical security monitoring
    '7.5': ISO27001_DOMAIN.PHYSICAL, // Physical/environmental threats
    '7.6': ISO27001_DOMAIN.PHYSICAL, // Working in secure areas
    '7.7': ISO27001_DOMAIN.PHYSICAL, // Clear desk and clear screen
    '7.8': ISO27001_DOMAIN.PHYSICAL, // Equipment siting and protection
    '7.9': ISO27001_DOMAIN.PHYSICAL, // Security of assets off-premises
    '7.10': ISO27001_DOMAIN.PHYSICAL, // Storage media
    '7.11': ISO27001_DOMAIN.PHYSICAL, // Supporting utilities
    '7.12': ISO27001_DOMAIN.PHYSICAL, // Cabling security
    '7.13': ISO27001_DOMAIN.PHYSICAL, // Equipment maintenance
    '7.14': ISO27001_DOMAIN.PHYSICAL, // Secure disposal or re-use
    // 8.x — Technological
    '8.1': ISO27001_DOMAIN.OPERATIONS, // User endpoint devices
    '8.2': ISO27001_DOMAIN.ACCESS_CONTROL, // Privileged access rights
    '8.3': ISO27001_DOMAIN.ACCESS_CONTROL, // Information access restriction
    '8.4': ISO27001_DOMAIN.ACCESS_CONTROL, // Access to source code
    '8.5': ISO27001_DOMAIN.ACCESS_CONTROL, // Secure authentication
    '8.6': ISO27001_DOMAIN.OPERATIONS, // Capacity management
    '8.7': ISO27001_DOMAIN.THREAT_VULN, // Protection against malware
    '8.8': ISO27001_DOMAIN.THREAT_VULN, // Technical vulnerabilities
    '8.9': ISO27001_DOMAIN.OPERATIONS, // Configuration management
    '8.10': ISO27001_DOMAIN.DATA_PROTECTION, // Information deletion
    '8.11': ISO27001_DOMAIN.DATA_PROTECTION, // Data masking
    '8.12': ISO27001_DOMAIN.DATA_PROTECTION, // Data leakage prevention
    '8.13': ISO27001_DOMAIN.CONTINUITY, // Information backup
    '8.14': ISO27001_DOMAIN.CONTINUITY, // Redundancy of facilities
    '8.15': ISO27001_DOMAIN.OPERATIONS, // Logging
    '8.16': ISO27001_DOMAIN.OPERATIONS, // Monitoring activities
    '8.17': ISO27001_DOMAIN.OPERATIONS, // Clock synchronization
    '8.18': ISO27001_DOMAIN.ACCESS_CONTROL, // Privileged utility programs
    '8.19': ISO27001_DOMAIN.OPERATIONS, // Software on operational systems
    '8.20': ISO27001_DOMAIN.NETWORK, // Networks security
    '8.21': ISO27001_DOMAIN.NETWORK, // Security of network services
    '8.22': ISO27001_DOMAIN.NETWORK, // Segregation of networks
    '8.23': ISO27001_DOMAIN.NETWORK, // Web filtering
    '8.24': ISO27001_DOMAIN.CRYPTO, // Use of cryptography
    '8.25': ISO27001_DOMAIN.SECURE_DEV, // Secure development life cycle
    '8.26': ISO27001_DOMAIN.SECURE_DEV, // Application security requirements
    '8.27': ISO27001_DOMAIN.SECURE_DEV, // Secure system architecture
    '8.28': ISO27001_DOMAIN.SECURE_DEV, // Secure coding
    '8.29': ISO27001_DOMAIN.SECURE_DEV, // Security testing in development
    '8.30': ISO27001_DOMAIN.SECURE_DEV, // Outsourced development
    '8.31': ISO27001_DOMAIN.SECURE_DEV, // Separation of dev/test/prod
    '8.32': ISO27001_DOMAIN.SECURE_DEV, // Change management
    '8.33': ISO27001_DOMAIN.SECURE_DEV, // Test information
    '8.34': ISO27001_DOMAIN.SECURE_DEV, // Protection during audit testing
};

// ─── Framework labels ─────────────────────────────────────────────────

export const FRAMEWORK_LABELS: Record<string, string> = {
    iso27001: 'ISO 27001',
    soc2: 'SOC 2',
    nis2: 'NIS2',
    iso9001: 'ISO 9001',
    iso28000: 'ISO 28000',
    iso39001: 'ISO 39001',
    nist80053: 'NIST 800-53',
};

/** Fallback label for the "framework couldn't be determined" bucket. */
export const UNCLASSIFIED_FRAMEWORK_KEY = 'other';
export const UNCATEGORIZED_LABEL = 'Uncategorized';

// ─── Clause parsing + classification ──────────────────────────────────

/**
 * Extract an ISO 27001:2022 Annex A clause ("5.15", "8.34", …) from a
 * control code. Accepts the forms the codebase uses:
 *   "A.5.15"  "A-5.15"  "5.15"
 * Returns null for anything that isn't a bare ISO annex reference — so
 * SOC 2 "CC5.1" / "NIS2-3" / etc. fall through to their own detectors.
 */
export function parseIsoClause(value: string | null | undefined): string | null {
    if (!value) return null;
    const m = value.trim().match(/^A?[.\-]?\s*([5-8])\.(\d{1,2})\s*$/i);
    return m ? `${m[1]}.${m[2]}` : null;
}

/** Map an ISO 27001 clause to its granular domain, or null. */
export function iso27001Domain(
    value: string | null | undefined,
): string | null {
    const clause = parseIsoClause(value);
    return clause ? ISO27001_CLAUSE_DOMAIN[clause] ?? null : null;
}

/**
 * Resolve a control to its framework-tagged category.
 *
 * Resolution order:
 *   1. ISO 27001 by Annex clause parsed from `code` → granular domain.
 *   2. Known framework by code prefix → the control's persisted
 *      framework-native `category` (SOC 2 TSC, NIS2/ISO section, …).
 *   3. Any persisted `category` with no detectable framework → an
 *      untagged "other" bucket.
 *   4. Otherwise null (the control is excluded from category grouping).
 */
export function categorizeControl(
    control: CategorizableControl,
): ControlCategory | null {
    const code = (control.code ?? '').trim();
    const persisted = (control.category ?? '').trim();

    // 1. ISO 27001 — an ISO-shaped code ("A.5.15" / "A-5.15" / "5.15").
    // The dedicated `annexId` column that used to lead this lookup was
    // dropped with the control exoskeleton; `code` carries the Annex
    // reference now, and `parseIsoClause` already accepts every form it
    // was written in.
    const isoDomain = iso27001Domain(code);
    if (isoDomain) {
        return {
            frameworkKey: 'iso27001',
            frameworkLabel: FRAMEWORK_LABELS.iso27001,
            category: isoDomain,
        };
    }

    // 2. Other frameworks — detect by code prefix, use persisted category.
    const prefixed = detectByCodePrefix(code);
    if (prefixed) {
        return {
            frameworkKey: prefixed.frameworkKey,
            frameworkLabel: prefixed.frameworkLabel,
            category: persisted || prefixed.frameworkLabel,
        };
    }

    // 3. Persisted category, framework unknown.
    if (persisted) {
        return {
            frameworkKey: UNCLASSIFIED_FRAMEWORK_KEY,
            frameworkLabel: '',
            category: persisted,
        };
    }

    // 4. Nothing to group on.
    return null;
}

function detectByCodePrefix(
    code: string,
): { frameworkKey: string; frameworkLabel: string } | null {
    if (!code) return null;
    if (/^CC\d/i.test(code))
        return { frameworkKey: 'soc2', frameworkLabel: FRAMEWORK_LABELS.soc2 };
    if (/^NIS2[-.]/i.test(code))
        return { frameworkKey: 'nis2', frameworkLabel: FRAMEWORK_LABELS.nis2 };
    if (/^QMS[-.]/i.test(code))
        return { frameworkKey: 'iso9001', frameworkLabel: FRAMEWORK_LABELS.iso9001 };
    if (/^SCS[-.]/i.test(code))
        return { frameworkKey: 'iso28000', frameworkLabel: FRAMEWORK_LABELS.iso28000 };
    if (/^RTS[-.]/i.test(code))
        return { frameworkKey: 'iso39001', frameworkLabel: FRAMEWORK_LABELS.iso39001 };
    // NIST 800-53 family prefixes: AC-1, AU-2, etc. (two-letter family).
    if (/^(AC|AU|AT|CM|CP|IA|IR|MA|MP|PE|PL|PS|RA|SA|SC|SI|SR|CA|PM)-\d/i.test(code))
        return { frameworkKey: 'nist80053', frameworkLabel: FRAMEWORK_LABELS.nist80053 };
    return null;
}
