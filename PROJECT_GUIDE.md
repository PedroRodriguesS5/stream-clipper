# Stream Clipper: Project Guide

## 1. What the project does (in one paragraph)

Stream Clipper watches a **live Portuguese-speaking Twitch stream** (by default the biggest live *Grand Theft Auto VI* stream in Portuguese). It keeps the **last ~5 minutes of video** on disk and reads the **live chat**. When chat suddenly explodes (lots of "KKKKK", "CLIPA", emote spam), it assumes something funny or epic just happened. It asks **Claude** to pick the best 15–45 seconds and turns that into a **vertical 9:16 video** with the streamer's **webcam on top and the game below**. Claude then writes a **title, description and hashtags in Brazilian Portuguese**, and the clip is uploaded to **YouTube Shorts** and **TikTok**.

---

## 2. The pipeline, step by step

```
Twitch (PT stream)
   │
   ├─ video ─► streamlink ─► ffmpeg (30s segments, ring of 10) ─► buffer/segment_00X.mp4
   │
   └─ chat ──► tmi.js ─► ChatVelocitySensor ── "spike!" (more than 20 msgs in 10s)
                                    │
                                    ▼
        1. Snapshot: join the segments into one ~5 min MP4
        2. Claude (text) : reads the chat and picks clip_start / clip_end / hook_split_point
        3. Claude (vision): looks at one frame and finds where the webcam and the game are
        4. FFmpeg: trims, reorders (climax first), stacks webcam + game into 1080x1920
        5. Claude (text) : writes the title/description/hashtags in pt-BR
        6. Upload: YouTube Data API + TikTok Studio (Playwright browser automation)
```

| Step | File | What to look at |
|---|---|---|
| Find PT streams | `src/ingestion/ingestion.ts` → `discoverLiveGtaVIStreams` | Twitch GQL query with `broadcasterLanguages: [PT]` |
| Rolling buffer | `src/ingestion/ingestion.ts` → `RollingStreamBuffer` | `ffmpeg -f segment -segment_wrap` |
| Hype detection | `src/ingestion/ingestion.ts` → `ChatVelocitySensor` | sliding window of message timestamps |
| Pick the moment | `src/ai/ai.ts` → `extractClipWithClaudeAgent` | `claude -p ... --json-schema` |
| Find the face | `src/video/layout.ts` → `planLayout` | frame → Claude reads the image → boxes in pixels |
| Build the vertical video | `src/video/layout.ts` → `buildLayoutFilter`, `src/video/video.ts` | FFmpeg `filter_complex` |
| SEO in Portuguese | `src/ai/ai.ts` → `generateSEO`, `buildSeoRules` | the language rules in the prompt |
| Publish | `src/publishing/publishing.ts` | OAuth2 refresh token, Playwright cookies |
| Settings | `src/utils/config.ts`, `.env` | every option and its default |

---

## 3. What changed in this update

### a) The face is no longer cut
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

### b) Portuguese streams only
`STREAM_LANGUAGE=PT` (the default) passes Twitch's own `broadcasterLanguages` filter and double-checks each broadcaster's language. Streams filed under another GTA category (e.g. GTA V RP) count too, as long as their title says GTA 6. The clipping prompt also tells Claude that the chat is Brazilian Portuguese and what hype looks like there (KKKK, MDS, CLIPA…).

### c) Titles / description / hashtags in Portuguese
`CONTENT_LOCALE=pt-BR` (or `pt-PT` for Portugal). The prompt forces Portuguese text, puts "GTA 6" near the start of the title (that's what people search), keeps the title under 70 characters, and uses Brazilian hashtags (`#gta6brasil #cortes #cortesdelive`…). YouTube uploads also set `defaultLanguage` / `defaultAudioLanguage`, so YouTube recommends the clip to Portuguese speakers.

**Per-game and per-platform SEO** (`src/ai/game-profile.ts`, `src/publishing/platform-seo.ts`). Every keyword and hashtag comes from the game actually streamed, so GTA RP clips get `#gtarp…` and never `#gta6…`. Hashtags are stored most-specific first (micro-topic, streamer, game, BR niche), and each platform keeps only what it can use:

| | YouTube Shorts | TikTok | Instagram Reels |
|---|---|---|---|
| Hashtags | 4 + `#Shorts` (first 3 show above the title; more than 15 = all ignored) | 5, at the end | 5 (Instagram's limit since Dec 2025) |
| Search phrases | hidden `tags` field, 500 chars total | written as normal sentences in the caption | written as normal sentences in the caption |
| Text limit | title 100, description 5000 | 2200 (API-safe; the app allows 4000) | 2200 |
| Credit | `Live na Twitch: @x` or `twitch.tv/x` | same | `@x` turned into a plain name / `twitch.tv/x`, so strangers with that handle aren't tagged |

The old `Tags de busca: a, b, c` list in descriptions was removed: YouTube's spam policy counts keyword lists in the description as "tag stuffing". `npm run test:seo` checks these rules offline.

### c4) Daily posting plan (5-10 per platform)
`POSTS_PER_DAY_MIN=5`, `POSTS_PER_DAY_MAX=10`, `POST_HOURS=10-23` (local time). Each platform gets at most 10 slots a day, spread evenly over the posting hours (~78 min apart). Clips wait in the queue and each slot takes the **most viral** one: virality score, +2 for priority channels, -3 if the same streamer was just posted, -0.5 per hour of waiting (fresh moments win). Only clips scored **>= 8** (`MIN_POST_SCORE`) are posted; if a platform is behind the 5-a-day pace (or under 5 near the end of the window) the bar drops to 7 so the day still reaches 5. Weaker clips go stale after `MAX_QUEUE_AGE_HOURS`. Per-platform overrides: `POSTS_PER_DAY_MAX_TIKTOK=5`, etc.

### c3) Whisper subtitles
Every clip gets the streamer's speech burned in as big 1-3 word captions (keywords in yellow), about 60% down the screen, clear of the TikTok/Reels buttons (`src/video/subtitles.ts`). Most people watch muted, and TikTok/Instagram read on-screen text for search. It runs locally with whisper.cpp (about 2 s per clip on an M4):
```bash
brew install whisper-cpp
mkdir -p models
curl -L -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o models/ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```
The Silero VAD model matters: without it Whisper repeats the same sentence over game noise. The code also drops English NPC dialogue and known Whisper hallucinations ("Legendas pela comunidade Amara.org"), masks swear words with one asterisk (`f*da`, `p*rra`), and skips subtitles when fewer than 4 Portuguese words are spoken. An `.srt` is saved next to each clip. `SUBTITLES=off` disables it. FFmpeg's drawtext/libass aren't needed: each caption is a PNG rendered by Playwright and played as an image track.

### c2) Instagram Reels
Set `INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_ACCOUNT_ID` (see `.env.example`), and every approved clip is also queued for Instagram, with the same spacing as the other platforms. The upload goes straight from the local file (Graph API resumable upload), waits until Instagram finishes processing, then publishes. When the 24 h publishing quota is used up, the queue pauses Instagram instead of failing the clip. `npm run test:publish -- output/<clip>.mp4 --instagram-only` posts one clip. Streamers on the allowlist need `"instagram"` in `platformsAllowed`. Instagram ranks reposts below originals and may not recommend repost-only accounts to non-followers, so clips without the webcam reframing + hook caption reach very few people there.

Example output from a test run:
> **GTA 6: thimagroo fugiu da polícia e achou um poste 😂**
> O thimagroo tava numa fuga insana da polícia no GTA 6 até que um poste apareceu no meio do caminho… Segue pra mais cortes!
> `#gta6 #gtavi #gta6brasil #cortes #cortesdelive #twitch #thimagroo`

### d) Bug fixed along the way
Your Homebrew FFmpeg has **no `drawtext` filter** (it was built without libfreetype). The main pipeline burns the title into the video, so every render in `npm start` would have crashed. Now the caption is **skipped with a warning** when `drawtext` is missing. To get captions back, install an FFmpeg build that includes libfreetype (for example the `homebrew-ffmpeg/ffmpeg` tap with `--with-freetype`, or a static build from evermeet.cx).

---

## 3.5 Update 2: permissions, chat validation, monetization gate

### Clip permission list (`data/clip-permissions.json`, `src/compliance/`)
- A channel can only be clipped **and posted** if its entry is `status: "allowed"` **with a quoted piece of evidence** (panel text, written permission…). Unknown means not allowed.
- `npm run scan:permissions` scans live PT channels (big **and** small, sorted both ways) in `SCAN_CATEGORIES`. It reads each channel's Twitch bio and text panels, and Claude classifies any clip rules it finds. An "allowed" result is downgraded to `needs_review` if the quote isn't verbatim, or if no platform (YouTube/TikTok) is named.
- **Result of the first scan (18 Nov 2026):** 448 live PT channels. 18 mention clips/cuts, **0 explicitly allow third parties to post them**. Most only promote their *own* clip channel. One (a monthly clip contest) invites clipping but names no platform and says nothing about monetization. Many channels put their rules in **image panels**, which can't be read as text.
- So, for now, **written permission is the way in**: use the template in `docs/pedido-de-permissao.md` (pt-BR) and record the answer. Small creators are the best bet.

### Chat validation by channel size (`src/ingestion/chat-validation.ts`)
| Tier | Viewers | Window | Needs |
|---|---|---|---|
| small | < 100 | 20 s | ≥ 5 msgs or 3× its own baseline, 3+ people, 30%+ hype |
| normal | 100–2000 | 10 s | ≥ 12 msgs or 2.5× baseline, 6+ people, 35%+ hype |
| big | > 2000 | 8 s | ≥ 40 msgs or 2× baseline, 20+ people, 40%+ hype |

It ignores bots (Nightbot, StreamElements…), `!commands`, links, number-counting spam, and repeated copy-paste. Each person counts for at most 2 messages per window, and enough different people must be reacting. "Hype" means KKKK, MDS, CLIPA, NÃO ACREDITO, KEKW, emote-only messages, CAPS shouting, and similar. Run `npm run test:chat` for 14 offline checks.

### Monetization gate (`src/compliance/monetization.ts`)
Each rendered clip gets a report `output/<clip>.monetization.json`. It is **posted only to platforms where every check passes**:
1. Streamer permission with evidence, **explicit permission to monetize**, the platform allowed, credit in the description if required.
2. No third-party media in the stream (react/film/sports/music in the title or category, plus a vision check of the frames).
3. Transformation (YouTube's reused-content policy): webcam/face reframing **plus** an on-screen hook caption **plus** the loop re-edit. Blur-only clips (no webcam) fail.
4. Advertiser-friendly: no profanity in caption/title/description, plus a Claude vision review of 3 frames.
5. Account in the program: `YOUTUBE_PARTNER_PROGRAM=true` / `TIKTOK_CREATOR_REWARDS=true` (you set these, since the APIs don't expose them).
6. Duration: YouTube ≤ 180 s, TikTok > 60 s. That's why clips are now 62–90 s.

What it **can't** check: background music (Content ID), and the platforms' final decision. Passing the gate means "meets every rule we can check", not "guaranteed money".

Hook captions are drawn with Playwright as a transparent PNG, because this FFmpeg has no drawtext/libass, and placed just below the webcam.

### Live test (18 Nov 2026, `npm run test:live`)
| Channel | Viewers / tier | Layout | Result |
|---|---|---|---|
| surskity11 | 1049 / normal | stack (webcam detected) | **blocked**: no permission, no monetization permission, accounts not in programs |
| dabliuking | 97 / small | blur (no webcam) | **blocked**: same + transformation (no webcam) |

Nothing was posted, which is correct: neither streamer has given permission.

---

## 3.6 Update 3: growth mode, block list, delayed posting

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

## 3.7 Update 4: watching several channels at once

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

## 3.8 Update 5: clips need a real reaction, and captions are specific

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

## 3.9 Update 6: really public posts

- **YouTube API uploads are locked to private** when the Google Cloud project hasn't passed YouTube's API audit (all projects created after July 2020). Sending `privacyStatus: public` doesn't help.
- **New default: `YOUTUBE_UPLOAD_METHOD=browser`** (`src/publishing/youtube-studio.ts`). It uploads through YouTube Studio with `cookies/youtube.json` (a full Cookie-Editor export from youtube.com: about 26 cookies including `SID` and `LOGIN_INFO`). It waits for YouTube to pre-fill the title before typing, reads back the title, description, "not made for kids" and **Public** settings, and confirms the video is public through YouTube's oEmbed endpoint. It works with Studio in Portuguese or English. `publishYouTubeDraft()` finishes a stuck draft and `updateYouTubeTitle()` fixes a title, so nothing gets uploaded twice.
- **TikTok:** the uploader forces "Who can see this post: Everyone" and then confirms the post appears in TikTok Studio. New posts show **"Only me, under review"** for a few minutes; after review they switch to **Everyone**. The first test post disappeared during review, and no reason was found.

---

## 3.10 Update 7: launch-day mode (GTA VI, alanzoka priority, spaced posting)

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

---

## 4. Known limitations / next improvements

- **Claude only "sees" the chat when choosing the moment**, not the video or audio. Adding **audio loudness peaks** (streamer screaming) and a few sampled frames would pick better moments.
- Webcam detection uses **one frame**. If the streamer switches scenes mid-clip, the layout can be wrong for part of it.
- YouTube uploads use `YOUTUBE_PRIVACY` (default `private`).
- Background music in the stream isn't detected (Content ID can claim the audio).
- **Copyright/permission:** reposting other streamers' content can earn strikes. Many Brazilian streamers allow "cortes" but some don't; check before you automate at scale.

---

## 5. Topics to study (in a good order)

### Level 1: Foundations
1. **TypeScript + Node.js**: `async/await`, Promises, ES modules (`import ... from './x.js'`), `npm` scripts, `tsc`.
2. **Child processes in Node**: `child_process.spawn` vs `execFile`, stdin/stdout **pipes**, exit codes. The project is mostly "Node orchestrating other programs" (streamlink, ffmpeg, claude).
3. **EventEmitter**: how `chatSensor.on('spike', ...)` works.
4. **Environment variables & `.env`**: `dotenv`, why secrets never go into git.

### Level 2: Video
5. **Video basics**: containers vs codecs (MP4 / H.264 / AAC), resolution, **aspect ratio** (16:9 vs 9:16), frame rate, keyframes, `yuv420p` (and why widths must be even).
6. **FFmpeg**: start with `-i`, `-ss`, `-t`, `-c copy`, then learn **filters**: `crop`, `scale`, `trim`/`atrim`, `setpts`, `concat`, `split`, `vstack`, `overlay`, `boxblur`, `drawtext`. Then learn `filter_complex` with labels like `[v_cat]`. That's the heart of `video.ts` and `layout.ts`.
   *Practice:* take any MP4 and make it vertical with the webcam on top using one FFmpeg command.
7. **HLS live streaming & streamlink**: how Twitch delivers live video in small chunks, and why we use segments + a ring buffer.

### Level 3: Twitch
8. **Twitch IRC chat** (tmi.js): channels, messages, tags, rate limits.
9. **GraphQL**: the discovery query in `ingestion.ts`. Compare it with the official **Twitch Helix API** (`GET /streams?language=pt&game_id=...`), which is the supported way and needs an app token.

### Level 4: AI
10. **Prompt engineering**: giving context, rules and examples (see `buildSeoRules`).
11. **Structured outputs / JSON Schema**: why we pass `--json-schema` and still validate (`validateClipDecision`).
12. **Claude Code CLI in headless mode**: `claude -p`, `--output-format json`, `--tools`, `--allowedTools`.
13. **Vision models**: how a model can return bounding boxes, and why we pad and clamp them.
14. *(Next step)* **Face detection without an LLM**: OpenCV / MediaPipe face detection. Faster and free per frame, useful for tracking a face across the whole clip.
15. *(Next step)* **Speech-to-text**: Whisper / whisper.cpp for Portuguese subtitles.

### Level 5: Publishing & growth
16. **OAuth 2.0**: client id/secret, refresh tokens, access tokens (`publishing.ts`).
17. **YouTube Data API v3**: `videos.insert`, quotas (an upload costs 1600 units of the 10,000/day default), the Shorts rules (≤ 3 min, vertical).
18. **Browser automation with Playwright**: cookies, selectors, why it breaks when TikTok changes its UI.
19. **Short-form SEO & retention**: hook in the first 1–2 seconds (why we put the climax first and loop), titles with search keywords, Portuguese hashtags, posting times for Brazil (BRT, UTC-3).
20. **Content rights**: Twitch ToS, YouTube reused-content policy, getting streamer permission for "cortes".

---

## 6. Useful commands

```bash
npm start                 # supervisor: watches MAX_CHANNELS live PT channels at once
npm start -- --dry-run    # same, never uploads
npm run scan:permissions  # look for clip rules in live PT channels' Twitch panels
npm run test:chat         # offline tests of the chat validation
npm run test:layout       # re-render a saved buffer to check the vertical framing
npm run test:live         # live trial on 2 PT GTA channels live now (gate decides posting)
npm run test:e2e          # synthetic end-to-end test
npm run test:publish -- output/<clip>.mp4   # post a rendered clip (only if its gate report passed)
```
