// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../lib/types';
import { NoteCard } from './NoteCard';

const annotation: Annotation = {
  schema_version: 1,
  annotation_id: 'note-1',
  target: {
    paper_id: 'paper-1', pdf_hash: 'hash', page_anchors: [
      { page_number: 2, quad_points: [], text_quote: { exact_text: 'The selected passage.', prefix: '', suffix: '', normalization_version: 1 } },
      { page_number: 3, quad_points: [], text_quote: { exact_text: 'A second passage.', prefix: '', suffix: '', normalization_version: 1 } },
    ],
  },
  body: { kind: 'note', content: 'First line\nA longer explanation.' },
  created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z',
};

function aiNote(note_content?: string): Annotation {
  return { ...annotation, body: {
    kind: 'ai_answer', question: 'What does this mean?', answer: 'The full answer.\nMore detail.', note_content,
    provider_id: 'provider', model_id: 'model-id', context_text: 'Surrounding text.',
  } };
}

function callbacks() {
  return { on_navigate: vi.fn(), on_update: vi.fn().mockResolvedValue(true), on_delete: vi.fn().mockResolvedValue(true), on_before_resize: vi.fn() };
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
}

afterEach(cleanup);

describe('saved note cards', () => {
  it('starts with only the first line, then exposes the saved content and anchored passage', () => {
    const props = callbacks();
    const { container } = render(<NoteCard annotation={annotation} {...props} />);
    const toggle = screen.getByRole('button', { name: 'Expand note: First line' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('A longer explanation.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to passage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete annotation' })).toBeNull();
    expand();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.note-card-body')?.textContent).toBe('First line\nA longer explanation.');
    expect(container.querySelector('.note-card-quote')?.textContent).toBe('The selected passage.\nA second passage.');
    expect(screen.getByText('p. 2, 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
    expect(props.on_navigate).toHaveBeenCalledWith(annotation);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse note: First line' }));
    expect(container.querySelector('.note-card-content')).toBeNull();
    expect(props.on_before_resize).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.textLayer')).toBeNull();
  });

  it('uses the original answer for legacy AI notes and preserves the question and model', () => {
    const { container } = render(<NoteCard annotation={aiNote()} {...callbacks()} />);
    expect(screen.getByRole('button', { name: 'Expand note: The full answer.' })).toBeTruthy();
    expand();
    expect(container.querySelector('.note-card-body')?.textContent).toBe('The full answer.\nMore detail.');
    expect(screen.getByRole('heading', { name: 'What does this mean?' })).toBeTruthy();
    expect(screen.getByText('model-id')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Full answer' })).toBeNull();
  });

  it('shows an AI takeaway while keeping its full answer behind a separate resize-aware toggle', () => {
    const props = callbacks();
    const { container } = render(<NoteCard annotation={aiNote('A saved takeaway.')} {...props} />);
    expand();
    expect(container.querySelector('.note-card-body')?.textContent).toBe('A saved takeaway.');
    expect(screen.queryByText(/More detail/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Full answer' });
    props.on_before_resize.mockImplementation(() => {
      expect(container.querySelector('.note-card-answer .note-card-body')).toBeNull();
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.note-card-answer .note-card-body')?.textContent).toBe('The full answer.\nMore detail.');
    props.on_before_resize.mockImplementation(() => {});
    fireEvent.click(toggle);
    expect(container.querySelector('.note-card-answer .note-card-body')).toBeNull();
    expect(props.on_before_resize).toHaveBeenCalledTimes(3);
  });

  it('retains a failed edit for retry and blocks empty saves', async () => {
    const props = callbacks();
    props.on_update.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<NoteCard annotation={annotation} {...props} />);
    expand();
    props.on_before_resize.mockImplementation(() => {
      expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    props.on_before_resize.mockImplementation(() => {});
    const editor = screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement;
    expect(editor.value).toBe('First line\nA longer explanation.');
    fireEvent.change(editor, { target: { value: '  ' } });
    expect((screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor, { target: { value: 'Revised note\nKeep this draft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement).disabled).toBe(false));
    expect(editor.value).toBe('Revised note\nKeep this draft.');
    expect(props.on_update).toHaveBeenNthCalledWith(1, annotation, 'Revised note\nKeep this draft.');
    props.on_before_resize.mockImplementation(() => expect(screen.getByRole('textbox', { name: 'Edit note' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull());
    expect(props.on_update).toHaveBeenCalledTimes(2);
    expect(props.on_before_resize).toHaveBeenCalledTimes(3);
  });

  it('restores controlled drafts and reports edit, cancel, and successful saves to the owner', async () => {
    const props = callbacks();
    function ControlledCard() {
      const [draft, setDraft] = useState<string | null>('Restored unsaved draft');
      return <NoteCard annotation={annotation} {...props} edit_draft={draft} on_edit_draft_change={setDraft} />;
    }
    render(<ControlledCard />);
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('Restored unsaved draft');
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'Updated draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull());
    expect(props.on_update).toHaveBeenCalledWith(annotation, 'Updated draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('First line\nA longer explanation.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
    expect(props.on_before_resize).toHaveBeenCalledTimes(3);
  });

  it('does not clear a persisted edit draft after its card unmounts during a save', async () => {
    const props = callbacks();
    let finish!: (value: boolean) => void;
    props.on_update.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    const change = vi.fn();
    const { unmount } = render(<NoteCard annotation={annotation} {...props} edit_draft="Unsaved draft" on_edit_draft_change={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    unmount();
    await act(async () => { finish(true); });
    expect(change).not.toHaveBeenCalled();
    expect(props.on_before_resize).not.toHaveBeenCalled();
  });

  it('keeps navigation available while mutations are busy, then allows deletion with the original annotation', async () => {
    const props = callbacks();
    const { rerender } = render(<NoteCard annotation={annotation} {...props} />);
    expand();
    rerender(<NoteCard annotation={annotation} {...props} busy pending />);
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete annotation' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
    expect(props.on_navigate).toHaveBeenCalledWith(annotation);
    rerender(<NoteCard annotation={annotation} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete annotation' }) as HTMLButtonElement).disabled).toBe(false));
    expect(props.on_delete).toHaveBeenCalledWith(annotation);
  });

  it('freezes expansion and full-answer layout changes while its reader is pinching', () => {
    const props = callbacks();
    const { container, rerender } = render(<NoteCard annotation={aiNote('Saved takeaway')} {...props} frozen />);
    expand();
    expect(screen.queryByRole('button', { name: 'Full answer' })).toBeNull();
    expect(props.on_before_resize).not.toHaveBeenCalled();
    rerender(<NoteCard annotation={aiNote('Saved takeaway')} {...props} />);
    expand();
    rerender(<NoteCard annotation={aiNote('Saved takeaway')} {...props} frozen />);
    fireEvent.click(screen.getByRole('button', { name: 'Full answer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Collapse note:/ }));
    expect(screen.getByRole('button', { name: 'Full answer' }).getAttribute('aria-expanded')).toBe('false');
    expect(props.on_before_resize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.note-card')?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('.spin')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Delete annotation' }).getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Delete annotation' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }));
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
    expect(props.on_delete).not.toHaveBeenCalled();
  });

  it.each([0.1, 1, 3])('scales inline note metrics at %sx while sidebar metrics stay unchanged under the production cascade', (zoom) => {
    const readStyles = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
    const component_styles = ['note-card.css', 'reading-view.css', 'reference-components.css', 'reading-workspace.css']
      .map(readStyles).join('\n');
    const global_styles = readStyles('../styles.css')
      .replace("@import './components/pdf-reader.css';", readStyles('pdf-reader.css'));
    for (const inline of [true, false]) {
      const scale = inline ? zoom : 1;
      const styles = document.createElement('style');
      // JSDOM applies selectors and late global overrides but cannot inherit CSS
      // variables. Resolve just the two scale inputs; native QA checks layout.
      styles.textContent = `${component_styles}\n${global_styles}`
        .replace(/var\(--note-scale,\s*1\)/g, String(scale))
        .replace(/var\(--reading-zoom(?:,\s*1)?\)/g, String(zoom));
      document.head.append(styles);
      const card = <NoteCard annotation={annotation} {...callbacks()} />;
      const view = render(inline
        ? <div className="pdf-pages reading-pages"><article className="reading-block"><aside className="note-strip">{card}</aside></article></div>
        : <aside className="inspector"><section className="saved-notes"><div className="annotation-list">{card}</div></section></aside>);
      try {
        const styleOf = (selector: string) => getComputedStyle(view.container.querySelector(selector)!);
        const scaled = (pixels: number) => `calc(${Number((pixels * scale).toFixed(4))}px)`;
        expect(styleOf('.note-card').width).toBe('0px');
        expect(styleOf('.note-card').minWidth).toBe('100%');
        expect(styleOf('.note-card').maxWidth).toBe('100%');
        expect(styleOf('.note-card').fontSize).toBe(scaled(13));
        expect(styleOf('.note-card').borderTopWidth).toBe(scaled(1));
        expect(styleOf('.note-card-heading').paddingTop).toBe(scaled(9));
        expect(styleOf('.note-card-heading').minHeight).toBe(`calc(44px * ${scale})`);
        expect(styleOf('.note-card-heading > svg').width).toBe(scaled(16));
        expect(styleOf('.note-card-preview').textOverflow).toBe('ellipsis');
        expect(styleOf('.note-card-preview').whiteSpace).toBe('nowrap');
        if (inline) expect(styleOf('.note-strip').getPropertyValue('--note-scale')).toBe(String(zoom));
        expand();
        expect(styleOf('.note-card-content').paddingLeft).toBe(scaled(12));
        expect(styleOf('.note-card-meta').fontSize).toBe(scaled(11));
        expect(styleOf('.note-card-actions button').fontSize).toBe(scaled(12));
        expect(styleOf('.note-card-actions button').minHeight).toBe(`calc(44px * ${scale})`);
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(styleOf('.note-card-editor textarea').fontSize).toBe(scaled(16));
      } finally {
        view.unmount();
        styles.remove();
      }
    }
  });

  it.each([0.1, 0.5, 1, 3])('keeps touch editors readable at %sx without changing the scaled saved text', (zoom) => {
    const readStyles = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
    const source = readStyles('note-card.css');
    const touch_media = source.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/);
    expect(touch_media).not.toBeNull();
    for (const coarse of [false, true]) {
      const styles = document.createElement('style');
      // JSDOM does not evaluate pointer queries, inherited variables, or max().
      // Apply the real coarse-pointer rule only to that case and evaluate its
      // numeric max() operands so the cascade and selector scope remain real.
      styles.textContent = `${source.replace(touch_media![0], '')}\n${coarse ? touch_media![1] : ''}`
        .replace(/var\(--note-scale,\s*1\)/g, String(zoom))
        .replace(/max\(([\d.]+)px,\s*calc\(([\d.]+)px\s*\*\s*([\d.]+)\)\)/g,
          (_expression, floor: string, base: string, scale: string) => `${Math.max(Number(floor), Number(base) * Number(scale))}px`);
      document.head.append(styles);
      const view = render(<aside className="note-strip"><NoteCard annotation={annotation} {...callbacks()} edit_draft="Editing a note" on_edit_draft_change={vi.fn()} /></aside>);
      try {
        const card = getComputedStyle(view.container.querySelector('.note-card')!);
        const editor = getComputedStyle(screen.getByRole('textbox', { name: 'Edit note' }));
        const scaled = (pixels: number) => `calc(${Number((pixels * zoom).toFixed(4))}px)`;
        expect(card.fontSize).toBe(scaled(13));
        expect(editor.fontSize).toBe(coarse ? `${Math.max(16, 16 * zoom)}px` : scaled(16));
      } finally {
        view.unmount();
        styles.remove();
      }
    }
  });
});
