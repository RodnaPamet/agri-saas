/**
 * Guard: the audit redaction list is derived from the schema, not from memory (#1935).
 *
 * ## What this replaces
 *
 * `src/lib/audit-redact.ts` decides what the automatic audit extension may
 * snapshot into `diffJson.after` by matching the field NAME against a
 * hand-written list of regexes. It is the only filter: the prisma extension
 * in `src/lib/prisma.ts` audits every model but `AuditLog` — an EXCLUSION
 * list — and `AuditDetailsJsonSchema` is `.passthrough()`, so nothing behind
 * it strips an unexpected key either.
 *
 * #1934 found three columns the list missed — `Tenant.encryptedDek`,
 * `Tenant.previousEncryptedDek`, `NotificationOutbox.toEmailEncrypted` — and
 * closed them with `/encrypted/i`. What it could not fix is the mechanism:
 * the four sibling `*Encrypted` columns that WERE redacted were covered only
 * by the accident of their names containing `secret` or `token`. Nobody
 * chose that, and nobody would have noticed the next miss.
 *
 * #1935 found one more the same way: `UserMfaEnrollment.backupCodesHashJson`,
 * which `/hash$/i` missed because the name ends in `Json`. MFA backup codes
 * are short enough to brute-force from a hash offline.
 *
 * A list that mirrors the schema BY NAME goes stale in silence every time the
 * schema gains a column. This derives the population from
 * `prisma/schema/*.prisma` instead, so a new credential-shaped column fails
 * until it is either matched or excused in writing.
 *
 * ## Why a wide net plus an exact allowlist
 *
 * The net is deliberately WIDER than the redaction list — it has to be, or it
 * could only confirm what the list already says. A wide net has real false
 * positives: `Unit.key` is a slug, `lotCode` is printed on a delivery note,
 * `seedsPerGram` matched only because of "seed".
 *
 * So each false positive is named EXACTLY and grouped under a shared reason.
 * Exact names rather than patterns: a `*Key` pattern would silently excuse a
 * future `apiKeyMaterial`, which is the hole this guard exists to close.
 *
 * ## Both directions
 *
 * Under-redaction is the dangerous one, but over-redaction is a real defect
 * too and this file had one: its own comment said the AI patterns were
 * anchored "so they DON'T match `promptHash` (which is safe to store + is the
 * correlation key)" while `/hash/i` matched and redacted it anyway. The
 * anchoring protected the value from one pattern while another took it, so
 * the documented correlation key had never reached a diff. Pinned below as
 * the decision it now is, rather than left as a comment describing the
 * opposite of what the code does.
 */
import { readFileSync } from 'node:fs';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** Prisma scalar and wrapper types — anything else names a model or enum. */
const SCALARS = new Set([
    'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes',
    'Decimal', 'BigInt', 'Unsupported',
]);

interface Column {
    name: string;
    type: string;
    models: Set<string>;
}

/**
 * Every SCALAR column in the schema, with the models carrying it.
 *
 * Relations are excluded rather than allowlisted: `UserSession.authCodes` is
 * a `NativeAuthCode[]`, and a relation never appears in `changedFields`, so
 * including it would mean excusing something a diff cannot contain.
 */
function scalarColumns(): Map<string, Column> {
    const files = collectSourceFiles({
        roots: ['prisma/schema'],
        extensions: ['.prisma'],
        floor: 5,
    });
    const enums = new Set<string>();
    const models = new Set<string>();
    const raw: Array<{ name: string; type: string; model: string }> = [];

    for (const abs of files) {
        let model: string | null = null;
        for (const line of readFileSync(abs, 'utf8').split('\n')) {
            const m = /^model\s+(\w+)/.exec(line);
            if (m) {
                model = m[1];
                models.add(m[1]);
                continue;
            }
            const e = /^enum\s+(\w+)/.exec(line);
            if (e) {
                enums.add(e[1]);
                model = null;
                continue;
            }
            if (/^}/.test(line)) {
                model = null;
                continue;
            }
            if (!model) continue;
            const f = /^\s{2,}(\w+)\s+(\S+)/.exec(line);
            if (f && !f[1].startsWith('@@')) raw.push({ name: f[1], type: f[2], model });
        }
    }

    const out = new Map<string, Column>();
    for (const { name, type, model } of raw) {
        const base = type.replace(/[?[\]]/g, '');
        // A model-typed field is a relation. An enum IS scalar on the wire.
        if (models.has(base) && !enums.has(base)) continue;
        if (!SCALARS.has(base) && !enums.has(base)) continue;
        if (!out.has(name)) out.set(name, { name, type, models: new Set() });
        out.get(name)!.models.add(model);
    }
    return out;
}

/** Patterns read FROM the source, so this cannot drift from what runs. */
function livePatterns(): RegExp[] {
    const src = readFileSync(`${REPO_ROOT}/src/lib/audit-redact.ts`, 'utf8');
    const start = src.indexOf('const SENSITIVE_PATTERNS');
    const block = src.slice(start, src.indexOf('];', start));
    return block
        .split('\n')
        .map((l) => /^\s*\/(.+)\/([gimsuy]*),\s*(?:\/\/.*)?$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => new RegExp(m[1], m[2]));
}

const PATTERNS = livePatterns();
const redacted = (name: string): boolean => PATTERNS.some((p) => p.test(name));

/**
 * Credential-shaped names, wider than the redaction list on purpose. A net
 * that matched only what the list matches could never find a gap.
 */
const SUSPECT = /hash|code|key|pin|otp|backup|secret|token|signature|nonce|dek|kek|cipher|encrypted|verifier|challenge|seed|password|salt|credential/i;

/**
 * Columns the net catches that are NOT credentials, grouped by the reason.
 *
 * Exact names, never patterns — a `*Key` pattern would silently excuse a
 * future `apiKeyMaterial`.
 */
const NOT_A_CREDENTIAL: ReadonlyArray<[reason: string, columns: readonly string[]]> = [
    [
        'A stable slug naming a catalogue row or a graph node — human-readable, chosen by the tenant, and the thing an operator needs the audit row to identify.',
        ['key', 'nameKey', 'nodeKey', 'parentNodeKey', 'edgeKey', 'sourceKey', 'targetKey',
         'pathKey', 'practiceKey', 'cohortKey', 'titleKey', 'weedKeys', 'storageKey', 'automationKey'],
    ],
    [
        'A client-supplied request handle. It authenticates nothing, and tracing a retry or a duplicate is exactly what an operator reads the trail for.',
        ['idempotencyKey', 'dedupeKey'],
    ],
    [
        'A domain or regulatory code a person reads off a document.',
        ['lotCode', 'measureCode', 'regionCode', 'reasonCode'],
    ],
    [
        'An agronomy quantity. Matched only because the word "seed" appears in a net aimed at "seeds" as key material.',
        ['seedQuantityGrams', 'seedsPerCell', 'seedsPerGram'],
    ],
    [
        'A search term a user typed.',
        ['keyword'],
    ],
    [
        'The PKCE challenge — base64url SHA-256 of the verifier, sent in the clear by the client at authorize time. The VERIFIER is the secret and is deliberately not a column anywhere.',
        ['codeChallenge'],
    ],
    [
        'A timestamp.',
        ['lastChallengeAt'],
    ],
    [
        'The non-secret handle an operator uses to recognise WHICH key a row is about. Deliberately stored: refusing it makes the trail less useful for no security gain, and it was the one match a whole-expression rule produced across 220 logEvent calls in #1784.',
        ['keyPrefix'],
    ],
];

const EXCUSED = new Set(NOT_A_CREDENTIAL.flatMap(([, cols]) => cols));

const columns = scalarColumns();
const suspects = [...columns.values()].filter((c) => SUSPECT.test(c.name));
const unredacted = suspects.filter((c) => !redacted(c.name));

describe('audit redaction covers the schema (#1935)', () => {
    it('ranges over the real schema — the denominators', () => {
        console.log(
            `[audit-redact] ${columns.size} scalar column name(s) in prisma/schema, ` +
                `${suspects.length} credential-shaped, ${unredacted.length} of those not redacted, ` +
                `${EXCUSED.size} excused by name`,
        );
        // Floors, so a parser that stopped finding columns fails loudly
        // instead of passing over an empty population — the failure the two
        // tests #1784 deleted actually had.
        // 664 scalar columns at the time of writing. The earlier figure of
        // 910 counted RELATIONS too, and this floor caught that — a diff can
        // only ever contain scalars.
        expect(columns.size).toBeGreaterThan(500);
        expect(suspects.length).toBeGreaterThan(30);
        expect(PATTERNS.length).toBeGreaterThan(20);
    });

    it('the net and the patterns both work — the control', () => {
        // The net must catch things the list already covers, or it is not
        // wider than the list and can never find a gap.
        expect(SUSPECT.test('encryptedDek')).toBe(true);
        expect(SUSPECT.test('backupCodesHashJson')).toBe(true);
        expect(SUSPECT.test('displayName')).toBe(false);
        // And the patterns parsed from source actually match.
        expect(redacted('passwordHash')).toBe(true);
        expect(redacted('encryptedDek')).toBe(true);
        expect(redacted('backupCodesHashJson')).toBe(true);
        expect(redacted('displayName')).toBe(false);
    });

    it('every credential-shaped column is redacted or excused in writing', () => {
        const gaps = unredacted
            .filter((c) => !EXCUSED.has(c.name))
            .map((c) => `  ${c.name} (${c.type}) on ${[...c.models].join(', ')} — redact it, or excuse it with a reason`);
        expect(gaps.sort().join('\n')).toBe('');
    });

    it('no excuse outlives its column', () => {
        // An allowlist rots the moment a column is renamed or removed: the
        // name stays, and silently excuses whatever next matches it.
        const stale = [...EXCUSED]
            .filter((name) => !columns.has(name))
            .map((name) => `  ${name} — no such scalar column any more; delete the excuse`);
        expect(stale.sort().join('\n')).toBe('');
    });

    it('no excuse is for a column that IS redacted', () => {
        // The other way an allowlist rots. An excuse for something already
        // covered reads as a decision to store it, which is the opposite of
        // what happens.
        const pointless = [...EXCUSED]
            .filter((name) => redacted(name))
            .map((name) => `  ${name} — is already redacted; the excuse says the opposite`);
        expect(pointless.sort().join('\n')).toBe('');
    });

    it('promptHash stays redacted, and the comment says so', () => {
        // The over-redaction direction, and the defect this found. The file's
        // own note claimed the AI patterns were anchored so they would not
        // match `promptHash`, "which is safe to store + is the correlation
        // key" — while `/hash/i` matched it and redacted it anyway.
        //
        // Resolved by keeping the redaction: a prompt is low-entropy enough
        // that its hash confirms a guess offline, and the correlation use
        // case is served by `AiCall.promptHash` itself. Pinned so it stays a
        // decision rather than drifting back to a comment that describes the
        // opposite of the behaviour.
        expect(redacted('promptHash')).toBe(true);
        const src = readFileSync(`${REPO_ROOT}/src/lib/audit-redact.ts`, 'utf8');
        expect(src).toContain('CORRECTION (#1935)');
        expect(src).not.toContain("so they DON'T match `promptHash` (which is safe to store");
    });
});
