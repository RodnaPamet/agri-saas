/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked in #2736. */
import { PaginationState } from "@tanstack/react-table";
import { useEffect, useState } from "react";

export function useTablePagination({
  pageSize,
  page,
  onPageChange,
}: {
  pageSize: number;
  page: number;
  onPageChange?: (page: number) => void;
}) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: page,
    pageSize,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPagination((p) => ({
      ...p,
      pageIndex: page,
    }));
  }, [page]);

  useEffect(() => {
    onPageChange?.(pagination.pageIndex);
  }, [pagination]);

  return { pagination, setPagination };
}
