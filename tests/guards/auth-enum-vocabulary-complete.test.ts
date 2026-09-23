/**
 * Every tenant role and membership status has a label, in both locales.
 *
 * `admin/members` rendered `{m.role}` and `{row.original.status}` — the RAW
 * ENUM — so a Bulgarian admin read "OWNER" and "ACTIVE" on a screen that is
 * otherwise fully translated. There was no vocabulary to reach for: three crop
 * vocabularies exist in `messages/`, and zero for the role a person holds.
 *
 * The labels now live under `authEnums.role.*` and
 * `authEnums.membershipStatus.*`, and this derives what they must contain from
 * the PRISMA SCHEMA rather than from a copy of the list. The failure it exists
 * to prevent is the one that always happens to enum vocabularies: a seventh
 * role is added, nothing renders it in Bulgarian, and nobody notices because
 * the live tenant only ever holds two of them.
 *
 * That last part is not hypothetical — the native client reported this tenant
 * returning only ADMIN and OWNER, and treated it as a sample rather than the
 * set precisely because it had been caught by a `LogEntryType` that held two
 * of ten in production.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The members of a Prisma enum.
 *
 * Reads through `readPrismaSchema()` rather than walking the schema folder by
 * hand — a hand-rolled collector can be gutted to return nothing with every
 * assertion built on it still green, which is the whole subject of
 * `file-collection-is-not-silently-empty`. I wrote one anyway; the union of
 * this branch with the others is what caught it.
 */
function prismaEnum(name: string): string[] {
    const src = readPrismaSchema();
    const m = src.match(new RegExp(`^enum ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
    if (!m) {
        throw new Error(
            `enum ${name} not found in the Prisma schema. If it was renamed, this ` +
                `guard is protecting nothing — update it in the same change.`,
        );
    }
    return m[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

function messages(locale: string): Record<string, Record<string, string>> {
    const raw = fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8');
    return JSON.parse(raw).authEnums;
}

const CASES = [
    { enumName: 'Role', key: 'role', minMembers: 6 },
    { enumName: 'MembershipStatus', key: 'membershipStatus', minMembers: 4 },
] as const;

describe('authEnums covers every role and status', () => {
    it('the schema is actually being read (positive control)', () => {
        // An empty enum satisfies every "for each" below, so without this the
        // guard would pass loudest exactly when the parser broke.
        for (const { enumName, minMembers } of CASES) {
            const members = prismaEnum(enumName);
            expect(members.length).toBeGreaterThanOrEqual(minMembers);
        }
        expect(prismaEnum('Role')).toContain('MECHANISATOR');
        // The member PARITY.md missed and production has never shown.
        expect(prismaEnum('MembershipStatus')).toContain('REMOVED');
    });

    for (const locale of ['en', 'bg']) {
        for (const { enumName, key } of CASES) {
            it(`${locale}: every ${enumName} member has a label`, () => {
                const members = prismaEnum(enumName);
                const labels = messages(locale)?.[key] ?? {};
                const missing = members.filter((m) => !labels[m]);
                const orphan = Object.keys(labels).filter((k) => !members.includes(k));
                expect({ missing, orphan }).toEqual({ missing: [], orphan: [] });
            });
        }
    }

    it('bg is not just en pasted across', () => {
        // The untranslated-copy check the i18n guards apply globally, stated
        // here too because this namespace is small enough to be pasted in one
        // careless edit and large enough to matter on an admin screen.
        for (const { key } of CASES) {
            const en = messages('en')[key];
            const bg = messages('bg')[key];
            const identical = Object.keys(en).filter((k) => en[k] === bg[k]);
            expect(identical).toEqual([]);
        }
    });
});
