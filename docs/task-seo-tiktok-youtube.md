# Task: SEO for YouTube Shorts, TikTok and Instagram Reels

## Verified platform facts (checked Nov 2026)

| Fact | Confidence | Source |
|---|---|---|
| YouTube `snippet.tags`: 500 characters for the whole list | Official docs | [YouTube Data API videos resource](https://developers.google.com/youtube/v3/docs/videos) |
| YouTube: more than 15 hashtags means all of them are ignored; the first 3 show above the title | Widely reported, says it comes from YouTube Help | [hashtagtools](https://hashtagtools.io/blog/youtube-shorts-character-limits-title-description-hashtags-2026), [socialk.it](https://socialk.it/en/blog/youtube-hashtags-guide) |
| YouTube: tags pasted into the description ("tag stuffing") break the spam policy | Official policy (example from the archived version) | [YouTube spam policy](https://support.google.com/youtube/answer/2801973) |
| TikTok caption: 2200 via TikTok's API, 4000 in the app | Official API doc for 2200; the 4000 figure is only from guides | [kodahq](https://kodahq.app/en/reference/tiktok-caption-and-hashtag-limits), [linklay](https://linklay.io/guides/kb/tiktok-caption-character-limit) |
| TikTok search reads the caption, on-screen text (OCR) and speech; 3-5 hashtags; keyword near the start | Agreement across guides, not TikTok docs | [darkroom](https://www.darkroomagency.com/observatory/tiktok-seo), [shortgen](https://shortgen.io/blog/tiktok-seo-2026) |
| Instagram: 5 hashtags max per post/Reel since Dec 2025 (rollout may vary) | Widely reported | [Later](https://later.com/blog/ultimate-guide-to-using-instagram-hashtags/), [creatorlane](https://creatorlanehq.com/blog/instagram-5-hashtag-limit-2026) |
| Instagram Graph API caption: 2200 chars, 30 hashtags, 20 @mentions | Official docs | [IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) |
| Reels via the API: 3 s to 15 min, 300 MB, H.264/HEVC, AAC, 9:16 recommended | Official docs | same |
| Resumable upload from a local file (`rupload.facebook.com`), status `FINISHED` before publishing | Official docs | [Resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads) |
| Publishing quota: `content_publishing_limit` (docs say 50 or 100 per 24 h, so read it live) | Official docs (they contradict each other) | [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) |
| Instagram ranks reposts below originals; repost-only accounts may not be recommended | Official announcement (2022) + 2026 expansion | [Engadget](https://www.engadget.com/instagrams-algorithm-overhaul-will-reward-original-content-and-penalize-aggregators-130018977.html), [PetaPixel](https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/) |

Not verified: Brazil-specific best posting times (no good data found; measure our own instead).

## Done
- [x] Per-game vocabulary (`src/ai/game-profile.ts`): no GTA 6 tags or phrases on GTA RP / other games
- [x] `normalizeSEO` drops wrong-game and filler tags, orders hashtags most-specific first, removes "Tags de busca" lists
- [x] Separate formatters per platform (`src/publishing/platform-seo.ts`): YouTube (4 + #Shorts, tags at 500 chars or less), TikTok (5 hashtags, 2200 chars, line breaks), Instagram (5 hashtags, 2200 chars, no @mentions)
- [x] YouTube API and YouTube Studio uploads use the same formatter
- [x] TikTok caption typed line by line (Escape before Enter so suggestion lists don't pick a tag)
- [x] Instagram Reels publishing (resumable upload, status polling, quota pause) in the gate and the queue
- [x] `npm run test:seo` (offline)
- [x] Whisper subtitles burned in (whisper.cpp large-v3-turbo + Silero VAD, English/hallucination filter, profanity mask, `.srt` per clip)
- [x] Hook caption badge shows the streamed game (was always "GTA VI")
- [x] Metrics: TikTok Studio list fully read (virtualized list, scroll snapshots), privacy/views parsed per row

## Next
1. **Upload the `.srt` to YouTube** as a caption track (searchable transcript).
2. **Real search phrases**: YouTube autocomplete (`suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=pt-BR&q=…`) and TikTok Creator Search Insights, so `search_tags` come from real searches.
3. **Feedback loop**: store each post's title/hashtags/hour with views from `collect-metrics.ts`. Add our 5 best titles to the prompt, and use the best BRT hours in `post-queue.ts`.
4. **YouTube Studio hidden tags**: the browser uploader can't fill the tags field yet (it sits behind "Show more"). Only the API path sends them.
5. **Instagram cover**: send `cover_url` (needs a public JPEG) or tune `thumb_offset` to the hook frame.
