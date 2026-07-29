================================================================================
WEDDING VIDEO WISHES PROJECT — REQUIREMENTS, DESIGN & SPECS
================================================================================
Status: Planning backup document
Last updated: 2026-06-26

This document is a backup summary of the full project plan discussed in chat.
If that conversation is ever lost, this file should contain enough detail to
resume planning or hand off to a developer.

================================================================================
1. PROJECT OVERVIEW
================================================================================

GOAL
A self-service video guestbook for a wedding, plus a live-updating digital
display that turns guest messages into shared content during the event itself
(not after).

TWO PARTS
  Part 1 — Recording: a single kiosk phone near the guestbook where guests
           record a short video wish for the couple.
  Part 2 — Live display: an automated pipeline that processes each clip as it
           arrives and shows results on a live website / venue screen within
           seconds to minutes, no manual editing during the event.

KEY CONSTRAINTS
  - Most guests speak Mandarin Chinese; couple's names are in Chinese.
  - Clip length capped at 15 seconds to 1 minute per recording.
  - Must work reliably on one device, on imperfect venue WiFi.
  - All tooling must be free or near-free (small personal project, no budget
    for ongoing service fees beyond a few dollars for Whisper API usage).
  - Long-term archive handoff to the couple (Google Drive) will be done
    MANUALLY after the event — not automated.

================================================================================
2. PART 1 — RECORDING APP (KIOSK)
================================================================================

DEVICE SETUP
  - One old phone, mounted near the guestbook, running a web page in
    fullscreen/kiosk mode (Android "screen pinning" or similar).
  - No app installation needed — runs entirely in the phone's browser (PWA).
  - No login/accounts for guests. Tap record, optionally type a name, done.

CORE FLOW
  1. Guest taps "Record your wishes" button.
  2. Browser requests camera/mic via getUserMedia.
  3. MediaRecorder API records video, with a visible countdown timer
     (configurable cap: 15s / 30s / 1min — current decision: short, 15s-1min).
  4. On stop (manual or auto at time limit), clip is held in the browser
     first (buffer to IndexedDB) BEFORE upload starts.
  5. Upload begins in the background to Backblaze B2 (see Part 2 stack).
  6. UI shows "Uploading... please don't close this", then "Thank you!
     Tap to record another."
  7. Retry logic on upload failure (venue WiFi will be unreliable).

FILE NAMING / METADATA
  - Filename includes upload timestamp, e.g. 2026-06-25T19-42-10_clip.webm
  - Optional guest name as a separate text field, not required.

WHY WEB APP, NOT NATIVE APP
  - Zero install friction — anyone can use it instantly.
  - Single trusted kiosk device means no need for per-guest auth or signed
    upload URLs; the one device can hold a long-lived credential safely.

TESTING NOTE
  - iOS Safari has historically been the flakiest with MediaRecorder
    (codec/permission quirks). Test on the actual kiosk device(s) before the
    event, not just in a desktop browser.

================================================================================
3. PART 2 — LIVE PROCESSING PIPELINE
================================================================================

DESIGN PRINCIPLE
Two independent paths process every uploaded clip:
  (A) FAST PATH — word cloud, near-instant (seconds)
  (B) BACKGROUND PATH — highlight reel, periodic (every 10-15 min), not
      time-critical

--------------------------------------------------------------------------------
3.1 TRIGGER
--------------------------------------------------------------------------------
  - Storage event fires the moment a clip finishes uploading to B2.
  - A Cloudflare Worker function runs both paths (A) and (B) without
    blocking on either (fire-and-forget, Promise.allSettled style).

--------------------------------------------------------------------------------
3.2 FAST PATH — LIVE WORD CLOUD
--------------------------------------------------------------------------------
  STEP 1 — Extract audio only from the clip (small/fast, ffmpeg, no video
           decode needed).
  STEP 2 — Transcribe using OpenAI Whisper API.
           - MUST set language: "zh" explicitly (do not rely on
             auto-detect — short clips can be misdetected).
           - MUST request word-level timestamps
             (timestamp_granularities: ["word"]).
           - Use the `prompt` parameter to hint the couple's names in
             Chinese characters, improving recognition accuracy.
  STEP 3 — Segment transcript into phrases using PAUSE GAPS between word
           timestamps (gap > ~0.4-0.5 sec between words = phrase boundary).
           This works identically for English and Mandarin since it is
           based on timing, not language structure.
           NOTE: when joining Chinese tokens back into text for keyword
           matching, join with '' (empty string), NOT ' ' (space) — Whisper
           does not insert spaces between Chinese tokens.
  STEP 4 — Extract keywords / score relevance:
           - Name match: check if couple's names (or PINYIN equivalents,
             for homophone-error tolerance) appear in the phrase.
           - Keyword match: check against a curated list of Chinese wedding
             blessing phrases (see Section 5 — Content Tasks).
  STEP 5 — Push results to a live data store (e.g. Cloudflare KV, Firestore,
           or simple JSON) that the website reads from in near-real-time.
  STEP 6 — Website (Cloudflare Pages) subscribes/polls and re-renders the
           word cloud as new words arrive — sized by frequency.

--------------------------------------------------------------------------------
3.3 BACKGROUND PATH — HIGHLIGHT REEL
--------------------------------------------------------------------------------
  IMPORTANT DESIGN DECISION: Do NOT use pure audio loudness/peak detection
  to pick "best moments." This was identified as a flawed approach because:
    - Loud moments are often background noise (claps, glasses, DJ), not the
      guest's voice.
    - Loudness has no concept of word boundaries -> risk of cutting a clip
      mid-word or mid-sentence, which reads as broken/low-effort on a
      guest's message they cannot re-record.
    - Loud != meaningful (heartfelt lines are often spoken softly).
    - Absolute loudness isn't comparable across guests (mic distance varies).

  CHOSEN APPROACH: Reuse the same Whisper transcript + word timestamps
  already generated for the word cloud (Section 3.2) to do PHRASE-LEVEL
  SCORING instead of audio-volume scanning.

  SCORING ALGORITHM (plain weighted checklist, no ML needed):
    1. Segment phrases by pause gaps (same logic as 3.2 Step 3).
    2. Score each phrase:
         + Contains couple's name (or pinyin-fuzzy match)   => +5
         + Contains a blessing/emotion keyword (per hit)     => +2 each
         + Phrase duration in a natural "goldilocks" range
           (re-tune this range for short clips, since clips
           are now only 15s-1min total — favor keeping more
           of the clip rather than a tiny 1-3 sec snippet)   => +3
         + Too short (<0.8s) or too long (>6s, adjust for
           short-clip context)                                => -3
         + Bonus for exclamation-style words (love, congrats,
           forever, happy, beautiful, etc.)                   => +1
    3. Pick the highest-scoring phrase.
    4. SAFE FALLBACK: if no phrase scores above 0 (e.g. silence, awkward
       laughter, no clear blessing), fall back to the first phrase with
       reasonable length (>=1.5s) rather than forcing a fake "best moment."
    5. SPECIAL CASE for short total clip length (added after deciding on
       15s-1min clip cap): if the ENTIRE clip is already short (e.g. <=20
       sec) and clean, consider using the WHOLE clip (trimmed of leading/
       trailing silence only) rather than extracting a sub-snippet. Reserve
       phrase-extraction specifically for clips closer to the 1-minute cap
       where trimming actually helps.
    5. Cut precisely at the chosen phrase's word-boundary timestamps
       (start of first word, end of last word) — this is what eliminates
       the mid-word-cut problem, by construction.
    6. Add ~150-200ms padding before/after the cut so it doesn't feel
       abrupt.

  RE-RENDER CADENCE
    - Do NOT re-render the full highlight reel after every single clip
      (too slow to feel "live" and wasteful).
    - Instead: cut each clip's chosen snippet immediately (cheap), append
      to a running manifest/list.
    - A separate periodic job (every 10-15 min, or every N new snippets)
      re-stitches the manifest into one growing video via ffmpeg concat,
      with a background music track and crossfade transitions at cut
      points (hides any awkward facial-expression frame at cut boundaries).
    - The website/display always shows whichever rendered file is most
      current — viewers see it grow throughout the night.
    - Plan a final "official" re-render near the end of the reception as a
      reveal moment (e.g. at cake-cutting or speeches).

--------------------------------------------------------------------------------
3.4 OTHER LIVE DISPLAY IDEAS (lower priority / optional)
--------------------------------------------------------------------------------
  - Muted video wall: grid of clip thumbnails looping silently, click to
    play with sound — works as a simple "just append on arrival" feed.
  - Scrolling ticker of new clip thumbnails.
  - Live sentiment/emoji tagging per clip (cheap to add once transcript
    exists).
  - "Most mentioned word/name" leaderboard.
  - Live participation counter ("32 of 80 guests have recorded").

================================================================================
4. MANDARIN / CHINESE LANGUAGE HANDLING — KEY NOTES
================================================================================

  - Whisper API supports Mandarin natively — same API, just set language:
    "zh" and don't let it auto-detect (auto-detect can misfire on short
    clips, especially with hesitation noises at the start).
  - Word-level timestamps for Chinese come back per character/token, not
    per whitespace-delimited "word" (Mandarin has no spaces). This is FINE
    for pause-based phrase segmentation (timing-based, language-agnostic)
    but matters for keyword matching:
      -> Join tokens with '' not ' ' before doing substring search.
  - NAME RECOGNITION RISK: personal names (2-3 Chinese characters) are a
    common Whisper failure case, especially uncommon names with no
    contextual help.
      Mitigation 1: Use the Whisper `prompt` parameter to hint the names
      in Chinese characters before transcribing.
      Mitigation 2 (more robust): Convert both the transcript and the
      couple's names to PINYIN and match on pinyin substrings instead of
      exact characters. This catches the common failure mode where Whisper
      transcribes a HOMOPHONE (same pinyin, wrong character) instead of
      the correct name. Suggested npm package: `pinyin`.
  - WORD CLOUD RENDERING: must use a web font with Chinese glyph support
    (e.g. Noto Sans SC, Source Han Sans) — default web-safe fonts often
    silently fail to render CJK characters. Test this explicitly.
  - WORD CLOUD SEGMENTATION: naive character-by-character splitting produces
    meaningless single-character clouds (e.g. splitting 祝福 into 祝 + 福).
    Use substring matching against a known phrase list (see Section 5)
    rather than attempting general-purpose Chinese word segmentation.
  - CONTENT VALIDATION: a native Mandarin speaker (already arranged by
    project owner) must review:
      a) the blessing-phrase keyword list before the event,
      b) a test batch of 5-10 real recorded clips run through the actual
         pipeline, checking transcript accuracy and whether the
         "best phrase" picked by the scoring function actually makes sense.
    This is a CONTENT task, not an engineering task, and gates pipeline
    quality more than any code change would.

================================================================================
5. CONTENT TASKS (NON-ENGINEERING — DO BEFORE THE EVENT)
================================================================================

  [ ] Couple's full names in Chinese characters, written out for use in:
      - Whisper prompt hints
      - Pinyin conversion for fuzzy name matching
  [ ] Curated list of ~15-20 common Mandarin wedding blessing phrases,
      written by a native speaker (NOT auto-translated from English list).
      Examples of the *category* of phrase to gather (do not rely on these
      exact examples — get real ones from the native-speaker reviewer):
      百年好合 / 永浴愛河 / 早生貴子 / 幸福 / 恭喜 / 新婚快樂, etc.
  [ ] Test recording session: 5-10 sample clips (ideally with Mandarin
      speakers) run through the full pipeline before the wedding, reviewed
      by the native-speaker collaborator for transcript + phrase-pick
      accuracy.
  [ ] Decide final clip length cap within the 15s-1min range.

================================================================================
6. TECH STACK — FINAL DECISIONS
================================================================================

  Layer                          | Tool
  --------------------------------|------------------------------------------
  Code repository                 | GitHub (public or private, free)
  CI/CD                           | GitHub Actions (free tier: 2,000 min/mo
                                  |   private repo; unlimited for public)
  Coding agent                    | GitHub Copilot Free tier, in VS Code
                                  |   (agent mode; 2,000 completions +
                                  |   50 premium requests/month, no card)
  Kiosk recording app             | Plain HTML/JS, MediaRecorder API,
                                  |   IndexedDB buffering before upload
  Object storage                  | Backblaze B2 (10GB free, no card to
                                  |   start, free egress up to 3x monthly
                                  |   average stored data)
  Processing pipeline / functions | Cloudflare Workers (event-triggered on
                                  |   B2 upload)
  Transcription                   | OpenAI Whisper API (paid, pay-as-you-go,
                                  |   cheap at this volume — needs card)
  Live website hosting            | Cloudflare Pages (free tier)
  Long-term archive                | Google Drive (manual copy-out by
                                  |   project owner after the event —
                                  |   NOT automated)

  REJECTED / RECONSIDERED OPTIONS (for reference):
  - Firebase Storage: rejected — Cloud Storage was removed from Firebase's
    free Spark plan; now requires the Blaze (pay-as-you-go) plan and a
    credit card just to enable storage at all, even within a "free quota."
  - Cloudflare R2: viable alternative to B2, same free storage amount
    (10GB) and S3-compatible API, but requires a credit card on file even
    for the free tier. B2 was chosen instead specifically to avoid that.
  - Google Drive API as the PRIMARY live storage: rejected for the live
    pipeline — consumer OAuth/quota complexity is a poor fit for guest-
    facing or automated upload flows. Kept only for the manual, one-time,
    end-of-event archive handoff, where its complexity doesn't matter.
  - Gemini CLI: was considered as a free Claude-Code-style terminal coding
    agent, but as of June 18, 2026, Google discontinued free/individual-
    tier access to Gemini CLI, redirecting users to a new product called
    Antigravity CLI. Antigravity's free tier has a documented recent
    history of repeated, unannounced quota cuts and lockouts as of early-
    to-mid 2026, so it was NOT selected as a dependable free option.
  - GitHub Copilot's cloud "coding agent" (assign a GitHub Issue, get a PR
    back automatically, no manual involvement): requires a PAID Copilot
    seat (Pro or higher). Only the IN-EDITOR agent mode is covered by the
    free tier, which is what was selected instead — same general outcome
    (agent edits code, you review/commit/PR) with slightly more manual
    involvement (you trigger it and run the git commands yourself).
  - Claude Code (Anthropic's terminal coding agent): NOT free — requires
    Pro subscription ($20/month) or paid API credits. Noted as a viable
    PAID fallback if GitHub Copilot's free request quota proves too
    limiting once development is underway.

================================================================================
7. INTEGRATION MAP — HOW THE PIECES CONNECT
================================================================================

  CONTENT / RUNTIME FLOW (runs live during the wedding):

    [Kiosk phone browser]
        | records clip, buffers locally, uploads via B2 API
        v
    [Backblaze B2 bucket] --(upload event)--> [Cloudflare Worker]
                                                    |
                                                    |-- extract audio
                                                    |-- call Whisper API
                                                    |     (transcript + word
                                                    |      timestamps)
                                                    |-- segment into phrases
                                                    |-- score phrases
                                                    |     (name/keyword/length)
                                                    |
                                          +---------+---------+
                                          |                   |
                                  [Fast path:           [Background path:
                                   push words to          cut best phrase,
                                   live data store]        append to reel
                                          |                 manifest; periodic
                                          v                 ffmpeg re-render]
                                  [Cloudflare Pages              |
                                   website: live                 v
                                   word cloud]            [Cloudflare Pages
                                                            website: growing
                                                            highlight reel]

  DEV / DEPLOY FLOW (runs beforehand, while building):

    [VS Code + GitHub Copilot agent mode]
        | edits/creates files
        v
    [git commit, push, gh pr create]
        v
    [GitHub repo: Pull Request opened]
        v
    [GitHub Actions: runs automatically on PR — lint/test]
        v
    [Project owner reviews diff on GitHub, clicks Merge]
        v
    [GitHub Actions: runs automatically on merge to main]
        v
    [Deploys to Cloudflare Pages (website) + Cloudflare Workers (pipeline)]

  POST-EVENT (manual, one-time):

    [Backblaze B2: raw + processed clips] --(manual drag-and-drop copy)-->
    [Google Drive folder, shared with the couple]

================================================================================
8. ACCOUNTS / CREDENTIALS CHECKLIST (PREPARE BEFORE BUILDING)
================================================================================

  [ ] GITHUB ACCOUNT
      - Sign up at github.com (free).
      - Create one repository for this project.
      - Later: add API keys below as GitHub Actions "repo secrets"
        (Settings > Secrets and variables > Actions). NEVER commit keys
        directly into code.

  [ ] BACKBLAZE B2 ACCOUNT
      - Sign up at backblaze.com (free, no card required for 10GB tier).
      - Create a bucket (e.g. "wedding-clips").
      - Generate an Application Key (Account > App Keys) -> produces a
        keyID and applicationKey. SAVE IMMEDIATELY — the secret is shown
        only once.
      - Note the bucket's S3-compatible endpoint URL (in bucket settings).

  [ ] CLOUDFLARE ACCOUNT
      - Sign up at cloudflare.com (free).
      - Enable Workers and Pages (both free tier).
      - Note Account ID; generate an API Token (My Profile > API Tokens)
        for deploy automation via GitHub Actions (Wrangler CLI uses this).

  [ ] OPENAI ACCOUNT (for Whisper API)
      - Sign up at platform.openai.com.
      - Add a payment method (this step DOES require a card — Whisper is
        pay-as-you-go, but expected cost for this event's volume is only a
        few dollars total).
      - Generate an API key (API Keys section). Store as a secret, never
        in code.

  [ ] GOOGLE ACCOUNT
      - Normal personal Google account, used only for the manual,
        end-of-event Drive archive handoff. No API/developer setup needed
        for this step since it's done by hand.

  [ ] VS CODE + GITHUB COPILOT
      - Install VS Code (code.visualstudio.com).
      - Install the "GitHub Copilot" extension; sign in with the GitHub
        account above to activate the free tier.

  [ ] NATIVE MANDARIN-SPEAKING REVIEWER
      - Already arranged by project owner (per chat discussion). Needed
        for: blessing-phrase list review, test-clip transcript/scoring
        review before the event.

================================================================================
9. OPEN ITEMS / DECISIONS STILL PENDING
================================================================================

  - Exact final clip length cap (somewhere in the 15s-1min range) — not yet
    fixed to a single number.
  - Whether to build the "whole clip vs. extracted phrase" length-based
    branching logic (Section 3.3, item 5) — proposed but not yet confirmed
    as in-scope.
  - Repo scaffold (folder structure, starter GitHub Actions YAML,
    placeholder wrangler.toml for the Worker) — discussed as a next step,
    not yet generated as of this document's last update.
  - Domain name for the live display website — optional, ~$10-15/year if
    desired; not required (Cloudflare Pages provides a free subdomain).

================================================================================
10. IMPLEMENTATION UPDATE - PART 1 KIOSK RECORDER
================================================================================

STATUS
  Part 1 has been implemented on branch:

    codex/kiosk-recorder

  Commit:

    e7e5dd3 Build kiosk recorder PWA

WHAT WAS BUILT
  - Replaced the placeholder root page with a kiosk-ready PWA under:

      public/

  - Added a browser recording flow:
      - Camera/microphone capture through MediaRecorder.
      - Live camera preview.
      - 30-second recording cap for the first implementation.
      - Optional guest name field.
      - Record and stop controls.
      - Visible upload queue counts.

  - Added local buffering before upload:
      - Recorded Blob is saved into IndexedDB before upload starts.
      - Pending clips remain on the phone if upload fails.
      - Upload queue retries when the user taps retry or the browser comes
        back online.
      - Clips stuck in "uploading" after a page close are retried on reopen.

  - Added PWA shell files:
      - manifest.webmanifest
      - service-worker.js
      - icon.svg

  - Moved public web assets into public/ and changed wrangler.jsonc so
    Cloudflare serves only public assets, not repo internals.

  - Added Worker upload-token endpoint:

      POST /api/uploads/b2-token

    The Worker holds the Backblaze B2 credentials and returns a temporary B2
    upload target to the browser. This keeps real B2 credentials out of the
    kiosk phone/browser code.

  - Added kiosk upload protection:
      - Worker requires X-MemoryReel-Kiosk-Key.
      - The kiosk phone stores this shared key in localStorage after first
        setup using a setupKey URL parameter.
      - Guests do not need login or credentials.

  - Added setup documentation:

      docs/kiosk-setup.md

REQUIRED DEPLOYMENT CONFIGURATION
  Cloudflare Worker secrets:

    B2_KEY_ID
    B2_APPLICATION_KEY
    B2_BUCKET_ID
    KIOSK_UPLOAD_KEY

  Optional Worker variable:

    B2_FILE_PREFIX=raw

  Backblaze B2 bucket CORS must allow the deployed kiosk origin and these
  upload-related headers:

    Authorization
    Content-Type
    X-MemoryReel-Kiosk-Key
    X-Bz-File-Name
    X-Bz-Content-Sha1
    X-Bz-Info-guest-name
    X-Bz-Info-created-at
    X-Bz-Info-duration-ms

  The B2 Application Key should be scoped to the clip bucket and needs
  writeFiles capability.

HOW TO SET UP THE KIOSK PHONE
  After deployment and Worker secret setup, open the deployed kiosk URL once
  on the kiosk phone with:

    https://YOUR-KIOSK-URL/?setupKey=YOUR_KIOSK_UPLOAD_KEY

  The app saves the key in the phone browser's localStorage and removes it
  from the address bar. After that, guests can use the normal kiosk URL.

VERIFICATION ALREADY DONE
  - JavaScript syntax checks:
      node --check public/app.js
      node --check public/service-worker.js
      node --check worker.js

  - Local static asset checks:
      / served successfully
      /app.js served successfully
      /manifest.webmanifest served successfully

  - Browser desktop smoke check:
      - Page title loads as "MemoryReel Kiosk".
      - Record button is visible.
      - Stop button starts disabled.
      - No horizontal overflow on desktop viewport.

IMPORTANT NOTES FOR FURTHER DEVELOPMENT
  - Test on the exact kiosk phone before the wedding. MediaRecorder support,
    camera permission behavior, video codec, and fullscreen/kiosk behavior
    can differ by device and browser.

  - The current recording cap is 30 seconds. This can be changed in
    public/app.js via MAX_RECORDING_SECONDS after the final event decision.

  - The current browser upload uses Backblaze's native upload URL flow.
    Confirm the B2 CORS configuration early; if CORS blocks direct upload,
    the phone will correctly keep clips buffered, but no uploads will reach
    B2 until CORS is fixed.

  - The Worker upload-token endpoint is intentionally lightweight. It does
    not yet write a separate metadata JSON file, notify the processing
    pipeline, or create database records. Those should be added in Part 2.

  - The app currently uploads only the recorded video file. For the fast
    transcription path, consider adding an audio sidecar upload in a later
    iteration so Cloudflare Workers do not need to run ffmpeg.

  - The setupKey approach is practical for a one-phone kiosk, but it relies
    on localStorage. If the browser data is cleared, the kiosk must be opened
    once again with the setupKey URL.

  - The PWA service worker caches the app shell, but not recorded clips.
    Recorded clips live in IndexedDB until successfully uploaded.

  - Uploaded records marked "uploaded" keep metadata but drop the Blob from
    IndexedDB to save phone storage. If a post-upload audit UI is needed,
    add a small admin/debug view rather than keeping uploaded videos locally.

  - Before the event, run a realistic test:
      1. Record several clips on the actual phone.
      2. Toggle WiFi/airplane mode during upload.
      3. Confirm retries resume.
      4. Confirm files arrive in the B2 bucket under the expected prefix.
      5. Confirm guest-name metadata is present or acceptable if omitted.

================================================================================
11. IDEA TO REPLACE WHISPER API WITH LOCAL FASTER-WHISPER
================================================================================

# Local Speech-to-Text with Faster-Whisper

## Overview

Instead of using the OpenAI Whisper API, this project uses **faster-whisper** to perform speech-to-text transcription locally. The transcription model runs on the local machine, eliminating API calls and per-minute usage charges.

The application is designed for processing short Mandarin audio clips (typically 15–60 seconds) that arrive periodically rather than in large batches.

## Why Replace the Whisper API?

### Pros

* **No API cost** after the initial setup.
* **Offline operation** – audio never leaves the local machine.
* **Low latency** – no network upload or download required.
* **No rate limits** imposed by external services.
* **Easy to customize** with domain-specific prompts and vocabulary.
* **Suitable for one-time or temporary deployments** without ongoing cloud expenses.

### Cons

* Requires a local machine with sufficient CPU/RAM.
* Initial model download (1–3 GB depending on the model).
* Transcription speed depends on the host hardware.
* Updates and model management become part of the application maintenance.

## Recommended Model

| Model    | Recommendation                              |
| -------- | ------------------------------------------- |
| Small    | Fastest, suitable for general transcription |
| Medium   | Recommended balance of speed and accuracy   |
| Large-v3 | Highest accuracy, slower inference          |

For Mandarin speech with names, company terms, and industry-specific vocabulary, the **Medium** model is recommended as the default. The **Large-v3** model can be used when maximum transcription accuracy is required.

## Implementation Summary

1. Monitor for new audio clips.
2. Load the Faster-Whisper model during application startup.
3. Transcribe incoming audio locally.
4. Provide an optional Mandarin vocabulary list as an `initial_prompt` to improve recognition of expected names and terminology.
5. Optionally perform post-processing to correct common names or domain-specific terms.
6. Save the transcription result and continue waiting for the next audio clip.

```
Incoming Audio
       │
       ▼
Faster-Whisper
 (Local Model)
       │
       ▼
Optional Vocabulary Prompt
       │
       ▼
Transcript
       │
       ▼
Optional Post-processing
       │
       ▼
Output (Text / JSON)
```

## Hardware Considerations

Recommended minimum for local execution:

* Intel Core Ultra 7 (or equivalent modern CPU)
* 32 GB RAM
* SSD storage
* Approximately 5 GB free disk space if both `medium` and `large-v3` models are installed

For workloads where audio clips arrive every few minutes, CPU-only inference is sufficient and does not require a dedicated NVIDIA GPU.

## Future Enhancements

* Automatic language detection
* Speaker diarization (multiple speakers)
* Confidence score reporting
* Batch processing support
* Vocabulary management per customer or project
* Export to JSON, CSV, or subtitle formats


================================================================================
IDEA ON NOISE REDUCTION TO IMPROVE TRANSCIPT QUALITY
================================================================================

# Audio Quality Enhancement Pipeline

## Overview

To improve speech recognition accuracy before sending audio to the transcription model, the system applies two levels of audio enhancement:

1. **Browser-level audio processing during recording**
2. **Post-processing noise reduction before transcription**

The goal is to provide Whisper/faster-whisper with cleaner speech input, improving recognition accuracy for Mandarin speech, names, and domain-specific terms.

---

# 1. Browser Audio Processing

The PWA should request audio with built-in browser processing enabled.

Example:

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  video: true,
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
});
```

## Enabled Features

### Echo Cancellation

Reduces feedback and echo caused by:

* Device speakers
* Room reflections
* Nearby audio playback

Useful when recording in environments where audio output may exist.

---

### Noise Suppression

Reduces common background noise such as:

* Fan noise
* Air conditioning
* Constant machine noise
* General background sounds

This provides the first layer of cleanup before recording.

---

### Auto Gain Control

Automatically adjusts microphone volume.

Benefits:

* Prevents very quiet recordings
* Reduces overly loud audio
* Keeps speech volume more consistent

---

# 2. Post-Processing Noise Reduction

After video upload, the audio is extracted and processed before transcription.

Pipeline:

```
Recorded Video
        |
        ▼
Extract Audio
        |
        ▼
Noise Reduction
        |
        ▼
faster-whisper Transcription
        |
        ▼
Transcript Output
```

---

# Preferred Approach: AI Speech Enhancement

The preferred noise reduction approach is using an AI-based speech enhancement model.

Unlike traditional filters, AI enhancement models learn the difference between speech and noise, allowing them to preserve human voice while reducing unwanted sounds.

Examples:

* DeepFilterNet
* RNNoise

## Advantages

* Better speech isolation
* Handles more complex environments
* Improves transcription accuracy
* More suitable for real-world recordings

## Limitations

* Higher processing requirements
* Additional model dependency
* Slightly longer processing time

For short clips (15–60 seconds), the additional processing time is acceptable because the system is not operating under strict real-time constraints.

---

# Alternative Approach: FFmpeg Audio Filtering

For simpler deployments, FFmpeg filters can be applied before transcription.

Example processing steps:

```
Extract Audio

↓

Normalize Volume

↓

Reduce Background Noise

↓

Adjust Frequency Range

↓

Whisper Transcription
```

Typical improvements:

* Remove constant background noise
* Improve speech volume consistency
* Reduce low-frequency hum

Advantages:

* Lightweight
* Fast
* Easy to deploy
* No additional AI model required

Limitations:

* Less effective with complex noise
* Cannot distinguish speech from overlapping voices as well as AI models

---

# Recommended Processing Strategy

Initial implementation:

```
PWA Recording
      |
      ▼
MediaRecorder
      |
      ▼
Browser Audio Processing
      |
      ▼
Upload Video
      |
      ▼
Extract Audio
      |
      ▼
AI Noise Reduction
      |
      ▼
faster-whisper
      |
      ▼
Transcript
```

Fallback/simple mode:

```
PWA Recording
      |
      ▼
MediaRecorder
      |
      ▼
Extract Audio
      |
      ▼
FFmpeg Filter
      |
      ▼
faster-whisper
```

---

# Expected Impact

Improving audio quality can have a larger effect on transcription accuracy than switching between Whisper model sizes.

A clean recording with a smaller model may outperform a noisy recording with a larger model.

The enhancement pipeline is especially beneficial for:

* Mandarin speech recognition
* Names and proper nouns
* Industrial environments
* Outdoor recordings
* Recordings with background noise

---

# Future Improvements

Possible enhancements:

* Automatic audio quality scoring before transcription
* Adaptive selection between FFmpeg and AI enhancement
* Speaker diarization for multi-person conversations
* Customer/project-specific vocabulary enhancement
* Real-time microphone quality feedback in the PWA


================================================================================
IDEA ON ARCHITECTURE
================================================================================

# System Architecture

## Overview

The application is designed around a lightweight cloud orchestration layer and a dedicated AI processing worker.

The cloud is responsible for coordinating jobs and maintaining application state, while the AI worker performs the computationally intensive tasks such as audio processing and speech transcription.

This separation allows the system to leverage free-tier cloud resources for orchestration while keeping AI processing independent and easily scalable.

---

# Architecture Diagram

```text
                           PWA (JavaScript)
                                  │
                                  │ Upload Video
                                  ▼
                         Backblaze B2 Storage
                                  │
                                  ▼
                     Cloudflare Worker (API)
                                  │
            ┌─────────────────────┴─────────────────────┐
            │                                           │
            ▼                                           ▼
     Cloudflare D1 Database                 Cloudflare Queue
     (Job Metadata & Status)                (Processing Queue)
            │                                           │
            └─────────────────────┬─────────────────────┘
                                  ▼
                      Oracle OCI Compute Instance
                         Python Transcription Worker
                                  │
              ┌───────────────────┼────────────────────┐
              │                   │                    │
              ▼                   ▼                    ▼
        Download Video        Extract Audio      AI Noise Reduction
             (B2)               (FFmpeg)        (DeepFilterNet)
                                                       │
                                                       ▼
                                               faster-whisper
                                                       │
                                                       ▼
                                            Transcript Generation
                                                       │
                                                       ▼
                                            Upload Transcript (B2)
                                                       │
                                                       ▼
                                          Update Job Status (D1)
```

---

# Component Responsibilities

## PWA (JavaScript)

Responsibilities:

* Record video using `MediaRecorder`
* Enable browser audio processing
* Upload video to Backblaze B2
* Create a transcription job
* Poll for processing status
* Display transcription results

The frontend remains lightweight and does not perform any AI processing.

---

## Backblaze B2

Responsibilities:

* Store uploaded video files
* Store generated transcripts
* Serve as the application's file storage

B2 is responsible only for storing files and should not be used as a job queue or status database.

---

## Cloudflare Worker

Responsibilities:

* Expose REST API endpoints
* Authenticate requests
* Create transcription jobs
* Push jobs into the processing queue
* Return job status
* Generate download or upload URLs when required

The Worker contains business logic but performs no CPU-intensive processing.

---

## Cloudflare D1

Responsibilities:

* Store job metadata
* Track processing status
* Record timestamps
* Store processing errors
* Store transcript locations

Example job lifecycle:

```text
Queued
    ↓
Processing
    ↓
Completed
```

or

```text
Queued
    ↓
Processing
    ↓
Failed
```

---

## Cloudflare Queue

Responsibilities:

* Hold pending transcription jobs
* Deliver jobs to available workers
* Decouple upload requests from AI processing

Using a queue prevents uploads from waiting for transcription to complete and provides a scalable mechanism for distributing work.

---

## Oracle OCI Compute Instance

Responsibilities:

* Execute the Python transcription worker
* Process queued jobs
* Download videos from Backblaze B2
* Perform AI inference
* Upload completed transcripts
* Update job status

This instance performs all CPU-intensive workloads.

---

# Python Transcription Pipeline

Each job follows the processing pipeline below:

```text
Download Video
        │
        ▼
Extract Audio (FFmpeg)
        │
        ▼
AI Noise Reduction
(DeepFilterNet)
        │
        ▼
Speech-to-Text
(faster-whisper)
        │
        ▼
Vocabulary Enhancement
(Optional)
        │
        ▼
Generate Transcript
        │
        ▼
Upload Transcript
```

Future enhancements may include:

* Speaker diarization
* Confidence scoring
* Automatic language detection
* Multiple output formats (TXT, JSON, SRT)

---

# Design Principles

## Separation of Responsibilities

Each service has a clearly defined role.

| Component         | Responsibility      |
| ----------------- | ------------------- |
| PWA               | User interaction    |
| Backblaze B2      | File storage        |
| Cloudflare Worker | API & orchestration |
| Cloudflare D1     | Job metadata        |
| Cloudflare Queue  | Work distribution   |
| Oracle OCI        | AI processing       |

This separation improves maintainability and allows individual components to evolve independently.

---

## Scalability

The architecture supports future scaling without major redesign.

Current deployment:

```text
1 Queue
        │
        ▼
1 Python Worker
```

Future deployment:

```text
1 Queue
        │
 ┌──────┼──────┐
 ▼      ▼      ▼
Worker Worker Worker
```

Additional workers can process jobs concurrently without changes to the frontend or API.

---

## Cost Optimization

The solution is designed to maximize the use of free-tier cloud services.

| Component    | Platform                      |
| ------------ | ----------------------------- |
| Frontend     | Existing PWA                  |
| API          | Cloudflare Workers (Free)     |
| Database     | Cloudflare D1 (Free)          |
| Queue        | Cloudflare Queues (Free Tier) |
| AI Compute   | Oracle OCI Always Free        |
| File Storage | Backblaze B2                  |

Only Backblaze B2 incurs usage-based costs, while the orchestration layer and AI compute can operate within the available free-tier allocations for the expected project workload.

---

# Benefits

* Low operational cost
* Fully asynchronous processing
* Decoupled architecture
* AI processing isolated from application logic
* Easy to scale with additional workers
* Supports future AI enhancements without architectural changes
* Leverages managed cloud services while keeping compute-intensive workloads under full control

================================================================================
12. LOCAL FASTER-WHISPER IMPLEMENTATION (CURRENT)
================================================================================

STATUS
  The architecture has been updated to use local faster-whisper transcription
  instead of OpenAI Whisper API, with Cloudflare D1 for job tracking.

ARCHITECTURE
  Kiosk PWA → B2 Upload → Worker creates D1 job → Local Python worker polls →
  Download video → Extract audio → faster-whisper → Upload transcript → Update D1

COMPONENTS
  - Cloudflare D1 Database: Job metadata, status tracking, suggested clip segments
  - Worker API: Job creation, polling endpoints, status updates
  - Local Python CLI Worker: Polls for jobs, processes with faster-whisper
  - Backblaze B2: Stores videos and generated transcripts

D1 SCHEMA
  Jobs table includes:
  - id, video_file_path, transcript_file_path
  - status (queued, processing, completed, failed)
  - guest_name, duration_ms, timestamps
  - error_message, retry_count (max 3 retries)
  - suggested_start_ms, suggested_end_ms, suggested_score, suggested_reason

WORKER API ENDPOINTS
  - POST /api/uploads/b2-upload: Uploads video and creates D1 job
  - GET /api/jobs/next: Poll for next queued job (requires LOCAL_WORKER_KEY)
  - POST /api/jobs/:id/status: Update job status (requires LOCAL_WORKER_KEY)
  - POST /api/jobs/:id/transcript: Upload transcript location (requires LOCAL_WORKER_KEY)

LOCAL WORKER SETUP
  See local-worker/README.md for detailed setup instructions.

  Prerequisites:
  - Python 3.10+, ffmpeg
  - Backblaze B2 credentials
  - Cloudflare Worker with D1 database

  Configuration (local-worker/config.json):
  - worker_api_url: Deployed Worker URL
  - local_worker_key: Shared secret (matches Worker secret)
  - B2 credentials and bucket name
  - whisper_model: medium (recommended for Mandarin)

  Running the worker:
  cd local-worker
  pip install -r requirements.txt
  python main.py

DEPLOYMENT STEPS
  1. Create D1 database:
     wrangler d1 create memoryreel-jobs

  2. Update wrangler.jsonc with database_id from step 1

  3. Run schema migration:
     wrangler d1 execute memoryreel-jobs --file=schema.sql

  4. Set Worker secret:
     wrangler secret put LOCAL_WORKER_KEY

  5. Deploy Worker:
     wrangler deploy

  6. Configure local-worker/config.json with credentials

  7. Run local worker: python local-worker/main.py

BENEFITS OVER OPENAI WHISPER API
  - No API costs after initial setup
  - Offline operation (audio never leaves local machine)
  - No rate limits
  - Easy customization with domain-specific prompts
  - Suitable for one-time deployments without ongoing cloud expenses

TRANSCRIPT FORMAT
  JSON with word-level timestamps for both text and timing:
  {
    "language": "zh",
    "language_probability": 0.98,
    "segments": [
      {
        "start": 0.0,
        "end": 2.5,
        "text": "segment text",
        "words": [
          {"start": 0.0, "end": 0.5, "word": "word1"},
          {"start": 0.6, "end": 1.2, "word": "word2"}
        ]
      }
    ]
  }

  This format supports both the word cloud feature and the phrase-level
  scoring algorithm for highlight reel generation.

CLIP SEGMENT SUGGESTION
  The local worker calculates suggested clip segments based on:
  - Segment duration (prefer 2-5 seconds)
  - Word count (more words = higher score)
  - Future enhancement: name matching, blessing phrase detection

  Results stored in D1 for highlight reel assembly.

ERROR HANDLING
  - Jobs marked as failed with error_message
  - Automatic retry up to 3 times (retry_count field)
  - Worker continues polling for other jobs if one fails

================================================================================
END OF DOCUMENT
================================================================================