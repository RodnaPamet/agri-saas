/**
 * Typed hooks for Practices domain.
 *
 * Usage:
 *   const { data: practices, loading } = usePractices();
 *   const { data: practice } = usePractice(practiceId);
 *   const { mutate: create } = useCreatePractice();
 */
'use client';

import { useCallback } from 'react';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useApi, useMutation } from './use-api';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import {
    PracticeListItemDTOSchema,
    PracticeDetailDTOSchema,
    type PracticeListItemDTO,
    type PracticeDetailDTO,
} from '@/lib/dto';
import { z } from 'zod';

const PracticeListSchema = z.array(PracticeListItemDTOSchema);

export function usePractices() {
    const apiUrl = useTenantApiUrl();
    return useApi<PracticeListItemDTO[]>(apiUrl('/practices'), PracticeListSchema);
}

export function usePractice(id: string | null | undefined) {
    const apiUrl = useTenantApiUrl();
    return useApi<PracticeDetailDTO>(
        id ? apiUrl(`/practices/${id}`) : null,
        PracticeDetailDTOSchema,
    );
}

export function useCreatePractice() {
    const apiUrl = useTenantApiUrl();
    return useMutation<Record<string, unknown>, PracticeDetailDTO>(
        useCallback((body: Record<string, unknown>) =>
            apiPost<PracticeDetailDTO>(apiUrl('/practices'), body), [apiUrl]),
    );
}

export function useUpdatePractice(id: string) {
    const apiUrl = useTenantApiUrl();
    return useMutation<Record<string, unknown>, PracticeDetailDTO>(
        useCallback((body: Record<string, unknown>) =>
            apiPatch<PracticeDetailDTO>(apiUrl(`/practices/${id}`), body), [apiUrl, id]),
    );
}

export function useDeletePractice() {
    const apiUrl = useTenantApiUrl();
    return useMutation<string, void>(
        useCallback((practiceId: string) =>
            apiDelete(apiUrl(`/practices/${practiceId}`)), [apiUrl]),
    );
}
