/**
 * `<EvidenceAddForm>` — the single shared add-evidence surface used by
 * the Practice / Task / Risk / Asset evidence tabs.
 *
 * Locks the canonical shape so the four tabs stay EXACTLY the same:
 * a Title field (always), a brand-tinted file input, a URL + note pair,
 * and the same trigger / submit labels. The ids are configurable so each
 * page keeps its E2E selectors; this test drives the form generically.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { EvidenceAddForm } from '@/components/EvidenceAddForm';

const IDS = {
    trigger: 't-trigger',
    form: 't-form',
    title: 't-title',
    file: 't-file',
    url: 't-url',
    note: 't-note',
    error: 't-error',
    submit: 't-submit',
};

function Harness(props: Partial<React.ComponentProps<typeof EvidenceAddForm>>) {
    const [show, setShow] = React.useState(true);
    const ref = React.useRef<HTMLInputElement>(null);
    return (
        <EvidenceAddForm
            ids={IDS}
            canWrite
            show={show}
            onToggleShow={() => setShow((s) => !s)}
            file={null}
            onFileChange={() => {}}
            fileInputRef={ref}
            title=""
            onTitleChange={() => {}}
            url=""
            onUrlChange={() => {}}
            note=""
            onNoteChange={() => {}}
            onSubmit={(e) => e.preventDefault()}
            error=""
            uploading={false}
            saving={false}
            {...props}
        />
    );
}

describe('EvidenceAddForm — canonical shape', () => {
    it('renders Title, file, URL and note fields + trigger/submit', () => {
        render(<Harness />);
        // Trigger + submit both read "Add Evidence" (matches the Practice tab).
        expect(document.getElementById('t-trigger')?.textContent).toContain('Add Evidence');
        // The always-present Title field (the difference the Task tab lacked).
        expect(document.getElementById('t-title')).not.toBeNull();
        // Brand-tinted file button (not the muted grey the Task tab used).
        const fileInput = document.getElementById('t-file');
        expect(fileInput?.className).toContain('file:bg-[var(--brand-default)]');
        expect(document.getElementById('t-url')).not.toBeNull();
        expect(document.getElementById('t-note')).not.toBeNull();
        expect(document.getElementById('t-submit')?.textContent).toContain('Add Evidence');
    });

    it('disables submit until a file or URL is provided', () => {
        render(<Harness />);
        expect(document.getElementById('t-submit')).toBeDisabled();
    });

    it('shows "Linking..." while a URL link is saving', () => {
        render(<Harness url="https://x.test" saving />);
        expect(document.getElementById('t-submit')?.textContent).toBe('Linking...');
    });

    it('shows the progress bar + "Uploading..." during a file upload', () => {
        const file = new File(['x'], 'e.txt', { type: 'text/plain' });
        render(<Harness file={file} uploading />);
        expect(document.getElementById('t-submit')?.textContent).toBe('Uploading...');
        expect(screen.getByLabelText('Uploading evidence file')).not.toBeNull();
    });

    it('hides the form when not writable', () => {
        render(<Harness canWrite={false} />);
        expect(document.getElementById('t-form')).toBeNull();
        expect(document.getElementById('t-trigger')).toBeNull();
    });

    it('disables the URL/note pair once a file is chosen', () => {
        const file = new File(['x'], 'e.txt', { type: 'text/plain' });
        render(<Harness file={file} />);
        expect(document.getElementById('t-url')).toBeDisabled();
        expect(document.getElementById('t-note')).toBeDisabled();
    });
});
