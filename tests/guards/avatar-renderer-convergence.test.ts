/**
 * Avatar roadmap, P1 — one avatar renderer.
 *
 * `<InitialsAvatar>` (`src/components/ui/initials-avatar.tsx`) is the
 * single avatar primitive. Before P1, two surfaces still hand-rolled
 * their own initials circle:
 *   - `admin/members` — a `rounded-full` circle + `.charAt(0)`.
 *   - `user-combobox` — carried `image` in its data shape but
 *     rendered no avatar at all.
 *
 * P1 routes both through `<InitialsAvatar>`. Converging on one
 * renderer is the precondition for the rest of the avatar roadmap:
 * when P2 adds image-backed rendering it lands in ONE component and
 * every converged surface upgrades for free.
 *
 * This ratchet locks the two P1 conversions. It does NOT police every
 * avatar in the app — the Practices / Policies owner-column circles
 * use a different (neutral) visual tone and are a deliberate,
 * separately-scoped follow-up.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const MEMBERS_PATH =
    'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx';
const USER_COMBOBOX_PATH = 'src/components/ui/user-combobox.tsx';
const AVATAR_PATH = 'src/components/ui/initials-avatar.tsx';

describe('Avatar renderer convergence (avatar roadmap P1)', () => {
    it('admin/members renders identity through <InitialsAvatar>', () => {
        const src = read(MEMBERS_PATH);
        expect(src).toMatch(
            /import\s*\{\s*InitialsAvatar\s*\}\s*from\s*['"]@\/components\/ui\/initials-avatar['"]/,
        );
        expect(src).toMatch(/<InitialsAvatar\b/);
        // The hand-rolled circle is gone — no `(name || email).charAt(0)`
        // avatar glyph in the members table.
        expect(src).not.toMatch(
            /\.user\.name\s*\|\|\s*m\.user\.email\)\.charAt\(0\)/,
        );
    });

    it('user-combobox renders identity through <InitialsAvatar>', () => {
        const src = read(USER_COMBOBOX_PATH);
        expect(src).toMatch(
            /import\s*\{\s*InitialsAvatar\s*\}\s*from\s*['"]@\/components\/ui\/initials-avatar['"]/,
        );
        // The people-picker projects an avatar into each option via
        // the shared primitive (the Combobox `icon` slot).
        expect(src).toMatch(/<InitialsAvatar\b/);
    });

    it('<InitialsAvatar> is the one home — exports the shared primitive', () => {
        const src = read(AVATAR_PATH);
        expect(src).toMatch(/export function InitialsAvatar\(/);
        expect(src).toMatch(/export function getInitials\(/);
    });
});

/**
 * Avatar roadmap, P2 — image-backed avatars.
 *
 * `<InitialsAvatar>` gains an optional `imageUrl`: it renders the
 * image clipped to the circle with the initials as the always-present
 * fallback (shown on a missing URL or an `onError` load failure).
 * The two P1-converged surfaces now feed it `User.image`.
 */
describe('Image-backed avatars (avatar roadmap P2)', () => {
    it('<InitialsAvatar> accepts imageUrl and renders an <img> with a fallback', () => {
        const src = read(AVATAR_PATH);
        // A client component now — it holds load-failure state.
        expect(src).toMatch(/^'use client';/);
        expect(src).toMatch(/imageUrl\?:\s*string\s*\|\s*null/);
        expect(src).toMatch(/<img\b/);
        // The image must degrade to initials on load failure — never a
        // broken-image glyph.
        expect(src).toMatch(/onError=/);
    });

    it('admin/members feeds User.image to the avatar', () => {
        const src = read(MEMBERS_PATH);
        expect(src).toMatch(/<InitialsAvatar[\s\S]*?imageUrl=\{m\.user\.image\}/);
    });

    it('user-combobox feeds User.image to the avatar', () => {
        const src = read(USER_COMBOBOX_PATH);
        expect(src).toMatch(/<InitialsAvatar[\s\S]*?imageUrl=\{member\.image\}/);
    });
});

/**
 * Avatar roadmap, P3 — the upload flow.
 *
 * An account/profile page + a self-service upload/serve API let a
 * user set a real photo. The image is resized + EXIF-stripped +
 * webp-encoded client-side; the server validates (magic-number sniff
 * + size cap) and persists it, pointing `User.image` at a stable,
 * provider-agnostic serve route.
 */
describe('Avatar upload flow (avatar roadmap P3)', () => {
    const AVATAR_LIB = 'src/lib/account/avatar.ts';
    const UPLOAD_ROUTE = 'src/app/api/account/avatar/route.ts';
    const SERVE_ROUTE = 'src/app/api/account/avatar/[userId]/route.ts';
    const PROFILE_PAGE = 'src/app/account/profile/page.tsx';
    const UPLOAD_FIELD = 'src/app/account/profile/AvatarUploadField.tsx';

    it('the avatar lib validates the bytes and caps the size', () => {
        const src = read(AVATAR_LIB);
        // Magic-number sniff is the trust boundary — never store
        // unvalidated bytes.
        expect(src).toMatch(/export function isWebp\(/);
        expect(src).toMatch(/AVATAR_MAX_BYTES/);
        // It persists through the storage abstraction, never a raw fs
        // write, and points User.image at the serve URL.
        expect(src).toMatch(/getStorageProvider\(\)/);
        expect(src).toMatch(/prisma\.user\.update/);
    });

    it('upload/delete is self-service — own session user only, no requirePermission', () => {
        const src = read(UPLOAD_ROUTE);
        expect(src).toMatch(/export const POST =/);
        expect(src).toMatch(/export const DELETE =/);
        expect(src).toMatch(/getServerSession/);
        // Acts on the session user id — never a caller-supplied id —
        // so one user cannot write another's avatar.
        expect(src).toMatch(/session\.user\.id/);
        // No `requirePermission(...)` call — self-service, not a
        // tenant-privileged route. (Matches the call, not the bare
        // word, so the rationale comment can still name it.)
        expect(src).not.toMatch(/requirePermission\s*\(/);
    });

    it('the serve route streams a stored avatar behind auth', () => {
        const src = read(SERVE_ROUTE);
        expect(src).toMatch(/export const GET =/);
        expect(src).toMatch(/getServerSession/);
        // Async-params contract (Next 15+).
        expect(src).toMatch(/params:\s*Promise</);
        expect(src).toMatch(/getAvatarStream/);
    });

    it('the account/profile page mounts the upload field', () => {
        const page = read(PROFILE_PAGE);
        expect(page).toMatch(/<AvatarUploadField/);
        const field = read(UPLOAD_FIELD);
        // The client field renders identity through the shared
        // primitive and resizes via canvas before upload.
        expect(field).toMatch(/<InitialsAvatar/);
        expect(field).toMatch(/canvas/i);
        expect(field).toMatch(/image\/webp/);
    });
});

/**
 * Avatar roadmap, P4 — surface the avatar in the chrome.
 *
 * The top-bar user menu was the last hand-rolled initials surface.
 * P4 threads the user's photo URL through `<AppShell>` → `<TopChrome>`
 * → `<UserMenu>` and converts the menu's avatar trigger to the shared
 * `<InitialsAvatar>` — finally one renderer everywhere, with image
 * support reaching the chrome for free.
 */
describe('Avatar in the chrome (avatar roadmap P4)', () => {
    const USER_MENU = 'src/components/layout/user-menu.tsx';
    const TOP_CHROME = 'src/components/layout/TopChrome.tsx';
    const APP_SHELL = 'src/components/layout/AppShell.tsx';
    const TENANT_LAYOUT =
        'src/app/t/[tenantSlug]/(app)/layout.tsx';
    const ORG_LAYOUT = 'src/app/org/[orgSlug]/layout.tsx';

    it('UserMenu renders the trigger through <InitialsAvatar> with imageUrl', () => {
        const src = read(USER_MENU);
        expect(src).toMatch(
            /import\s*\{[^}]*\bInitialsAvatar\b/,
        );
        expect(src).toMatch(/displayImage:\s*string\s*\|\s*null/);
        expect(src).toMatch(
            /<InitialsAvatar[\s\S]*?imageUrl=\{displayImage\}/,
        );
        // The per-component `<span>{getInitials(...)}</span>` is gone.
        expect(src).not.toMatch(/getInitials\(effectiveName\)/);
    });

    it('TopChrome carries `image` on its user prop and threads it to UserMenu', () => {
        const src = read(TOP_CHROME);
        expect(src).toMatch(/image\?:\s*string\s*\|\s*null/);
        expect(src).toMatch(/displayImage=\{user\.image\s*\?\?\s*null\}/);
    });

    it('AppShellUser carries `image`', () => {
        const src = read(APP_SHELL);
        expect(src).toMatch(/image\?:\s*string\s*\|\s*null/);
    });

    it('both server layouts feed session.user.image into the shell', () => {
        for (const path of [TENANT_LAYOUT, ORG_LAYOUT]) {
            const src = read(path);
            expect(src).toMatch(/image:\s*session\.user\.image/);
        }
    });
});
