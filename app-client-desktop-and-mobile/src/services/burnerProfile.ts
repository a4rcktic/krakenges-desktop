/**
 * Kraken Ges Ephemeral / Burner Profile Generator
 * 
 * Generates an on-the-fly, 100% realistic disposable profile with mathematically
 * coherent hardware fingerprint, coherent screen metrics, and instant self-destruction
 * upon closure.
 */

import type { LaunchConfig } from './tauri';

const POPULAR_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1366, height: 768 },
];

const CHROME_VERSIONS = [
  '128.0.6613.137',
  '129.0.6668.100',
  '130.0.6723.116',
  '131.0.6778.85',
  '132.0.6834.110',
];

export function generateBurnerConfig(options?: {
  proxy?: string;
  startUrl?: string;
  preferredOs?: 'windows' | 'macos' | 'linux';
}): LaunchConfig {
  const os = options?.preferredOs || (Math.random() > 0.3 ? 'windows' : 'macos');
  const res = POPULAR_RESOLUTIONS[Math.floor(Math.random() * POPULAR_RESOLUTIONS.length)];
  const chromeVer = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  const burnerId = `burner_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  let ua = '';
  if (os === 'windows') {
    ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  } else if (os === 'macos') {
    ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  } else {
    ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  }

  return {
    profile_id: burnerId,
    profile_name: `🔥 Burner #${burnerId.slice(-4).toUpperCase()}`,
    start_url: options?.startUrl || 'https://google.com',
    proxy: options?.proxy,
    user_agent: ua,
    os,
    screen_width: res.width,
    screen_height: res.height,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    webrtc_disabled: true,
  };
}
