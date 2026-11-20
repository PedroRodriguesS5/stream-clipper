# Live Stream Clipping Agent — Architecture Blueprint

## 1. System Overview
An event-driven, autonomous live-stream clipping pipeline written in **Node.js + TypeScript**. It buffers a live Twitch stream into a 5-minute rolling ring buffer, monitors live Twitch IRC chat velocity for hype spikes, invokes **Claude Code CLI (`claude -p`) as a local AI Agent** (zero API key required) to choose clip timestamps and an infinite-loop split point, edits the clip into a **9:16 (1080x1920) seamless infinite loop** using **FFmpeg**, generates viral SEO metadata, and publishes to **YouTube Shorts** and **TikTok**.

---

## 2. Directory Structure
```text
/src
  /ingestion
    ingestion.ts      # Streamlink + FFmpeg 5-min rolling ring buffer & TMI.js sliding-window sensor
  /ai
    ai.ts             # Claude Code CLI Agent (`claude -p --json-schema`) & 9Router SEO generator
  /video
    video.ts          # FFmpeg `filter_complex` `hook_split_point` infinite loop stitcher
    layout.ts         # Webcam detection (Claude vision) + 9:16 stack/blur/face-center framing
  /publishing
    publishing.ts     # YouTube Data API v3 (OAuth2) & Playwright TikTok Studio cookie uploader
  /utils
    config.ts         # Centralized typed environment configuration
    logger.ts         # Structured timestamped logger
    cleanup.ts        # Directory bootstrap & rolling file cleanup
  /types
    tmi.d.ts          # Strict TypeScript definitions for tmi.js
  index.ts            # Live stream daemon entry point
  test-pipeline.ts    # End-to-end verification suite
```

---

## 3. End-to-End Data Flow
1. **Ingestion (`RollingStreamBuffer` & `ChatVelocitySensor`)**
   - `streamlink --stdout https://twitch.tv/<channel> best` pipes into `ffmpeg -f segment -segment_time 30 -segment_wrap 10`, maintaining a continuous 5-minute rolling buffer (`segment_000.mp4` .. `segment_009.mp4`).
   - Discovery only selects streams whose broadcaster language is `STREAM_LANGUAGE` (default `PT`).
   - `tmi.js` monitors live chat in a 10-second sliding window. When velocity exceeds `>20 messages / 10s`, it emits a `spike` event with the recent chat context.
2. **AI Decision Engine (`extractClipWithClaudeAgent` & `generateSEO`)**
   - Spawns `claude -p <prompt> --output-format json --json-schema <EXTRACT_CLIP_JSON_SCHEMA> --tools ""` directly via `child_process.execFile`.
   - Returns strictly validated `{ clip_start, clip_end, hook_split_point, reason }` without needing a `CLAUDE_API_KEY`.
   - Generates `{ title, description, hashtags }` in `CONTENT_LOCALE` (default `pt-BR`) via local **9Router** or the **Claude Code CLI Agent**.
3. **Video Engine (`createInfiniteLoopClip`)**
   - Uses a single FFmpeg `filter_complex` graph to:
     - Trim Part B (`[hook_split_point .. clip_end]`) and Part A (`[clip_start .. hook_split_point]`)
     - Concatenate `[Part B][Part A]` (`concat=n=2:v=1:a=1`) so the climax hooks the viewer immediately and the ending seamlessly loops back into the buildup.
     - Reframe to `9:16` (`1080x1920`) with `src/video/layout.ts`: Claude reads one frame and locates the webcam + gameplay, then the clip is stacked (webcam top / game bottom), face-centered (IRL), or blurred-background fit (fallback). Override with `VIDEO_LAYOUT`, `FACECAM_REGION`, `GAMEPLAY_REGION`.
4. **Publishing (`uploadToYouTube` & `uploadToTikTok`)**
   - **YouTube Shorts**: Authenticates with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` via `googleapis` and uploads the vertical `.mp4`.
   - **TikTok Studio**: Loads `./cookies/tiktok.json` (exported from Cookie-Editor), normalizes `sameSite` (`no_restriction` -> `None`, `lax` -> `Lax`) and `expirationDate` -> `expires`, injects cookies into Playwright Chromium, and automates the TikTok Studio upload.

---

## 4. Commands
- **Run full End-to-End Test Suite**:
  ```bash
  npm run test:e2e
  ```
- **Start Live Stream Clipping Agent**:
  ```bash
  npm start
  ```
