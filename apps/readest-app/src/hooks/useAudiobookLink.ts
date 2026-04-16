/**
 * useAudiobookLink — stores and retrieves audiobook manifest URLs in localStorage.
 *
 * Keyed by book.hash (the MD5 fingerprint of the EPUB file) so the link
 * survives book renames and survives across browser sessions on the same device.
 *
 * Storage format:
 *   localStorage['readest-audiobook-manifests'] = JSON.stringify({
 *     [bookHash]: manifestUrl,
 *     ...
 *   })
 */

const STORAGE_KEY = 'readest-audiobook-manifests';

function readStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

/**
 * Extract the manifest URL from either:
 *  - A direct manifest URL:  https://pub-xxx.r2.dev/slug/manifest.json
 *  - The player URL produced by audiobook-maker:
 *      https://player.example.com/?manifest=https://pub-xxx.r2.dev/slug/manifest.json
 */
export function extractManifestUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Player URL pattern: contains ?manifest= or &manifest=
  try {
    const url = new URL(trimmed);
    const manifestParam = url.searchParams.get('manifest');
    if (manifestParam) return manifestParam.trim();
  } catch {}

  // If it looks like a direct manifest URL, accept it as-is
  if (trimmed.includes('manifest.json')) return trimmed;

  return null;
}

/** Retrieve the manifest URL linked to a book (by hash), or null if not linked. */
export function getAudiobookManifestUrl(bookHash: string): string | null {
  return readStore()[bookHash] ?? null;
}

/** Save a manifest URL for a book. */
export function setAudiobookManifestUrl(bookHash: string, manifestUrl: string): void {
  const store = readStore();
  store[bookHash] = manifestUrl;
  writeStore(store);
}

/** Remove an audiobook link from a book. */
export function removeAudiobookManifestUrl(bookHash: string): void {
  const store = readStore();
  delete store[bookHash];
  writeStore(store);
}

/** Check whether a book has an audiobook linked. */
export function hasAudiobookLinked(bookHash: string): boolean {
  return bookHash in readStore();
}
