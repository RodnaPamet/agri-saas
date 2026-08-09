/**
 * Typed hooks for Controls domain.
 *
 * Usage:
 *   const { data: controls, loading } = useControls();
 *   const { data: control } = useControl(controlId);
 *   const { mutate: create } = useCreateControl();
 */
'use client';

import { useCallback } from 'react';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useApi, useMutation } from './use-api';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import {
    ControlListItemDTOSchema,
    ControlDetailDTOSchema,
    type ControlListItemDTO,
    type ControlDetailDTO,
} from '@/lib/dto';
import { z } from 'zod';

const ControlListSchema = z.array(ControlListItemDTOSchema);

export function useControls() {
    const apiUrl = useTenantApiUrl();
    return useApi<ControlListItemDTO[]>(apiUrl('/controls'), ControlListSchema);
}

export function useControl(id: string | null | undefined) {
    const apiUrl = useTenantApiUrl();
    return useApi<ControlDetailDTO>(
        id ? apiUrl(`/controls/${id}`) : null,
        ControlDetailDTOSchema,
    );
}

export function useCreateControl() {
    const apiUrl = useTenantApiUrl();
    return useMutation<Record<string, unknown>, ControlDetailDTO>(
        useCallback((body: Record<string, unknown>) =>
            apiPost<ControlDetailDTO>(apiUrl('/controls'), body), [apiUrl]),
    );
}

export function useUpdateControl(id: string) {
    const apiUrl = useTenantApiUrl();
    return useMutation<Record<string, unknown>, ControlDetailDTO>(
        useCallback((body: Record<string, unknown>) =>
            apiPatch<ControlDetailDTO>(apiUrl(`/controls/${id}`), body), [apiUrl, id]),
    );
}

export function useDeleteControl() {
    const apiUrl = useTenantApiUrl();
    return useMutation<string, void>(
        useCallback((controlId: string) =>
            apiDelete(apiUrl(`/controls/${controlId}`)), [apiUrl]),
    );
}
