# Study Plan

**This file is with the topics and what can be studied to understand how it works!**

Stream Clipper mixes many technologies: Node.js orchestrating other programs, video editing with FFmpeg, live streaming, AI models, speech-to-text, browser automation, platform APIs, testing, CI and open source on GitHub. You don't need all of it to *use* the app (that's in the [README](README.md)); this plan is for understanding *how it works* and being able to change it.

Each level lists **what to learn**, **where it is in this project**, a small **practice** exercise, and **links** to good documentation. The levels follow the order the project was built: study a level, then open the files it points to and read the code. Levels 1–5 are the base; 6–12 cover the features added later (see the update history in [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md#4-update-history)).

## Level 1: TypeScript and Node.js foundations
- **Learn**: types and interfaces, `async/await` and Promises, ES modules (`import … from './x.js'`), `npm` scripts, `tsc`.
- **Node APIs used everywhere**: `child_process` (`spawn` vs `execFile`, pipes, exit codes: the project mostly orchestrates other programs), `EventEmitter` (`chatSensor.on('spike')`), `fs/promises`, environment variables with `dotenv` (why secrets never go into git).
- **Where**: `src/index.ts`, `src/video/video.ts` (`runFFmpeg`), `src/utils/config.ts`.
- **Practice**: write a script that runs `ffprobe` with `execFile` and prints a video's duration.
- **Links**: [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) · [Node.js child_process](https://nodejs.org/api/child_process.html) · [Node.js events](https://nodejs.org/api/events.html) · [dotenv](https://github.com/motdotla/dotenv)

## Level 2: Video with FFmpeg
- **Learn**: containers vs codecs (MP4/H.264/AAC), resolution and aspect ratio (16:9 → 9:16), keyframes, `yuv420p`. FFmpeg basics (`-i`, `-ss`, `-t`, `-c copy`), then filters (`crop`, `scale`, `trim`/`atrim`, `setpts`, `split`, `vstack`, `overlay`) and `filter_complex` labels. The **concat demuxer** (used to join buffer segments and to play the subtitle images as a timed track).
- **Where**: `src/video/layout.ts` (`buildLayoutFilter`), `src/video/video.ts`, `src/video/subtitles.ts` (ffconcat file).
- **Practice**: make any 16:9 MP4 vertical with the top-right corner (webcam) stacked over the center (game) in one command.
- **Links**: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) · [concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat-1) · [FFmpeg wiki](https://trac.ffmpeg.org/wiki)

## Level 3: Live streaming and Twitch
- **Learn**: HLS (live video in small chunks) and why we keep a ring buffer of segments; streamlink; Twitch IRC chat (tmi.js); GraphQL queries (aliases, arguments, why big aliased queries get rejected) vs the official Helix API.
- **Where**: `src/ingestion/ingestion.ts`, `src/ingestion/twitch-gql.ts`, `src/setup/twitch-lookup.ts` (trending categories in batches of 5).
- **Practice**: query the top 5 categories and count live streams in Portuguese for each.
- **Links**: [HTTP Live Streaming](https://developer.apple.com/streaming/) · [streamlink](https://streamlink.github.io/) · [Twitch chat (IRC)](https://dev.twitch.tv/docs/chat/irc/) · [Twitch Helix API](https://dev.twitch.tv/docs/api/reference/) · [Learn GraphQL](https://graphql.org/learn/)

## Level 4: AI as a component
- **Learn**: prompt engineering (context, rules, examples, "never invent"); structured outputs with **JSON Schema** and why we still validate the answer; vision (frames as input, bounding boxes); fallbacks (9Router → Claude CLI → keyword heuristics); using AI to turn plain language into a config (the startup assistant).
- **Where**: `src/ai/ai.ts` (moment picker, `buildSeoRules`, fact-check), `src/ai/claude-cli.ts` (`runClaudeJson`), `src/setup/interpret.ts` (`PLAN_SCHEMA`, `heuristicPlan`).
- **Practice**: write a schema for "pick a movie genre from a sentence" and validate the model's answer before using it.
- **Links**: [Prompt engineering overview](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview) · [Claude Code headless mode](https://docs.claude.com/en/docs/claude-code/headless) · [JSON Schema: getting started](https://json-schema.org/learn/getting-started-step-by-step)

## Level 5: Publishing, OAuth and browser automation
- **Learn**: OAuth 2.0 (client id/secret, refresh and access tokens, the **device flow** you used with `gh auth login`); YouTube Data API (`videos.insert`, quotas); Playwright (selectors, cookies, **persistent contexts**, why it breaks when a site's UI changes); how session cookies rotate (why a copied cookie file dies after a day or two).
- **Where**: `src/publishing/publishing.ts`, `src/publishing/youtube-studio.ts` (`saveYouTubeCookies`, `youtubeInteractiveLogin`).
- **Practice**: with Playwright, log in to a test site once, save `context.cookies()` to a file, and reuse it in a new browser.
- **Links**: [OAuth 2.0](https://oauth.net/2/) · [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) · [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [Playwright docs](https://playwright.dev/docs/intro) · [launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

## Level 6: Short-form SEO and platform rules (Update 8, steps 1–3)
- **Learn**: how search works on each platform (title/caption text, hidden tags, on-screen text via OCR, speech); hashtag limits (YouTube ignores all if more than 15; Instagram caps at 5); keyword stuffing and reused-content policies; API limits vs app limits; Instagram's container → upload → status → publish flow.
- **Where**: `src/ai/game-profile.ts`, `src/publishing/platform-seo.ts`, `uploadToInstagram`, `docs/task-seo-tiktok-youtube.md` (facts with sources).
- **Practice**: take one clip's `.seo.json` and run it through `formatYouTube`, `formatTikTokCaption`, `formatInstagramCaption`; compare the outputs.
- **Links**: [YouTube spam & deceptive practices policy](https://support.google.com/youtube/answer/2801973) · [YouTube Shorts monetization](https://support.google.com/youtube/answer/12504220) · [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) · [Instagram resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads) · [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)

## Level 7: Speech-to-text and subtitles (step 4)
- **Learn**: how Whisper works at a high level (audio → tokens with timestamps); whisper.cpp and quantized models (`q5_0`); **voice activity detection** (why Whisper loops/hallucinates on music and game noise without it); word timestamps and why we re-map them into the segment; the SRT format; Unicode-aware regexes (the `\b` + "ó" bug).
- **Where**: `src/video/subtitles.ts` (`fitWordsToSegment`, `cleanSegments`, `chunkWords`), `src/compliance/profanity.ts`.
- **Practice**: run `whisper-cli` on a 20 s clip with and without `--vad`, compare the JSON.
- **Links**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [Whisper paper](https://arxiv.org/abs/2212.04356) · [Silero VAD](https://github.com/snakers4/silero-vad) · [SubRip (.srt) format](https://en.wikipedia.org/wiki/SubRip) · [Unicode property escapes in regex](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape)

## Level 8: Scheduling, queues and data hygiene (steps 5–7, 10)
- **Learn**: queues with priorities (score, freshness, variety); rate limiting by time windows (daily max, even slots, "behind pace" logic); idempotency and duplicate detection; pausing on quota errors; retention rules (what is safe to delete, and when); scraping virtualized lists; designing monitoring that also matches failures.
- **Where**: `src/publishing/post-queue.ts` (`postingPlan`, `processPostQueue`), `src/utils/clip-retention.ts`, `src/metrics/collect-metrics.ts`.
- **Practice**: change `POSTS_PER_DAY_MAX` and `POST_HOURS` and work out (then test with `npm run test:queue`) when the slots open.
- **Links**: [Node.js fs](https://nodejs.org/api/fs.html) · [Rate limiting](https://en.wikipedia.org/wiki/Rate_limiting)

## Level 9: Testing (all steps)
- **Learn**: pure functions are easy to test (`clipsToDelete`, `postingPlan`, `validatePlan`); dependency injection (fake `fetch`, fake resolvers); keeping tests away from real accounts and files (env vars, temp folders); end-to-end checks in a pseudo-terminal.
- **Where**: `src/test-seo.ts`, `src/test-queue.ts`, `src/test-setup.ts`; `pr-dashboard/test/` (uses `node:test`).
- **Practice**: add a test for a new hashtag rule in `test-seo.ts`, watch it fail, then make it pass.
- **Links**: [Node.js test runner (node:test)](https://nodejs.org/api/test.html) · [Node.js assert](https://nodejs.org/api/assert.html)

## Level 10: Git, GitHub and open source (steps 8–9)
- **Learn**: branches, commits, pull requests, **stacked PRs** (a PR based on another PR's branch); GitHub Actions (workflows, jobs, triggers, required checks); **branch protection** (PRs only, checks must pass, no force push); secret scanning (gitleaks); Dependabot; `npm audit`; the `gh` CLI; licenses and contribution guides; the GitHub REST and GraphQL APIs (what the PR dashboard uses).
- **Where**: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/protect-main.sh`, `CONTRIBUTING.md`, `LICENSE`, `~/Projects/pr-dashboard/src/prs.ts` and `actions.ts`.
- **Practice**: open a PR that breaks a test, see CI block it, fix it, merge from the dashboard.
- **Links**: [Git branching](https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging) · [About pull requests](https://docs.github.com/en/pull-requests) · [GitHub Actions](https://docs.github.com/en/actions) · [Workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions) · [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) · [Dependabot](https://docs.github.com/en/code-security/dependabot) · [gitleaks](https://github.com/gitleaks/gitleaks) · [npm audit](https://docs.npmjs.com/cli/commands/npm-audit) · [gh CLI manual](https://cli.github.com/manual/) · [GitHub GraphQL API](https://docs.github.com/en/graphql) · [REST: pulls](https://docs.github.com/en/rest/pulls) · [Open Source Guides](https://opensource.guide/) · [Choose a license](https://choosealicense.com/)

## Level 11: Local web apps and security (PR dashboard)
- **Learn**: a minimal HTTP server with `node:http`; why a local app that holds your token must defend itself: **XSS** (render untrusted text with `textContent`), **CSRF** (per-session token header), **DNS rebinding** (check the `Host` header), **Content-Security-Policy**; binding to `127.0.0.1` only.
- **Where**: `~/Projects/pr-dashboard/src/server.ts`, `public/index.html` (`el()` helper).
- **Practice**: try to break it: open the dashboard and call `/api/prs` from another site or with a wrong `Host` header, and see the 401/403.
- **Links**: [Node.js http](https://nodejs.org/api/http.html) · [OWASP: XSS](https://owasp.org/www-community/attacks/xss/) · [OWASP: CSRF](https://owasp.org/www-community/attacks/csrf) · [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding) · [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

## Level 12: Terminal UX and memory (step 11)
- **Learn**: interactive CLIs with `readline/promises`; detecting a terminal (`process.stdin.isTTY`) so unattended runs never wait for input; ANSI colors and `NO_COLOR`; storing user preferences locally and ranking suggestions (frequency + recency + results).
- **Where**: `src/setup/wizard.ts`, `src/setup/preferences.ts` (`remember`, `rankSuggestions`), `src/setup/session.ts`.
- **Practice**: add a new suggestion source (e.g. "channels you clipped most") to `rankSuggestions` with a test.
- **Links**: [Node.js readline](https://nodejs.org/api/readline.html) · [process.stdin / TTY](https://nodejs.org/api/tty.html) · [NO_COLOR](https://no-color.org/)

## Always: content rights
Twitch's terms, YouTube's reused-content policy, getting streamer permission for cortes, crediting the streamer. See "Responsible use" in the README.
