"use client";

/**
 * Epic P2-PR-C — "Where is this practice used?" modal.
 *
 * Opens from the Practice detail page's header actions and lists
 * every process map that gates an edge with this practice. Each
 * row deep-links to `/t/<slug>/processes?activeId=<mapId>` so the
 * user can jump to the map in the canvas.
 *
 * Why a modal (not a tab):
 *   - The practice detail page already carries 6 tabs (Overview /
 *     Evidence / Tests / Requirements / Risks / Comments). Adding
 *     a "Process Maps" tab would weight a low-frequency view on
 *     par with daily-use tabs.
 *   - A modal is the right disclosure level for "look up where
 *     this is referenced, then jump" — short read, return to the
 *     practice.
 *
 * Why read-only (no edit affordance here):
 *   - The picker on each map's canvas is the canonical write
 *     surface. The reverse-lookup modal is a navigation surface;
 *     edits stay where they live (P2-PR-A's edge picker).
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/icons/loading-spinner";

interface MapRef {
    mapId: string;
    mapName: string;
    mapStatus: string;
    edgeKey: string;
    edgeLabel: string | null;
}

export function PracticeReverseLookupModal({
    practiceId,
    tenantSlug,
    open,
    onOpenChange,
}: {
    practiceId: string;
    tenantSlug: string;
    open: boolean;
    onOpenChange: (next: boolean) => void;
}) {
    const t = useTranslations("practiceReverseLookup");
    const [maps, setMaps] = useState<MapRef[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Fetch lazily — only when the modal opens. Re-fetches
        // on every open so newly-created maps land without a
        // page reload.
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/practices/${practiceId}/process-maps`,
                );
                if (!res.ok) {
                    throw new Error(t("lookupFailed", { status: res.status }));
                }
                const body = (await res.json()) as { maps?: MapRef[] };
                if (cancelled) return;
                setMaps(body.maps ?? []);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : t("couldNotLoad"),
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // `t` is a stable next-intl binding; omitted so opening the modal
        // doesn't refetch on unrelated re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, tenantSlug, practiceId]);

    // Group rows by map — multiple edges within the same map
    // collapse into one row with a count.
    const groups: Array<{
        mapId: string;
        mapName: string;
        mapStatus: string;
        edgeCount: number;
    }> = (() => {
        if (!maps) return [];
        const m = new Map<
            string,
            { mapId: string; mapName: string; mapStatus: string; edgeCount: number }
        >();
        for (const row of maps) {
            const prev = m.get(row.mapId);
            if (prev) {
                prev.edgeCount += 1;
            } else {
                m.set(row.mapId, {
                    mapId: row.mapId,
                    mapName: row.mapName,
                    mapStatus: row.mapStatus,
                    edgeCount: 1,
                });
            }
        }
        return Array.from(m.values()).sort((a, b) =>
            a.mapName.localeCompare(b.mapName),
        );
    })();

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => onOpenChange(typeof next === "boolean" ? next : !open)}
            title={t("title")}
            description={t("description")}
        >
            <Modal.Header
                title={t("title")}
                description={t("description")}
            />
            <Modal.Body>
                <div
                    data-testid="practice-reverse-lookup-body"
                    className="flex flex-col gap-default"
                >
                    {loading && (
                        <div className="flex items-center gap-tight text-sm text-content-muted">
                            <LoadingSpinner /> {t("loading")}
                        </div>
                    )}
                    {!loading && error && (
                        <div
                            data-testid="practice-reverse-lookup-error"
                            className="text-sm text-danger-default"
                        >
                            {error}
                        </div>
                    )}
                    {!loading && !error && groups.length === 0 && (
                        <p
                            data-testid="practice-reverse-lookup-empty"
                            className="text-sm text-content-subtle"
                        >
                            {t("empty")}
                        </p>
                    )}
                    {!loading && !error && groups.length > 0 && (
                        <ul className="flex flex-col gap-tight">
                            {groups.map((g) => (
                                <li
                                    key={g.mapId}
                                    data-testid="practice-reverse-lookup-row"
                                    className="flex items-center justify-between rounded-[8px] border border-border-subtle px-default py-2"
                                >
                                    <div className="flex flex-col">
                                        <Link
                                            href={`/t/${tenantSlug}/processes?activeId=${g.mapId}`}
                                            className="text-sm font-medium text-content-emphasis hover:underline"
                                        >
                                            {g.mapName}
                                        </Link>
                                        <span className="text-[11px] text-content-subtle">
                                            {g.mapStatus} · {t("edgeCount", { count: g.edgeCount })}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        data-testid="practice-reverse-lookup-close"
                    >
                        {t("close")}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
