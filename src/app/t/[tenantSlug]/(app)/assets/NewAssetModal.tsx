'use client';

/**
 * NewAssetModal — modal-form follow-up (assets-create was missed by
 * the original P2 which scoped assets-EDIT only). Mirrors
 * `<NewVendorModal>` exactly: shared `<NewAssetFields>` + unsaved-
 * changes guard + `Modal.Form` pinned-footer shell.
 */
import { type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { queryKeys } from '@/lib/queryKeys';
import { useNewAssetForm } from './_form/useNewAssetForm';
import {
    NewAssetFields,
    type NewAssetFieldsLabels,
} from './_form/NewAssetFields';

export interface NewAssetModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    labels: NewAssetFieldsLabels & {
        cancel: string;
        createAsset: string;
        addAsset: string;
    };
}

export function NewAssetModal({
    open,
    setOpen,
    tenantSlug,
    labels,
}: NewAssetModalProps) {
    const tenantHref = useTenantHref();
    const router = useRouter();
    const queryClient = useQueryClient();
    const t = useTranslations('assets');

    const form = useNewAssetForm({
        onSuccess: (asset) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.assets.all(tenantSlug),
            });
            setOpen(false);
            router.push(tenantHref(`/assets/${asset.id}`));
        },
    });

    // #2209 - the hand-rolled close guard is GONE, both halves of it.
    //
    //   - the DIRTY half is the Modal primitive's `isDirty` prop, which
    //     renders the design system's own <Confirm> on every dismiss (X,
    //     Escape, outside-click, mobile drag), mounted as a sibling of the
    //     surface so it stacks above it;
    //   - the SUBMITTING half is `preventDefaultClose`, which this modal
    //     already passed.
    //
    // So `setShowModal` goes straight to `setOpen`. This is the shape
    // `NewTaskModal` has had since mobile-forms PR-3, and it is what the two
    // guards grading this family require for a flow marked `guard: 'native'`
    // - they assert the wrapper is ABSENT, not merely thinned.
    const close = () => setOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void form.submit();
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={labels.addAsset}
            description={t('newAssetDescription')}
            preventDefaultClose={form.submitting}
            isDirty={form.isDirty}
        >
            <Modal.Header
                title={labels.addAsset}
                description={t('newAssetDescription')}
            />
            <Modal.Form id="new-asset-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-asset-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewAssetFields form={form} labels={labels} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="new-asset-cancel-btn"
                    >
                        {labels.cancel}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-asset-submit"
                    >
                        {form.submitting ? t('creating') : labels.createAsset}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
