import { youtubeInteractiveLogin } from './publishing/youtube-studio.js';
import { log } from './utils/logger.js';

/**
 * Opens a browser window on YouTube Studio so you can log in once. The session is kept in
 * browser-profile/youtube (Google's rotating cookies stay fresh) and copied to cookies/youtube.json.
 *   npm run youtube:login
 */
youtubeInteractiveLogin().catch((e) => {
  log('ERROR', 'YouTubeLogin', (e as Error).message.split('\n')[0]);
  process.exit(1);
});
