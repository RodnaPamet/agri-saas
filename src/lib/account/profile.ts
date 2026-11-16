/**
 * Self-service profile updates (UI roadmap 14b).
 *
 * The owner / assignee columns display the user's NAME (via
 * `ownerDisplayName`), falling back to the email local-part when no name is
 * set. This lets a user capture a real first + last name so those columns —
 * and the top-bar — read as a person, not a handle.
 *
 * `User.name` is a single (encrypted-at-rest) field, so first + last are
 * composed into one display string here rather than adding schema columns.
 */
import prisma from '@/lib/prisma';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest } from '@/lib/errors/types';

/**
 * Max length of the composed display name.
 *
 * Declared in `@/lib/schemas/profile-limits` — a leaf module — and re-exported
 * here so every existing importer is unchanged. It moved because this file
 * imports `@/lib/prisma`, and the shared schema barrel needs the bound: see
 * that module's docblock for the client-bundle failure that caused.
 */
// Imported AND re-exported: `export { X } from '…'` creates no local binding,
// and this module uses the bound two lines below.
import { DISPLAY_NAME_MAX } from '@/lib/schemas/profile-limits';

export { DISPLAY_NAME_MAX };

/**
 * Compose a single display name from first + last. Each part is
 * server-sanitised (strips any HTML/script) and trimmed; the result is the
 * space-joined non-empty parts. Throws `badRequest` if nothing usable remains
 * or the result exceeds the length cap.
 */
export function composeDisplayName(
    firstName?: string | null,
    lastName?: string | null,
): string {
    const first = sanitizePlainText(firstName ?? '').trim();
    const last = sanitizePlainText(lastName ?? '').trim();
    const name = [first, last].filter(Boolean).join(' ').trim();
    if (!name) {
        throw badRequest('Enter at least a first or last name.');
    }
    if (name.length > DISPLAY_NAME_MAX) {
        throw badRequest(`Name must be ${DISPLAY_NAME_MAX} characters or fewer.`);
    }
    return name;
}

/**
 * Update the authenticated user's own display name. Self-service only — the
 * caller passes their own `userId` from the session; there is no cross-user
 * write path. `User.name` is encrypted on write by the Epic B middleware.
 */
export async function updateOwnDisplayName(
    userId: string,
    firstName?: string | null,
    lastName?: string | null,
): Promise<{ name: string }> {
    const name = composeDisplayName(firstName, lastName);
    await prisma.user.update({ where: { id: userId }, data: { name } });
    return { name };
}
