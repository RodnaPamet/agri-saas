import { redirect } from 'next/navigation';

/**
 * Epic 54 — `/practices/new` compatibility shim.
 *
 * Practice creation moved from a full-page form into a modal mounted
 * inside the Practices list (`src/.../practices/NewPracticeModal.tsx`). This
 * route still exists so bookmarks, "+ New Practice" deep links, and E2E
 * tests that `page.goto('/practices/new')` continue to work — they all
 * land on `/practices?create=1`, which `PracticesClient` detects on mount
 * and opens the modal automatically. The URL flag is then stripped so
 * subsequent back/forward doesn't re-open the modal unexpectedly.
 */
export default async function NewPracticeRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/practices?create=1`);
}
