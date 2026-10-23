'use client';

/**
 * EditAssetModal — modal-form P2 execution.
 *
 * Unlike the three create modals (which the list page opens via
 * `?create=1`), the asset edit modal mounts from the asset DETAIL
 * page header. The detail page URL stays canonical; the modal is a
 * pure overlay launched from the "Edit" button.
 *
 * Composes the P1-extracted `useEditAssetForm` hook + `<EditAssetFields>`
 * markup. The hook seeds from the loaded asset row and PATCHes back;
 * on success the modal closes and the parent's `onSaved` callback
 * applies the updated row to the detail-page state.
 */
import { type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useTenantContext } from '@/lib/tenant-context-provider';
import {
    useEditAssetForm,
    type EditAssetFormFields,
} from './_form/useEditAssetForm';
import { EditAssetFields } from './_form/EditAssetFields';

export interface EditAssetModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    assetId: string;
    initial: Partial<EditAssetFormFields>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSaved: (updated: any) => void;
}

export function EditAssetModal({
    open,
    setOpen,
    assetId,
    initial,
    onSaved,
}: EditAssetModalProps) {
    const t = useTranslations('assets');
    const { tenantSlug } = useTenantContext();
    const form = useEditAssetForm({
        assetId,
        initial,
        onSuccess: (updated) => {
            setOpen(false);
            onSaved(updated);
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
            title={t('editAsset')}
            description={t('editAssetDescription')}
            preventDefaultClose={form.submitting}
            isDirty={form.isDirty}
        >
            <Modal.Header
                title={t('editAsset')}
                description={t('editAssetDescription')}
            />
            <Modal.Form id="edit-asset-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="edit-asset-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <EditAssetFields form={form} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="edit-asset-cancel-btn"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="save-asset-btn"
                    >
                        {form.submitting ? t('saving') : t('save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
