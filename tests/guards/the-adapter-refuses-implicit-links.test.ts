/**
 * The adapter in `src/auth.ts` must be WRAPPED, not bare.
 *
 * `refuseImplicitAccountLinks` has its own suite proving it refuses an
 * implicit link and still serves a first-time signup. None of that protects
 * anybody if `authOptions.adapter` goes back to a bare `PrismaAdapter(prisma)`
 * — the module would keep passing its tests while next-auth linked an unseen
 * provider identity to whoever the session cookie names.
 *
 * That is this repo's recurring shape: a mechanism with a thorough suite and
 * an enforcement point with nothing. `platform-support-route-gate.test.ts`
 * exists for the same reason, and its docblock records that commenting out
 * both gate calls left 2173/2173 tests green.
 *
 * Comments are blanked before matching. A docblock that merely NAMES the
 * wrapper would otherwise satisfy a guard about whether it is called — the
 * inverse of the failure this exists to catch, and one several guards in this
 * repo have already had.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const AUTH = path.resolve(__dirname, '../../src/auth.ts');

describe('authOptions.adapter refuses implicit OAuth links', () => {
    const code = blankNonCode(fs.readFileSync(AUTH, 'utf8'));

    it('control: the file was read and its adapter key is present in CODE', () => {
        expect(code).toMatch(/adapter:/);
        // Positive control on the stripper: the docblock prose is gone while
        // the declaration survives, so a later match means code, not comment.
        expect(code).not.toMatch(/next-auth 4 links an UNSEEN OAuth identity/);
    });

    it('calls refuseImplicitAccountLinks around the Prisma adapter', () => {
        // The CALL, not the import: an unused import satisfies nothing.
        expect(code).toMatch(/refuseImplicitAccountLinks\s*\(/);
        const adapterBlock = /adapter:\s*([\s\S]{0,200})/.exec(code)?.[1] ?? '';
        expect(adapterBlock).toMatch(/refuseImplicitAccountLinks\s*\(/);
        expect(adapterBlock).toMatch(/PrismaAdapter\s*\(\s*prisma\s*\)/);
    });

    it('does not hand a BARE PrismaAdapter to the adapter key', () => {
        // The exact regression: `adapter: PrismaAdapter(prisma) as ...`.
        expect(code).not.toMatch(/adapter:\s*PrismaAdapter\s*\(/);
    });

    it('sets allowDangerousEmailAccountLinking on no provider', () => {
        // The other way an unseen identity reaches an existing user. Off
        // today, and the refusal above does not cover it: that flag makes
        // next-auth take the email-match branch instead.
        expect(code).not.toMatch(/allowDangerousEmailAccountLinking/);
    });
});
