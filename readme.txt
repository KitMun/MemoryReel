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
END OF DOCUMENT
================================================================================