/**
 * Barrel export for typed domain hooks.
 *
 * Usage:
 *   import { useControls, usePolicy, useCreateRisk } from '@/lib/hooks';
 */

export { useApi, useMutation } from './use-api';
export type { UseApiResult, UseMutationResult } from './use-api';

export { useTenantSWR } from './use-tenant-swr';
export type { UseTenantSWROptions, UseTenantSWRResult } from './use-tenant-swr';

export { useTenantMutation } from './use-tenant-mutation';
export type {
    OptimisticUpdater,
    PopulateCacheFn,
    UseTenantMutationOptions,
    UseTenantMutationResult,
} from './use-tenant-mutation';

export {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
    useRegisteredShortcuts,
} from './use-keyboard-shortcut';
export type {
    RegisteredShortcut,
    ShortcutHandler,
    ShortcutInput,
    ShortcutScope,
    UseKeyboardShortcutOptions,
} from './use-keyboard-shortcut';

export { useControls, useControl, useControlDashboard, useCreateControl, useUpdateControl, useDeleteControl } from './use-controls';
export { usePolicies, usePolicy, useCreatePolicy, useUpdatePolicy, useDeletePolicy } from './use-policies';
export { useTasks, useTask, useCreateTask, useUpdateTask, useDeleteTask } from './use-tasks';
export { useAssets, useAsset, useCreateAsset, useUpdateAsset, useDeleteAsset } from './use-assets';
export { useEvidence, useEvidenceItem, useCreateEvidence, useDeleteEvidence } from './use-evidence';
