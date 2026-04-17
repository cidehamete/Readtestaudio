'use client';

/**
 * AudiobookLinkDialog — lets the user link an EPUB to a pre-recorded audiobook.
 *
 * The user pastes either:
 *  (a) The manifest URL directly:
 *        https://pub-xxx.r2.dev/ocean-of-sound-david-toop-4cca1a/manifest.json
 *  (b) The player URL that audiobook-maker displays after upload:
 *        https://player.example.com/?manifest=https://pub-xxx.r2.dev/...manifest.json
 *
 * The dialog stores the resolved manifest URL in localStorage via useAudiobookLink.
 */

import { useState } from 'react';
import { MdHeadphones, MdLinkOff } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import { Book } from '@/types/book';
import {
  extractManifestUrl,
  setAudiobookManifestUrl,
  removeAudiobookManifestUrl,
  getAudiobookManifestUrl,
} from '@/hooks/useAudiobookLink';

interface AudiobookLinkDialogProps {
  book: Book;
  onClose: () => void;
}

export function AudiobookLinkDialog({ book, onClose }: AudiobookLinkDialogProps) {
  const existingUrl = getAudiobookManifestUrl(book.hash);
  const [input, setInput] = useState(existingUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setError(null);
    const manifestUrl = extractManifestUrl(input);
    if (!manifestUrl) {
      setError(
        'Paste the manifest.json URL or the player URL from your audiobook maker (it contains ?manifest=…).',
      );
      return;
    }
    setAudiobookManifestUrl(book.hash, manifestUrl);
    setSaved(true);
    setTimeout(onClose, 800);
  };

  const handleRemove = () => {
    removeAudiobookManifestUrl(book.hash);
    onClose();
  };

  return (
    <Dialog
      isOpen={true}
      title='Link Audiobook'
      onClose={onClose}
      boxClassName='sm:min-w-[600px] sm:w-[640px] sm:h-auto'
    >
      <div className='flex flex-col gap-5 pb-4'>
        {/* Book title reminder */}
        <p className='text-base-content/70 text-sm'>
          Linking audiobook for:{' '}
          <span className='text-base-content font-semibold'>{book.title}</span>
        </p>

        {/* URL input */}
        <div className='flex flex-col gap-2'>
          <label className='text-base-content text-sm font-medium' htmlFor='manifest-url-input'>
            Manifest URL or Player URL
          </label>
          <textarea
            id='manifest-url-input'
            className='textarea textarea-bordered h-36 w-full resize-none font-mono text-xs'
            placeholder={
              'https://pub-xxx.r2.dev/your-book-slug/manifest.json\n\nor paste the player URL:\nhttps://player.example.com/?manifest=https://pub-xxx.r2.dev/...'
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
              setSaved(false);
            }}
            spellCheck={false}
          />
          {error && <p className='text-error text-xs'>{error}</p>}
          {saved && (
            <p className='text-success flex items-center gap-1 text-xs'>
              <MdHeadphones size={14} /> Audiobook linked!
            </p>
          )}
        </div>

        {/* Hint */}
        <p className='text-base-content/50 text-xs'>
          After generating an audiobook, your audiobook-maker app shows a <em>Player URL</em>. Paste
          that here. The URL must point to a{' '}
          <code className='bg-base-200 rounded px-1'>manifest.json</code> stored in your Cloudflare
          R2 bucket.
        </p>

        {/* Actions */}
        <div className='flex items-center justify-between gap-3'>
          {existingUrl ? (
            <button
              className='btn btn-ghost btn-sm text-error flex items-center gap-1'
              onClick={handleRemove}
            >
              <MdLinkOff size={15} />
              Remove link
            </button>
          ) : (
            <div />
          )}
          <div className='flex gap-2'>
            <button className='btn btn-ghost btn-sm' onClick={onClose}>
              Cancel
            </button>
            <button
              className='btn btn-primary btn-sm flex items-center gap-1'
              onClick={handleSave}
              disabled={!input.trim() || saved}
            >
              <MdHeadphones size={15} />
              {saved ? 'Saved!' : 'Link audiobook'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
