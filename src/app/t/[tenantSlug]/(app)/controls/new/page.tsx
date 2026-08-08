import { redirect } from 'next/navigation';

/**
 * Epic 54 — `/controls/new` compatibility shim.
 *
 * Control creation moved from a full-page form into a modal mounted
 * inside the Controls list (`src/.../controls/NewControlModal.tsx`). This
 * route still exists so bookmarks, "+ New Control" deep links, and E2E
 * tests that `page.goto('/controls/new')` continue to work — they all
 * land on `/controls?create=1`, which `ControlsClient` detects on mount
 * and opens the modal automatically. The URL flag is then stripped so
 * subsequent back/forward doesn't re-open the modal unexpectedly.
 */
export default async function NewControlRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/controls?create=1`);
}
