import 'dotenv/config';

/**
 * Example API Key Configuration Template
 * --------------------------------------
 * Copy this file to `apiKey.config.ts` and place your actual Groq (`gsk_...`),
 * Pollinations (`sk_...`), Hugging Face (`hf_...`), or Gemini (`AIza...`) API keys below.
 * `apiKey.config.ts` is git-ignored so your real API keys are never committed.
 */
const CUSTOM_GROQ_API_KEY: string = 'YOUR_GROQ_API_KEY_HERE';
const CUSTOM_POLLINATIONS_API_KEY: string = 'YOUR_POLLINATIONS_API_KEY_HERE';
const CUSTOM_HF_TOKEN: string = 'YOUR_HF_TOKEN_HERE';
const CUSTOM_GEMINI_API_KEY: string = 'YOUR_GEMINI_API_KEY_HERE';

export const CONFIGURED_GROQ_API_KEY: string = (
  CUSTOM_GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE'
    ? CUSTOM_GROQ_API_KEY
    : process.env.GROQ_API_KEY || ''
).trim();

export const CONFIGURED_POLLINATIONS_API_KEY: string = (
  CUSTOM_POLLINATIONS_API_KEY !== 'YOUR_POLLINATIONS_API_KEY_HERE'
    ? CUSTOM_POLLINATIONS_API_KEY
    : process.env.POLLINATIONS_API_KEY || ''
).trim();

export const CONFIGURED_HF_TOKEN: string = (
  CUSTOM_HF_TOKEN !== 'YOUR_HF_TOKEN_HERE'
    ? CUSTOM_HF_TOKEN
    : process.env.HF_TOKEN || ''
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
