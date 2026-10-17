/**
 * Notification Eligibility Guardrail
 *
 * INVARIANT: Every code path that writes to notificationOutbox MUST check
 * isNotificationsEnabled before the write. No bypass is acceptable.
 *
 * This test structurally scans ALL source files that contain
 * `notificationOutbox.create` and verifies that the same file also
 * imports and calls `isNotificationsEnabled`.
 *
 * WHY THIS EXISTS:
 *   Three separate send paths bypassed tenant notification settings:
 *     1. digest-dispatcher.ts  (fixed)
 *     2. retention-notifications.ts  (fixed)
 *     3. Future files — this guard catches them at CI time
 *
 * HOW TO READ FAILURES:
 *   If this test fails, a file writes to notificationOutbox without
 *   checking tenant notification eligibility. Either:
 *     a) Import and call isNotificationsEnabled before the write, or
 *     b) If this is a test file/script, add it to the EXEMPT list below.
 *
 * Regression guard: enforced on every CI run.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

import { blankNonCode } from '../helpers/blank-non-code';

const SRC_ROOT = resolve(__dirname, '../../src');

/**
 * Files exempt from the eligibility check requirement.
 * Only add files here if they are test helpers or internal tools
 * that intentionally bypass tenant settings.
 */
const EXEMPT_FILES: string[] = [
    // None currently — all outbox writers must be gated
];

/**
 * Recursively find all .ts files in a directory.
 */
function walkTs(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...walkTs(full));
        } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

// ═════════════════════════════════════════════════════════════════════
// 1. STRUCTURAL: Every outbox writer checks isNotificationsEnabled
// ═════════════════════════════════════════════════════════════════════

describe('GUARDRAIL: notification eligibility enforced at every outbox write site', () => {
    const allFiles = walkTs(SRC_ROOT);

    // Find files with outbox writes
    const outboxWriters = allFiles.filter(f => {
        const content = blankNonCode(readFileSync(f, 'utf8'));
        return content.includes('notificationOutbox.create');
    });

    test('at least 2 outbox write sites exist (sanity check)', () => {
        // If this drops to 0, the test is no longer guarding anything
        expect(outboxWriters.length).toBeGreaterThanOrEqual(2);
    });

    test.each(outboxWriters.map(f => [relative(SRC_ROOT, f), f]))(
        '%s: calls isNotificationsEnabled before writing to outbox',
        (_relPath, absPath) => {
            if (EXEMPT_FILES.some(e => absPath.includes(e))) return;

            const content = blankNonCode(readFileSync(absPath, 'utf8'));

            // The file must either:
            //   a) Import isNotificationsEnabled directly, OR
            //   b) Call a function that is known to gate on isNotificationsEnabled
            //      (i.e. enqueueEmail from enqueue.ts — but that file itself must check)
            const hasEligibilityImport = content.includes('isNotificationsEnabled');

            // For enqueue.ts specifically: it both defines and calls the check
            const isEnqueueFile = absPath.includes('enqueue.ts');
            const importsFromSettings =
                content.includes("from './settings'") ||
                content.includes("from '../notifications/settings'");

            const isGated = hasEligibilityImport && (importsFromSettings || isEnqueueFile);

            if (!isGated) {
                fail(
                    `${_relPath} writes to notificationOutbox but does not import/call isNotificationsEnabled.\n` +
                    `Every notification send path MUST check tenant notification eligibility.\n` +
                    `Fix: import { isNotificationsEnabled } from '../notifications/settings' and check before writing.`
                );
            }
        },
    );
});

// ═════════════════════════════════════════════════════════════════════
// 2. STRUCTURAL: settings.ts is the single source of truth
// ═════════════════════════════════════════════════════════════════════

describe('GUARDRAIL: isNotificationsEnabled is defined in settings.ts only', () => {
    test('isNotificationsEnabled is exported from settings.ts', () => {
        const settingsPath = resolve(SRC_ROOT, 'app-layer/notifications/settings.ts');
        const content = blankNonCode(readFileSync(settingsPath, 'utf8'));
        expect(content).toContain('export async function isNotificationsEnabled');
    });

    test('no other file re-defines isNotificationsEnabled', () => {
        const allFiles = walkTs(SRC_ROOT);
        const definers = allFiles.filter(f => {
            const content = blankNonCode(readFileSync(f, 'utf8'));
            return (
                content.includes('function isNotificationsEnabled') &&
                !f.includes('settings.ts')
            );
        });

        if (definers.length > 0) {
            fail(
                `isNotificationsEnabled is redefined outside settings.ts:\n` +
                definers.map(f => `  - ${relative(SRC_ROOT, f)}`).join('\n') +
                `\nKeep the single source of truth in settings.ts.`
            );
        }
    });

    test('notification module barrel re-exports isNotificationsEnabled', () => {
        const indexPath = resolve(SRC_ROOT, 'app-layer/notifications/index.ts');
        const content = blankNonCode(readFileSync(indexPath, 'utf8'));
        expect(content).toContain('isNotificationsEnabled');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. STRUCTURAL: digest-dispatcher uses shared eligibility path
// ═════════════════════════════════════════════════════════════════════

describe('GUARDRAIL: digest-dispatcher uses shared eligibility', () => {
    test('digest-dispatcher imports isNotificationsEnabled from settings', () => {
        const content = blankNonCode(readFileSync(
            resolve(SRC_ROOT, 'app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        ));
        expect(content).toContain("import { isNotificationsEnabled } from './settings'");
    });

    test('digest-dispatcher checks eligibility per tenant', () => {
        const content = blankNonCode(readFileSync(
            resolve(SRC_ROOT, 'app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        ));
        // Must check eligibility and skip disabled tenants
        expect(content).toContain('eligibleTenants');
        expect(content).toContain('isNotificationsEnabled(prisma, tenantId)');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. SCHEMA DRIFT GUARD: enum values must exist in migrations
// ═════════════════════════════════════════════════════════════════════

describe('GUARDRAIL: EmailNotificationType schema-migration alignment', () => {
    test('every EmailNotificationType value has a corresponding migration', () => {
        const schema = readPrismaSchema();

        const enumMatch = schema.match(
            /enum\s+EmailNotificationType\s*\{([^}]+)\}/,
        );
        expect(enumMatch).not.toBeNull();

        const schemaValues = enumMatch![1]
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('//'));

        // Read all migration SQL
        const migrationsDir = resolve(__dirname, '../../prisma/migrations');
        const dirs = readdirSync(migrationsDir).filter(d =>
            statSync(resolve(migrationsDir, d)).isDirectory(),
        );

        let allSql = '';
        for (const dir of dirs) {
            const sqlPath = resolve(migrationsDir, dir, 'migration.sql');
            try {
                // NOT blanked (#1774): SQL comments are `--`, and a `/* */`
                // in a migration is Postgres syntax a TS blanker would eat.
                // The assertions on `allSql` are about DDL, not code shape.
                allSql += readFileSync(sqlPath, 'utf8') + '\n';
            } catch {
                // Some dirs may not have migration.sql
            }
        }

        const unmigrated = schemaValues.filter(v => !allSql.includes(v));

        if (unmigrated.length > 0) {
            fail(
                `EmailNotificationType values exist in schema.prisma but not in any migration:\n` +
                unmigrated.map(v => `  - ${v}`).join('\n') + '\n' +
                `Run: npx prisma migrate dev --name add_<value>_enum\n` +
                `Or manually add: ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS '<value>';`
            );
        }
    });

    test('DigestCategory type in code is a subset of schema EmailNotificationType', () => {
        const schema = readPrismaSchema();
        const dispatcher = blankNonCode(readFileSync(
            resolve(SRC_ROOT, 'app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        ));

        const enumMatch = schema.match(
            /enum\s+EmailNotificationType\s*\{([^}]+)\}/,
        );
        const schemaValues = new Set(
            enumMatch![1].split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('//')),
        );

        const categoryMatch = dispatcher.match(
            /type\s+DigestCategory\s*=\s*([^;]+);/,
        );
        const codeValues = (categoryMatch![1].match(/'([^']+)'/g) || [])
            .map(v => v.replace(/'/g, ''));

        const notInSchema = codeValues.filter(v => !schemaValues.has(v));
        if (notInSchema.length > 0) {
            fail(
                `DigestCategory values not in EmailNotificationType enum:\n` +
                notInSchema.map(v => `  - ${v}`).join('\n') + '\n' +
                `Add these to the schema enum and create a migration.`
            );
        }
    });
});
