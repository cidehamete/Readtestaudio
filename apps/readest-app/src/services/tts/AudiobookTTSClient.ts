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

// Drift threshold: if audio position deviates more than this from expected, seek to correct.
const SEEK_DRIFT_THRESHOLD_SEC = 2.0;

// Pacing cushion: hold each page slightly longer than the chapter-average
// word rate predicts. Pages pre-estimated at 15 s actually take ~17–18 s
// (pauses, punctuation, phrasing), so a ~18 % cushion keeps the text from
// running ahead of the narrator.
const PAGE_PACING_FACTOR = 1.18;

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

interface AudiobookChapter {
  index: number;
  title: string;
  audio_url: string;
  timestamps_url: string;
  word_count: number;
  duration_seconds: number;
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
  #timestampsCache = new Map<string, AudiobookChapterTimestamps>();
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

  /**
   * Find the manifest chapter matching the current EPUB section label.
   * Three tiers:
   *  1. Exact case-insensitive match.
   *  2. Normalized match (strip numbering, punctuation).
   *  3. Position-based fallback using the EPUB section index.
   */
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

    // Tier 3: position fallback — use EPUB section index to pick the manifest chapter
    const sectionIndex = this.controller?.sectionIndex ?? -1;
    if (sectionIndex >= 0 && sectionIndex < this.#manifest.chapters.length) {
      return this.#manifest.chapters[sectionIndex] ?? null;
    }

    return null;
  }

  async #loadTimestamps(url: string): Promise<AudiobookChapterTimestamps | null> {
    if (this.#timestampsCache.has(url)) return this.#timestampsCache.get(url)!;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AudiobookChapterTimestamps;
      this.#timestampsCache.set(url, data);
      return data;
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
    timestamps: AudiobookChapterTimestamps,
    pageStartAudioTime: number,
  ): { startTimes: number[]; endTimes: number[] } {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const wordNorms = timestamps.words.map((w) => norm(w.word));

    // Find the first word at or after pageStartAudioTime, then step back a few
    // words to allow for minor timing imprecision in the audio element.
    let searchPos = timestamps.words.findIndex((w) => w.start >= pageStartAudioTime);
    if (searchPos < 0) searchPos = timestamps.words.length;
    searchPos = Math.max(0, searchPos - 5);

    // Fallback rate used when fuzzy matching fails.
    const totalDuration = timestamps.words[timestamps.words.length - 1]?.end ?? 0;
    const fallbackSpw =
      totalDuration > 0 && timestamps.words.length > 0
        ? (totalDuration / timestamps.words.length) * PAGE_PACING_FACTOR
        : 0.35 * PAGE_PACING_FACTOR;

    const startTimes: number[] = [];
    const endTimes: number[] = [];

    for (const mark of marks) {
      // Extract up to 4 non-trivial keywords from the mark text for matching.
      const keyWords = norm(mark.text)
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 4);

      let matched = false;

      if (keyWords.length >= 2 && searchPos < timestamps.words.length) {
        const limit = timestamps.words.length - keyWords.length;
        for (let i = searchPos; i <= limit; i++) {
          let ok = true;
          for (let ki = 0; ki < keyWords.length; ki++) {
            if (!wordNorms[i + ki]?.includes(keyWords[ki]!)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            const tStart = timestamps.words[i]!.start;
            const markWordCount = mark.text.trim().split(/\s+/).length;
            const lastWordIdx = Math.min(i + markWordCount - 1, timestamps.words.length - 1);
            const tEnd = timestamps.words[lastWordIdx]!.end;
            // Clamp to pageStartAudioTime: marks before the current audio
            // position fire immediately rather than being skipped.
            startTimes.push(Math.max(pageStartAudioTime, tStart));
            endTimes.push(Math.max(pageStartAudioTime, tEnd));
            searchPos = i + 1; // advance cursor so next mark searches forward
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        // Fallback: pace proportionally from the last known position.
        const prevEnd = endTimes.length > 0 ? endTimes[endTimes.length - 1]! : pageStartAudioTime;
        const markWords = Math.max(1, mark.text.trim().split(/\s+/).length);
        startTimes.push(prevEnd);
        endTimes.push(prevEnd + markWords * fallbackSpw);
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
    timestamps: AudiobookChapterTimestamps,
  ): Promise<void> {
    if (!this.#audioEl || !firstMarkText.trim()) return;

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const keyWords = norm(firstMarkText)
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5);
    if (keyWords.length === 0) return;

    const wordNorms = timestamps.words.map((w) => norm(w.word));
    const limit = timestamps.words.length - keyWords.length;

    for (let i = 0; i <= limit; i++) {
      let ok = true;
      for (let ki = 0; ki < keyWords.length; ki++) {
        if (!wordNorms[i + ki]?.includes(keyWords[ki]!)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const targetTime = timestamps.words[i]!.start;
        console.info(
          `[AudiobookTTSClient] chapter start seek: "${firstMarkText.slice(0, 40)}" → ${targetTime.toFixed(2)}s`,
        );
        this.#audioEl.currentTime = targetTime;
        return;
      }
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

  /** Throttled to ~4 Hz; dispatches current playback position to the controller. */
  #handleTimeUpdate = (): void => {
    const now = Date.now();
    if (now - this.#lastTimeDispatchMs < 250) return;
    this.#lastTimeDispatchMs = now;
    if (!this.#audioEl || !this.#manifest) return;
    const chapter = this.#manifest.chapters.find((c) => c.index === this.#currentChapterIndex);
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
  };

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

      const done = () => {
        cancelAnimationFrame(rafId);
        resolve();
      };

      const tick = () => {
        if (signal.aborted || audio.ended || audio.paused || audio.currentTime >= targetTime) {
          done();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };

      signal.addEventListener('abort', done, { once: true });
      audio.addEventListener('ended', done, { once: true });
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

    const sectionLabel = this.controller?.sectionLabel ?? '';
    const chapter = this.#findChapter(sectionLabel);

    if (!chapter) {
      console.info(`[AudiobookTTSClient] No chapter matched "${sectionLabel}" — skipping`);
      this.#dispatchError(
        `No audiobook chapter matched "${sectionLabel}". Check that the manifest title matches the EPUB chapter.`,
      );
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const timestamps = await this.#loadTimestamps(chapter.timestamps_url);
    if (!timestamps || timestamps.words.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (marks.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    // Load new audio source only when the chapter changes (i.e. first
    // speak() of a chapter). Between pages within the same chapter, the
    // audio element keeps playing continuously — stop() only pauses it,
    // doesn't reset currentTime.
    const chapterChanged = this.#currentChapterIndex !== chapter.index;
    if (chapterChanged) {
      // Swap in preloaded element if it already has the right src
      if (
        this.#nextAudioEl &&
        this.#nextAudioEl.src === chapter.audio_url &&
        this.#nextAudioEl.readyState >= 2
      ) {
        const prev = this.#audioEl;
        prev.pause();
        prev.removeEventListener('timeupdate', this.#handleTimeUpdate);
        this.#audioEl = this.#nextAudioEl;
        this.#audioEl.addEventListener('timeupdate', this.#handleTimeUpdate);
        this.#nextAudioEl = prev; // recycle for next preload
        this.#nextAudioEl.src = '';
      } else if (this.#audioEl.src !== chapter.audio_url) {
        this.#audioEl.src = chapter.audio_url;
      }
      this.#audioEl.playbackRate = this.#playbackRate;
      this.#currentChapterIndex = chapter.index;

      const savedPos = this.#loadPosition(chapter.index);
      if (savedPos > 0) {
        this.#audioEl.currentTime = savedPos;
      } else if (marks.length > 0) {
        // No saved position — seek to the first mark's text so the audio
        // starts at the current page rather than from the chapter beginning.
        const firstMarkText = marks[0]!.text.trim().split(/\s+/).slice(0, 6).join(' ');
        await this.#seekToPageStart(firstMarkText, timestamps);
      }
    }

    // Preload the next chapter in the background
    this.#preloadNextChapter(chapter.index);

    // Match each mark to its actual word-level timestamp, anchored to the
    // current audio position. Re-anchoring at every page turn self-corrects
    // any accumulated drift. Falls back to proportional pacing for marks
    // whose text cannot be matched against the timestamp word list.
    const pageStartAudioTime = this.#audioEl.currentTime;
    const { startTimes: sentenceStartTimes, endTimes: sentenceEndTimes } =
      this.#matchMarksToTimestamps(marks, timestamps, pageStartAudioTime);

    console.info(
      `[AudiobookTTSClient] speak: chapter=${chapter.index} chapterChanged=${chapterChanged} ` +
        `audioT=${pageStartAudioTime.toFixed(2)} marks=${marks.length} ` +
        `pageDur=${(sentenceEndTimes[sentenceEndTimes.length - 1]! - pageStartAudioTime).toFixed(2)}s`,
    );

    try {
      await this.#audioEl.play();
    } catch (e) {
      console.warn('[AudiobookTTSClient] play() failed:', e);
      yield { code: 'error', message: String(e) } as TTSMessageEvent;
      return;
    }

    // Dispatch each mark when audio reaches its estimated start time.
    for (let i = 0; i < marks.length; i++) {
      if (signal.aborted) break;

      const mark = marks[i]!;
      const sentenceStart = sentenceStartTimes[i] ?? this.#audioEl.currentTime;

      // Only seek forward if audio has fallen significantly behind.
      // Never seek backwards (would skip already-played content).
      if (this.#audioEl.currentTime < sentenceStart - SEEK_DRIFT_THRESHOLD_SEC) {
        console.info(
          `[AudiobookTTSClient] seek: ${this.#audioEl.currentTime.toFixed(2)} → ${sentenceStart.toFixed(2)}`,
        );
        this.#audioEl.currentTime = sentenceStart;
      }

      // Wait until audio reaches this sentence's start
      await this.#waitUntilTime(sentenceStart, signal);

      if (signal.aborted) break;
      if (this.#audioEl.ended) {
        // Chapter ended mid-page — dispatch remaining marks rapidly
        // so the reader still advances to the chapter end.
        this.controller?.dispatchSpeakMark(mark);
        yield { code: 'boundary', mark: mark.name } as TTSMessageEvent;
        continue;
      }

      this.controller?.dispatchSpeakMark(mark);
      yield { code: 'boundary', mark: mark.name } as TTSMessageEvent;
    }

    // Wait for the end-time of this page's LAST sentence (computed from
    // real word-level timestamps when matched). This prevents yielding
    // 'end' before the audio has finished speaking the block, AND prevents
    // overshooting into the next block — which would make the next block's
    // marks all resolve instantly and the reader would skip a paragraph.
    if (!signal.aborted) {
      const pageEndAudioTime = sentenceEndTimes[sentenceEndTimes.length - 1] ?? pageStartAudioTime;
      if (!this.#audioEl.ended && this.#audioEl.currentTime < pageEndAudioTime) {
        await this.#waitUntilTime(pageEndAudioTime, signal);
      }
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
    return true;
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
    }
    // Keep #currentChapterIndex so same-chapter speak() calls skip reload.
  }

  /** Skip backward by the given number of seconds (default 15). */
  async skipBack(seconds = 15): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.max(0, this.#audioEl.currentTime - seconds);
    }
  }

  /** Skip forward by the given number of seconds (default 30). */
  async skipForward(seconds = 30): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.min(
        this.#audioEl.duration || 0,
        this.#audioEl.currentTime + seconds,
      );
    }
  }

  /** Seek to an absolute time in seconds within the current chapter. */
  async seekTo(seconds: number): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.max(0, Math.min(this.#audioEl.duration || 0, seconds));
    }
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
    const chapter = this.#manifest.chapters.find((c) => c.index === this.#currentChapterIndex);
    if (!chapter) return false;
    const timestamps = await this.#loadTimestamps(chapter.timestamps_url);
    if (!timestamps || timestamps.words.length === 0) return false;

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const keyWords = norm(text)
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 4);
    if (keyWords.length === 0) return false;

    const wordNorms = timestamps.words.map((w) => norm(w.word));
    const limit = timestamps.words.length - keyWords.length;
    const matches: number[] = [];
    for (let i = 0; i <= limit; i++) {
      let ok = true;
      for (let j = 0; j < keyWords.length; j++) {
        if (!wordNorms[i + j]?.includes(keyWords[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(i);
    }

    if (matches.length === 0) {
      console.info(`[AudiobookTTSClient] seekToText: no match for "${text.slice(0, 40)}"`);
      return false;
    }

    // Pick the match closest to the current audio position
    const now = this.#audioEl.currentTime;
    let best = matches[0]!;
    let bestDist = Math.abs((timestamps.words[best]?.start ?? 0) - now);
    for (const m of matches) {
      const d = Math.abs((timestamps.words[m]?.start ?? 0) - now);
      if (d < bestDist) {
        best = m;
        bestDist = d;
      }
    }
    const targetTime = timestamps.words[best]!.start;
    console.info(
      `[AudiobookTTSClient] seekToText: "${text.slice(0, 40)}" → ${targetTime.toFixed(2)}s`,
    );
    this.#audioEl.currentTime = targetTime;
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
