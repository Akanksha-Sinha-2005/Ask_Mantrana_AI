import 'dotenv/config';

/**
 * Example API Key Configuration Template
 * --------------------------------------
 * Copy this file to `apiKey.config.ts` and place your actual Groq (`gsk_...`)
 * or Gemini (`AIza...`) API key below.
 * `apiKey.config.ts` is git-ignored so your real API key is never committed.
 */
const CUSTOM_GROQ_API_KEY: string = 'YOUR_GROQ_API_KEY_HERE';
const CUSTOM_GEMINI_API_KEY: string = 'YOUR_GEMINI_API_KEY_HERE';

export const CONFIGURED_GROQ_API_KEY: string = (
  CUSTOM_GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE'
    ? CUSTOM_GROQ_API_KEY
    : process.env.GROQ_API_KEY || ''
).trim();

export const GEMINI_CONFIGURED_API_KEY: string = (
  CUSTOM_GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE'
    ? CUSTOM_GEMINI_API_KEY
    : process.env.GEMINI_API_KEY || process.env.API_KEY || ''
).trim();

export function getConfiguredApiKey(): string {
  return (
    CONFIGURED_GROQ_API_KEY ||
    GEMINI_CONFIGURED_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    ''
  ).trim();
}
