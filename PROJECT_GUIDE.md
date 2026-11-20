# Stream Clipper: Project Guide

## 1. What the project does (in one paragraph)

Stream Clipper watches **live Twitch streams** (by default Portuguese *Grand Theft Auto VI* streams, or whatever you ask for in the startup assistant). It keeps the **last ~5 minutes of video** of each watched channel on disk and reads the **live chat**. When chat explodes (KKKKK, CLIPA, emote spam), an AI looks at **frames, chat and audio loudness** and picks the best 15–90 seconds. FFmpeg turns that into a **vertical 9:16 video** (webcam on top, game below) with a **hook caption** and **Whisper subtitles** of what the streamer says. The AI writes a **title, description and hashtags in Brazilian Portuguese**, a second AI pass fact-checks them against the frames, a **safety/monetization gate** checks permissions and platform rules, and a **post queue** publishes the best clips on a daily schedule to **YouTube Shorts**, **TikTok** and (optionally) **Instagram Reels**. Posted videos are deleted from disk automatically.

---

## 2. How to use it (day to day)

### First time
```bash
npm install
npx playwright install chromium
cp .env.example .env                                   # read the comments, adjust
cp data/clip-permissions.example.json data/clip-permissions.json
npm run youtube:login                                  # log in to the channel once (the session refreshes itself)
# TikTok: export tiktok.com cookies with Cookie-Editor → cookies/tiktok.json
# Subtitles: brew install whisper-cpp + download the two models (README → Quick start)
```

### Every time
1. **Choose what to clip**: `npm start` in a terminal asks *"o que vamos clipar hoje?"*. Answer with a number from the suggestions, your own words ("fails engraçados de minecraft", "só as lives do cellbit"), a `twitch.tv/` link, or press Enter to repeat the last plan. Confirm with `S` or adjust in words. `npm run setup` only changes the plan.
2. **Let it run unattended** (Mac awake, lid open, plugged in):
   ```bash
   nohup caffeinate -ims node dist/index.js >> output/supervisor.log 2>&1 &
   tail -f output/supervisor.log           # watch
   pkill -INT -f "node dist/index.js"      # stop (running clips finish first)
   ```
   Unattended runs don't ask anything: they reuse the plan saved in `data/session.json`.
3. **Check results**: `npm run metrics` (views per video in `data/video-metrics.json`). The best/worst clips are fed back to the AI automatically.
4. **When YouTube says "redirected to login"**: run `npm run youtube:login` again.

### How much it posts
`POSTS_PER_DAY_MIN/MAX` (default 5–10 per platform, override per platform with `…_YOUTUBE`, `…_TIKTOK`), between `POST_HOURS` (10–23 local). Slots are spread over the day and each slot takes the **most viral** waiting clip (score ≥ `MIN_POST_SCORE`, 8). Unverified YouTube channels can only upload ~10 videos a day: verify at youtube.com/verify for more.

### Disk
Posted clips are deleted from `output/` (their `.seo.json`/`.srt` stay); recordings of channels no longer watched are deleted from `buffer/`. Clips not posted yet are kept. `npm run cleanup:clips -- --dry-run` shows what would go.

### Changing the code (open-source workflow)
`main` is protected: every change goes through a **pull request** that must pass CI (type check + tests, secret scan, dependency audit).
```bash
git checkout -b feat/my-change
# edit, then:
npm run typecheck && npm test
git commit -am "Describe the change" && git push -u origin feat/my-change
gh pr create                      # CI runs on GitHub; merge when green
```
Pull requests from other people (and Dependabot) are reviewed in the separate **PR dashboard** project (`~/Projects/pr-dashboard`, `npm start` → http://localhost:4317): approve, request changes, merge or close, across all your repositories.

---

## 3. The pipeline, step by step

```
npm start ─► startup assistant (what to clip?) ─► data/session.json
   │
Twitch live streams (category + language, chosen channels)
   │
   ├─ video ─► streamlink ─► ffmpeg (30 s segments, ring of 10) ─► buffer/<channel>/segment_00X.mp4
   │
   └─ chat ──► tmi.js ─► chat sensor (tuned per channel size) ── "spike!"
                                    │
                                    ▼
   1. Snapshot: join the segments into one ~5 min MP4
   2. AI picks the moment: frames + chat timeline + loudness → clip_start/end, what happened, virality score
   3. AI writes title / description / hashtags (per game, pt-BR) → fact-check against frames
   4. Render: layout (webcam top / game bottom) + hook caption + Whisper subtitles → 1080x1920
   5. Gate: permission, credit, third-party media, advertiser-friendly text & frames, durations
   6. Post queue: daily plan, most viral first → YouTube Studio / TikTok Studio / Instagram Graph API
   7. Cleanup: delete posted clips and stale recordings
```

| Step | File | What to look at |
|---|---|---|
| Startup assistant | `src/setup/` (`wizard.ts`, `interpret.ts`, `preferences.ts`) | readline UI, AI → plan JSON, validation, memory |
| Find streams | `src/index.ts`, `src/ingestion/ingestion.ts`, `twitch-gql.ts` | Twitch GQL with `broadcasterLanguages`, priority channels |
| Rolling buffer | `src/ingestion/ingestion.ts` → `RollingStreamBuffer` | `ffmpeg -f segment -segment_wrap` |
| Hype detection | `src/ingestion/chat-validation.ts`, `ChatVelocitySensor` | sliding window, thresholds per channel size |
| Pick the moment | `src/ai/ai.ts` → `extractClipWithClaudeAgent`, `src/ai/moment-signals.ts` | prompt + JSON schema, loudness/scene signals |
| SEO | `src/ai/ai.ts` → `generateSEO`, `src/ai/game-profile.ts`, `src/publishing/platform-seo.ts` | per-game tags, per-platform limits |
| Render | `src/video/layout.ts`, `video.ts`, `caption.ts`, `subtitles.ts` | FFmpeg `filter_complex`, PNG overlays, Whisper |
| Gate | `src/compliance/monetization.ts`, `permissions.ts`, `profanity.ts` | checks with `post`/`money` scope |
| Queue & publish | `src/publishing/post-queue.ts`, `youtube-studio.ts`, `publishing.ts` | daily plan, Playwright uploads, Graph API |
| Cleanup | `src/utils/clip-retention.ts` | what is safe to delete, and when |
| Metrics | `src/metrics/collect-metrics.ts`, `performance.ts` | Studio scraping, feedback to the AI |
| Settings | `src/utils/config.ts`, `.env.example` | every option and its default |
| CI | `.github/workflows/ci.yml`, `scripts/protect-main.sh` | jobs, required checks |

---

## 4. Update history

### Update 1: face framing, Portuguese, captions

#### a) The face is no longer cut
**Before:** every clip was a **center crop** of the 16:9 frame (`crop=ih*9/16:ih:(iw-ow)/2:0`). Webcams usually sit in a corner, so they fell outside the crop.

**Now** (`src/video/layout.ts`):
1. FFmpeg saves **one frame** from the middle of the clip.
2. Claude Code CLI opens that image (`--tools Read`) and returns JSON:
   `layout` (`facecam_overlay` / `full_camera` / `no_camera`), plus the `facecam` and `gameplay` boxes in pixels.
3. The code pads the webcam box slightly, fixes the aspect ratios, and builds one of these layouts:

| Layout | When | Result |
|---|---|---|
| `stack` | webcam over gameplay (most streams) | webcam on top (25–42% of the height), game crop below. The game crop slides away from the webcam so the face isn't shown twice |
| `face_center` | IRL / Just Chatting, camera fills the frame | 9:16 crop centered on the person |
| `blur` | no camera, or detection failed | the whole 16:9 frame over a blurred background. Nothing is ever cut |
| `center` | only if you force it | the old behaviour |

Overrides in `.env`:
```
VIDEO_LAYOUT=auto            # auto | stack | blur | center
FACECAM_REGION=0.036,0.381,0.2,0.202    # x,y,w,h as fractions of the frame (skips AI detection)
GAMEPLAY_REGION=0.022,0.164,0.672,0.672
```
Use the manual regions when you always clip the same streamer and want zero AI cost and 100% consistency.

Test the framing on any recorded buffer without going live:
```
npm run test:layout -- buffer/some_snapshot.mp4
```

#### b) Portuguese streams only
`STREAM_LANGUAGE=PT` (the default) passes Twitch's own `broadcasterLanguages` filter and double-checks each broadcaster's language. Streams filed under another GTA category (e.g. GTA V RP) count too, as long as their title says GTA 6. The clipping prompt also tells Claude that the chat is Brazilian Portuguese and what hype looks like there (KKKK, MDS, CLIPA…).

#### c) Titles / description / hashtags in Portuguese
`CONTENT_LOCALE=pt-BR` (or `pt-PT` for Portugal). The prompt forces Portuguese text, puts "GTA 6" near the start of the title (that's what people search), keeps the title under 70 characters, and uses Brazilian hashtags (`#gta6brasil #cortes #cortesdelive`…). YouTube uploads also set `defaultLanguage` / `defaultAudioLanguage`, so YouTube recommends the clip to Portuguese speakers.

**Per-game and per-platform SEO** (`src/ai/game-profile.ts`, `src/publishing/platform-seo.ts`). Every keyword and hashtag comes from the game actually streamed, so GTA RP clips get `#gtarp…` and never `#gta6…`. Hashtags are stored most-specific first (micro-topic, streamer, game, BR niche), and each platform keeps only what it can use:

| | YouTube Shorts | TikTok | Instagram Reels |
|---|---|---|---|
| Hashtags | 4 + `#Shorts` (first 3 show above the title; more than 15 = all ignored) | 5, at the end | 5 (Instagram's limit since Dec 2025) |
| Search phrases | hidden `tags` field, 500 chars total | written as normal sentences in the caption | written as normal sentences in the caption |
| Text limit | title 100, description 5000 | 2200 (API-safe; the app allows 4000) | 2200 |
| Credit | `Live na Twitch: @x` or `twitch.tv/x` | same | `@x` turned into a plain name / `twitch.tv/x`, so strangers with that handle aren't tagged |

The old `Tags de busca: a, b, c` list in descriptions was removed: YouTube's spam policy counts keyword lists in the description as "tag stuffing". `npm run test:seo` checks these rules offline.

#### Daily posting plan (details)
`POSTS_PER_DAY_MIN=5`, `POSTS_PER_DAY_MAX=10`, `POST_HOURS=10-23` (local time). Each platform gets at most 10 slots a day, spread evenly over the posting hours (~78 min apart). Clips wait in the queue and each slot takes the **most viral** one: virality score, +2 for priority channels, -3 if the same streamer was just posted, -0.5 per hour of waiting (fresh moments win). Only clips scored **>= 8** (`MIN_POST_SCORE`) are posted; if a platform is behind the 5-a-day pace (or under 5 near the end of the window) the bar drops to 7 so the day still reaches 5. Weaker clips go stale after `MAX_QUEUE_AGE_HOURS`. Per-platform overrides: `POSTS_PER_DAY_MAX_TIKTOK=5`, etc.

#### Whisper subtitles (details)
Every clip gets the streamer's speech burned in as big 1-3 word captions (keywords in yellow), about 60% down the screen, clear of the TikTok/Reels buttons (`src/video/subtitles.ts`). Most people watch muted, and TikTok/Instagram read on-screen text for search. It runs locally with whisper.cpp (about 2 s per clip on an M4):
```bash
brew install whisper-cpp
mkdir -p models
curl -L -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o models/ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```
The Silero VAD model matters: without it Whisper repeats the same sentence over game noise. The code also drops English NPC dialogue and known Whisper hallucinations ("Legendas pela comunidade Amara.org"), masks swear words with one asterisk (`f*da`, `p*rra`), and skips subtitles when fewer than 4 Portuguese words are spoken. An `.srt` is saved next to each clip. `SUBTITLES=off` disables it. FFmpeg's drawtext/libass aren't needed: each caption is a PNG rendered by Playwright and played as an image track.

#### Instagram Reels (details)
Set `INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_ACCOUNT_ID` (see `.env.example`), and every approved clip is also queued for Instagram, with the same spacing as the other platforms. The upload goes straight from the local file (Graph API resumable upload), waits until Instagram finishes processing, then publishes. When the 24 h publishing quota is used up, the queue pauses Instagram instead of failing the clip. `npm run test:publish -- output/<clip>.mp4 --instagram-only` posts one clip. Streamers on the allowlist need `"instagram"` in `platformsAllowed`. Instagram ranks reposts below originals and may not recommend repost-only accounts to non-followers, so clips without the webcam reframing + hook caption reach very few people there.

Example output from a test run:
> **GTA 6: thimagroo fugiu da polícia e achou um poste 😂**
> O thimagroo tava numa fuga insana da polícia no GTA 6 até que um poste apareceu no meio do caminho… Segue pra mais cortes!
> `#gta6 #gtavi #gta6brasil #cortes #cortesdelive #twitch #thimagroo`

#### d) Bug fixed along the way
Your Homebrew FFmpeg has **no `drawtext` filter** (it was built without libfreetype). The main pipeline burns the title into the video, so every render in `npm start` would have crashed. Now the caption is **skipped with a warning** when `drawtext` is missing. To get captions back, install an FFmpeg build that includes libfreetype (for example the `homebrew-ffmpeg/ffmpeg` tap with `--with-freetype`, or a static build from evermeet.cx).

---

### Update 2: permissions, chat validation, monetization gate

#### Clip permission list (`data/clip-permissions.json`, `src/compliance/`)
- A channel can only be clipped **and posted** if its entry is `status: "allowed"` **with a quoted piece of evidence** (panel text, written permission…). Unknown means not allowed.
- `npm run scan:permissions` scans live PT channels (big **and** small, sorted both ways) in `SCAN_CATEGORIES`. It reads each channel's Twitch bio and text panels, and Claude classifies any clip rules it finds. An "allowed" result is downgraded to `needs_review` if the quote isn't verbatim, or if no platform (YouTube/TikTok) is named.
- **Result of the first scan (18 Nov 2026):** 448 live PT channels. 18 mention clips/cuts, **0 explicitly allow third parties to post them**. Most only promote their *own* clip channel. One (a monthly clip contest) invites clipping but names no platform and says nothing about monetization. Many channels put their rules in **image panels**, which can't be read as text.
- So, for now, **written permission is the way in**: use the template in `docs/pedido-de-permissao.md` (pt-BR) and record the answer. Small creators are the best bet.

#### Chat validation by channel size (`src/ingestion/chat-validation.ts`)
| Tier | Viewers | Window | Needs |
|---|---|---|---|
| small | < 100 | 20 s | ≥ 5 msgs or 3× its own baseline, 3+ people, 30%+ hype |
| normal | 100–2000 | 10 s | ≥ 12 msgs or 2.5× baseline, 6+ people, 35%+ hype |
| big | > 2000 | 8 s | ≥ 40 msgs or 2× baseline, 20+ people, 40%+ hype |

It ignores bots (Nightbot, StreamElements…), `!commands`, links, number-counting spam, and repeated copy-paste. Each person counts for at most 2 messages per window, and enough different people must be reacting. "Hype" means KKKK, MDS, CLIPA, NÃO ACREDITO, KEKW, emote-only messages, CAPS shouting, and similar. Run `npm run test:chat` for 14 offline checks.

#### Monetization gate (`src/compliance/monetization.ts`)
Each rendered clip gets a report `output/<clip>.monetization.json`. It is **posted only to platforms where every check passes**:
1. Streamer permission with evidence, **explicit permission to monetize**, the platform allowed, credit in the description if required.
2. No third-party media in the stream (react/film/sports/music in the title or category, plus a vision check of the frames).
3. Transformation (YouTube's reused-content policy): webcam/face reframing **plus** an on-screen hook caption **plus** the loop re-edit. Blur-only clips (no webcam) fail.
4. Advertiser-friendly: no profanity in caption/title/description, plus a Claude vision review of 3 frames.
5. Account in the program: `YOUTUBE_PARTNER_PROGRAM=true` / `TIKTOK_CREATOR_REWARDS=true` (you set these, since the APIs don't expose them).
6. Duration: YouTube ≤ 180 s, TikTok > 60 s. That's why clips are now 62–90 s.

What it **can't** check: background music (Content ID), and the platforms' final decision. Passing the gate means "meets every rule we can check", not "guaranteed money".

Hook captions are drawn with Playwright as a transparent PNG, because this FFmpeg has no drawtext/libass, and placed just below the webcam.

#### Live test (18 Nov 2026, `npm run test:live`)
| Channel | Viewers / tier | Layout | Result |
|---|---|---|---|
| surskity11 | 1049 / normal | stack (webcam detected) | **blocked**: no permission, no monetization permission, accounts not in programs |
| dabliuking | 97 / small | blur (no webcam) | **blocked**: same + transformation (no webcam) |

Nothing was posted, which is correct: neither streamer has given permission.

---

### Update 3: growth mode, block list, delayed posting

**Who gets clipped** (`PERMISSION_MODE=denylist`, now the default): any live Brazilian stream **except channels you block**.
- `npm run block -- <login> "reason"` blocks a streamer. Their queued clips are cancelled too. `--unblock` undoes it.
- ⚠️ **Deleting** an entry from `data/clip-permissions.json` does **not** block it. In denylist mode a missing channel means "allowed". Always use `npm run block`.
- Channels marked `"allowed"` are preferred whenever they're live: **alanzoka** and **gaules** (added from your information, `source: user_reported`). Replace those quotes with links to their official statements when you have them.
- Reruns ("RERUN:", "REPRISE") are skipped.
- `PERMISSION_MODE=allowlist` brings back the strict "verified permission only" behavior.

**Posting delay:** `postDelayHours` per channel. gaules = **24**, so his clips go to `data/post-queue.json` and are posted 24 h after the moment. `npm start` checks the queue every 5 minutes. If the bot isn't running, `npm run post-queue` posts whatever is due.

**Growth mode** (`GROWTH_MODE=true`): every gate check now has a scope.
| Scope | Checks | When it fails |
|---|---|---|
| `post` | streamer blocked, platform not allowed, **credit missing**, react/film/sports stream, profanity in texts, **unsafe frames** (sexual content, slurs…), Shorts > 180 s | never posted (growth mode doesn't change this) |
| `money` | account not in YPP / Creator Rewards, TikTok ≤ 60 s, not enough editing (no webcam), streamer forbids monetization | posted **only** in growth mode, as "not monetizable yet" |

Turn growth mode off once your accounts are accepted, so only monetizable clips get posted. `.env` now has `YOUTUBE_PRIVACY=public`.

**Real catch during testing:** a surskity11 clip was blocked because the frames showed a paid donation alert with explicit sexual text and profanity in the chat overlay. That's exactly the kind of clip that gets a channel striked. The gate also blocks titles that name the wrong game ("GTA 6" on a GTA V stream). The SEO now uses the game actually being played.

New commands: `npm run block`, `npm run post-queue`, `npm run test:gate -- output/<clip>.mp4` (gate scenarios, never uploads), `npm run test:live -- --dry-run`.

---

### Update 4: watching several channels at once

`npm start` is now a **supervisor**, not a single-channel loop:

```
Supervisor (every 5 min)
  ├─ finds live channels: "allowed" first (alanzoka, gaules), then the biggest others in TARGET_CATEGORIES
  ├─ skips blocked channels and reruns; drops channels that go offline/rerun/get blocked
  └─ keeps up to MAX_CHANNELS ChannelWorkers running
        ChannelWorker (one per channel, all at the same time)
          ├─ its own rolling buffer in buffer/<login>/ + its own chat sensor
          └─ on a validated spike: waits one segment (so the moment and the reaction are recorded),
             snapshots the buffer and pushes a job to ↓
JobQueue: runs MAX_CONCURRENT_JOBS clip jobs at a time (Claude + FFmpeg + gate + upload)
```

**Why not real threads (worker_threads)?** Each channel spends its time waiting on external programs (streamlink, ffmpeg, Twitch chat, `claude`). Node already runs those in parallel, and the heavy CPU work (video encoding) happens inside ffmpeg processes. So one Node process with async workers gives the same parallelism with much less complexity. The JobQueue is what protects your CPU.

**Costs per channel:** ~3–4 Mbps of download (720p, stream copied without re-encoding) and ~300 MB of disk for the ring buffer. Each clip job uses one ffmpeg encode plus 3–5 Claude calls.

**Testing outside GTA, then going back:**
```bash
TARGET_CATEGORIES=any MAX_CHANNELS=3 npm start -- --dry-run     # any Brazilian stream, no uploads
npm start                                                       # back to GTA (TARGET_CATEGORIES default)
```

---

### Update 5: clips need a real reaction, and captions are specific

**Problem:** clips were chosen from chat *text* only, so Claude guessed "something happened in the last 20–60 s". Result: a clean kill with no reaction (Twitch-clip material) and a generic caption ("O CHAT PEDIU PRA CLIPAR ISSO").

**Now (`src/ai/moment-signals.ts`, `src/pipeline.ts`):**
1. **Audio curve:** FFmpeg `ebur128` measures loudness every second. A jump above the stream's usual level often means the streamer shouting or laughing.
2. **Chat on the video timeline:** every chat message is timestamped and mapped to a second of the recording. Viewers type 3–15 s *after* they see something, so a chat burst points back to the moment.
3. **Candidate moments:** score = audio jump at the moment + hype-chat burst right after. The top 3, at least 20 s apart, are kept.
4. **Cheap pre-filter:** if neither audio nor chat stands out (both < 1.5σ), the clip is skipped without calling Claude.
5. **Claude looks at frames** (webcam + game) before, at and after the top 2 candidates. It returns `has_reaction`, `what_happened`, `streamer_reaction` and `chat_reaction`. **No reaction means no clip.**
6. **Captions from facts:** the SEO only uses what Claude saw, in the style of Brazilian "cortes" channels. Generic/meta phrases ("o chat", "clipa", "ninguém esperava", "momento insano"…) are banned. If one appears, it rewrites once.
7. **Shorter clips in growth mode:** 25–60 s (set `CLIP_MIN_SECONDS`/`CLIP_MAX_SECONDS` to change). With growth mode off it goes back to 62–90 s for TikTok earnings.

**Same channel, before vs after (xarola_, VALORANT):**
| | Before | After |
|---|---|---|
| Moment | 80 s guessed from chat text: a clean kill | 40 s built around the chat burst (+3.3σ, "KKKK") right after he lost a duel |
| Caption | O CHAT PEDIU PRA CLIPAR ISSO 😳 | DEU 78 NA CLOVE E FICOU DE BOCA ABERTA |
| Title | VALORANT: Xarola carregando o time no fim da ranked 😳 (inferred) | VALORANT: xarola deu 78 na Clove no arco e ficou de boca aberta 😳 (from the frames) |

**Still missing:** speech-to-text (Whisper). Captions could then quote what the streamer actually said, which is the biggest remaining upgrade.

---

### Update 6: really public posts

- **YouTube API uploads are locked to private** when the Google Cloud project hasn't passed YouTube's API audit (all projects created after July 2020). Sending `privacyStatus: public` doesn't help.
- **New default: `YOUTUBE_UPLOAD_METHOD=browser`** (`src/publishing/youtube-studio.ts`). It uploads through YouTube Studio with `cookies/youtube.json` (a full Cookie-Editor export from youtube.com: about 26 cookies including `SID` and `LOGIN_INFO`). It waits for YouTube to pre-fill the title before typing, reads back the title, description, "not made for kids" and **Public** settings, and confirms the video is public through YouTube's oEmbed endpoint. It works with Studio in Portuguese or English. `publishYouTubeDraft()` finishes a stuck draft and `updateYouTubeTitle()` fixes a title, so nothing gets uploaded twice.
- **TikTok:** the uploader forces "Who can see this post: Everyone" and then confirms the post appears in TikTok Studio. New posts show **"Only me, under review"** for a few minutes; after review they switch to **Everyone**. The first test post disappeared during review, and no reason was found.

---

### Update 7: launch-day mode (GTA VI, alanzoka priority, spaced posting)

- **Priority channels** (`status: "allowed"`: alanzoka, gaules) are checked **every minute** and are **always watched when live, in any category and with any viewer count** (only reruns are skipped). The safety checks still drop trailers, movies, explicit content and so on.
- **`MIN_VIEWERS=1000`**: normal channels need 1,000+ viewers to be picked. A watched channel is dropped if it falls below 800, so streams around the limit don't flap. When one goes live and all slots are full, the smallest *idle* non-priority channel is dropped to make room. Priority channels show a ★ in the "Watching" log line.
- **Post queue** (`src/publishing/post-queue.ts`): `npm start` never uploads directly. Every approved clip is queued and the queue posts:
  - one upload at a time, at least `MIN_MINUTES_BETWEEN_POSTS` (10) apart per platform, so a new account doesn't look like spam;
  - priority channels' clips first, then the freshest;
  - clips waiting more than `MAX_QUEUE_AGE_HOURS` (3) are dropped as stale; gaules' 24 h delay is respected.
  - `npm run test:queue` runs offline checks of this logic.
- **Running unattended:**
  ```bash
  nohup caffeinate -ims node dist/index.js >> output/run.log 2>&1 &   # start (Mac won't sleep; survives closing the terminal)
  tail -f output/run.log                                            # watch
  pkill -INT -f "node dist/index.js"                                # stop (lets running clips finish)
  ```
  Keep the Mac plugged in with the lid open: `caffeinate` can't stop sleep when the lid is closed on battery.

### Update 8: SEO per platform, subtitles, daily plan, open source, assistant (19–20 Nov 2026)

Each step below, with the problem that started it, what we did, and where it lives. The study plan (section 6) has the topics and links behind each step.

| # | Problem | What we built | Where |
|---|---|---|---|
| 1 | SEO rules were guesses, and GTA 6 tags went on GTA RP/VALORANT clips | Checked each platform's limits against official docs; per-game vocabulary; hashtags ordered most-specific first; removed the "Tags de busca" keyword list (YouTube counts it as spam) | `src/ai/game-profile.ts`, `normalizeSEO` |
| 2 | One caption for every platform | A formatter per platform: YouTube 4 hashtags + `#Shorts` and a ≤ 500-char tags field; TikTok 5 hashtags, 2200 chars; Instagram 5 hashtags, no @mentions | `src/publishing/platform-seo.ts`, `npm run test:seo` |
| 3 | No Instagram | Reels through the Graph API with resumable upload from the local file, processing status polling and quota pause | `uploadToInstagram`, gate + queue |
| 4 | No subtitles (most people watch muted) | whisper.cpp + Silero VAD; English game dialogue and hallucinations filtered; profanity masked (`f*da`); PNG captions overlaid as an image track (no drawtext/libass needed) | `src/video/subtitles.ts` |
| 5 | TikTok metrics showed "not found" | The Studio list is virtualized: read it while scrolling; parse rows | `src/metrics/collect-metrics.ts` |
| 6 | ~80 posts/day looked like spam | Daily plan: min/max per platform, posting hours, even slots, viral bar 8 (7 when behind pace), freshness bonus | `postingPlan` in `post-queue.ts` |
| 7 | YouTube logged out every ~1–2 days | Google rotates session cookies; the uploader now saves them back after every run; `npm run youtube:login` for the one-time login | `src/publishing/youtube-studio.ts` |
| 8 | Publish as open source safely | README, MIT license, contributing guide, PR template; CI (type check + tests, gitleaks, npm audit); Dependabot; branch protection; runtime data and secrets kept out of git | `.github/`, `scripts/protect-main.sh` |
| 9 | Reviewing PRs across many repos | Separate project `pr-dashboard`: local web app listing open PRs from all repos with CI/review state; approve, request changes, merge, close | `~/Projects/pr-dashboard` |
| 10 | Disk 86% full | Posted clips deleted from `output/`; stale recordings from `buffer/`; tests isolated from real folders | `src/utils/clip-retention.ts` |
| 11 | Program was hard to configure | Startup assistant: suggestions (Twitch now + memory + your views), plain-language request → AI plan → Twitch validation → confirm; memory in `data/preferences.json` | `src/setup/` |

Lessons worth remembering from this round:
- **Verify, don't assume**: platform limits change. Several popular "facts" (e.g. TikTok's 4000-char caption) only hold in the app, not the API.
- **Silence isn't success**: monitoring must match failure signatures too (a buffered `cut` hid log lines for 30 minutes).
- **Tests must never touch real accounts or files**: the queue test once opened the real YouTube Studio, and later ran the real cleanup. Both are now isolated with env vars and temp folders.
- **Accented words**: in JavaScript `\b` treats "ó" as a non-letter, so `/\bsó\b/` never matches. Use Unicode-aware lookarounds (`(?<!\p{L})…(?!\p{L})` with the `u` flag).
- **Reach is decided by the platforms**: zero views on 100+ TikTok posts and stalled new Shorts were account-level limits (volume, reused content, unverified channel), not caption problems.

---

## 5. Known limitations / next improvements

- **Only live Twitch streams.** Recorded videos (VODs, YouTube links) can't be clipped yet: that needs VOD download + the VOD chat replay.
- **Reach is decided by the platforms.** A new TikTok account that posts a lot of reposted content can get 0 views; YouTube may stop testing new Shorts after a burst. Post less, verify the YouTube channel, and get streamer permission.
- **Unverified YouTube channels** have a small daily upload cap (~10); the queue pauses YouTube when it's hit.
- **Webcam detection uses one frame.** If the streamer switches scenes mid-clip, the layout can be wrong for part of it.
- **Background music isn't detected** (Content ID can claim the audio).
- **Browser uploads break when the sites change their UI** (TikTok Studio, YouTube Studio). The official APIs avoid that but need app reviews (TikTok Content Posting API, YouTube API audit).
- **Subtitles only show Portuguese speech**; English game dialogue is dropped on purpose.
- Next ideas: upload the `.srt` to YouTube as a caption track; real search phrases from YouTube autocomplete; post TikTok a few hours after YouTube; face tracking across the whole clip.

---

## 6. Study plan: the topics behind what we built

Each level lists **what to learn**, **where it is in this project**, a small **practice**, and **links**. The levels follow the order things were built, so you can study a level and then read the matching code. Levels 1–5 are the base; 6–11 cover Update 8.

### Level 1: TypeScript and Node.js foundations
- **Learn**: types and interfaces, `async/await` and Promises, ES modules (`import … from './x.js'`), `npm` scripts, `tsc`.
- **Node APIs used everywhere**: `child_process` (`spawn` vs `execFile`, pipes, exit codes: the project mostly orchestrates other programs), `EventEmitter` (`chatSensor.on('spike')`), `fs/promises`, environment variables with `dotenv` (why secrets never go into git).
- **Where**: `src/index.ts`, `src/video/video.ts` (`runFFmpeg`), `src/utils/config.ts`.
- **Practice**: write a script that runs `ffprobe` with `execFile` and prints a video's duration.
- **Links**: [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) · [Node.js child_process](https://nodejs.org/api/child_process.html) · [Node.js events](https://nodejs.org/api/events.html) · [dotenv](https://github.com/motdotla/dotenv)

### Level 2: Video with FFmpeg
- **Learn**: containers vs codecs (MP4/H.264/AAC), resolution and aspect ratio (16:9 → 9:16), keyframes, `yuv420p`. FFmpeg basics (`-i`, `-ss`, `-t`, `-c copy`), then filters (`crop`, `scale`, `trim`/`atrim`, `setpts`, `split`, `vstack`, `overlay`) and `filter_complex` labels. The **concat demuxer** (used to join buffer segments and to play the subtitle images as a timed track).
- **Where**: `src/video/layout.ts` (`buildLayoutFilter`), `src/video/video.ts`, `src/video/subtitles.ts` (ffconcat file).
- **Practice**: make any 16:9 MP4 vertical with the top-right corner (webcam) stacked over the center (game) in one command.
- **Links**: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) · [concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat-1) · [FFmpeg wiki](https://trac.ffmpeg.org/wiki)

### Level 3: Live streaming and Twitch
- **Learn**: HLS (live video in small chunks) and why we keep a ring buffer of segments; streamlink; Twitch IRC chat (tmi.js); GraphQL queries (aliases, arguments, why big aliased queries get rejected) vs the official Helix API.
- **Where**: `src/ingestion/ingestion.ts`, `src/ingestion/twitch-gql.ts`, `src/setup/twitch-lookup.ts` (trending categories in batches of 5).
- **Practice**: query the top 5 categories and count live streams in Portuguese for each.
- **Links**: [HTTP Live Streaming](https://developer.apple.com/streaming/) · [streamlink](https://streamlink.github.io/) · [Twitch chat (IRC)](https://dev.twitch.tv/docs/chat/irc/) · [Twitch Helix API](https://dev.twitch.tv/docs/api/reference/) · [Learn GraphQL](https://graphql.org/learn/)

### Level 4: AI as a component
- **Learn**: prompt engineering (context, rules, examples, "never invent"); structured outputs with **JSON Schema** and why we still validate the answer; vision (frames as input, bounding boxes); fallbacks (9Router → Claude CLI → keyword heuristics); using AI to turn plain language into a config (the startup assistant).
- **Where**: `src/ai/ai.ts` (moment picker, `buildSeoRules`, fact-check), `src/ai/claude-cli.ts` (`runClaudeJson`), `src/setup/interpret.ts` (`PLAN_SCHEMA`, `heuristicPlan`).
- **Practice**: write a schema for "pick a movie genre from a sentence" and validate the model's answer before using it.
- **Links**: [Prompt engineering overview](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview) · [Claude Code headless mode](https://docs.claude.com/en/docs/claude-code/headless) · [JSON Schema: getting started](https://json-schema.org/learn/getting-started-step-by-step)

### Level 5: Publishing, OAuth and browser automation
- **Learn**: OAuth 2.0 (client id/secret, refresh and access tokens, the **device flow** you used with `gh auth login`); YouTube Data API (`videos.insert`, quotas); Playwright (selectors, cookies, **persistent contexts**, why it breaks when a site's UI changes); how session cookies rotate (why a copied cookie file dies after a day or two).
- **Where**: `src/publishing/publishing.ts`, `src/publishing/youtube-studio.ts` (`saveYouTubeCookies`, `youtubeInteractiveLogin`).
- **Practice**: with Playwright, log in to a test site once, save `context.cookies()` to a file, and reuse it in a new browser.
- **Links**: [OAuth 2.0](https://oauth.net/2/) · [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) · [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [Playwright docs](https://playwright.dev/docs/intro) · [launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

### Level 6: Short-form SEO and platform rules (Update 8, steps 1–3)
- **Learn**: how search works on each platform (title/caption text, hidden tags, on-screen text via OCR, speech); hashtag limits (YouTube ignores all if more than 15; Instagram caps at 5); keyword stuffing and reused-content policies; API limits vs app limits; Instagram's container → upload → status → publish flow.
- **Where**: `src/ai/game-profile.ts`, `src/publishing/platform-seo.ts`, `uploadToInstagram`, `docs/task-seo-tiktok-youtube.md` (facts with sources).
- **Practice**: take one clip's `.seo.json` and run it through `formatYouTube`, `formatTikTokCaption`, `formatInstagramCaption`; compare the outputs.
- **Links**: [YouTube spam & deceptive practices policy](https://support.google.com/youtube/answer/2801973) · [YouTube Shorts monetization](https://support.google.com/youtube/answer/12504220) · [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) · [Instagram resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads) · [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)

### Level 7: Speech-to-text and subtitles (step 4)
- **Learn**: how Whisper works at a high level (audio → tokens with timestamps); whisper.cpp and quantized models (`q5_0`); **voice activity detection** (why Whisper loops/hallucinates on music and game noise without it); word timestamps and why we re-map them into the segment; the SRT format; Unicode-aware regexes (the `\b` + "ó" bug).
- **Where**: `src/video/subtitles.ts` (`fitWordsToSegment`, `cleanSegments`, `chunkWords`), `src/compliance/profanity.ts`.
- **Practice**: run `whisper-cli` on a 20 s clip with and without `--vad`, compare the JSON.
- **Links**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [Whisper paper](https://arxiv.org/abs/2212.04356) · [Silero VAD](https://github.com/snakers4/silero-vad) · [SubRip (.srt) format](https://en.wikipedia.org/wiki/SubRip) · [Unicode property escapes in regex](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape)

### Level 8: Scheduling, queues and data hygiene (steps 5–7, 10)
- **Learn**: queues with priorities (score, freshness, variety); rate limiting by time windows (daily max, even slots, "behind pace" logic); idempotency and duplicate detection; pausing on quota errors; retention rules (what is safe to delete, and when); scraping virtualized lists; designing monitoring that also matches failures.
- **Where**: `src/publishing/post-queue.ts` (`postingPlan`, `processPostQueue`), `src/utils/clip-retention.ts`, `src/metrics/collect-metrics.ts`.
- **Practice**: change `POSTS_PER_DAY_MAX` and `POST_HOURS` and work out (then test with `npm run test:queue`) when the slots open.
- **Links**: [Node.js fs](https://nodejs.org/api/fs.html) · [Rate limiting](https://en.wikipedia.org/wiki/Rate_limiting)

### Level 9: Testing (all steps)
- **Learn**: pure functions are easy to test (`clipsToDelete`, `postingPlan`, `validatePlan`); dependency injection (fake `fetch`, fake resolvers); keeping tests away from real accounts and files (env vars, temp folders); end-to-end checks in a pseudo-terminal.
- **Where**: `src/test-seo.ts`, `src/test-queue.ts`, `src/test-setup.ts`; `pr-dashboard/test/` (uses `node:test`).
- **Practice**: add a test for a new hashtag rule in `test-seo.ts`, watch it fail, then make it pass.
- **Links**: [Node.js test runner (node:test)](https://nodejs.org/api/test.html) · [Node.js assert](https://nodejs.org/api/assert.html)

### Level 10: Git, GitHub and open source (steps 8–9)
- **Learn**: branches, commits, pull requests, **stacked PRs** (a PR based on another PR's branch); GitHub Actions (workflows, jobs, triggers, required checks); **branch protection** (PRs only, checks must pass, no force push); secret scanning (gitleaks); Dependabot; `npm audit`; the `gh` CLI; licenses and contribution guides; the GitHub REST and GraphQL APIs (what the PR dashboard uses).
- **Where**: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/protect-main.sh`, `CONTRIBUTING.md`, `LICENSE`, `~/Projects/pr-dashboard/src/prs.ts` and `actions.ts`.
- **Practice**: open a PR that breaks a test, see CI block it, fix it, merge from the dashboard.
- **Links**: [Git branching](https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging) · [About pull requests](https://docs.github.com/en/pull-requests) · [GitHub Actions](https://docs.github.com/en/actions) · [Workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions) · [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) · [Dependabot](https://docs.github.com/en/code-security/dependabot) · [gitleaks](https://github.com/gitleaks/gitleaks) · [npm audit](https://docs.npmjs.com/cli/commands/npm-audit) · [gh CLI manual](https://cli.github.com/manual/) · [GitHub GraphQL API](https://docs.github.com/en/graphql) · [REST: pulls](https://docs.github.com/en/rest/pulls) · [Open Source Guides](https://opensource.guide/) · [Choose a license](https://choosealicense.com/)

### Level 11: Local web apps and security (PR dashboard)
- **Learn**: a minimal HTTP server with `node:http`; why a local app that holds your token must defend itself: **XSS** (render untrusted text with `textContent`), **CSRF** (per-session token header), **DNS rebinding** (check the `Host` header), **Content-Security-Policy**; binding to `127.0.0.1` only.
- **Where**: `~/Projects/pr-dashboard/src/server.ts`, `public/index.html` (`el()` helper).
- **Practice**: try to break it: open the dashboard and call `/api/prs` from another site or with a wrong `Host` header, and see the 401/403.
- **Links**: [Node.js http](https://nodejs.org/api/http.html) · [OWASP: XSS](https://owasp.org/www-community/attacks/xss/) · [OWASP: CSRF](https://owasp.org/www-community/attacks/csrf) · [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding) · [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

### Level 12: Terminal UX and memory (step 11)
- **Learn**: interactive CLIs with `readline/promises`; detecting a terminal (`process.stdin.isTTY`) so unattended runs never wait for input; ANSI colors and `NO_COLOR`; storing user preferences locally and ranking suggestions (frequency + recency + results).
- **Where**: `src/setup/wizard.ts`, `src/setup/preferences.ts` (`remember`, `rankSuggestions`), `src/setup/session.ts`.
- **Practice**: add a new suggestion source (e.g. "channels you clipped most") to `rankSuggestions` with a test.
- **Links**: [Node.js readline](https://nodejs.org/api/readline.html) · [process.stdin / TTY](https://nodejs.org/api/tty.html) · [NO_COLOR](https://no-color.org/)

### Always: content rights
Twitch's terms, YouTube's reused-content policy, getting streamer permission for cortes, crediting the streamer. See "Responsible use" in the README.

---

## 7. Useful commands

```bash
npm start                      # ask what to clip (terminal), then run
npm start -- --no-setup        # skip the questions, reuse data/session.json
npm start -- --dry-run         # never uploads
npm run setup                  # only choose what to clip
npm run youtube:login          # log in to YouTube Studio once
npm run metrics                # views per posted video
npm run cleanup:clips -- --dry-run   # what would be deleted from output/ and buffer/
npm test                       # all offline tests (SEO, queue/daily plan, assistant)
npm run typecheck
npm run scan:permissions       # look for clip rules in streamers' Twitch panels
npm run block -- <login> "reason"
npm run test:publish -- output/<clip>.mp4 [--youtube-only|--tiktok-only|--instagram-only]
npm run test:layout            # re-render a saved buffer to check the framing
npm run test:live              # live trial on channels live now (gate decides posting)
```
