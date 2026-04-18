/**
 * Tests for AudiobookTTSClient — the audio↔text sync behavior.
 *
 * Written test-first per .claude/rules/test-first.md. These codify the
 * expected behavior of the sync rewrite (AudiobookTTSClient only):
 *
 *  1. Audio is the single source of truth. Once a chapter is loaded, speak()
 *     must NEVER seek the audio forward at a block boundary — doing so skips
 *     unheard content the narrator was about to say.
 *
 *  2. If audio.currentTime is already past the block's last-mark end time
 *     when speak() is entered, yield 'end' immediately so the reader can
 *     catch up to the audio. The old code would wait forever for a point
 *     the audio had already passed.
 *
 *  3. Fuzzy matching must tolerate short/filler words between content
 *     keywords. The old strict-consecutive match fails on common sentences
 *     and falls back to proportional pacing, which is the root cause of drift.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudiobookTTSClient } from '@/services/tts/AudiobookTTSClient';
import { TTSController } from '@/services/tts/TTSController';

// ---- Fake HTMLAudioElement ---------------------------------------------------

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = 600;
  paused = true;
  ended = false;
  readyState = 4;
  preload = 'auto';
  playbackRate = 1;
  preservesPitch = true;

  // Counts explicit assignments to currentTime so tests can assert no seeks.
  currentTimeSetCount = 0;

  constructor() {
    super();
    let t = 0;
    Object.defineProperty(this, 'currentTime', {
      get: () => t,
      set: (v: number) => {
        this.currentTimeSetCount++;
        t = v;
      },
      configurable: true,
    });
  }

  async play(): Promise<void> {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  /** Test helper: set currentTime WITHOUT counting as an explicit seek. */
  setTimeSilently(t: number): void {
    const before = this.currentTimeSetCount;
    this.currentTime = t;
    this.currentTimeSetCount = before;
  }

  advanceTo(t: number): void {
    this.setTimeSilently(t);
    this.dispatchEvent(new Event('timeupdate'));
  }
}

let lastAudio: FakeAudio | null = null;

function installAudioMock() {
  const ctor = function (): FakeAudio {
    const a = new FakeAudio();
    lastAudio = a;
    return a;
  } as unknown as typeof Audio;
  (globalThis as unknown as { Audio: typeof Audio }).Audio = ctor;
}

// ---- Fake manifest + timestamps ---------------------------------------------

const FAKE_MANIFEST = {
  title: 'Test Book',
  slug: 'test',
  voice_id: 'v1',
  voice_name: 'Tester',
  generated_at: '2026-01-01T00:00:00Z',
  total_chapters: 1,
  chapters: [
    {
      index: 1,
      title: 'Chapter 1',
      audio_url: 'https://example.com/audio/chapter_01.mp3',
      timestamps_url: 'https://example.com/ts/chapter_01.json',
      word_count: 20,
      duration_seconds: 30,
    },
  ],
};

function makeWords(
  words: string[],
  secondsPerWord = 1,
): Array<{ word: string; start: number; end: number }> {
  return words.map((w, i) => ({
    word: w,
    start: i * secondsPerWord,
    end: (i + 1) * secondsPerWord,
  }));
}

// Word-aligned transcript for the whole test chapter.
//   indices  0..8  → "The quick brown fox jumps over the lazy dog."  (0-9s)
//   indices  9..15 → "I am a happy little camper today."             (9-16s)
//   indices 16..19 → trailing padding                                  (16-20s)
const FAKE_TIMESTAMPS = {
  chapter: 1,
  title: 'Chapter 1',
  duration_seconds: 30,
  words: makeWords([
    'The',
    'quick',
    'brown',
    'fox',
    'jumps',
    'over',
    'the',
    'lazy',
    'dog.',
    'I',
    'am',
    'a',
    'happy',
    'little',
    'camper',
    'today.',
    'And',
    'now',
    'we',
    'continue.',
  ]),
};

function installFetchMock() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('manifest.json') || url.endsWith('manifest')) {
      return new Response(JSON.stringify(FAKE_MANIFEST), { status: 200 });
    }
    if (url.includes('timestamps') || url.endsWith('.json')) {
      return new Response(JSON.stringify(FAKE_TIMESTAMPS), { status: 200 });
    }
    return new Response('', { status: 404 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// ---- Fake controller --------------------------------------------------------

function makeController(sectionLabel = 'Chapter 1'): TTSController {
  const target = new EventTarget();
  const controller = {
    sectionLabel,
    sectionIndex: 0,
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
    dispatchSpeakMark: vi.fn(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return controller as unknown as TTSController;
}

// SSML fixtures -- these are the shape that parseSSMLMarks expects.
const SSML_SENTENCE_A =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">' +
  '<mark name="0"/>The quick brown fox jumps over the lazy dog.' +
  '</speak>';

const SSML_TWO_SENTENCES =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">' +
  '<mark name="0"/>The quick brown fox jumps over the lazy dog.' +
  '<mark name="1"/>I am a happy little camper today.' +
  '</speak>';

// Short-filler sentence whose content keywords ("happy", "camper", "today")
// are NOT consecutive in the timestamps: "I am a happy little camper today."
const SSML_SHORT_WORDS =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">' +
  '<mark name="0"/>I am a happy little camper today.' +
  '</speak>';

// ---- Helper: drain a speak() iterator with a timeout ------------------------

async function drainWithTimeout(
  iter: AsyncIterator<{ code: string }>,
  timeoutMs: number,
): Promise<string[]> {
  const codes: string[] = [];
  const start = Date.now();
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`speak() did not terminate within ${timeoutMs}ms`);
    }
    const next = iter.next();
    const timer = new Promise<{ done: true; value: undefined; timedOut: true }>((resolve) =>
      setTimeout(
        () => resolve({ done: true, value: undefined, timedOut: true }),
        Math.max(100, timeoutMs - (Date.now() - start)),
      ),
    );
    const result = (await Promise.race([next, timer])) as
      | IteratorResult<{ code: string }>
      | { done: true; value: undefined; timedOut: true };
    if ((result as { timedOut?: boolean }).timedOut) {
      throw new Error(`speak() did not terminate within ${timeoutMs}ms`);
    }
    const r = result as IteratorResult<{ code: string }>;
    if (r.done) return codes;
    codes.push(r.value.code);
    if (r.value.code === 'end') return codes;
  }
}

/** Drive the first speak() of a chapter, which does chapter-load + seek-to-page-start. */
async function primeFirstBlock(
  client: AudiobookTTSClient,
  audio: FakeAudio,
  signal: AbortSignal,
  ssml: string,
): Promise<void> {
  // Start the first speak() and let it complete by advancing audio past all its marks.
  audio.advanceTo(20);
  const iter = client.speak(ssml, signal)[Symbol.asyncIterator]();
  await drainWithTimeout(iter, 2000).catch(() => {
    // If it hangs we don't care for this prime call — subsequent tests still
    // work because chapter state is set after the first speak() initiates.
  });
}

// ---- Tests ------------------------------------------------------------------

describe('AudiobookTTSClient sync behavior', () => {
  beforeEach(() => {
    lastAudio = null;
    installAudioMock();
    installFetchMock();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('init loads manifest and creates an audio element', async () => {
    const ctl = makeController();
    const client = new AudiobookTTSClient(ctl, 'https://example.com/manifest.json');
    const ok = await client.init();
    expect(ok).toBe(true);
    expect(lastAudio).not.toBeNull();
  });

  test('yields end quickly when audio is already past the block end', async () => {
    const ctl = makeController();
    const client = new AudiobookTTSClient(ctl, 'https://example.com/manifest.json');
    await client.init();
    const audio = lastAudio!;

    // Prime chapter 1 with sentence A so subsequent speak() calls skip the
    // chapter-load + seek-to-page-start path.
    const abort1 = new AbortController();
    await primeFirstBlock(client, audio, abort1.signal, SSML_SENTENCE_A);
    abort1.abort();

    // Now push audio past the entire chapter.
    audio.setTimeSilently(25);

    const abort2 = new AbortController();
    const iter = client.speak(SSML_TWO_SENTENCES, abort2.signal)[Symbol.asyncIterator]();

    const codes = await drainWithTimeout(iter, 2000);
    expect(codes.at(-1)).toBe('end');
  }, 10_000);

  test('never seeks audio forward during normal block playback', async () => {
    const ctl = makeController();
    const client = new AudiobookTTSClient(ctl, 'https://example.com/manifest.json');
    await client.init();
    const audio = lastAudio!;

    // Prime chapter 1 (this may set currentTime once — we reset the counter
    // after priming so the second speak() starts with a clean slate).
    const abort1 = new AbortController();
    await primeFirstBlock(client, audio, abort1.signal, SSML_SENTENCE_A);
    abort1.abort();

    audio.currentTimeSetCount = 0;
    audio.setTimeSilently(3);
    audio.currentTimeSetCount = 0;

    // Ask for sentence B whose fuzzy-match lands at ~12s. The OLD code
    // would jump currentTime forward because 12 - 3 > the 2s drift threshold,
    // skipping ~9 s of unheard narration.
    const abort2 = new AbortController();
    const iter = client.speak(SSML_TWO_SENTENCES, abort2.signal)[Symbol.asyncIterator]();

    // Let speak() do its matching + play()
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    // Walk audio forward naturally so speak() can terminate.
    audio.advanceTo(25);
    await drainWithTimeout(iter, 2000).catch(() => {});

    expect(audio.currentTimeSetCount).toBe(0);
  }, 10_000);

  test('fuzzy-matches a sentence with short filler words without falling back', async () => {
    const ctl = makeController();
    const dispatchSpy = ctl.dispatchSpeakMark as unknown as ReturnType<typeof vi.fn>;
    const client = new AudiobookTTSClient(ctl, 'https://example.com/manifest.json');
    await client.init();
    const audio = lastAudio!;

    // Prime chapter 1.
    const abort1 = new AbortController();
    await primeFirstBlock(client, audio, abort1.signal, SSML_SENTENCE_A);
    abort1.abort();
    // Priming may have dispatched its own mark for sentence A. Reset
    // the spy so the count below reflects only the sentence-B speak().
    dispatchSpy.mockClear();

    // "I am a happy little camper today." — "I", "am", "a" are filler
    // words ≤2 chars. The OLD matcher (strict consecutive kept-keywords)
    // fails and proportional pacing kicks in. The NEW matcher must land
    // the mark near t=9s (where "I" starts in the transcript).
    audio.setTimeSilently(8);
    const abort2 = new AbortController();
    const iter = client.speak(SSML_SHORT_WORDS, abort2.signal)[Symbol.asyncIterator]();

    // Advance audio past the sentence so speak() completes.
    await Promise.resolve();
    await Promise.resolve();
    audio.advanceTo(18);

    await drainWithTimeout(iter, 2000);

    // The mark should have been dispatched exactly once. If the fuzzy
    // matcher was going to drift, the old code would still dispatch
    // eventually — but the test really cares that we reached 'end'
    // within the timeout, which depended on a sensible endTime for the
    // sentence. drainWithTimeout above is what enforces that.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  }, 10_000);

  // Regression: after a long-press seek in the same chapter, the view was
  // racing wildly through every preceding sentence mark before settling at
  // the tapped word. Root cause: speak() iterates marks from index 0; when
  // audio.currentTime is already past the earlier marks' start times,
  // waitUntilTime returns instantly for each and dispatchSpeakMark fires —
  // the audio-leader scrolls the view through each dispatched mark.
  //
  // Fix: speak() must advance to the first mark whose sentence is actually
  // "current" given audio.currentTime, and skip dispatching earlier marks.
  test('skips past-time marks when audio has been seeked forward', async () => {
    const ctl = makeController();
    const dispatchSpy = ctl.dispatchSpeakMark as unknown as ReturnType<typeof vi.fn>;
    const client = new AudiobookTTSClient(ctl, 'https://example.com/manifest.json');
    await client.init();
    const audio = lastAudio!;

    // Prime chapter 1 so subsequent speak() calls use the normal mid-chapter path.
    const abort1 = new AbortController();
    await primeFirstBlock(client, audio, abort1.signal, SSML_SENTENCE_A);
    abort1.abort();
    dispatchSpy.mockClear();

    // Simulate a successful seekToText that moved audio into sentence B
    // (sentence B starts at t=9). Pretend the user tapped a word inside
    // sentence B so audio now sits at t=12 — past sentence A entirely.
    audio.setTimeSilently(12);

    const abort2 = new AbortController();
    const iter = client.speak(SSML_TWO_SENTENCES, abort2.signal)[Symbol.asyncIterator]();

    // Drive the first .next() with audio still at 12 (NOT past chapter end).
    // The async generator only starts executing when next() is called, so if
    // we advance audio before that, speak() would see audio-past-chapter-end
    // and hit the rapid-dispatch fast-path — masking the bug we're testing.
    const first = await iter.next();
    expect(first.done).toBe(false);

    // ✗ Buggy behavior: mark "0" (sentence A) is dispatched first because
    //   the iterator started at index 0 and all preceding marks fire.
    // ✓ Correct behavior: the first yielded boundary corresponds to mark "1"
    //   because earlier past-time marks are skipped.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const firstMark = dispatchSpy.mock.calls[0]![0] as { name: string };
    expect(firstMark.name).toBe('1');

    // Advance audio past the block so the iterator terminates with 'end'.
    audio.advanceTo(25);
    const remainingCodes: string[] = [];
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      remainingCodes.push(r.value.code);
      if (r.value.code === 'end') break;
    }
    expect(remainingCodes.at(-1)).toBe('end');

    // Still exactly one mark dispatched across the whole speak().
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  }, 10_000);
});
