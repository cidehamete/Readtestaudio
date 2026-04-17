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

  // ── Timestamp matching ───────────────────────────────────────────────────────

  /**
   * Map each SSML mark (sentence) to a start time in the word-timestamp array.
   *
   * Strategy: take the first 4 non-trivial words of each sentence, normalise
   * them, then do a forward-scanning substring search through the word list.
   * Falls back to proportional distribution if no match is found.
   */
  #wordIndexAtTime(words: AudiobookWord[], time: number): number {
    if (words.length === 0 || time <= 0) return 0;
    let lo = 0,
      hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((words[mid]?.start ?? 0) <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Map each SSML mark (sentence) to a start AND end time in the word-timestamp
   * array.
   *
   * Start: match the first 4 non-trivial words of the sentence against the
   * word list via forward-scanning substring search.
   * End: use the matched word index + markWordCount to look up the actual end
   * time from the word timestamps (far more accurate than start + count×avg).
   *
   * Falls back to word-rate extrapolation when matching fails.
   */
  #buildSentenceTimings(
    words: AudiobookWord[],
    marks: { text: string }[],
    startIdx = 0,
  ): { startTimes: number[]; endTimes: number[] } {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const wordNorms = words.map((w) => norm(w.word));
    const totalDuration = words[words.length - 1]?.end ?? 0;
    const avgWordDuration = words.length > 0 ? totalDuration / words.length : 0.35;

    let searchStartIdx = startIdx;
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    const markWordCounts = marks.map((m) => m.text.trim().split(/\s+/).length);

    const tryMatch = (keyWords: string[]): number => {
      if (keyWords.length === 0) return -1;
      const limit = words.length - keyWords.length;
      for (let i = searchStartIdx; i <= limit; i++) {
        let ok = true;
        for (let j = 0; j < keyWords.length; j++) {
          if (!wordNorms[i + j]?.includes(keyWords[j]!)) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    };

    for (let mi = 0; mi < marks.length; mi++) {
      const mark = marks[mi]!;

      const keyWords = mark.text
        .trim()
        .split(/\s+/)
        .map((w) => norm(w))
        .filter((w) => w.length > 1)
        .slice(0, 4);

      // Try primary match; if that fails, try skipping the first keyword
      // (handles occasional leading stray tokens).
      let matchedIdx = tryMatch(keyWords);
      if (matchedIdx < 0) matchedIdx = tryMatch(keyWords.slice(1));

      const markWordCount = markWordCounts[mi]!;

      if (matchedIdx >= 0) {
        startTimes.push(words[matchedIdx]!.start);
        // End = actual end time of the last word covered by this mark's length
        const endIdx = Math.min(matchedIdx + markWordCount - 1, words.length - 1);
        endTimes.push(words[endIdx]!.end);
        searchStartIdx = matchedIdx + 1;
      } else {
        // Fallback: extrapolate from previous mark's end.
        const prevEnd =
          endTimes[mi - 1] ?? words[searchStartIdx]?.start ?? words[startIdx]?.start ?? 0;
        startTimes.push(prevEnd);
        endTimes.push(prevEnd + markWordCount * avgWordDuration);
      }
    }

    // Enforce monotonic non-decreasing start times — matched/extrapolated
    // values can occasionally drift backward.
    for (let i = 1; i < startTimes.length; i++) {
      if (startTimes[i]! < startTimes[i - 1]!) {
        startTimes[i] = startTimes[i - 1]! + avgWordDuration;
      }
      if (endTimes[i]! < startTimes[i]!) {
        endTimes[i] = startTimes[i]! + avgWordDuration;
      }
    }

    return { startTimes, endTimes };
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
      }
    }

    // Preload the next chapter in the background
    this.#preloadNextChapter(chapter.index);

    // Seed search index with a 2s backward tolerance so a sentence that
    // started just before the current audio time can still be matched.
    const pageStartAudioTime = this.#audioEl.currentTime;
    const searchSeedTime = Math.max(0, pageStartAudioTime - 2.0);
    const audioStartIdx = this.#wordIndexAtTime(timestamps.words, searchSeedTime);
    const { startTimes: sentenceStartTimes, endTimes: sentenceEndTimes } =
      this.#buildSentenceTimings(timestamps.words, marks, audioStartIdx);

    console.info(
      `[AudiobookTTSClient] speak: chapter=${chapter.index} chapterChanged=${chapterChanged} ` +
        `audioT=${pageStartAudioTime.toFixed(2)} marks=${marks.length} ` +
        `sentenceTimes=[${sentenceStartTimes.map((t) => t.toFixed(1)).join(', ')}] ` +
        `end=${sentenceEndTimes[sentenceEndTimes.length - 1]?.toFixed(1)}`,
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
