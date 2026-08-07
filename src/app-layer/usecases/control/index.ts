/**
 * Control usecase barrel export.
 *
 * All public functions are re-exported here so existing imports
 * from '@/app-layer/usecases/control' continue to work unchanged.
 */
export {
    listControls,
    listControlsPaginated,
    getControl,
    getControlHeader,
    getControlActivity,
    getControlDashboard,
    runConsistencyCheck,
    listControlsWithDeleted,
} from './queries';

export {
    createControl,
    updateControl,
    setControlStatus,
    setControlApplicability,
    setControlOwner,
    markControlTestCompleted,
    deleteControl,
    bulkDeleteControl,
    restoreControl,
    purgeControl,
} from './mutations';

export {
    listControlTasks,
    createControlTask,
    updateControlTask,
    deleteControlTask,
} from './tasks';

export {
    listEvidenceLinks,
    getControlEvidenceTab,
    linkEvidence,
    unlinkEvidence,
    linkAssetToControl,
    unlinkAssetFromControl,
} from './evidence';

// Page-data orchestration (collapses control + sync waterfall on detail page)
export { getControlPageData, type ControlPageDataPayload, type SyncStatusPayload } from './page-data';

// Requirement ↔ control mapping (survivor of the removed template library)
export {
    listFrameworkRequirements,
    mapRequirementToControl,
    unmapRequirementFromControl,
    listControlMappings,
} from './requirements';
