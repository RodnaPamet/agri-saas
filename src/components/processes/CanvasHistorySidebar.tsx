"use client";

/**
 * Epic P5-PR-A + P5-PR-B — Canvas version-history sidebar.
 *
 * Lists every committed snapshot of the active process map,
 * descending by version. Each row carries the version number, a
 * relative timestamp, the author's display name, AND (P5-PR-B)
 * "Diff" + "Restore" action buttons.
 *
 *   - **Diff** fires `onDiffRequest(version)` which the canvas
 *     uses to mount a read-only overlay comparing the snapshot
 *     to the current state via `computeCanvasDiff`.
 *   - **Restore** POSTs the snapshot's graphJson back through
 *     `replaceGraph` (preserving history — the restored state
 *     becomes its own new snapshot).
 *
 * Mount: inside the page tree, opt-in via the canonical
 * `<AsidePanel>` primitive.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AsidePanel } from "@/components/ui/aside-panel";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/icons/loading-spinner";
import { useToast } from "@/components/ui/hooks";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDateTime } from "@/lib/format-date";

interface SnapshotRow {
    id: string;
    version: number;
    createdAt: string;
    createdByName: string | null;
}

export function CanvasHistorySidebar({
    tenantSlug,
    mapId,
    currentVersion,
    onDiffRequest,
    onRestored,
}: {
    tenantSlug: string;
    /** Active process map id; null when nothing is loaded. */
    mapId: string | null;
    /** Server's current version — flags the "current" snapshot. */
    currentVersion?: number | null;
    /**
     * Epic P5-PR-B — Diff action callback. Fires with the target
     * version when the user clicks "Diff"; the canvas mounts the
     * read-only overlay.
     */
    onDiffRequest?: (version: number) => void;
    /**
     * Epic P5-PR-B — Restore success callback. Fires AFTER the
     * server commits the restore so the canvas can re-fetch +
     * re-render at the new post-restore version.
     */
    onRestored?: () => void;
}) {
    const t = useTranslations("ui");
    const toast = useToast();
    const [restoringVersion, setRestoringVersion] = useState<number | null>(
        null,
    );

    /**
     * Which version is awaiting confirmation (#2209).
     *
     * NOT a discard-guard like the six modal ones: restoring a snapshot
     * REPLACES the canvas's current state, so this is an action confirmation
     * and takes a real `ConfirmDialog`. `tone="warning"` rather than
     * `danger` because it is recoverable — the state being replaced is itself
     * a version you can restore back to.
     *
     * The version is captured here rather than read at confirm time: the
     * version list refetches while the dialog is open.
     */
    const [pendingRestore, setPendingRestore] = useState<number | null>(null);

    const handleRestore = async (targetVersion: number) => {
        if (!mapId || currentVersion == null) return;
        setRestoringVersion(targetVersion);
        try {
            const res = await fetch(
                `/api/t/${tenantSlug}/processes/${mapId}/snapshots/${targetVersion}/restore`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ expectedVersion: currentVersion }),
                },
            );
            if (!res.ok) {
                throw new Error(`Restore failed (${res.status})`);
            }
            toast.success(t("canvasHistory.restored", { version: targetVersion }));
            onRestored?.();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : t("canvasHistory.restoreFailed"),
            );
        } finally {
            setRestoringVersion(null);
        }
    };
    const [rows, setRows] = useState<SnapshotRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!mapId) {
            setRows(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/processes/${mapId}/snapshots`,
                );
                if (!res.ok) {
                    throw new Error(`History load failed (${res.status})`);
                }
                const body = (await res.json()) as {
                    snapshots?: SnapshotRow[];
                };
                if (cancelled) return;
                setRows(body.snapshots ?? []);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : t("canvasHistory.couldNotLoad"),
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // currentVersion changes on every save — refetch then so
        // the new snapshot lands at the top without a manual
        // refresh.
    }, [tenantSlug, mapId, currentVersion, t]);

    return (
        <AsidePanel
            title={t("canvasHistory.title")}
            surfaceKey="processes-history"
        >
            <div
                data-testid="canvas-history-sidebar"
                className="flex flex-col gap-default"
            >
                {loading && (
                    <div className="flex items-center gap-tight text-sm text-content-muted">
                        <LoadingSpinner /> {t("canvasHistory.loading")}
                    </div>
                )}
                {!loading && error && (
                    <div
                        data-testid="canvas-history-error"
                        className="text-sm text-danger-default"
                    >
                        {error}
                    </div>
                )}
                {!loading && !error && rows !== null && rows.length === 0 && (
                    <p
                        data-testid="canvas-history-empty"
                        className="text-sm text-content-subtle"
                    >
                        {t("canvasHistory.emptyVersions")}
                    </p>
                )}
                {!loading && !error && rows !== null && rows.length > 0 && (
                    <ul className="flex flex-col gap-tight">
                        {rows.map((r) => {
                            const isCurrent = r.version === currentVersion;
                            return (
                                <li
                                    key={r.id}
                                    data-testid="canvas-history-row"
                                    data-version={r.version}
                                    className="flex flex-col rounded-[8px] border border-border-subtle px-default py-2"
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium text-content-emphasis">
                                            v{r.version}
                                        </span>
                                        {isCurrent && (
                                            <span
                                                className="text-[10px] uppercase tracking-wide text-brand-default"
                                                data-testid="canvas-history-current"
                                            >
                                                {t("canvasHistory.current")}
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-[11px] text-content-subtle">
                                        {formatDateTime(r.createdAt)}
                                        {r.createdByName
                                            ? ` · ${r.createdByName}`
                                            : ""}
                                    </span>
                                    {/* Epic P5-PR-B — action buttons.
                                        Diff: mounts the overlay vs current.
                                        Restore: writes the snapshot's
                                        graphJson back via replaceGraph. */}
                                    {!isCurrent && (
                                        <div className="mt-1 flex items-center gap-tight">
                                            <Button
                                                variant="secondary"
                                                size="xs"
                                                onClick={() =>
                                                    onDiffRequest?.(r.version)
                                                }
                                                disabled={!onDiffRequest}
                                                data-testid="canvas-history-diff"
                                            >
                                                {t("canvasHistory.diff")}
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="xs"
                                                onClick={() =>
                                                    setPendingRestore(r.version)
                                                }
                                                disabled={
                                                    restoringVersion !== null ||
                                                    currentVersion == null
                                                }
                                                data-testid="canvas-history-restore"
                                            >
                                                {restoringVersion === r.version
                                                    ? t("canvasHistory.restoring")
                                                    : t("canvasHistory.restore")}
                                            </Button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            {pendingRestore !== null ? (
                <ConfirmDialog
                    showModal
                    setShowModal={() => setPendingRestore(null)}
                    tone="warning"
                    title={t("canvasHistory.restoreConfirmTitle", {
                        version: pendingRestore,
                    })}
                    description={t("canvasHistory.restoreConfirm", {
                        version: pendingRestore,
                    })}
                    confirmLabel={t("canvasHistory.restore")}
                    onConfirm={async () => {
                        const version = pendingRestore;
                        setPendingRestore(null);
                        await handleRestore(version);
                    }}
                />
            ) : null}
        </AsidePanel>
    );
}
