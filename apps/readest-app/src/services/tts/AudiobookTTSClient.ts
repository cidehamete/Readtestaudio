/**
 * AudiobookTTSClient — plays pre-recorded audiobooks from Cloudflare R2.
 *
 * Audiobooks are produced by the companion audiobook-maker tool, which outputs:
 *   {slug}/manifest.json
 *   {slug}/audio/chapter_NN.mp3        (64 kbps mono MP3)
 *   {slug}/timestamps/chapter_NN_timestamps.json  (word-level timing)
 *
 * This client implements the TTSClient interface so it slots directly into
 * Readest's TTSController without requiring changes to any UI components.
 */

import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';
import { parseSSMLMarks } from '@/utils/ssml';

// Pacing cushion for the proportional-pacing fallback used when a mark's
// text cannot be matched against the word-level timestamps. Pages pre-
// estimated from chapter-average word rate tend to run slightly fast, so
// a small cushion keeps the text from visually running ahead of the
// narrator on unmatchable blocks.
const PAGE_PACING_FACTOR = 1.18;

// How many words of slack to apply when positioning the fuzzy search
// cursor. Lets us tolerate small skew between the current audio time and
// the true position of the next matched mark.
const FUZZY_SEARCH_LOOKBACK_WORDS = 8;

// When matching a mark's keywords, allow up to this many transcript words
// in between adjacent keywords before giving up on the match. This
// handles common short filler words (pronouns, articles, prepositions)
// that the normal keyword filter already strips from the query.
const FUZZY_MAX_GAP_BETWEEN_KEYWORDS = 3;

// ─── Manifest types (matching audiobook-maker's generator.py output) ──────────

interface AudiobookWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

interface AudiobookChapterTimestamps {
  chapter: number;
  title: string;
  duration_seconds: number;
  words: AudiobookWord[];
}

interface CachedChapterTimestamps {
  data: AudiobookChapterTimestamps;
  normalizedWords: string[];
}

interface AudiobookTextMatch {
  chapter: AudiobookChapter;
  timestamps: CachedChapterTimestamps;
  matchWordIndex: number;
  targetTime: number;
}

interface AudiobookChapter {
  index: number;
  title: string;
  normalized_title?: string;
  audio_url: string;
  timestamps_url: string;
  word_count: number;
  duration_seconds: number;
  section_type?: string;
  source_spine_index?: number;
  source_href?: string;
  source_item_id?: string;
  source_title?: string;
  chunk_index_in_source?: number;
  chunks_in_source?: number;
  first_words?: string;
  last_words?: string;
}

interface AudiobookManifest {
  title: string;
  slug: string;
  voice_id: string;
  voice_name: string;
  generated_at: string;
  total_chapters: number;
  chapters: AudiobookChapter[];
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class AudiobookTTSClient implements TTSClient {
  name = 'audiobook';
  initialized = false;
  controller?: TTSController;

  #manifestUrl: string;
  #manifest: AudiobookManifest | null = null;
  #audioEl: HTMLAudioElement | null = null;
  #nextAudioEl: HTMLAudioElement | null = null;
  #primaryLang = 'en';
  #speakingLang = 'en';
  #currentChapterIndex = -1;
  #timestampsCache = new Map<string, CachedChapterTimestamps>();
  #playbackRate = 1.0;
  #positionSaveIntervalId: ReturnType<typeof setInterval> | null = null;
  #lastTimeDispatchMs = 0;

  constructor(controller: TTSController, manifestUrl: string) {
    this.controller = controller;
    this.#manifestUrl = manifestUrl;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async init(): Promise<boolean> {
    try {
      const res = await fetch(this.#manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#manifest = (await res.json()) as AudiobookManifest;
      this.#audioEl = new Audio();
      this.#audioEl.preload = 'auto';
      this.#audioEl.playbackRate = this.#playbackRate;
      this.#audioEl.preservesPitch = true;
      (
        this.#audioEl as HTMLAudioElement & {
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        }
      ).mozPreservesPitch = true;
      (
        this.#audioEl as HTMLAudioElement & {
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        }
      ).webkitPreservesPitch = true;
      this.#audioEl.addEventListener('timeupdate', this.#handleTimeUpdate);
      // Save position every 10 seconds during playback
      this.#positionSaveIntervalId = setInterval(() => this.#savePosition(), 10_000);
      this.initialized = true;
      console.info(
        `[AudiobookTTSClient] Loaded "${this.#manifest.title}" (${this.#manifest.total_chapters} chapters)`,
      );
      return true;
    } catch (e) {
      console.warn('[AudiobookTTSClient] init failed:', e);
      this.#dispatchError("Audiobook manifest couldn't be loaded. Falling back to TTS.");
      return false;
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    if (this.#positionSaveIntervalId !== null) {
      clearInterval(this.#positionSaveIntervalId);
      this.#positionSaveIntervalId = null;
    }
    this.#nextAudioEl?.pause();
    this.#nextAudioEl = null;
    this.#audioEl?.removeEventListener('timeupdate', this.#handleTimeUpdate);
    this.#audioEl = null;
    this.#manifest = null;
    this.#timestampsCache.clear();
    this.#currentChapterIndex = -1;
    this.initialized = false;
  }

  // ── Chapter matching ─────────────────────────────────────────────────────────

  /** Strip chapter/part numbering and punctuation for fuzzy title comparison. */
  #normalizeForMatch(s: string): string {
    return s
      .toLowerCase()
      .replace(/\b(chapter|part|section)\b\s*[\divxlc]+\s*[:\.\-]?\s*/gi, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Find the manifest chapter matching the current EPUB section label. */
  #findChapter(sectionLabel: string): AudiobookChapter | null {
    if (!this.#manifest || !sectionLabel) return null;
    const label = sectionLabel.trim().toLowerCase();

    // Tier 1: exact
    const exact = this.#manifest.chapters.find((c) => c.title.trim().toLowerCase() === label);
    if (exact) return exact;

    // Tier 2: normalized
    const normLabel = this.#normalizeForMatch(label);
    if (normLabel) {
      const normalized = this.#manifest.chapters.find(
        (c) => this.#normalizeForMatch(c.title) === normLabel,
      );
      if (normalized) return normalized;
    }

    return null;
  }

  #findChapterByIndex(chapterIndex: number): AudiobookChapter | null {
    return this.#manifest?.chapters.find((chapter) => chapter.index === chapterIndex) ?? null;
  }

  #normalizeWord(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  #normalizeHref(href: string): string {
    return decodeURIComponent(href)
      .split('#')[0]!
      .replace(/^[./]+/, '')
      .replace(/\\/g, '/')
      .toLowerCase();
  }

  #hrefsMatch(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    const left = this.#normalizeHref(a);
    const right = this.#normalizeHref(b);
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  #getSourceMatchedChapters(): AudiobookChapter[] {
    if (!this.#manifest || !this.controller) return [];

    const seen = new Set<number>();
    const matches: AudiobookChapter[] = [];
    const add = (chapter: AudiobookChapter | null | undefined) => {
      if (!chapter || seen.has(chapter.index)) return;
      seen.add(chapter.index);
      matches.push(chapter);
    };

    const sectionIndex = this.controller.sectionIndex;
    const sectionHref = this.controller.view?.book?.sections?.[sectionIndex]?.href;

    if (sectionHref) {
      for (const chapter of this.#manifest.chapters) {
        if (this.#hrefsMatch(chapter.source_href, sectionHref)) {
          add(chapter);
        }
      }
    }

    if (sectionIndex >= 0) {
      for (const chapter of this.#manifest.chapters) {
        if (chapter.source_spine_index === sectionIndex) {
          add(chapter);
        }
      }
    }

    return matches;
  }

  #extractKeywords(text: string, minLength = 2, maxKeywords = 4): string[] {
    return this.#normalizeWord(text)
      .split(/\s+/)
      .filter((word) => word.length >= minLength)
      .slice(0, maxKeywords);
  }

  #findKeywordMatches(keyWords: string[], normalizedWords: string[]): number[] {
    if (keyWords.length === 0 || normalizedWords.length === 0) return [];

    const matches: number[] = [];
    outer: for (let i = 0; i < normalizedWords.length; i++) {
      if (!normalizedWords[i]?.includes(keyWords[0]!)) continue;
      let last = i;
      for (let ki = 1; ki < keyWords.length; ki++) {
        const searchStart = last + 1;
        const searchLimit = Math.min(
          last + 1 + FUZZY_MAX_GAP_BETWEEN_KEYWORDS,
          normalizedWords.length - 1,
        );
        let found = -1;
        for (let j = searchStart; j <= searchLimit; j++) {
          if (normalizedWords[j]?.includes(keyWords[ki]!)) {
            found = j;
            break;
          }
        }
        if (found < 0) continue outer;
        last = found;
      }
      matches.push(i);
    }
    return matches;
  }

  #findBestKeywordMatch(
    keyWords: string[],
    timestamps: CachedChapterTimestamps,
    preferNearest = false,
  ): number | null {
    const matches = this.#findKeywordMatches(keyWords, timestamps.normalizedWords);
    if (matches.length === 0) return null;
    if (!preferNearest || !this.#audioEl) {
      return matches[0] ?? null;
    }

    const now = this.#audioEl.currentTime;
    return matches.reduce((closest, candidate) => {
      const closestDistance = Math.abs((timestamps.data.words[closest]?.start ?? 0) - now);
      const candidateDistance = Math.abs((timestamps.data.words[candidate]?.start ?? 0) - now);
      return candidateDistance < closestDistance ? candidate : closest;
    }, matches[0]!);
  }

  #getApproximateChapterIndexFromSection(): number | null {
    if (!this.#manifest || !this.controller) return null;

    const sectionIndex = this.controller.sectionIndex;
    const totalSections = this.controller.view?.book?.sections?.length ?? 0;
    if (sectionIndex < 0 || totalSections <= 1 || this.#manifest.chapters.length === 0) {
      return null;
    }

    const approxPosition =
      (sectionIndex / Math.max(1, totalSections - 1)) * (this.#manifest.chapters.length - 1);
    return this.#manifest.chapters[Math.round(approxPosition)]?.index ?? null;
  }

  #getChapterSearchOrder(preferredChapterIndex?: number, sectionLabel = ''): AudiobookChapter[] {
    if (!this.#manifest) return [];

    const chapters: AudiobookChapter[] = [];
    const seen = new Set<number>();
    const add = (chapter: AudiobookChapter | null) => {
      if (!chapter || seen.has(chapter.index)) return;
      seen.add(chapter.index);
      chapters.push(chapter);
    };

    add(this.#findChapterByIndex(preferredChapterIndex ?? -1));
    add(this.#findChapterByIndex(this.#currentChapterIndex));
    for (const chapter of this.#getSourceMatchedChapters()) {
      add(chapter);
    }

    const currentChapterIndex = this.#currentChapterIndex;
    if (currentChapterIndex > 0) {
      for (let delta = 1; delta <= 2; delta++) {
        add(this.#findChapterByIndex(currentChapterIndex + delta));
        add(this.#findChapterByIndex(currentChapterIndex - delta));
      }
    }

    add(this.#findChapter(sectionLabel));

    const approximateChapterIndex = this.#getApproximateChapterIndexFromSection();
    add(this.#findChapterByIndex(approximateChapterIndex ?? -1));
    if (approximateChapterIndex !== null) {
      for (let delta = 1; delta <= 2; delta++) {
        add(this.#findChapterByIndex(approximateChapterIndex + delta));
        add(this.#findChapterByIndex(approximateChapterIndex - delta));
      }
    }

    for (const chapter of this.#manifest.chapters) {
      add(chapter);
    }

    return chapters;
  }

  async #locateTextMatch(
    text: string,
    options: { preferredChapterIndex?: number; sectionLabel?: string } = {},
  ): Promise<AudiobookTextMatch | null> {
    if (!this.#manifest) return null;

    const keyWords = this.#extractKeywords(text, 2, 6);
    if (keyWords.length === 0) return null;

    const { preferredChapterIndex, sectionLabel = '' } = options;
    const chapters = this.#getChapterSearchOrder(preferredChapterIndex, sectionLabel);

    for (const chapter of chapters) {
      const timestamps = await this.#loadTimestamps(chapter.timestamps_url);
      if (!timestamps || timestamps.data.words.length === 0) continue;

      const matchWordIndex = this.#findBestKeywordMatch(
        keyWords,
        timestamps,
        chapter.index === this.#currentChapterIndex,
      );
      if (matchWordIndex === null) continue;

      const targetTime = timestamps.data.words[matchWordIndex]?.start;
      if (targetTime === undefined) continue;

      return { chapter, timestamps, matchWordIndex, targetTime };
    }

    return null;
  }

  async #loadTimestamps(url: string): Promise<CachedChapterTimestamps | null> {
    if (this.#timestampsCache.has(url)) return this.#timestampsCache.get(url)!;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AudiobookChapterTimestamps;
      const cached = {
        data,
        normalizedWords: data.words.map((word) => this.#normalizeWord(word.word)),
      };
      this.#timestampsCache.set(url, cached);
      return cached;
    } catch (e) {
      console.warn('[AudiobookTTSClient] Failed to load timestamps:', e);
      this.#dispatchError(`Timestamps missing for a chapter — playing without word highlights.`);
      return null;
    }
  }

  // ── Mark timing ───────────────────────────────────────────────────────────────

  /**
   * Match each SSML mark to its actual word-level timestamp by fuzzy-searching
   * the mark's leading words against the chapter's word array.
   *
   * Key invariant: all returned startTimes are >= pageStartAudioTime, so no
   * mark fires before the audio has reached the current page position. Marks
   * that match a timestamp earlier than pageStartAudioTime (e.g. because of a
   * small lookback window) are clamped to pageStartAudioTime and will fire the
   * moment the loop starts.
   *
   * For marks that cannot be matched (short text, no match in remaining words),
   * timing falls back to proportional pacing from the last known end time.
   */
  #matchMarksToTimestamps(
    marks: { text: string }[],
    timestamps: CachedChapterTimestamps,
    pageStartAudioTime: number,
  ): { startTimes: number[]; endTimes: number[] } {
    const wordNorms = timestamps.normalizedWords;
    const words = timestamps.data.words;
    const totalWords = words.length;
    const chapterEndTime = words[totalWords - 1]?.end ?? 0;

    // Find the first word at or after pageStartAudioTime, then step back a few
    // words to allow for minor timing imprecision in the audio element.
    let searchPos = words.findIndex((w) => w.start >= pageStartAudioTime);
    if (searchPos < 0) searchPos = totalWords;
    searchPos = Math.max(0, searchPos - FUZZY_SEARCH_LOOKBACK_WORDS);

    // Fallback rate used when fuzzy matching fails. Scaled by the pacing
    // cushion so unmatched marks advance slightly slower than average to
    // avoid running ahead of the narrator.
    const fallbackSpw =
      chapterEndTime > 0 && totalWords > 0
        ? (chapterEndTime / totalWords) * PAGE_PACING_FACTOR
        : 0.35 * PAGE_PACING_FACTOR;

    const startTimes: number[] = [];
    const endTimes: number[] = [];

    for (const mark of marks) {
      // Extract up to 5 content keywords from the mark text. Filter out
      // short words (≤2 chars like "I", "am", "a", "it") whose text is
      // noisy to match against; they appear in almost every sentence.
      const keyWords = this.#extractKeywords(mark.text, 3, 5);

      let matchStart = -1;
      let matchEnd = -1;

      if (keyWords.length >= 2 && searchPos < totalWords) {
        const windowLimit = totalWords - 1;
        outer: for (let i = searchPos; i <= windowLimit; i++) {
          if (!wordNorms[i]?.includes(keyWords[0]!)) continue;
          // Anchored on keyWords[0]; greedily find each subsequent keyword
          // within FUZZY_MAX_GAP_BETWEEN_KEYWORDS of the previous one.
          let cursor = i;
          let last = i;
          for (let ki = 1; ki < keyWords.length; ki++) {
            const searchStart = last + 1;
            const searchLimit = Math.min(last + 1 + FUZZY_MAX_GAP_BETWEEN_KEYWORDS, totalWords - 1);
            let found = -1;
            for (let j = searchStart; j <= searchLimit; j++) {
              if (wordNorms[j]?.includes(keyWords[ki]!)) {
                found = j;
                break;
              }
            }
            if (found < 0) {
              // Anchor failed — advance outer loop to look for the next
              // occurrence of keyWords[0].
              continue outer;
            }
            cursor = found;
            last = found;
          }
          // All keywords found within gap tolerance. Use the first
          // keyword's word index as the start, and the last keyword's
          // word end as the end.
          matchStart = i;
          matchEnd = cursor;
          break;
        }
      }

      if (matchStart >= 0) {
        const tStart = words[matchStart]!.start;
        const tEnd = words[matchEnd]!.end;
        // Clamp to pageStartAudioTime so marks earlier than the audio
        // position fire immediately rather than being skipped.
        startTimes.push(Math.max(pageStartAudioTime, tStart));
        endTimes.push(Math.max(pageStartAudioTime, tEnd));
        searchPos = matchEnd + 1; // advance so next mark searches forward
      } else {
        // Proportional fallback: pace from the previous end time. Cap to
        // chapter end so a long tail of unmatchable marks never
        // extrapolates past the audio content, which would make speak()
        // block forever waiting for a time the audio will never reach.
        const prevEnd = endTimes.length > 0 ? endTimes[endTimes.length - 1]! : pageStartAudioTime;
        const markWords = Math.max(1, mark.text.trim().split(/\s+/).length);
        const start = Math.min(prevEnd, chapterEndTime || prevEnd);
        const end = Math.min(prevEnd + markWords * fallbackSpw, chapterEndTime || prevEnd);
        startTimes.push(start);
        endTimes.push(end);
      }
    }

    return { startTimes, endTimes };
  }

  // ── Chapter-start seek ────────────────────────────────────────────────────────

  /**
   * When a chapter first loads with no saved position (savedPos === 0), the
   * audio would start at t=0 while the reader might be deep into that chapter.
   * This method seeks the audio to the position corresponding to the first
   * mark on the current page, so narration starts where the reader is.
   *
   * Uses the same fuzzy matching logic as seekToText but against the
   * already-loaded timestamps and always picks the earliest match.
   */
  async #seekToPageStart(
    firstMarkText: string,
    timestamps: CachedChapterTimestamps,
  ): Promise<void> {
    if (!this.#audioEl || !firstMarkText.trim()) return;

    const keyWords = this.#extractKeywords(firstMarkText, 3, 5);
    if (keyWords.length === 0) return;

    const matchIndex = this.#findKeywordMatches(keyWords, timestamps.normalizedWords)[0];
    if (matchIndex !== undefined) {
      const targetTime = timestamps.data.words[matchIndex]!.start;
      console.info(
        `[AudiobookTTSClient] chapter start seek: "${firstMarkText.slice(0, 40)}" → ${targetTime.toFixed(2)}s`,
      );
      this.#setAudioTime(targetTime);
      return;
    }

    console.info(
      `[AudiobookTTSClient] chapter start seek: no match for "${firstMarkText.slice(0, 40)}" — starting from 0`,
    );
  }

  // ── Preload helpers ───────────────────────────────────────────────────────────

  /** Preload the next chapter's audio element and timestamps into cache. */
  #preloadNextChapter(currentChapterIndex: number): void {
    if (!this.#manifest) return;
    const nextChapter = this.#manifest.chapters.find((c) => c.index === currentChapterIndex + 1);
    if (!nextChapter) return;

    if (!this.#nextAudioEl) {
      this.#nextAudioEl = new Audio();
      this.#nextAudioEl.preload = 'auto';
    }
    if (this.#nextAudioEl.src !== nextChapter.audio_url) {
      this.#nextAudioEl.src = nextChapter.audio_url;
    }
    // Fire-and-forget timestamps prefetch into cache
    this.#loadTimestamps(nextChapter.timestamps_url);
  }

  async #waitForAudioReady(audio: HTMLAudioElement): Promise<void> {
    if (audio.readyState >= 1) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('canplay', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      audio.addEventListener('loadedmetadata', done, { once: true });
      audio.addEventListener('canplay', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      audio.load?.();
    });
  }

  async #setActiveChapter(chapter: AudiobookChapter): Promise<void> {
    if (!this.#audioEl) return;
    const chapterChanged = this.#currentChapterIndex !== chapter.index;
    if (!chapterChanged) {
      this.#audioEl.playbackRate = this.#playbackRate;
      return;
    }

    if (
      this.#nextAudioEl &&
      this.#nextAudioEl.src === chapter.audio_url &&
      this.#nextAudioEl.readyState >= 1
    ) {
      const prev = this.#audioEl;
      prev.pause();
      prev.removeEventListener('timeupdate', this.#handleTimeUpdate);
      this.#audioEl = this.#nextAudioEl;
      this.#audioEl.addEventListener('timeupdate', this.#handleTimeUpdate);
      this.#nextAudioEl = prev;
      this.#nextAudioEl.src = '';
    } else if (this.#audioEl.src !== chapter.audio_url) {
      this.#audioEl.src = chapter.audio_url;
    }

    await this.#waitForAudioReady(this.#audioEl);
    this.#audioEl.playbackRate = this.#playbackRate;
    this.#currentChapterIndex = chapter.index;
    this.#dispatchCurrentTime(true);
  }

  // ── Resume position ───────────────────────────────────────────────────────────

  #positionKey(chapterIndex: number): string {
    return `audiobook-pos:${this.#manifestUrl}:${chapterIndex}`;
  }

  #savePosition(): void {
    if (!this.#audioEl || this.#currentChapterIndex < 0) return;
    const t = this.#audioEl.currentTime;
    if (t > 0) {
      localStorage.setItem(this.#positionKey(this.#currentChapterIndex), String(t));
    }
  }

  #loadPosition(chapterIndex: number): number {
    const raw = localStorage.getItem(this.#positionKey(chapterIndex));
    return raw ? parseFloat(raw) || 0 : 0;
  }

  // ── Time update ───────────────────────────────────────────────────────────────

  #dispatchCurrentTime(force = false): void {
    if (!this.#audioEl || !this.#manifest) return;
    const now = Date.now();
    if (!force && now - this.#lastTimeDispatchMs < 250) return;
    this.#lastTimeDispatchMs = now;
    const chapter = this.#findChapterByIndex(this.#currentChapterIndex);
    this.controller?.dispatchEvent(
      new CustomEvent('tts-audiobook-time', {
        detail: {
          currentTime: this.#audioEl.currentTime,
          duration: this.#audioEl.duration || chapter?.duration_seconds || 0,
          chapterTitle: chapter?.title ?? '',
          narratorName: this.#manifest.voice_name,
        },
      }),
    );
  }

  /** Throttled to ~4 Hz; dispatches current playback position to the controller. */
  #handleTimeUpdate = (): void => {
    this.#dispatchCurrentTime();
  };

  #setAudioTime(seconds: number): void {
    if (!this.#audioEl) return;
    const duration = Number.isFinite(this.#audioEl.duration) && this.#audioEl.duration > 0;
    const maxTime = duration ? this.#audioEl.duration : seconds;
    this.#audioEl.currentTime = Math.max(0, Math.min(maxTime, seconds));
    this.#savePosition();
    this.#dispatchCurrentTime(true);
  }

  // ── Error dispatching ─────────────────────────────────────────────────────────

  #dispatchError(message: string): void {
    this.controller?.dispatchEvent(new CustomEvent('tts-error', { detail: { message } }));
  }

  // ── Playback helpers ─────────────────────────────────────────────────────────

  /** Resolves when audio.currentTime >= targetTime, the audio ends, or signal fires. */
  #waitUntilTime(targetTime: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const audio = this.#audioEl!;
      let rafId: number;
      const onAbort = () => done();
      const onEnded = () => done();

      const done = () => {
        cancelAnimationFrame(rafId);
        signal.removeEventListener('abort', onAbort);
        audio.removeEventListener('ended', onEnded);
        resolve();
      };

      const tick = () => {
        if (signal.aborted || audio.ended || audio.paused || audio.currentTime >= targetTime) {
          done();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      audio.addEventListener('ended', onEnded, { once: true });
      rafId = requestAnimationFrame(tick);
    });
  }

  // ── Core speak ───────────────────────────────────────────────────────────────

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    // Preload is a no-op for audiobooks; we can't pre-synthesise
    if (preload) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    if (!this.#manifest || !this.#audioEl) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (marks.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const sectionLabel = this.controller?.sectionLabel ?? '';
    const firstMarkText = marks[0]?.text.trim() ?? '';
    const resolvedTextMatch =
      firstMarkText.length > 0
        ? await this.#locateTextMatch(firstMarkText, {
            preferredChapterIndex:
              this.#currentChapterIndex > 0 ? this.#currentChapterIndex : undefined,
            sectionLabel,
          })
        : null;

    const chapter =
      resolvedTextMatch?.chapter ??
      this.#getSourceMatchedChapters()[0] ??
      this.#findChapterByIndex(this.#currentChapterIndex) ??
      this.#findChapter(sectionLabel);

    if (!chapter) {
      console.info(`[AudiobookTTSClient] No chapter matched "${sectionLabel}" — skipping`);
      this.#dispatchError(
        `No audiobook chapter matched "${sectionLabel}". Check that the manifest title matches the EPUB chapter.`,
      );
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const timestamps =
      resolvedTextMatch?.chapter.index === chapter.index
        ? resolvedTextMatch.timestamps
        : await this.#loadTimestamps(chapter.timestamps_url);
    if (!timestamps || timestamps.data.words.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    // Load new audio source only when the chapter changes (i.e. first
    // speak() of a chapter). Between pages within the same chapter, the
    // audio element keeps playing continuously — stop() only pauses it,
    // doesn't reset currentTime.
    const chapterChanged = this.#currentChapterIndex !== chapter.index;
    if (chapterChanged) {
      await this.#setActiveChapter(chapter);
      const savedPos = this.#loadPosition(chapter.index);
      if (savedPos > 0) {
        this.#setAudioTime(savedPos);
      } else if (resolvedTextMatch?.chapter.index === chapter.index) {
        this.#setAudioTime(resolvedTextMatch.targetTime);
      } else if (marks.length > 0) {
        // No saved position — seek to the first mark's text so the audio
        // starts at the current page rather than from the chapter beginning.
        const chapterStartText = marks[0]!.text.trim().split(/\s+/).slice(0, 10).join(' ');
        await this.#seekToPageStart(chapterStartText, timestamps);
      }
    }

    // Preload the next chapter in the background
    this.#preloadNextChapter(chapter.index);

    const pageStartAudioTime = this.#audioEl.currentTime;
    const chapterEndTime = timestamps.data.words[timestamps.data.words.length - 1]!.end;

    // Audio-past-chapter fast-path: if the audio has already advanced past
    // the last word of the chapter (e.g. because a previous block's marks
    // fell through to proportional pacing and the reader is still catching
    // up), dispatch this block's marks in rapid succession and yield 'end'
    // so the reader advances until it matches the audio. Avoids speak()
    // hanging on a target time the audio will never reach.
    if (pageStartAudioTime >= chapterEndTime && chapterEndTime > 0) {
      console.info(
        `[AudiobookTTSClient] audio past chapter end (t=${pageStartAudioTime.toFixed(2)} ≥ ` +
          `chapterEnd=${chapterEndTime.toFixed(2)}) — rapid-dispatch ${marks.length} marks`,
      );
      try {
        await this.#audioEl.play();
      } catch {
        // Safe to ignore — we're just catching the reader up.
      }
      for (const mark of marks) {
        if (signal.aborted) break;
        this.controller?.dispatchSpeakMark(mark);
        yield { code: 'boundary', mark: mark.name } as TTSMessageEvent;
      }
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    // Match each mark to its actual word-level timestamp, anchored to the
    // current audio position. Re-anchoring at every page turn self-corrects
    // any accumulated drift. Falls back to proportional pacing for marks
    // whose text cannot be matched against the timestamp word list.
    const { startTimes: sentenceStartTimes } = this.#matchMarksToTimestamps(
      marks,
      timestamps,
      pageStartAudioTime,
    );

    console.info(
      `[AudiobookTTSClient] speak: chapter=${chapter.index} chapterChanged=${chapterChanged} ` +
        `audioT=${pageStartAudioTime.toFixed(2)} marks=${marks.length} ` +
        `lastMarkAt=${sentenceStartTimes[sentenceStartTimes.length - 1]?.toFixed(2)}`,
    );

    try {
      await this.#audioEl.play();
    } catch (e) {
      console.warn('[AudiobookTTSClient] play() failed:', e);
      yield { code: 'error', message: String(e) } as TTSMessageEvent;
      return;
    }

    // Dispatch each mark when audio reaches its estimated start time.
    //
    // Key invariants of the new sync model:
    //   1. Audio is the single source of truth — we NEVER seek it forward
    //      at a block boundary. Doing so would skip unheard narration.
    //   2. If the audio has already passed a mark's start time (because the
    //      reader is catching up to the narrator), dispatch it immediately.
    //   3. We do NOT wait for the last sentence's *end* time before yielding
    //      'end'. The audio keeps playing continuously between blocks; the
    //      next block's first mark will naturally wait for the audio to
    //      arrive at its true position. Removing the end-wait eliminates
    //      the hang that occurred when proportional-pacing estimates
    //      extrapolated past the chapter content.
    //
    // Seek-alignment: after a user-initiated seek (e.g. long-press on a word
    // later in the chapter) the audio jumps forward but speak() is handed an
    // SSML payload starting at the top of the current block. Without
    // correction, every mark whose sentenceStart < audioT would be dispatched
    // back-to-back, and the audio-leader would race the reader's cursor
    // through each intervening sentence. Skip ahead to the mark whose
    // sentence window actually contains the current audio time.
    let startIdx = 0;
    {
      const now = this.#audioEl.currentTime;
      for (let i = 0; i < sentenceStartTimes.length; i++) {
        const s = sentenceStartTimes[i];
        if (s === undefined) continue;
        const next = sentenceStartTimes[i + 1];
        if (s <= now && (next === undefined || now < next)) {
          startIdx = i;
          break;
        }
        // If every known start time is in the future, the first waitUntilTime
        // will block anyway — leaving startIdx=0 is correct.
      }
      if (startIdx > 0) {
        console.info(
          `[AudiobookTTSClient] seek-align: audioT=${now.toFixed(2)} → skipping ` +
            `${startIdx} past-time mark${startIdx === 1 ? '' : 's'} (first dispatch at mark ${startIdx})`,
        );
      }
    }

    for (let i = startIdx; i < marks.length; i++) {
      if (signal.aborted) break;

      const mark = marks[i]!;
      const sentenceStart = sentenceStartTimes[i] ?? this.#audioEl.currentTime;

      if (this.#audioEl.currentTime < sentenceStart) {
        await this.#waitUntilTime(sentenceStart, signal);
      }

      if (signal.aborted) break;

      this.controller?.dispatchSpeakMark(mark);
      yield { code: 'boundary', mark: mark.name } as TTSMessageEvent;
    }

    if (signal.aborted) {
      this.#audioEl.pause();
      this.#savePosition();
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    console.info(
      `[AudiobookTTSClient] page done → end (audioT=${this.#audioEl.currentTime.toFixed(2)})`,
    );
    // Audio continues playing; controller calls forward() on 'end'.
    yield { code: 'end' } as TTSMessageEvent;
  }

  // ── Transport controls ───────────────────────────────────────────────────────

  async pause(): Promise<boolean> {
    this.#audioEl?.pause();
    this.#savePosition();
    this.#dispatchCurrentTime(true);
    return false;
  }

  async resume(): Promise<boolean> {
    try {
      await this.#audioEl?.play();
    } catch {}
    return true;
  }

  async stop(): Promise<void> {
    // TTSController calls stop() both on user-stop AND between pages
    // (inside forward()/backward()). We can't tell these cases apart,
    // so we just pause + save position. The audio stays cued where it
    // is; the next speak() call will resume from this position without
    // reloading the src. Shutdown handles real cleanup.
    if (this.#audioEl) {
      this.#savePosition();
      this.#audioEl.pause();
      this.#dispatchCurrentTime(true);
    }
    // Keep #currentChapterIndex so same-chapter speak() calls skip reload.
  }

  /** Skip backward by the given number of seconds (default 15). */
  async skipBack(seconds = 15): Promise<void> {
    if (this.#audioEl) {
      this.#setAudioTime(this.#audioEl.currentTime - seconds);
    }
  }

  /** Skip forward by the given number of seconds (default 30). */
  async skipForward(seconds = 30): Promise<void> {
    if (this.#audioEl) {
      this.#setAudioTime(this.#audioEl.currentTime + seconds);
    }
  }

  /** Seek to an absolute time in seconds within the current chapter. */
  async seekTo(seconds: number): Promise<void> {
    if (this.#audioEl) {
      this.#setAudioTime(seconds);
    }
  }

  #seekWithinChapterText(
    text: string,
    timestamps: CachedChapterTimestamps,
    preferNearest = true,
  ): boolean {
    if (!this.#audioEl || timestamps.data.words.length === 0) return false;

    const keyWords = this.#extractKeywords(text, 2, 4);
    if (keyWords.length === 0) return false;

    const matches = this.#findKeywordMatches(keyWords, timestamps.normalizedWords);
    if (matches.length === 0) {
      console.info(`[AudiobookTTSClient] seekToText: no match for "${text.slice(0, 40)}"`);
      return false;
    }

    const now = this.#audioEl.currentTime;
    const best = preferNearest
      ? matches.reduce((closest, candidate) => {
          const closestDistance = Math.abs((timestamps.data.words[closest]?.start ?? 0) - now);
          const candidateDistance = Math.abs((timestamps.data.words[candidate]?.start ?? 0) - now);
          return candidateDistance < closestDistance ? candidate : closest;
        }, matches[0]!)
      : matches[0]!;

    const targetTime = timestamps.data.words[best]!.start;
    console.info(
      `[AudiobookTTSClient] seekToText: "${text.slice(0, 40)}" → ${targetTime.toFixed(2)}s`,
    );
    this.#setAudioTime(targetTime);
    return true;
  }

  /**
   * Search the current chapter's word timestamps for the given text and seek
   * audio to the matched position. Used when the user selects a word/passage
   * and taps the headphones icon — a "re-orient the narrator" control.
   *
   * Picks the match closest to the current audio position so both rewind and
   * fast-forward work naturally. Returns true if a match was found.
   */
  async seekToText(text: string): Promise<boolean> {
    if (!this.#manifest || !this.#audioEl || this.#currentChapterIndex < 0) return false;
    const chapter = this.#findChapterByIndex(this.#currentChapterIndex);
    if (!chapter) return false;
    const timestamps = await this.#loadTimestamps(chapter.timestamps_url);
    if (!timestamps) return false;
    return this.#seekWithinChapterText(text, timestamps, true);
  }

  async cueToText(text: string, chapterIndex?: number): Promise<boolean> {
    if (!this.#manifest || !this.#audioEl) return false;
    const match = await this.#locateTextMatch(text, {
      preferredChapterIndex:
        chapterIndex ?? (this.#currentChapterIndex > 0 ? this.#currentChapterIndex : undefined),
      sectionLabel: this.controller?.sectionLabel ?? '',
    });

    if (!match) {
      this.#dispatchCurrentTime(true);
      return false;
    }

    await this.#setActiveChapter(match.chapter);
    this.#setAudioTime(match.targetTime);
    this.#audioEl.pause();
    this.#savePosition();
    this.#dispatchCurrentTime(true);
    return true;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  async setRate(rate: number): Promise<void> {
    this.#playbackRate = rate;
    if (this.#audioEl) this.#audioEl.playbackRate = rate;
  }

  async setPitch(_pitch: number): Promise<void> {
    // Pitch adjustment on HTMLAudioElement requires Web Audio API — skipped for now
  }

  async setVoice(_voice: string): Promise<void> {
    // Audiobooks have a fixed voice baked in at generation time
  }

  // ── Voice enumeration ────────────────────────────────────────────────────────

  async getAllVoices(): Promise<TTSVoice[]> {
    if (!this.#manifest) return [];
    return [
      {
        id: 'audiobook',
        name: `Audiobook — ${this.#manifest.voice_name}`,
        lang: 'en',
      },
    ];
  }

  async getVoices(_lang: string): Promise<TTSVoicesGroup[]> {
    return [
      {
        id: 'audiobook',
        name: 'Audiobook',
        voices: await this.getAllVoices(),
        disabled: !this.initialized,
      },
    ];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return 'audiobook';
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  // ── Public helpers ───────────────────────────────────────────────────────────

  /** The number of chapters available in this audiobook (for UI display). */
  get chapterCount(): number {
    return this.#manifest?.total_chapters ?? 0;
  }

  /** Title of the audiobook (for UI display). */
  get audiobookTitle(): string {
    return this.#manifest?.title ?? '';
  }

  /** Narrator (voice) name for display. */
  get narratorName(): string {
    return this.#manifest?.voice_name ?? '';
  }

  /** All chapters for the chapter-list UI. */
  getChapters(): { index: number; title: string; duration_seconds: number }[] {
    return (
      this.#manifest?.chapters.map((c) => ({
        index: c.index,
        title: c.title,
        duration_seconds: c.duration_seconds,
      })) ?? []
    );
  }

  /**
   * Set the current chapter directly (used when the user jumps from the chapter list).
   * Updates sectionLabel/sectionIndex on the controller so the next speak() call
   * picks the right chapter without waiting for a reader navigation event.
   */
  setCurrentChapterByIndex(chapterIndex: number): void {
    const chapter = this.#manifest?.chapters.find((c) => c.index === chapterIndex);
    if (!chapter || !this.controller) return;
    this.controller.sectionLabel = chapter.title;
    this.controller.sectionIndex = chapterIndex - 1;
  }
}
