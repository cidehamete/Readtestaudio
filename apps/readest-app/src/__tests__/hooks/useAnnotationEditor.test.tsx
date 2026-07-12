/**
 * Tests for useAnnotationEditor — the highlight-pin drag logic.
 *
 * The pins were unresponsive because every pointermove ran the full
 * annotation-update pipeline, including the async transformer chain in
 * getAnnotationText. During a drag we only need the raw range text for the
 * live highlight; the transformer runs once, on release.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookNote } from '@/types/book';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));

const editingAnnotation: BookNote = {
  id: 'note-1',
  type: 'annotation',
  cfi: 'cfi-old',
  style: 'highlight',
  color: 'yellow',
  text: 'old text',
  note: '',
  createdAt: 1,
  updatedAt: 1,
};

const mockConfig = { booknotes: [editingAnnotation] as BookNote[] };
const mockSaveConfig = vi.fn().mockResolvedValue(undefined);
const mockUpdateBooknotes = vi.fn((_bookKey: string, booknotes: BookNote[]) => ({
  booknotes,
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => mockConfig,
    saveConfig: mockSaveConfig,
    updateBooknotes: mockUpdateBooknotes,
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));

const mockView = {
  renderer: {
    getContents: () => [{ doc: document as unknown as Document, index: 0 }],
  },
  getCFI: vi.fn(() => 'cfi-new'),
  addAnnotation: vi.fn(),
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => mockView,
    getViewsById: () => [mockView],
    getProgress: () => ({ page: 3 }),
  }),
}));

import { useAnnotationEditor } from '@/app/reader/hooks/useAnnotationEditor';

const getAnnotationTextMock = vi.fn(async (range: Range) => range.toString());
const setSelectionMock = vi.fn();

let latestEditor: ReturnType<typeof useAnnotationEditor> | null = null;

const Harness = () => {
  latestEditor = useAnnotationEditor({
    bookKey: 'book-1',
    annotation: editingAnnotation,
    getAnnotationText: getAnnotationTextMock,
    setSelection: setSelectionMock,
  });
  return null;
};

describe('useAnnotationEditor drag performance', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p>alpha beta gamma delta</p>';
    const textNode = document.querySelector('p')!.firstChild!;
    const textLength = textNode.textContent!.length;
    // jsdom has no caret-from-point; map x → character offset (10px per char).
    (
      document as unknown as {
        caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number };
      }
    ).caretPositionFromPoint = (x: number) => ({
      offsetNode: textNode,
      offset: Math.max(0, Math.min(textLength, Math.round(x / 10))),
    });

    mockConfig.booknotes = [{ ...editingAnnotation }];
    mockView.getCFI.mockClear();
    mockView.addAnnotation.mockClear();
    mockSaveConfig.mockClear();
    mockUpdateBooknotes.mockClear();
    getAnnotationTextMock.mockClear();
    setSelectionMock.mockClear();
    latestEditor = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('skips the transformer pipeline while dragging and uses the raw range text', async () => {
    render(<Harness />);

    await act(async () => {
      // Drag in progress: start of "alpha" → end of "beta" (offset 10).
      await latestEditor!.handleAnnotationRangeChange(
        { x: 0, y: 5 },
        { x: 100, y: 5 },
        false,
        true,
      );
    });

    expect(getAnnotationTextMock).not.toHaveBeenCalled();
    // Live redraw still happens: remove the old annotation, add the updated one.
    expect(mockView.addAnnotation).toHaveBeenCalledTimes(2);
    expect(mockView.addAnnotation).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfi: 'cfi-new', text: 'alpha beta' }),
    );
    // Nothing is persisted mid-drag.
    expect(mockUpdateBooknotes).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('runs the transformer and persists the annotation on release', async () => {
    render(<Harness />);

    await act(async () => {
      await latestEditor!.handleAnnotationRangeChange(
        { x: 0, y: 5 },
        { x: 100, y: 5 },
        false,
        false,
      );
    });

    expect(getAnnotationTextMock).toHaveBeenCalledTimes(1);
    expect(mockUpdateBooknotes).toHaveBeenCalledWith(
      'book-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'note-1', cfi: 'cfi-new', text: 'alpha beta' }),
      ]),
    );
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(setSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ annotated: true, text: 'alpha beta', cfi: 'cfi-new' }),
    );
  });
});
