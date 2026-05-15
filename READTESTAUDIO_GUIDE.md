# Readtestaudio — Codebase Guide

A fork of the open-source [Readest](https://github.com/readest/readest) ebook reader, customized to play **pre-generated audiobooks** in sync with on-screen text. This document explains how the audiobook-sync system is wired so you can troubleshoot it from another machine.

The companion repo `audiobook-maker-main` produces the audio/timestamps/manifest that this app consumes. See `AUDIOBOOK_MAKER_GUIDE.md` (when written) for that side.

---

## Guiding principle: audio is the leader

The narrator's voice is the source of truth. The on-screen cursor, paragraph highlight, and page turns all follow `audio.currentTime` — never the reverse. If the audio is at second 47 of a chapter, the reader's job is to figure out which word/page that corresponds to and display it.

The one exception: user-initiated long-press to seek. That moves both audio and view to a tapped word. After the seek, audio is leader again.

---

## Repository layout

```
Readtestaudio/                                  monorepo root
├── apps/readest-app/                           the Next.js app (only thing Vercel builds)
│   ├── src/
│   │   ├── services/tts/                       TTS subsystem — the heart of audiobook sync
│   │   ├── app/reader/                         the reader UI + hooks
│   │   ├── components/                         shared React components
│   │   ├── store/                              Zustand state stores
│   │   └── __tests__/                          Vitest unit tests (mirror src/ tree)
│   ├── src-tauri/                              Rust-side Tauri code (desktop builds only)
│   ├── .env, .env.web, .env.tauri              committed env (NEXT_PUBLIC_* values)
│   └── package.json                            scripts: dev-web, build, test, lint
├── packages/                                   git submodules (see .gitmodules)
│   ├── foliate-js                              ePub renderer engine (required)
│   ├── simplecc-wasm                           Chinese text conversion (required for lint)
│   ├── tauri, tauri-plugins, qcms              desktop-build only
└── pnpm-workspace.yaml                         workspaces: apps/*, packages/foliate-js
```

**Submodules are mandatory.** A bare `git clone` will fail `pnpm install` because `foliate-js@workspace:*` won't resolve. Always use:

```
git clone --recurse-submodules https://github.com/cidehamete/Readtestaudio.git
# or, after a regular clone:
git submodule update --init --recursive
```

---

## The TTS subsystem (where 95% of audiobook bugs live)

Five files in `apps/readest-app/src/services/tts/`:

### `AudiobookTTSClient.ts` (1159 lines, the big one)

Plays MP3 chapters in sync with text. Implements the `TTSClient` interface. Owns one `HTMLAudioElement`.

Key methods:
- **`init()`** — fetches the manifest JSON, creates the `Audio` element, doesn't load any audio yet.
- **`speak(ssml, signal)`** — async generator. Called once per "block" (usually a page or paragraph) of SSML. Parses SSML marks, figures out which audiobook chapter the block belongs to (via `#getSourceMatchedChapters()`), loads that chapter's MP3 if it's not already loaded, then watches `audio.currentTime` and `dispatchSpeakMark` for each word boundary as the audio passes through it. Yields `{code: 'boundary'}` events and finally `{code: 'end'}`.
- **`pause()` / `resume()`** — wrappers around `audio.pause()` / `audio.play()`. iOS Safari note: `resume()` can fail silently if not called from a user gesture (autoplay policy). This is why we have the paused-state guard in `useTTSControl`.
- **`seekToText(text)` / `cueToText(text, chapterHint)`** — fuzzy-match a phrase against the timestamp data and move `audio.currentTime` to that word.

Key data structures (the schema contract with audiobook-maker):

```ts
interface AudiobookChapter {
  index: number;
  title: string;
  audio_url: string;                    // MP3 location
  timestamps_url: string;               // word-level timing JSON
  text_url?: string;                    // (optional) plain-text rendering
  word_count: number;
  duration_seconds: number;
  source_spine_index?: number;          // EPUB spine entry this chapter narrates
  source_href?: string;                 // EPUB section href
  source_spine_indexes?: number[];      // NEW: chapter spans multiple spine entries
  source_hrefs?: string[];              // NEW: ...and multiple hrefs
  // ...plus optional title/word/chunk metadata
}

interface AudiobookManifest {
  schema_version?: number;
  title: string;
  voice_id: string;
  voice_name: string;
  total_chapters: number;
  chapters_url?: string;                // (optional) pagination escape hatch
  chapters: AudiobookChapter[];
}
```

If audiobook-maker changes the manifest format, these types must change to match.

### `TTSController.ts` (671 lines)

The state machine that sits above all `TTSClient` implementations (AudiobookTTSClient, EdgeTTSClient, NativeTTSClient, WebSpeechClient). Holds the current state:

```ts
'stopped' | 'playing' | 'paused' | 'stop-paused'
  | 'backward-paused' | 'forward-paused'
  | 'setrate-paused' | 'setvoice-paused'
```

Public API: `start()`, `pause()`, `resume()`, `stop()`, `forward()`, `backward()`, `setRate()`, `setVoice()`. Internally iterates over `client.speak(ssml)` and dispatches `speak-mark` events to whoever's listening.

### `useTTSControl.ts` (1036 lines, the React glue)

Reader-side hook that wires the controller into the React tree. Listens for `speak-mark` events and tells the foliate-js renderer to highlight the right word. Listens for `tts-audiobook-seek` events (fired when the user long-presses) and calls `seekToText` / cross-chapter navigation.

The recent iOS autoplay fix lives here: when the controller is paused, the long-press handler refuses to call `controller.start()` because `audio.play()` would be rejected by Safari. It moves `audio.currentTime` only and waits for the user's next Play tap (a real user gesture).

### `EdgeTTSClient.ts`, `NativeTTSClient.ts`, `WebSpeechClient.ts`

The three on-device TTS implementations Readest ships with. The audiobook fork prefers `AudiobookTTSClient` when a manifest URL is available, falling back to these otherwise.

### Tests: `__tests__/services/audiobook-tts-client.test.ts`, `__tests__/hooks/useTTSControl.test.tsx`

Where every audiobook fix is anchored. The repo follows **test-first** strictly (see `.claude/rules/test-first.md`): every bug fix has a failing test written first, the fix is applied, the test goes green. Don't skip this on the other machine — the test fixtures are the documentation.

---

## Data flow for a single page turn

1. Reader displays a page. foliate-js gives us the text + per-word coordinates.
2. `useTTSControl` builds SSML for the page and calls `controller.start()`.
3. `TTSController` calls `client.speak(ssml)` on `AudiobookTTSClient`.
4. `speak()` figures out which chapter the page is in:
   - First tries `#locateTextMatch` — fuzzy text matching across already-loaded chapters.
   - Falls back to `#getSourceMatchedChapters()` — uses `source_spine_index` / `source_href` (and their array variants) to map current EPUB section → audiobook chapter.
   - Last resort: `#findChapter(sectionLabel)` — title-string matching.
5. If chapter changed: load new MP3, restore saved position if any.
6. Match the first SSML mark's text against the timestamps to find where in the audio this page starts.
7. Call `audio.play()` — this is the only place the audio is *seeked*; from here it's pure timeline playback.
8. As `audio.currentTime` advances past each word's timestamp, dispatch a `speak-mark` event. `useTTSControl` translates that to a highlight call against foliate-js.
9. When all marks for this block have fired, yield `'end'`. Audio keeps playing. The reader auto-advances to the next page when the audio passes the page boundary, which triggers another `speak()` call. **Audio doesn't pause between pages within a chapter.**

---

## How the iPhone gets the latest code

Vercel auto-deploys `main`. The keeper project is **`readtestaudio-readest-app`** (URL: `readtestaudio-readest-app-puce.vercel.app`). One build per push to main, ~2 minutes.

iOS Safari aggressively caches the service worker. After a deploy, clear it on the phone:

```js
// Paste into Safari's URL bar as a bookmarklet, or run from devtools:
caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
  .then(() => navigator.serviceWorker.getRegistrations())
  .then(rs => Promise.all(rs.map(r => r.unregister())))
  .then(() => location.reload());
```

You'll know you're on fresh code if the bundle hash in the Network tab changes and you see new `[TTS]` console logs that match the new code paths.

---

## Verification gate (from `.claude/rules/verification.md`)

Before marking work done:

```
pnpm test             # vitest
pnpm lint             # tsgo --noEmit && biome check .
# only if src-tauri/ changed:
pnpm fmt:check
pnpm clippy:check
```

There's a longstanding `@simplecc/simplecc_wasm` lint failure that resolves once submodules are properly initialized (the package lives in `packages/simplecc-wasm`). If you see two `TS2307: Cannot find module '@simplecc/simplecc_wasm'` errors, you forgot `git submodule update --init --recursive`.

Pre-commit and pre-push hooks (Husky) run lint. If they trip on simplecc, push with `--no-verify` — the rest of the codebase isn't actually broken.

---

## Common bugs and where they live

| Symptom | Likely file | Quick check |
|---|---|---|
| Audio skips ahead or paragraphs | `AudiobookTTSClient.ts` `#speak()` | Are timestamps being interpreted as elapsed time vs. absolute time? |
| View races through dispatch marks after a seek | `AudiobookTTSClient.ts` `#speak()` mark loop | Past-time marks must be skipped, not dispatched-then-skipped |
| Long-press works while playing, breaks while paused | `useTTSControl.ts` `handleTTSAudiobookSeek` | iOS autoplay — don't call `audio.play()` outside a user gesture |
| Cross-chapter long-press goes to wrong audio | `AudiobookTTSClient.ts` `#getSourceMatchedChapters` | Are `source_spine_indexes` / `source_hrefs` arrays being checked? |
| Chapter loads but no audio plays | `AudiobookTTSClient.ts` `speak()` line ~600 | `audio.play()` rejected — check console for `NotAllowedError` |
| Reader silent on certain pages | `AudiobookTTSClient.ts` matching path | Section probably maps to a chapter the matcher doesn't see — add source-href/index entry |

---

## When you sit down on the other laptop

```
cd ~/Readtestaudio
git pull origin main
git submodule update --init --recursive    # if any submodules changed upstream
pnpm install                                # only if package.json/lockfile changed
pnpm dev-web                                # http://localhost:3000
```

Run tests as you go:

```
pnpm test -- src/__tests__/services/audiobook-tts-client.test.ts
pnpm test -- src/__tests__/hooks/useTTSControl.test.tsx
```

When making a fix:

1. Write the failing test first (in `__tests__/` mirroring the file you're fixing).
2. Confirm it fails (`pnpm test -- <path>`).
3. Apply the fix.
4. Confirm it passes + nothing else regresses (`pnpm test` — expect ~59 pre-existing simplecc-related failures if submodules aren't initialized; those are noise, not your problem).
5. Lint: `pnpm lint`. Expect zero new errors.
6. Commit, push. Vercel builds. Clear iOS cache. Test on phone.

---

## What I'd hand to Claude Code on the other laptop

Open the repo in Claude Code and start with:

> "Read `READTESTAUDIO_GUIDE.md`. The current task is: [your bug or feature]."

That gives Claude the context it needs without re-explaining the architecture every time. The `.claude/rules/` directory also auto-loads behavior rules (test-first, verification, TypeScript-no-any).
