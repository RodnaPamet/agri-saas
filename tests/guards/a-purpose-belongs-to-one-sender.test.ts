import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

/**
 * `OutboundPurpose` is what a delivery webhook dispatches on (#1769): it reads
 * a bounced message's row, and the purpose tells it which table to act on —
 * clear `ContentReport.alertedAt`, or mark a `TenantInvite` undeliverable.
 *
 * That makes a REUSED purpose a correctness bug rather than untidiness. If a
 * second sender adopts 'invite' for its own mail, a bounce from that sender
 * marks an unrelated invite undeliverable, and the webhook has no way to tell
 * the two apart — the row it reads looks identical. The compiler cannot see
 * this: every member of the union is a legal value at every call site, so
 * `purpose: 'invite'` in a brand-new file typechecks perfectly.
 *
 * So the pairing is asserted here, in both directions:
 *   - every purpose has a sender  → a member deleted with its sender, or
 *                                   added in anticipation, is caught
 *   - every purpose has ONE sender → reuse is caught
 */
const SRC = path.join(__dirname, '..', '..', 'src');
const MAILER = path.join(SRC, 'lib', 'mailer.ts');

/** The union's members, read from the declaration rather than duplicated. */
function declaredPurposes(): string[] {
    const src = blankNonCode(readFileSync(MAILER, 'utf8'));
    const decl = /export type OutboundPurpose =([^;]+);/.exec(src);
    if (!decl) throw new Error('OutboundPurpose declaration not found in src/lib/mailer.ts');
    const members = [...decl[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    if (members.length === 0) throw new Error('OutboundPurpose parsed as empty');
    return members;
}

/** file -> purposes it passes, comments blanked so a docblock is not a sender. */
function sendersByPurpose(): Map<string, string[]> {
    const byPurpose = new Map<string, string[]>();
    // `collectSourceFiles`, not a hand-rolled walk: it refuses an empty
    // result. A collector that silently returns nothing would make every
    // assertion below pass while checking no senders at all, which is the
    // failure mode `file-collection-is-not-silently-empty` exists to stop.
    // The floor is near the real population so an over-eager skip is caught
    // too, not just a total emptiness.
    for (const file of collectSourceFiles({ roots: ['src'], floor: 2000 })) {
        if (path.resolve(file) === path.resolve(MAILER)) continue;
        const code = blankNonCode(readFileSync(file, 'utf8'));
        for (const m of code.matchAll(/\bpurpose:\s*'([a-z-]+)'/g)) {
            const rel = path.relative(SRC, file);
            const files = byPurpose.get(m[1]) ?? [];
            if (!files.includes(rel)) files.push(rel);
            byPurpose.set(m[1], files);
        }
    }
    return byPurpose;
}

describe('an outbound purpose belongs to exactly one sender', () => {
    const declared = declaredPurposes();
    const senders = sendersByPurpose();

    it('covers every declared purpose, and says how many', () => {
        // The denominator, so a shrunken union cannot make this vacuous.
        expect(declared.length).toBeGreaterThanOrEqual(9);
        console.log(
            `[purpose-ownership] ${declared.length} purposes declared, ` +
                `${[...senders.keys()].length} with a sender in src/`,
        );
    });

    it('has a sender for every declared purpose', () => {
        const orphans = declared.filter((p) => !senders.has(p));
        expect(orphans).toEqual([]);
    });

    it('never lets two modules share a purpose', () => {
        const shared = [...senders.entries()]
            .filter(([, files]) => files.length > 1)
            .map(([purpose, files]) => `${purpose} <- ${files.join(', ')}`);
        expect(shared).toEqual([]);
    });

    it('declares every purpose that a sender passes', () => {
        // The reverse direction. tsc already rejects an undeclared literal at
        // a `sendEmail` call, but a `purpose:` on some other object shape is
        // invisible to it — and would read as a sender to the webhook author.
        const undeclared = [...senders.keys()].filter((p) => !declared.includes(p));
        expect(undeclared).toEqual([]);
    });
});
