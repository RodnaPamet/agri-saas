/**
 * The MFA enrolment QR is a real code, and the otpauth link is a real anchor.
 *
 * The page used to render `lucide-react`'s `QrCode` ICON — a picture of a QR
 * code, on a white card, at enrolment-QR size, in exactly the right place. It
 * looked finished in a browser and in a screenshot, and it could not be
 * scanned. `otpauthUrl` was declared in the props type and never referenced:
 * the server computed it and the page dropped it (#1646).
 *
 * Nothing could have caught that. `tsc` is happy — both modules export a
 * component called `QrCode` and both accept a `className`. The only
 * difference is whether the thing on screen encodes anything, which no type
 * and no render test asserts.
 *
 * So this guard is about PROVENANCE: which module the component came from,
 * and whether the URI reaches it. Three things it pins:
 *
 *   1. the scannable component is imported from `@/components/ui/qr-code`;
 *   2. `otpauthUrl` is passed to it, rather than declared and dropped;
 *   3. the hand-off is a plain `<a href>`.
 *
 * (3) is not a style preference. agrent-ios verified the hand-off from inside
 * `ASWebAuthenticationSession` with a plain anchor tap and explicitly did NOT
 * test a scripted `location` change — so an `onClick` that navigates would be
 * an untested path for the one case the link exists to serve, a person sent
 * here from the native sign-in sheet who has no second device to scan with.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const PAGE = 'src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx';

/** Comments blanked: this file's own comments quote the old icon usage. */
const code = (): string =>
    blankNonCode(fs.readFileSync(path.join(REPO_ROOT, PAGE), 'utf8'));

describe('the MFA enrolment QR is scannable (#1646)', () => {
    it('imports the scannable component, not only the icon', () => {
        const src = code();
        expect(src).toMatch(/import \{\s*QrCode\s*\} from '@\/components\/ui\/qr-code'/);
    });

    it('does not import lucide’s QrCode under the bare name', () => {
        // The collision is the whole cause. Aliased (`QrCode as QrCodeIcon`)
        // is fine and is what the status-card button wants; unaliased means
        // the icon is shadowing the real component again.
        const src = code();
        const lucide = src.match(/import \{([^}]*)\} from 'lucide-react'/)?.[1] ?? '';
        expect(lucide).toContain('QrCode as ');
        expect(lucide).not.toMatch(/(^|,)\s*QrCode\s*(,|$)/);
    });

    it('passes otpauthUrl to the QR, rather than declaring it and dropping it', () => {
        const src = code();
        // Declared in the props type is not enough — that was true before.
        expect(src).toMatch(/value=\{enrollment\.otpauthUrl\}/);
    });

    it('offers the hand-off as a plain anchor', () => {
        const src = code();
        expect(src).toMatch(/<a\s[^>]*href=\{enrollment\.otpauthUrl\}/);
    });

    it('control: the lucide-alias check REJECTS the shape that caused this', () => {
        // Teeth. Without this, the assertion above passes on any import list
        // containing the substring "QrCode as " — including the original one
        // if someone adds an alias for a different icon.
        const original = "import { ShieldCheck, QrCode, Copy, X } from 'lucide-react';";
        const lucide = original.match(/import \{([^}]*)\} from 'lucide-react'/)?.[1] ?? '';
        expect(lucide).not.toContain('QrCode as ');
        expect(lucide).toMatch(/(^|,)\s*QrCode\s*(,|$)/);
    });

    it('both locales carry the link’s copy', () => {
        // A missing key renders the key name as the link text, which is worse
        // than no link: it looks like a bug the farmer caused.
        for (const loc of ['en', 'bg']) {
            const messages = JSON.parse(
                fs.readFileSync(path.join(REPO_ROOT, `messages/${loc}.json`), 'utf8'),
            ) as { mfa: { enroll: Record<string, string> } };
            expect(messages.mfa.enroll.openInAuthenticator).toBeTruthy();
        }
    });
});
