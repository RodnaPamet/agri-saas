/**
 * A modal names itself ONCE: the id `aria-labelledby` points at resolves to
 * exactly one element, and so does `aria-describedby` (#1836).
 *
 * ## The defect
 *
 * `<Modal.Header title=…>` renders a `Dialog.Title`, and `<Modal>` used to
 * render a visually-hidden one unconditionally as well. Radix gives every
 * `Dialog.Title` under one dialog the SAME generated id — the id
 * `aria-labelledby` names — so a modal with a header shipped two elements
 * carrying it. 33 call sites passed a title at both levels.
 *
 * The 18 that pass a title only to `Modal.Header` were worse off: their
 * fallback rendered `ui.modal.dialogFallback` — «Диалог» / "Dialog" — so a
 * hidden element saying "Dialog" shared the id with the real heading. Which
 * one a screen reader announces is then the consumer's choice, and one of the
 * two answers is useless.
 *
 * The description had the same shape with a sharper edge: the fallback's value
 * is `description ?? ""`, so a modal whose header supplied a description ALSO
 * had a hidden EMPTY element carrying the `aria-describedby` id.
 *
 * ## Why it asserts the id and not the element count
 *
 * Counting `h2`s would pass the day someone renders a second heading for
 * layout. What must hold is narrower and is the actual contract: the id the
 * dialog points at names one element, and that element says the right thing.
 * `document.querySelectorAll('#' + id)` is the direct question.
 *
 * ## Presentation
 *
 * Rendered tests answer `matches: false` to every media query, so `<Modal>`
 * takes its mobile DRAWER branch here. That is deliberate rather than
 * convenient: `vaul` re-exports Radix's dialog primitives, so this is also
 * what proves the drawer's `Drawer.Title` and the header's `Dialog.Title`
 * share one dialog context — they would not collide on an id otherwise.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/journal',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { Modal } from '@/components/ui/modal';

/** The element(s) the dialog actually points at for its name / description. */
function resolve(attr: 'aria-labelledby' | 'aria-describedby'): HTMLElement[] {
    const dialog = screen.getByRole('dialog');
    const id = dialog.getAttribute(attr);
    if (!id) return [];
    // `querySelectorAll` on the id, NOT `getElementById`, because the whole
    // point is that MORE THAN ONE element can carry it — `getElementById`
    // returns the first and would report a duplicate as healthy.
    return Array.from(document.querySelectorAll(`[id="${id}"]`)) as HTMLElement[];
}

const noop = () => undefined;

describe('a modal names itself once', () => {
    it('resolves to a single title when Modal.Header supplies one', async () => {
        render(
            <Modal showModal setShowModal={noop} title="Нов запис" description="Описание">
                <Modal.Header title="Нов запис" description="Описание" />
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        // And it is the VISIBLE heading, not the hidden fallback.
        expect(titles[0].textContent).toBe('Нов запис');

        const described = resolve('aria-describedby');
        expect(described).toHaveLength(1);
        // The load-bearing half: the hidden fallback's description was
        // `description ?? ""`, so a duplicate here could be an EMPTY element.
        expect(described[0].textContent).toBe('Описание');
    });

    it('does not announce «Диалог» over the header’s own title', async () => {
        // The 18-call-site case: a title on the HEADER only. The fallback used
        // to render the generic string under the same id.
        render(
            <Modal showModal setShowModal={noop}>
                <Modal.Header title="Третиране" />
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        expect(titles[0].textContent).toBe('Третиране');
        // Nowhere in the dialog, hidden or not.
        expect(screen.queryByText('Dialog')).toBeNull();
        expect(screen.queryByText('Диалог')).toBeNull();
    });

    it('still names a modal that renders NO header, which is why the fallback exists', async () => {
        // Radix refuses to mount a dialog without a title and warns at
        // runtime, so the fallback must survive for this shape. Removing it
        // outright — the obvious "fix" — breaks exactly this case.
        render(
            <Modal showModal setShowModal={noop} title="Поддръжка">
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        expect(titles[0].textContent).toBe('Поддръжка');
    });

    it('names a modal with neither, rather than mounting untitled', async () => {
        render(
            <Modal showModal setShowModal={noop}>
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        // Here the generic string IS the right answer — it is all the modal
        // has been given.
        expect(titles[0].textContent).toBe('Dialog');
    });

    it('finds a header nested inside ordinary JSX children, not only a direct one', async () => {
        // 5 of 62 call sites reach `Modal.Header` through a wrapper
        // (`Modal.Form`, a `form`). The scan descends `props.children`, so
        // those are covered too — and this is the assertion that fails if it
        // stops descending and the duplicate comes back for them alone.
        render(
            <Modal showModal setShowModal={noop} title="Обвит">
                <>
                    <div>
                        <Modal.Header title="Обвит заглавие" />
                    </div>
                </>
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        expect(titles[0].textContent).toBe('Обвит заглавие');
    });

    it('keeps the fallback when the header supplies an EMPTY title', async () => {
        // `Header` renders its `Dialog.Title` on a truthiness test, so an
        // empty string supplies NOTHING. The scan has to agree with it, or
        // the modal would be left with no title at all.
        render(
            <Modal showModal setShowModal={noop} title="Резерва">
                <Modal.Header title="" />
                <p>body</p>
            </Modal>,
        );

        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        const titles = resolve('aria-labelledby');
        expect(titles).toHaveLength(1);
        expect(titles[0].textContent).toBe('Резерва');
    });
});
