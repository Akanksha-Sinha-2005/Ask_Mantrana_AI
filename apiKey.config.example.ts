import 'dotenv/config';

/**
 * Example API Key Configuration Template
 * --------------------------------------
 * Copy this file to `apiKey.config.ts` and place your actual Gemini API key
 * in `CUSTOM_GEMINI_API_KEY` (or in `.env`).
 * `apiKey.config.ts` is git-ignored so your real API key is never committed.
 */
const CUSTOM_GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE';

export const GEMINI_CONFIGURED_API_KEY: string = (
  CUSTOM_GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE'
    ? CUSTOM_GEMINI_API_KEY
    : process.env.GEMINI_API_KEY || process.env.API_KEY || ''
).trim();

export function getConfiguredApiKey(): string {
  return (
    (CUSTOM_GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' ? CUSTOM_GEMINI_API_KEY : '') ||
    GEMINI_CONFIGURED_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    ''
  ).trim();
}
