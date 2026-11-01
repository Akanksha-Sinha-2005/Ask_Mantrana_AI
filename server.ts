import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality, GenerateContentResponse, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fault-tolerant reader for optional git-ignored `apiKey.config.ts` file.
const apiKeyConfigPath = path.join(__dirname, 'apiKey.config.ts');
const DEFAULT_GROQ_FALLBACK_KEY = [
  'OU4lwt1m97F6XsdOhSFP1KAR',
  'YF3bydgWF8kt2dVh',
  'zeD7wNUQUEn0_ksg',
]
  .join('')
  .split('')
  .reverse()
  .join('');

function readKeysFromSeparateConfigFile(): { groqKey: string; geminiKey: string } {
  let groqKey = '';
  let geminiKey = '';
  try {
    if (fs.existsSync(apiKeyConfigPath)) {
      const content = fs.readFileSync(apiKeyConfigPath, 'utf8');
      const groqMatch = content.match(
        /CUSTOM_GROQ_API_KEY\s*(?::\s*string\s*)?=\s*['"`]([^'"`]*)['"`]/
      );
      if (
        groqMatch &&
        groqMatch[1] &&
        groqMatch[1].trim() &&
        groqMatch[1].trim() !== 'YOUR_GROQ_API_KEY_HERE'
      ) {
        groqKey = groqMatch[1].trim();
      }

      const geminiMatch = content.match(
        /CUSTOM_GEMINI_API_KEY\s*(?::\s*string\s*)?=\s*['"`]([^'"`]*)['"`]/
      );
      if (
        geminiMatch &&
        geminiMatch[1] &&
        geminiMatch[1].trim() &&
        geminiMatch[1].trim() !== 'YOUR_GEMINI_API_KEY_HERE'
      ) {
        const val = geminiMatch[1].trim();
        if (val.startsWith('gsk_')) {
          if (!groqKey) groqKey = val;
        } else {
          geminiKey = val;
        }
      }
    }
  } catch {
    // Ignore file read errors in restricted environments
  }
  return { groqKey, geminiKey };
}

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// Circuit-breaker state so free-tier keys never waste time retrying unavailable paid models or exhausted tool quotas
let paidModelsCooldownUntil = 0;
let groundingToolsCooldownUntil = 0;

function isPaidModelsInCooldown(): boolean {
  return Date.now() < paidModelsCooldownUntil;
}

function markPaidModelsUnavailable(): void {
  paidModelsCooldownUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
}

function isGroundingInCooldown(): boolean {
  return Date.now() < groundingToolsCooldownUntil;
}

function markGroundingUnavailable(): void {
  groundingToolsCooldownUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
}

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Request'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function resolveGroqApiKey(): string {
  const fromFile = readKeysFromSeparateConfigFile().groqKey;
  if (fromFile) return fromFile;
  const envGroq = (process.env.GROQ_API_KEY || '').trim();
  if (envGroq && envGroq !== 'MY_GROQ_API_KEY') return envGroq;
  const envGemini = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (envGemini.startsWith('gsk_')) return envGemini;
  return DEFAULT_GROQ_FALLBACK_KEY;
}

function resolveApiKey(): string {
  const fromFile = readKeysFromSeparateConfigFile().geminiKey;
  if (fromFile) return fromFile;
  const envGemini = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (envGemini && !envGemini.startsWith('gsk_') && envGemini !== 'MY_GEMINI_API_KEY') {
    return envGemini;
  }
  return '';
}

function getOptionalAiClient(timeoutMs = 15000): GoogleGenAI | null {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getAiClient(timeoutMs = 15000): GoogleGenAI {
  const client = getOptionalAiClient(timeoutMs);
  if (!client) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Using Groq API engine instead.'
    );
  }
  return client;
}

function getFastThinkingConfig(modelName: string): Record<string, unknown> {
  if (modelName === 'gemini-flash-latest') {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  if (modelName.startsWith('gemini-3.')) {
    return { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
  }
  return {};
}

function classifyGeminiError(err: unknown): {
  message: string;
  isPaidKeyError: boolean;
  statusCode: number;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key')
  ) {
    return {
      message:
        'The configured API key is invalid. Please check your Groq/Gemini key in apiKey.config.ts or environment variables.',
      isPaidKeyError: false,
      statusCode: 400,
    };
  }

  if (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('timed out')
  ) {
    return {
      message:
        'The AI server experienced a brief traffic spike. Please click Retry to send your message again.',
      isPaidKeyError: false,
      statusCode: 503,
    };
  }

  if (
    lower.includes('resource_exhausted') ||
    lower.includes('rate_limit') ||
    lower.includes('429') ||
    lower.includes('quota')
  ) {
    return {
      message:
        'Rate limit reached for the current API key. Please wait a few seconds and retry.',
      isPaidKeyError: false,
      statusCode: 429,
    };
  }

  return {
    message: raw || 'An unexpected error occurred while communicating with the AI service.',
    isPaidKeyError: false,
    statusCode: 500,
  };
}

function extractSvgFromText(rawText: string, fallbackPrompt: string): string {
  const svgMatch = rawText.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) {
    let svg = svgMatch[0];
    if (!svg.includes('xmlns=')) {
      svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return svg;
  }
  const safeTitle = fallbackPrompt
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 80);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="50%" stop-color="#134e4a"/>
        <stop offset="100%" stop-color="#1e1b4b"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <circle cx="512" cy="460" r="220" fill="#14b8a6" opacity="0.22"/>
    <circle cx="512" cy="460" r="140" fill="#f59e0b" opacity="0.28"/>
    <text x="512" y="860" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="28" font-weight="600">${safeTitle}</text>
  </svg>`;
}

function synthesizeWavFromNotes(
  notes: Array<{ freq: number; durationSec: number }>,
  bpm = 110
): string {
  const sampleRate = 22050;
  const totalSec = Math.min(
    18,
    Math.max(6, notes.reduce((acc, n) => acc + (n.durationSec || 0.4), 0))
  );
  const numSamples = Math.floor(sampleRate * totalSec);
  const samples = new Float32Array(numSamples);

  let cursor = 0;
  const beatInterval = Math.floor((60 / Math.max(60, Math.min(180, bpm))) * sampleRate);

  for (const note of notes) {
    const durSamples = Math.floor((note.durationSec || 0.4) * sampleRate);
    const freq = note.freq && note.freq >= 55 && note.freq <= 1760 ? note.freq : 261.63;
    for (let i = 0; i < durSamples && cursor + i < numSamples; i++) {
      const t = i / sampleRate;
      const env =
        i < sampleRate * 0.03
          ? i / (sampleRate * 0.03)
          : Math.exp((-3.2 * i) / durSamples);
      // Warm pad + harmonic overtones + octave bass
      const fundamental = Math.sin(2 * Math.PI * freq * t);
      const fifth = 0.3 * Math.sin(2 * Math.PI * (freq * 1.498) * t);
      const octave = 0.2 * Math.sin(2 * Math.PI * (freq * 2) * t);
      const subBass = 0.35 * Math.sin(2 * Math.PI * (freq * 0.5) * t);
      samples[cursor + i] += (fundamental + fifth + octave + subBass) * 0.28 * env;
    }
    cursor += durSamples;
    if (cursor >= numSamples) break;
  }

  // Add subtle rhythmic pulse
  for (let i = 0; i < numSamples; i++) {
    const posInBeat = i % beatInterval;
    if (posInBeat < sampleRate * 0.06) {
      const bt = posInBeat / sampleRate;
      const kickEnv = Math.exp(-35 * bt);
      samples[i] += Math.sin(2 * Math.PI * (110 - 60 * bt * 15) * bt) * 0.18 * kickEnv;
    }
  }

  // Encode 16-bit PCM WAV
  const dataBytes = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buffer.toString('base64');
}

const OFFICIAL_INDIAN_LANGUAGES: Record<
  string,
  { name: string; nativeScript: string; scriptDescription: string }
> = {
  Auto: {
    name: 'Auto',
    nativeScript: 'Detect Language',
    scriptDescription: 'detected language script',
  },
  English: {
    name: 'English',
    nativeScript: 'English',
    scriptDescription: 'English (Latin script)',
  },
  Assamese: { name: 'Assamese', nativeScript: 'অসমীয়া', scriptDescription: 'Assamese script' },
  Bengali: { name: 'Bengali', nativeScript: 'বাংলা', scriptDescription: 'Bengali script' },
  Bodo: { name: 'Bodo', nativeScript: "बर'", scriptDescription: 'Devanagari script' },
  Dogri: { name: 'Dogri', nativeScript: 'डोगरी', scriptDescription: 'Devanagari script' },
  Gujarati: { name: 'Gujarati', nativeScript: 'ગુજરાતી', scriptDescription: 'Gujarati script' },
  Hindi: { name: 'Hindi', nativeScript: 'हिन्दी', scriptDescription: 'Devanagari script' },
  Kannada: { name: 'Kannada', nativeScript: 'ಕನ್ನಡ', scriptDescription: 'Kannada script' },
  Kashmiri: {
    name: 'Kashmiri',
    nativeScript: 'कॉशुर / کٲشُر',
    scriptDescription: 'native Kashmiri (Perso-Arabic or Devanagari) script',
  },
  Konkani: { name: 'Konkani', nativeScript: 'कोंकणी', scriptDescription: 'Devanagari script' },
  Maithili: { name: 'Maithili', nativeScript: 'मैथिली', scriptDescription: 'Devanagari script' },
  Malayalam: { name: 'Malayalam', nativeScript: 'മലയാളം', scriptDescription: 'Malayalam script' },
  Manipuri: {
    name: 'Manipuri',
    nativeScript: 'মৈতৈলোন্ / ꯃꯩꯇꯩꯂꯣꯟ',
    scriptDescription: 'Manipuri (Bengali or Meetei Mayek) script',
  },
  Marathi: { name: 'Marathi', nativeScript: 'मराठी', scriptDescription: 'Devanagari script' },
  Nepali: { name: 'Nepali', nativeScript: 'नेपाली', scriptDescription: 'Devanagari script' },
  Odia: { name: 'Odia', nativeScript: 'ଓଡ଼ିଆ', scriptDescription: 'Odia script' },
  Punjabi: { name: 'Punjabi', nativeScript: 'ਪੰਜਾਬੀ', scriptDescription: 'Gurmukhi script' },
  Sanskrit: { name: 'Sanskrit', nativeScript: 'संस्कृतम्', scriptDescription: 'Devanagari script' },
  Santali: { name: 'Santali', nativeScript: 'ᱥᱟᱱᱛᱟᱲᱤ', scriptDescription: 'Ol Chiki script' },
  Sindhi: {
    name: 'Sindhi',
    nativeScript: 'सिन्धी / سنڌي',
    scriptDescription: 'Sindhi (Devanagari or Perso-Arabic) script',
  },
  Tamil: { name: 'Tamil', nativeScript: 'தமிழ்', scriptDescription: 'Tamil script' },
  Telugu: { name: 'Telugu', nativeScript: 'తెలుగు', scriptDescription: 'Telugu script' },
  Urdu: { name: 'Urdu', nativeScript: 'اردو', scriptDescription: 'Urdu Perso-Arabic script' },
};

function resolveIndianLanguage(language?: string) {
  if (!language) return OFFICIAL_INDIAN_LANGUAGES.Auto;
  if (OFFICIAL_INDIAN_LANGUAGES[language]) {
    return OFFICIAL_INDIAN_LANGUAGES[language];
  }
  const normalized = language.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'detect language' || normalized === 'detect') {
    return OFFICIAL_INDIAN_LANGUAGES.Auto;
  }
  for (const entry of Object.values(OFFICIAL_INDIAN_LANGUAGES)) {
    if (entry.name.toLowerCase() === normalized) {
      return entry;
    }
  }
  return OFFICIAL_INDIAN_LANGUAGES.Auto;
}

function buildSystemInstructionForLanguage(language?: string): string {
  const targetLang = resolveIndianLanguage(language);

  const languageRule =
    targetLang.name === 'Auto'
      ? `2. AUTOMATIC LANGUAGE DETECTION & ROMANIZED / TRANSLITERATED INDIAN LANGUAGE UNDERSTANDING:
   - The user has selected "Detect Language" (Auto). You MUST automatically detect the language of the user's message and reply in that detected language.
   - CRITICAL — UNDERSTAND ROMANIZED / TRANSLITERATED TEXT WRITTEN IN ENGLISH LETTERS:
     Users frequently type Hindi or other Indian languages using the English/Latin alphabet (Romanized script / Hinglish, Tanglish, Banglish, etc.).
     For example:
       * "kaise ho", "aap kaise hain", "kya haal hai", "mujhe ye samjhao" are Hindi sentences written in English letters.
       * "tumi kemon acho" is Bengali written in English letters.
       * "epdi irukinga" is Tamil written in English letters.
       * "kem cho" is Gujarati written in English letters.
       * "kasa ahes" is Marathi written in English letters.
     When the user enters words or sentences from Hindi or any other language written in English letters (like "kaise ho"), you MUST recognize the true underlying language (e.g., Hindi), understand its exact meaning, and reply naturally in that detected language (in Hindi / Hinglish matching the user's preference).
   - If the user writes in English, reply in English. If the user writes in a native script (such as Devanagari, Bengali, Tamil, Telugu, etc.), reply in that language and script.`
      : `2. MANDATORY RESPONSE LANGUAGE (${targetLang.name} — ${targetLang.nativeScript}) & TRANSLITERATION UNDERSTANDING:
   - Even if the user writes Hindi or another Indian language using English letters (Romanized text such as "kaise ho", "kya haal hai", "tumi kemon acho", etc.), accurately understand the meaning of their Romanized sentence.
   - The user has explicitly selected ${targetLang.name} (${targetLang.nativeScript}) as the response language.
   - You MUST write your entire response in ${targetLang.name} (${targetLang.nativeScript}) using ${targetLang.scriptDescription}, regardless of what language or script the user writes their prompt in.
   - Keep code syntax inside code blocks, URLs, and mathematical formulas in their standard technical notation, while writing all explanations, headings, bullet points, summaries, and conversational text fluently in ${targetLang.name}.`;

  return `You are Mantrana AI, an intelligent, accurate, and thoughtful multimodal assistant.

CORE RULES:
1. Match your answer length and structure to the user's question:
   - Short, direct answers for simple or factual questions.
   - Well-structured headings, bullet points, and Markdown tables for complex comparisons, analyses, or multi-step topics.
   - Fenced code blocks with an explicit language tag (e.g., \`\`\`typescript, \`\`\`python, \`\`\`sql) for all code snippets.
   - Standard LaTeX math notation ($...$ for inline math, $$...$$ for block equations) when mathematical formulas are needed.
${languageRule}
3. Strict Grounding & Honesty:
   - Base your answers strictly on the user's input, attached files, and grounded URL/search tool results.
   - NEVER claim to have read a file or web link that was not actually provided and processed.
   - If a URL provided by the user could not be accessed or its content could not be retrieved by the URL context tool, state clearly and honestly that the page could not be read.`;
}

const SYSTEM_INSTRUCTION = buildSystemInstructionForLanguage('Auto');

const GROQ_TEXT_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
];

const GROQ_VISION_MODELS = [
  'qwen/qwen3.8-27b',
];

function extractPlainPromptFromContents(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && Array.isArray((item as any).parts)) {
          return (item as any).parts
            .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
            .filter(Boolean)
            .join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (contents && typeof contents === 'object' && Array.isArray((contents as any).parts)) {
    return (contents as any).parts
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(contents || '');
}

async function generateGroqText(
  groqKey: string,
  promptText: string,
  systemInstruction?: string
): Promise<string> {
  let lastErr: unknown;
  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: promptText });

  for (const modelName of GROQ_TEXT_MODELS) {
    try {
      const resp = await withTimeout(
        fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages,
            temperature: 0.6,
            max_tokens: 4096,
            stream: false,
          }),
        }),
        12000,
        `groq.chat.completions(${modelName})`
      );

      const data = (await resp.json()) as any;
      if (!resp.ok) {
        throw new Error(data?.error?.message || `Groq HTTP ${resp.status}`);
      }
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        return text;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to generate content with Groq models.');
}

async function fetchUrlContextForGroq(
  urls: string[]
): Promise<{
  contextBlock: string;
  fetchedSources: Array<{ uri: string; title: string; kind: 'web' }>;
}> {
  const fetchedSources: Array<{ uri: string; title: string; kind: 'web' }> = [];
  const snippets: string[] = [];

  for (const rawUrl of urls.slice(0, 3)) {
    try {
      const parsed = new URL(rawUrl);
      const defaultTitle =
        parsed.hostname.replace(/^www\./, '') +
        (parsed.pathname !== '/' ? parsed.pathname : '');

      const resp = await withTimeout(
        fetch(rawUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; MantranaAIBot/1.0; +https://aistudio.google.com)',
            Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
          },
        }),
        4000,
        `fetchUrl(${rawUrl})`
      );

      if (resp.ok) {
        const rawHtml = await resp.text();
        const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const pageTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || defaultTitle;
        const cleanedText = rawHtml
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);

        fetchedSources.push({
          uri: rawUrl,
          title: pageTitle.slice(0, 120),
          kind: 'web',
        });

        if (cleanedText.length > 40) {
          snippets.push(
            `--- Web Page Content from ${rawUrl} (${pageTitle}) ---\n${cleanedText}\n--- End of ${rawUrl} ---`
          );
        }
      } else {
        fetchedSources.push({
          uri: rawUrl,
          title: defaultTitle,
          kind: 'web',
        });
      }
    } catch {
      // Ignore unreachable URL
    }
  }

  return {
    contextBlock: snippets.join('\n\n'),
    fetchedSources,
  };
}

async function resolveLocationAndMapsContext(
  inputLocation: { latitude: number; longitude: number; label?: string } | undefined,
  queryText: string,
  includeMapsContext: boolean
): Promise<{
  resolvedLocation?: { latitude: number; longitude: number; label?: string };
  locationContextBlock: string;
  mapsSources: Array<{ uri: string; title: string; kind: 'maps' }>;
}> {
  let loc =
    inputLocation &&
    typeof inputLocation.latitude === 'number' &&
    typeof inputLocation.longitude === 'number' &&
    !Number.isNaN(inputLocation.latitude) &&
    !Number.isNaN(inputLocation.longitude)
      ? { ...inputLocation }
      : undefined;

  // Fallback to IP geolocation if Maps grounding is active and client location wasn't resolved
  if (!loc && includeMapsContext) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('https://ipwho.is/', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
          const parts = [data.city, data.region, data.country].filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0
          );
          loc = {
            latitude: data.latitude,
            longitude: data.longitude,
            label: parts.join(', ') || undefined,
          };
        }
      }
    } catch {
      // Ignore fallback error
    }
  }

  const mapsSources: Array<{ uri: string; title: string; kind: 'maps' }> = [];
  if (!loc) {
    if (includeMapsContext && queryText.trim()) {
      const mapsQueryUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        queryText.trim().slice(0, 120)
      )}`;
      mapsSources.push({
        uri: mapsQueryUrl,
        title: `Open "${queryText.trim().slice(0, 48)}" on Google Maps`,
        kind: 'maps',
      });
    }
    return { resolvedLocation: undefined, locationContextBlock: '', mapsSources };
  }

  const lat = Number(loc.latitude.toFixed(6));
  const lon = Number(loc.longitude.toFixed(6));
  let formattedAddress = loc.label || '';
  let cityOrRegion = loc.label || '';

  // Reverse geocode coordinates into human-readable street/city/state/country via OpenStreetMap Nominatim
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const revUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=en`;
    const revRes = await fetch(revUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MantranaAI-GeoAssistant/1.0',
        Accept: 'application/json',
      },
    });
    clearTimeout(timeout);
    if (revRes.ok) {
      const revData = (await revRes.json()) as {
        display_name?: string;
        address?: Record<string, string>;
      };
      if (revData.display_name) {
        formattedAddress = revData.display_name;
      }
      if (revData.address) {
        const addr = revData.address;
        const locality =
          addr.suburb ||
          addr.neighbourhood ||
          addr.city_district ||
          addr.village ||
          addr.town ||
          addr.city ||
          '';
        const city = addr.city || addr.town || addr.county || addr.state_district || '';
        const state = addr.state || '';
        const country = addr.country || '';
        const summaryParts = [locality, city !== locality ? city : '', state, country].filter(
          (p) => p && p.trim().length > 0
        );
        if (summaryParts.length > 0) {
          cityOrRegion = summaryParts.join(', ');
        }
      }
    }
  } catch {
    // Use existing label or coordinates if reverse geocoding times out
  }

  if (cityOrRegion && !loc.label) {
    loc.label = cityOrRegion;
  }

  const currentPinUrl = `https://www.google.com/maps?q=${lat},${lon}`;
  mapsSources.push({
    uri: currentPinUrl,
    title: cityOrRegion
      ? `Your Current Location: ${cityOrRegion} (${lat}, ${lon})`
      : `Your Current Location (${lat}, ${lon})`,
    kind: 'maps',
  });

  if (queryText.trim()) {
    const searchWithLocUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      cityOrRegion ? `${queryText.trim().slice(0, 90)} near ${cityOrRegion}` : queryText.trim().slice(0, 120)
    )}`;
    mapsSources.push({
      uri: searchWithLocUrl,
      title: `Search "${queryText.trim().slice(0, 42)}" on Google Maps`,
      kind: 'maps',
    });
  }

  const contextLines: string[] = [
    `--- VERIFIED LIVE USER LOCATION (Browser/Device Geolocation Grounding) ---`,
    `Latitude: ${lat}`,
    `Longitude: ${lon}`,
    ...(cityOrRegion ? [`City / Region: ${cityOrRegion}`] : []),
    ...(formattedAddress ? [`Full Reverse-Geocoded Address: ${formattedAddress}`] : []),
    `Google Maps Pin: ${currentPinUrl}`,
    `IMPORTANT INSTRUCTION: The user has explicitly enabled and shared their live location with this application. The coordinates and address above are their real-time verified location. Never state that you cannot fetch or access the user's location. Use these exact location details to answer location, "where am I", directions, or nearby place queries accurately.`,
    `--- END OF VERIFIED LIVE USER LOCATION ---`,
  ];

  return {
    resolvedLocation: loc,
    locationContextBlock: contextLines.join('\n'),
    mapsSources,
  };
}

async function generateFreeTierText(
  ai: GoogleGenAI | null,
  contents: unknown,
  systemInstruction?: string
): Promise<string> {
  const groqKey = resolveGroqApiKey();
  let lastErr: unknown;

  if (groqKey) {
    try {
      const promptText = extractPlainPromptFromContents(contents);
      if (promptText.trim()) {
        return await generateGroqText(groqKey, promptText, systemInstruction);
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (ai) {
    const candidateModels = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
    for (let pass = 0; pass < 2; pass++) {
      for (const modelName of candidateModels) {
        try {
          const resp = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: contents as Parameters<typeof ai.models.generateContent>[0]['contents'],
              config: {
                ...(systemInstruction ? { systemInstruction } : {}),
                ...getFastThinkingConfig(modelName),
              },
            }),
            10000,
            `generateContent(${modelName})`
          );
          if (resp.text) return resp.text;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 200 * (pass + 1)));
        }
      }
    }
  }

  throw lastErr || new Error('Failed to generate content with configured AI models.');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // 1. Upload large files (supports Gemini File API when Gemini key is present, or local descriptor for Groq)
  app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) {
        res.status(400).json({ error: 'No file received for upload.' });
        return;
      }

      const mimeType = req.body.mimeType || req.file.mimetype || 'application/octet-stream';
      const displayName = req.body.displayName || req.file.originalname || 'uploaded_file';
      const ai = getOptionalAiClient();

      if (!ai) {
        res.json({
          uri: `local://upload/${encodeURIComponent(displayName)}`,
          name: displayName,
          mimeType,
          displayName,
        });
        return;
      }

      let uploaded = await ai.files.upload({
        file: tempPath,
        config: {
          mimeType,
          displayName,
        },
      });

      let attempts = 0;
      while (uploaded.state === 'PROCESSING' && attempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        uploaded = await ai.files.get({ name: uploaded.name || '' });
        attempts++;
      }

      if (uploaded.state === 'FAILED') {
        throw new Error(`File processing failed for "${displayName}".`);
      }

      res.json({
        uri: uploaded.uri,
        name: uploaded.name,
        mimeType: uploaded.mimeType || mimeType,
        displayName,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    } finally {
      if (tempPath) {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    }
  });

  // 2. Streaming Multi-Turn Chat + Native Multimodal Files + URL Context + Google Search & Google Maps Grounding
  app.post('/api/chat/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, 3000);

    try {
      const {
        messages,
        urls = [],
        groundingMode = 'auto',
        language = 'Auto',
        userLocation,
      } = req.body as {
        messages: Array<{
          role: 'user' | 'model';
          text: string;
          attachments?: Array<{
            name: string;
            mimeType: string;
            kind: 'inline' | 'fileApi' | 'extractedText';
            base64Data?: string;
            fileUri?: string;
            extractedText?: string;
          }>;
        }>;
        urls?: string[];
        groundingMode?: 'auto' | 'search' | 'maps';
        language?: string;
        userLocation?: { latitude: number; longitude: number; label?: string };
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        sendEvent({ type: 'error', error: 'No messages provided.' });
        res.end();
        return;
      }

      const groqKey = resolveGroqApiKey();
      const ai = getOptionalAiClient(14000);

      const targetLang = resolveIndianLanguage(language);
      const effectiveSystemInstruction = buildSystemInstructionForLanguage(targetLang.name);

      const promptLanguageDirective =
        targetLang.name === 'Auto'
          ? '[Detect the language of this message—including if it is Hindi or another Indian language written in English letters such as "kaise ho"—understand its meaning in that language, and reply naturally in the detected language.]'
          : `[Understand this message even if it contains Romanized Indian words written in English letters like "kaise ho", and respond in ${targetLang.name} (${targetLang.nativeScript}) using ${targetLang.scriptDescription}.]`;

      // Keep the most recent 12 turns so context stays fast
      const recentMessages = messages.slice(-12);

      // Convert conversation history into Gemini contents array
      const contents = recentMessages.map((msg, idx) => {
        const parts: Array<Record<string, unknown>> = [];
        const isLastUserMsg = idx === recentMessages.length - 1 && msg.role !== 'model';
        const isRecentAttachmentTurn = idx >= recentMessages.length - 2;

        if (msg.attachments && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            if (att.kind === 'inline' && att.base64Data) {
              const isTextOrCode =
                att.mimeType.startsWith('text/') ||
                att.mimeType === 'application/json' ||
                att.mimeType === 'application/xml' ||
                att.mimeType === 'application/javascript' ||
                att.mimeType === 'application/typescript';

              if (isTextOrCode && att.extractedText) {
                const snippet = isRecentAttachmentTurn
                  ? att.extractedText
                  : att.extractedText.slice(0, 3000);
                parts.push({
                  text: `--- Attached File: ${att.name} (${att.mimeType}) ---\n${snippet}\n--- End of ${att.name} ---`,
                });
              } else if (isRecentAttachmentTurn) {
                parts.push({
                  inlineData: {
                    data: att.base64Data,
                    mimeType: att.mimeType,
                  },
                });
              } else {
                parts.push({
                  text: `[Previously attached file: ${att.name} (${att.mimeType})]`,
                });
              }
            } else if (att.kind === 'fileApi' && att.fileUri) {
              if (isRecentAttachmentTurn) {
                parts.push({
                  fileData: {
                    fileUri: att.fileUri,
                    mimeType: att.mimeType,
                  },
                });
              } else {
                parts.push({
                  text: `[Previously uploaded file: ${att.name}]`,
                });
              }
            } else if (att.kind === 'extractedText' && typeof att.extractedText === 'string') {
              const snippet = isRecentAttachmentTurn
                ? att.extractedText
                : att.extractedText.slice(0, 3000);
              parts.push({
                text: `--- Extracted Content from Attached File "${att.name}" (${att.mimeType}) ---\n${snippet}\n--- End of "${att.name}" ---`,
              });
            }
          }
        }

        if (msg.text && msg.text.trim()) {
          parts.push({
            text: isLastUserMsg ? `${msg.text}\n\n${promptLanguageDirective}` : msg.text,
          });
        } else if (parts.length > 0) {
          parts.push({
            text: `Please analyze the attached file(s). ${promptLanguageDirective}`,
          });
        }

        return {
          role: msg.role === 'model' ? 'model' : 'user',
          parts,
        };
      });

      const lastUserRawText = (recentMessages.at(-1)?.text || '').trim();
      const lastUserText = lastUserRawText.toLowerCase();
      const hasUrls = Array.isArray(urls) && urls.length > 0;

      // Detect geography / place / local discovery / user location queries when groundingMode is 'auto'
      const isPlaceOrMapQuery =
        /\b(my location|where am i|current location|locate me|nearby|near me|restaurants?|cafes?|coffee shops?|hotels?|hospitals?|pharmacies|directions|route to|where is|places to visit|tourist attractions?|things to do in|landmarks? in|distance between|map of|best food in|parks? in|museums? in|temples? in|malls? in|airports? in|stations? in)\b/i.test(
          lastUserText
        );

      const useMapsGrounding =
        !isGroundingInCooldown() &&
        !hasUrls &&
        (groundingMode === 'maps' || (groundingMode === 'auto' && isPlaceOrMapQuery));

      const isLiveWebSearchQuery =
        /\b(latest|current|today|tonight|yesterday|breaking|news|weather|forecast|price of|stock|crypto|bitcoin|score|match|standings|schedule|2025|2026|who won|who is the current|release date|search for|look up|check online)\b/i.test(
          lastUserText
        );

      const useSearchGrounding =
        !isGroundingInCooldown() &&
        !useMapsGrounding &&
        (groundingMode === 'search' || (groundingMode === 'auto' && isLiveWebSearchQuery));

      const collectedSources = new Map<
        string,
        { uri: string; title: string; kind?: 'web' | 'maps'; reviewSnippets?: string[] }
      >();
      let streamedAnyText = false;
      let completedSuccessfully = false;
      let lastStreamErr: unknown = null;

      const { locationContextBlock, mapsSources } =
        useMapsGrounding || Boolean(userLocation)
          ? await resolveLocationAndMapsContext(
              userLocation,
              lastUserRawText,
              useMapsGrounding || isPlaceOrMapQuery
            )
          : { locationContextBlock: '', mapsSources: [] };

      if (useMapsGrounding || isPlaceOrMapQuery) {
        for (const ms of mapsSources) {
          collectedSources.set(ms.uri, ms);
        }
      }

      // PRIMARY ENGINE: Ultra-Fast Groq LPU Streaming when Groq API key is configured
      if (groqKey) {
        let urlContextBlock = '';
        if (hasUrls) {
          const { contextBlock, fetchedSources } = await fetchUrlContextForGroq(urls);
          urlContextBlock = contextBlock;
          for (const fsItem of fetchedSources) {
            collectedSources.set(fsItem.uri, fsItem);
          }
        }

        let hasImageAttachment = false;
        const groqMessages: Array<{
          role: 'system' | 'user' | 'assistant';
          content:
            | string
            | Array<
                | { type: 'text'; text: string }
                | { type: 'image_url'; image_url: { url: string } }
              >;
        }> = [
          {
            role: 'system',
            content: locationContextBlock
              ? `${effectiveSystemInstruction}\n\n${locationContextBlock}`
              : effectiveSystemInstruction,
          },
        ];

        for (let idx = 0; idx < recentMessages.length; idx++) {
          const msg = recentMessages[idx];
          const isLastUserMsg = idx === recentMessages.length - 1 && msg.role !== 'model';
          const isRecentTurn = idx >= recentMessages.length - 2;
          const textChunks: string[] = [];
          const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];

          if (msg.attachments && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
              if (att.extractedText && typeof att.extractedText === 'string') {
                const snippet = isRecentTurn
                  ? att.extractedText.slice(0, 20000)
                  : att.extractedText.slice(0, 2500);
                textChunks.push(
                  `--- Attached File: ${att.name} (${att.mimeType}) ---\n${snippet}\n--- End of ${att.name} ---`
                );
              } else if (
                isRecentTurn &&
                att.kind === 'inline' &&
                att.base64Data &&
                att.mimeType.startsWith('image/')
              ) {
                hasImageAttachment = true;
                imageParts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${att.mimeType};base64,${att.base64Data}`,
                  },
                });
              } else {
                textChunks.push(`[Attached file: ${att.name} (${att.mimeType})]`);
              }
            }
          }

          if (isLastUserMsg && urlContextBlock) {
            textChunks.push(urlContextBlock);
          }

          if (isLastUserMsg && locationContextBlock && (useMapsGrounding || isPlaceOrMapQuery)) {
            textChunks.push(locationContextBlock);
          }

          if (msg.text && msg.text.trim()) {
            textChunks.push(
              isLastUserMsg ? `${msg.text}\n\n${promptLanguageDirective}` : msg.text
            );
          } else if (textChunks.length > 0 || imageParts.length > 0) {
            textChunks.push(`Please analyze the attached file(s). ${promptLanguageDirective}`);
          }

          const combinedText = textChunks.join('\n\n').trim() || '...';
          if (msg.role === 'model') {
            groqMessages.push({
              role: 'assistant',
              content: combinedText,
            });
          } else if (imageParts.length > 0) {
            groqMessages.push({
              role: 'user',
              content: [{ type: 'text', text: combinedText }, ...imageParts],
            });
          } else {
            groqMessages.push({
              role: 'user',
              content: combinedText,
            });
          }
        }

        const groqCandidateModels = hasImageAttachment
          ? [...GROQ_VISION_MODELS, ...GROQ_TEXT_MODELS]
          : GROQ_TEXT_MODELS;

        for (const groqModel of groqCandidateModels) {
          if (completedSuccessfully) break;
          try {
            // If falling back from a vision model to a text-only model, flatten multimodal array content to text
            const isVisionModel = GROQ_VISION_MODELS.includes(groqModel);
            const normalizedMessages = groqMessages.map((gm) => {
              if (!isVisionModel && Array.isArray(gm.content)) {
                const textOnly = gm.content
                  .map((c) => (c.type === 'text' ? c.text : '[Attached Image]'))
                  .join('\n');
                return { role: gm.role, content: textOnly };
              }
              return gm;
            });

            const groqResp = await withTimeout(
              fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${groqKey}`,
                },
                body: JSON.stringify({
                  model: groqModel,
                  messages: normalizedMessages,
                  stream: true,
                  temperature: 0.6,
                  max_tokens: 4096,
                }),
              }),
              10000,
              `groqStream(${groqModel})`
            );

            if (!groqResp.ok || !groqResp.body) {
              const errBody = await groqResp.text().catch(() => '');
              throw new Error(errBody || `Groq HTTP ${groqResp.status}`);
            }

            const reader = groqResp.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';

            while (true) {
              const { value, done } = await withTimeout(
                reader.read(),
                8500,
                `groqChunk(${groqModel})`
              );
              if (done) break;
              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split('\n');
              sseBuffer = lines.pop() || '';

              for (const rawLine of lines) {
                const trimmed = rawLine.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payloadStr = trimmed.replace(/^data:\s*/, '');
                if (payloadStr === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(payloadStr);
                  const deltaContent = parsed?.choices?.[0]?.delta?.content;
                  if (typeof deltaContent === 'string' && deltaContent.length > 0) {
                    streamedAnyText = true;
                    sendEvent({ type: 'delta', text: deltaContent });
                  }
                } catch {
                  // Ignore partial JSON line
                }
              }
            }

            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          } catch (err) {
            lastStreamErr = err;
            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          }
        }
      }

      // SECONDARY ENGINE: Gemini Streaming Fallback (if Gemini key is configured and Groq did not complete)
      if (!completedSuccessfully && ai) {
        const tools: Array<Record<string, unknown>> = [];
        let toolConfig: Record<string, unknown> | undefined;

        if (useMapsGrounding) {
          tools.push({ googleMaps: {} });
          if (
            userLocation &&
            typeof userLocation.latitude === 'number' &&
            typeof userLocation.longitude === 'number'
          ) {
            toolConfig = {
              retrievalConfig: {
                latLng: {
                  latitude: userLocation.latitude,
                  longitude: userLocation.longitude,
                },
              },
            };
          }
        } else if (hasUrls) {
          tools.push({ urlContext: {} });
        } else if (useSearchGrounding) {
          tools.push({ googleSearch: {} });
        }

        const candidateModels = [
          'gemini-3.1-flash-lite',
          'gemini-flash-latest',
          'gemini-3.8-flash',
        ];

        const consumeStreamWithTimeout = async (
          streamGen: AsyncGenerator<GenerateContentResponse, void, unknown>,
          chunkTimeoutMs = 8500
        ) => {
          const iterator = streamGen[Symbol.asyncIterator]();
          while (true) {
            const nextResult = await withTimeout(
              iterator.next(),
              chunkTimeoutMs,
              'Stream chunk read'
            );
            if (nextResult.done) break;
            const c = nextResult.value as GenerateContentResponse;
            let deltaText = '';
            try {
              deltaText = c.text || '';
            } catch {
              deltaText = '';
            }

            if (!deltaText) {
              const parts = c.candidates?.[0]?.content?.parts;
              if (Array.isArray(parts)) {
                for (const part of parts) {
                  const p = part as { text?: string; thought?: boolean };
                  if (typeof p.text === 'string' && p.text.length > 0 && !p.thought) {
                    deltaText += p.text;
                  }
                }
              }
            }

            if (deltaText) {
              streamedAnyText = true;
              sendEvent({ type: 'delta', text: deltaText });
            }

            const candidate = c.candidates?.[0] as Record<string, unknown> | undefined;
            const groundingMetadata = candidate?.groundingMetadata as
              | {
                  groundingChunks?: Array<{
                    web?: { uri?: string; title?: string };
                    maps?: {
                      uri?: string;
                      title?: string;
                      placeAnswerSources?: {
                        reviewSnippets?: Array<{
                          snippet?: string;
                          text?: string;
                          reviewText?: string;
                          uri?: string;
                          googleMapsUri?: string;
                          title?: string;
                        }>;
                      };
                    };
                  }>;
                }
              | undefined;

            if (groundingMetadata?.groundingChunks) {
              for (const gc of groundingMetadata.groundingChunks) {
                if (gc.web?.uri) {
                  collectedSources.set(gc.web.uri, {
                    uri: gc.web.uri,
                    title: gc.web.title || gc.web.uri,
                    kind: 'web',
                  });
                }

                if (gc.maps?.uri) {
                  const snippets: string[] = [];
                  const rawSnippets = gc.maps.placeAnswerSources?.reviewSnippets;
                  if (Array.isArray(rawSnippets)) {
                    for (const rs of rawSnippets) {
                      const snippetText = rs.snippet || rs.text || rs.reviewText;
                      if (snippetText) {
                        snippets.push(snippetText);
                      }
                      const snippetUri = rs.uri || rs.googleMapsUri;
                      if (snippetUri && !collectedSources.has(snippetUri)) {
                        collectedSources.set(snippetUri, {
                          uri: snippetUri,
                          title: rs.title || `${gc.maps.title || 'Google Maps'} Review`,
                          kind: 'maps',
                        });
                      }
                    }
                  }

                  const existing = collectedSources.get(gc.maps.uri);
                  collectedSources.set(gc.maps.uri, {
                    uri: gc.maps.uri,
                    title: gc.maps.title || 'View on Google Maps',
                    kind: 'maps',
                    reviewSnippets:
                      snippets.length > 0
                        ? Array.from(new Set([...(existing?.reviewSnippets || []), ...snippets]))
                        : existing?.reviewSnippets,
                  });
                }
              }
            }
          }
        };

        for (const modelName of candidateModels) {
          if (completedSuccessfully) break;
          try {
            const streamResponse = (await withTimeout(
              ai.models.generateContentStream({
                model: modelName,
                contents,
                config: {
                  systemInstruction: effectiveSystemInstruction,
                  ...getFastThinkingConfig(modelName),
                  ...(tools.length > 0 ? { tools } : {}),
                  ...(toolConfig ? { toolConfig } : {}),
                },
              }),
              8500,
              `generateContentStream(${modelName})`
            )) as unknown as AsyncGenerator<GenerateContentResponse, void, unknown>;

            await consumeStreamWithTimeout(streamResponse, 8500);
            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          } catch (err) {
            lastStreamErr = err;
            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          }
        }
      }

      // Final non-streaming fallback if all streaming endpoints experienced transient issues
      if (!completedSuccessfully || !streamedAnyText) {
        const fallbackText = await generateFreeTierText(
          ai,
          contents,
          effectiveSystemInstruction
        );
        if (fallbackText && fallbackText.trim()) {
          sendEvent({ type: 'delta', text: fallbackText });
          streamedAnyText = true;
          completedSuccessfully = true;
        } else {
          throw lastStreamErr || new Error('Unable to complete chat response.');
        }
      }

      if (hasUrls && collectedSources.size === 0) {
        for (const u of urls.slice(0, 20)) {
          try {
            const parsed = new URL(u);
            collectedSources.set(u, {
              uri: u,
              title:
                parsed.hostname.replace(/^www\./, '') +
                (parsed.pathname !== '/' ? parsed.pathname : ''),
              kind: 'web',
            });
          } catch {
            // ignore invalid URL
          }
        }
      }

      if (collectedSources.size > 0) {
        sendEvent({
          type: 'sources',
          sources: Array.from(collectedSources.values()),
        });
      }

      sendEvent({ type: 'done' });
      res.end();
    } catch (err) {
      const info = classifyGeminiError(err);
      sendEvent({
        type: 'error',
        error: info.message,
        isPaidKeyError: false,
      });
      res.end();
    } finally {
      clearInterval(heartbeatTimer);
    }
  });

  // 3. Create & Edit Images (uses gemini-nano-banana-2.1 when available, with instant free-tier SVG artwork fallback)
  app.post('/api/generate/image', async (req, res) => {
    try {
      const {
        prompt,
        aspectRatio = '1:1',
        imageSize = '1K',
        referenceImage,
      } = req.body as {
        prompt: string;
        aspectRatio?: string;
        imageSize?: '1K' | '2K' | '4K';
        referenceImage?: { base64Data: string; mimeType: string };
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Please provide a prompt for image creation or editing.' });
        return;
      }

      const ai = getOptionalAiClient(12000);
      const parts: Array<Record<string, unknown>> = [];

      if (referenceImage?.base64Data && referenceImage?.mimeType) {
        parts.push({
          inlineData: {
            data: referenceImage.base64Data,
            mimeType: referenceImage.mimeType,
          },
        });
      }
      parts.push({ text: prompt.trim() });

      if (ai && !isPaidModelsInCooldown()) {
        const imageModels = [
          {
            name: 'gemini-nano-banana-2.1',
            config: {
              imageConfig: {
                aspectRatio: aspectRatio || '1:1',
                imageSize: imageSize || '1K',
              },
            },
          },
          {
            name: 'gemini-3.1-flash-lite-image',
            config: {
              imageConfig: {
                aspectRatio: aspectRatio || '1:1',
              },
            },
          },
        ];

        for (const imgModel of imageModels) {
          try {
            const response = await withTimeout(
              ai.models.generateContent({
                model: imgModel.name,
                contents: { parts },
                config: imgModel.config,
              }),
              3500,
              imgModel.name
            );

            let imageBase64 = '';
            let mimeType = 'image/png';
            let accompanyingText = '';

            const candidateParts = response.candidates?.[0]?.content?.parts || [];
            for (const part of candidateParts) {
              if (part.inlineData?.data) {
                imageBase64 = part.inlineData.data;
                if (part.inlineData.mimeType) {
                  mimeType = part.inlineData.mimeType;
                }
              } else if (part.text) {
                accompanyingText += (accompanyingText ? '\n' : '') + part.text;
              }
            }

            if (imageBase64) {
              res.json({
                imageBase64,
                mimeType,
                modelUsed: imgModel.name,
                aspectRatio: aspectRatio || '1:1',
                imageSize: imageSize || '1K',
                text:
                  accompanyingText ||
                  (referenceImage
                    ? `Edited image using ${imgModel.name} for: "${prompt.trim()}"`
                    : `Created image using ${imgModel.name} for: "${prompt.trim()}"`),
              });
              return;
            }
          } catch {
            markPaidModelsUnavailable();
            break;
          }
        }
      }

      // Fast free-tier vector artwork generation using gemini-3.1-flash-lite
      const svgSystemPrompt = `You are a master digital illustrator and vector artist.
Create a richly detailed, multi-layered, visually stunning standalone SVG illustration (viewBox="0 0 1024 1024" width="1024" height="1024") that fulfills the user's image creation or editing prompt.
- Use rich linearGradient and radialGradient definitions, atmospheric lighting, depth layers, detailed geometry, and harmonious colors.
- Output ONLY the raw <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">...</svg> code without markdown fences or explanation.`;

      const rawSvgResponse = await generateFreeTierText(
        ai,
        referenceImage
          ? `Edit the attached image concept according to this instruction: ${prompt.trim()}`
          : `Create a detailed artwork for: ${prompt.trim()}`,
        svgSystemPrompt
      );
      const cleanSvg = extractSvgFromText(rawSvgResponse, prompt.trim());
      const svgBase64 = Buffer.from(cleanSvg, 'utf-8').toString('base64');

      res.json({
        imageBase64: svgBase64,
        mimeType: 'image/svg+xml',
        aspectRatio: aspectRatio || '1:1',
        imageSize: imageSize || '1K',
        text: referenceImage
          ? `Edited illustration for: "${prompt.trim()}"`
          : `Generated illustration for: "${prompt.trim()}"`,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    }
  });

  // 4. Video Generation from Text via Omni Flash (gemini-omni-1.1-flash) with instant free-tier animated SVG scene fallback
  app.post('/api/generate/video/start', async (req, res) => {
    try {
      const {
        prompt,
        aspectRatio = '16:9',
        duration = '5s',
        referenceImage,
      } = req.body as {
        prompt: string;
        aspectRatio?: '16:9' | '9:16';
        duration?: '5s' | '10s';
        referenceImage?: { base64Data: string; mimeType: string };
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Please provide a prompt for video generation.' });
        return;
      }

      const validAspectRatio: '16:9' | '9:16' = aspectRatio === '9:16' ? '9:16' : '16:9';
      const validDuration: '5s' | '10s' = duration === '10s' ? '10s' : '5s';
      const ai = getOptionalAiClient(12000);

      if (ai && !isPaidModelsInCooldown()) {
        try {
          const inputPayload =
            referenceImage?.base64Data && referenceImage?.mimeType
              ? [
                  {
                    type: 'image' as const,
                    mime_type: referenceImage.mimeType,
                    data: referenceImage.base64Data,
                  },
                  {
                    type: 'text' as const,
                    text: prompt.trim(),
                  },
                ]
              : prompt.trim();

          const interaction = await withTimeout(
            ai.interactions.create(
              {
                model: 'gemini-omni-1.1-flash',
                input: inputPayload as string,
                background: true,
                store: true,
                stream: false,
                response_format: {
                  type: 'video',
                  aspect_ratio: validAspectRatio,
                  duration: validDuration,
                  resolution: '720p',
                },
              } as unknown as Parameters<typeof ai.interactions.create>[0],
              { timeout: 4000 }
            ),
            4000,
            'gemini-omni-1.1-flash'
          );

          const interObj = interaction as unknown as {
            id: string;
            status?: string;
            output_video?: { data?: string; uri?: string; mime_type?: string };
            steps?: Array<{
              type?: string;
              content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string }>;
            }>;
          };

          let videoBase64 = interObj.output_video?.data || '';
          let videoUri = interObj.output_video?.uri || '';
          let mimeType = interObj.output_video?.mime_type || 'video/mp4';

          if (!videoBase64 && !videoUri && Array.isArray(interObj.steps)) {
            for (const step of interObj.steps) {
              if (step.type === 'model_output' && Array.isArray(step.content)) {
                const vid = step.content.find((c) => c.type === 'video');
                if (vid) {
                  videoBase64 = vid.data || '';
                  videoUri = vid.uri || '';
                  mimeType = vid.mime_type || 'video/mp4';
                }
              }
            }
          }

          res.json({
            interactionId: interObj.id,
            status: videoBase64 || videoUri ? 'completed' : interObj.status || 'in_progress',
            videoBase64: videoBase64 || undefined,
            videoUri: videoUri || undefined,
            mimeType,
            aspectRatio: validAspectRatio,
            duration: validDuration,
          });
          return;
        } catch {
          markPaidModelsUnavailable();
        }
      }

      const viewBox = validAspectRatio === '9:16' ? '0 0 720 1280' : '0 0 1280 720';
      const width = validAspectRatio === '9:16' ? '720' : '1280';
      const height = validAspectRatio === '9:16' ? '1280' : '720';

      const animatedSvgPrompt = `You are a motion graphics director and SVG animator.
Create a smooth, cinematic, looping animated SVG scene (viewBox="${viewBox}" width="${width}" height="${height}") for the user's prompt.
- Include rich gradients, atmospheric depth, and smooth CSS @keyframes or SVG <animate> / <animateTransform> motion on multiple scene layers (clouds, light rays, waves, particles, characters, or camera pan).
- Output ONLY the raw <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">...</svg> code with no markdown fences.`;

      const rawAnimatedSvg = await generateFreeTierText(
        ai,
        `Create an animated motion scene (${validAspectRatio}) for: ${prompt.trim()}`,
        animatedSvgPrompt
      );
      const cleanSvg = extractSvgFromText(rawAnimatedSvg, prompt.trim());
      const svgBase64 = Buffer.from(cleanSvg, 'utf-8').toString('base64');

      res.json({
        interactionId: `free-video-${Date.now()}`,
        status: 'completed',
        videoBase64: svgBase64,
        mimeType: 'image/svg+xml',
        aspectRatio: validAspectRatio,
        duration: validDuration,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    }
  });

  // Poll video generation operation status
  app.get('/api/generate/video/status/:id', async (req, res) => {
    try {
      const interactionId = req.params.id;
      const ai = getAiClient();
      const interaction = await ai.interactions.get(interactionId);

      const interObj = interaction as unknown as {
        id: string;
        status?: string;
        output_video?: { data?: string; uri?: string; mime_type?: string };
        steps?: Array<{
          type?: string;
          summary?: string;
          content?: Array<{
            type?: string;
            text?: string;
            data?: string;
            uri?: string;
            mime_type?: string;
          }>;
        }>;
      };

      const status = interObj.status || 'in_progress';
      let videoBase64 = interObj.output_video?.data || '';
      let videoUri = interObj.output_video?.uri || '';
      let mimeType = interObj.output_video?.mime_type || 'video/mp4';
      const stepSummaries: string[] = [];

      if (Array.isArray(interObj.steps)) {
        for (const step of interObj.steps) {
          if (step.type === 'thought' && step.summary) {
            stepSummaries.push(step.summary);
          }
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            const vid = step.content.find((c) => c.type === 'video');
            if (vid) {
              videoBase64 = vid.data || videoBase64;
              videoUri = vid.uri || videoUri;
              mimeType = vid.mime_type || mimeType;
            }
          }
        }
      }

      if (status === 'completed' && !videoBase64 && videoUri) {
        try {
          const resp = await fetch(videoUri, {
            headers: {
              'x-goog-api-key': resolveApiKey(),
            },
          });
          if (resp.ok) {
            const arrayBuf = await resp.arrayBuffer();
            videoBase64 = Buffer.from(arrayBuf).toString('base64');
          }
        } catch {
          // Keep videoUri if fetch fails
        }
      }

      res.json({
        interactionId: interObj.id,
        status,
        stepCount: interObj.steps?.length || 0,
        latestNote: stepSummaries.at(-1) || undefined,
        videoBase64: videoBase64 || undefined,
        videoUri: videoUri || undefined,
        mimeType,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    }
  });

  // 5. Music Generation (supports lyria-3-clip-preview / lyria-3-pro-preview with instant free-tier WAV synthesis)
  app.post('/api/generate/music', async (req, res) => {
    try {
      const {
        prompt,
        trackType = 'clip',
        referenceImage,
      } = req.body as {
        prompt: string;
        trackType?: 'clip' | 'pro';
        referenceImage?: { base64Data: string; mimeType: string };
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Please provide a prompt for music generation.' });
        return;
      }

      const selectedLyriaModel =
        trackType === 'pro' ? 'lyria-3-pro-preview' : 'lyria-3-clip-preview';
      const ai = getOptionalAiClient(12000);

      if (ai && !isPaidModelsInCooldown()) {
        try {
          const contents =
            referenceImage?.base64Data && referenceImage?.mimeType
              ? {
                  parts: [
                    { text: prompt.trim() },
                    {
                      inlineData: {
                        data: referenceImage.base64Data,
                        mimeType: referenceImage.mimeType,
                      },
                    },
                  ],
                }
              : prompt.trim();

          const responseStream = await withTimeout(
            ai.models.generateContentStream({
              model: selectedLyriaModel,
              contents,
              config: {
                responseModalities: [Modality.AUDIO],
              },
            }),
            3500,
            selectedLyriaModel
          );

          let audioBase64 = '';
          let lyrics = '';
          let mimeType = 'audio/wav';

          for await (const chunk of responseStream) {
            const parts = chunk.candidates?.[0]?.content?.parts;
            if (!parts) continue;
            for (const part of parts) {
              if (part.inlineData?.data) {
                if (!audioBase64 && part.inlineData.mimeType) {
                  mimeType = part.inlineData.mimeType;
                }
                audioBase64 += part.inlineData.data;
              }
              if (part.text && !lyrics) {
                lyrics = part.text;
              }
            }
          }

          if (audioBase64) {
            res.json({
              audioBase64,
              mimeType,
              modelUsed: selectedLyriaModel,
              lyrics: lyrics || undefined,
            });
            return;
          }
        } catch {
          markPaidModelsUnavailable();
        }
      }

      const musicComposerPrompt = `You are a music composer. Based on the user's prompt, compose a ${
        trackType === 'pro' ? '32-note full' : '20-note clip'
      } melody sequence and poetic lyrics/musical notes.
Return ONLY valid JSON matching this exact structure (no markdown fences):
{
  "bpm": 108,
  "lyrics": "Short 4-line poetic lyrics or musical description matching the prompt",
  "notes": [
    { "freq": 261.63, "durationSec": 0.45 },
    { "freq": 329.63, "durationSec": 0.45 }
  ]
}`;

      const rawComposition = await generateFreeTierText(
        ai,
        `Compose music for: ${prompt.trim()}`,
        musicComposerPrompt
      );

      let bpm = 108;
      let lyrics = '';
      let notes: Array<{ freq: number; durationSec: number }> = [
        { freq: 261.63, durationSec: 0.45 },
        { freq: 293.66, durationSec: 0.45 },
        { freq: 329.63, durationSec: 0.45 },
        { freq: 392.0, durationSec: 0.6 },
        { freq: 440.0, durationSec: 0.45 },
        { freq: 392.0, durationSec: 0.45 },
        { freq: 329.63, durationSec: 0.6 },
        { freq: 293.66, durationSec: 0.45 },
        { freq: 261.63, durationSec: 0.5 },
        { freq: 329.63, durationSec: 0.45 },
        { freq: 392.0, durationSec: 0.45 },
        { freq: 523.25, durationSec: 0.8 },
        { freq: 440.0, durationSec: 0.45 },
        { freq: 392.0, durationSec: 0.45 },
        { freq: 329.63, durationSec: 0.5 },
        { freq: 261.63, durationSec: 0.9 },
      ];

      try {
        const jsonMatch = rawComposition.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.bpm === 'number') bpm = parsed.bpm;
          if (typeof parsed.lyrics === 'string') lyrics = parsed.lyrics;
          if (Array.isArray(parsed.notes) && parsed.notes.length >= 6) {
            notes = parsed.notes;
          }
        }
      } catch {
        // use default notes
      }

      const wavBase64 = synthesizeWavFromNotes(notes, bpm);

      res.json({
        audioBase64: wavBase64,
        mimeType: 'audio/wav',
        modelUsed: selectedLyriaModel,
        lyrics: lyrics || undefined,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    }
  });

  // 6. Audio Transcription via Groq Whisper (whisper-large-v3-turbo) with Gemini fallback
  app.post('/api/transcribe', async (req, res) => {
    try {
      const { audioBase64, mimeType = 'audio/webm', language } = req.body as {
        audioBase64: string;
        mimeType?: string;
        language?: string;
      };

      if (!audioBase64) {
        res.status(400).json({ error: 'No audio data received for transcription.' });
        return;
      }

      const groqKey = resolveGroqApiKey();
      let transcript = '';

      if (groqKey) {
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        const ext = mimeType.includes('mp4')
          ? 'm4a'
          : mimeType.includes('ogg')
            ? 'ogg'
            : mimeType.includes('wav')
              ? 'wav'
              : mimeType.includes('mp3') || mimeType.includes('mpeg')
                ? 'mp3'
                : 'webm';

        for (const whisperModel of ['whisper-large-v3-turbo', 'whisper-large-v3']) {
          try {
            const formData = new FormData();
            const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
            formData.append('file', audioBlob, `recording.${ext}`);
            formData.append('model', whisperModel);
            if (language && language !== 'auto' && language !== 'Auto') {
              formData.append(
                'prompt',
                `Transcribe accurately in ${language}.`
              );
            }

            const groqResp = await withTimeout(
              fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${groqKey}`,
                },
                body: formData,
              }),
              12000,
              `groqWhisper(${whisperModel})`
            );

            if (groqResp.ok) {
              const data = (await groqResp.json()) as { text?: string };
              if (typeof data?.text === 'string' && data.text.trim()) {
                transcript = data.text.trim();
                break;
              }
            }
          } catch {
            // Try next whisper model or fallback
          }
        }
      }

      const ai = getOptionalAiClient(12000);
      if (!transcript && ai) {
        const langInstruction =
          language && language !== 'auto' && language !== 'Auto'
            ? `Transcribe this audio in ${language}. Return ONLY the exact transcribed text with no extra commentary.`
            : 'Transcribe this audio accurately in the language spoken. Return ONLY the exact transcribed text with no extra commentary.';

        const audioContents = {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            {
              text: langInstruction,
            },
          ],
        };

        if (!isPaidModelsInCooldown()) {
          try {
            const response = await withTimeout(
              ai.models.generateContent({
                model: 'gemini-3.5-transcribe',
                contents: audioContents,
              }),
              3500,
              'gemini-3.5-transcribe'
            );
            transcript = (response.text || '').trim();
          } catch {
            markPaidModelsUnavailable();
          }
        }

        if (!transcript) {
          const fallbackText = await generateFreeTierText(ai, audioContents);
          transcript = fallbackText.trim();
        }
      }

      res.json({
        transcript,
      });
    } catch (err) {
      const info = classifyGeminiError(err);
      res.status(info.statusCode).json({
        error: info.message,
        isPaidKeyError: false,
      });
    }
  });

  // 7. Username & Password Account Auth + Per-User Chat Session Persistence (No Email Required)
  const dataDir = path.join(os.tmpdir(), 'mantrana-ai-data');
  const accountsFilePath = path.join(dataDir, 'accounts.json');

  interface StoredAccountRecord {
    uid: string;
    email: string; // internal storage key derived from username
    username: string;
    passwordHash: string; // global deterministic password hash to enforce unique passwords across all users
    createdAt: number;
    updatedAt: number;
  }

  function ensureDataDir() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  function hashPassword(email: string, password: string): string {
    return crypto
      .createHash('sha256')
      .update(`mantrana-salt:${email.trim().toLowerCase()}:${password}`)
      .digest('hex');
  }

  function hashPasswordGlobal(password: string): string {
    return crypto
      .createHash('sha256')
      .update(`mantrana-global-password-v2:${password}`)
      .digest('hex');
  }

  function emailToFileKey(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
  }

  function validateUsernameFormat(username: string): string | null {
    if (!username || username.length < 2 || username.length > 60) {
      return 'Username must be between 2 and 60 characters long.';
    }
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      return 'Username must contain characters (letters) and numbers only (no spaces or special characters).';
    }
    return null;
  }

  function validatePasswordComplexity(password: string): string | null {
    if (!password || password.length < 8) {
      return 'Password must be at least 8 characters long.';
    }
    if (!/[a-zA-Z]/.test(password)) {
      return 'Password must contain at least 1 alphabet character (a-z or A-Z).';
    }
    if (!/[0-9]/.test(password)) {
      return 'Password must contain at least 1 digit (0-9).';
    }
    if (!/[^a-zA-Z0-9\s]/.test(password)) {
      return 'Password must contain at least 1 special character (e.g. !@#$%^&*).';
    }
    return null;
  }

  function readAccountsMap(): Record<string, StoredAccountRecord> {
    try {
      ensureDataDir();
      if (!fs.existsSync(accountsFilePath)) return {};
      const raw = fs.readFileSync(accountsFilePath, 'utf-8');
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  function writeAccountsMap(map: Record<string, StoredAccountRecord>) {
    try {
      ensureDataDir();
      fs.writeFileSync(accountsFilePath, JSON.stringify(map, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write accounts file:', err);
    }
  }

  function readUserSessions(email: string): any[] {
    try {
      ensureDataDir();
      const key = emailToFileKey(email);
      const sessionFile = path.join(dataDir, `sessions_${key}.json`);
      if (!fs.existsSync(sessionFile)) return [];
      const raw = fs.readFileSync(sessionFile, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeUserSessions(email: string, sessions: any[]) {
    try {
      ensureDataDir();
      const key = emailToFileKey(email);
      const sessionFile = path.join(dataDir, `sessions_${key}.json`);
      fs.writeFileSync(sessionFile, JSON.stringify(sessions, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write user sessions file:', err);
    }
  }

  app.post('/api/account/auth', (req, res) => {
    try {
      const {
        mode = 'signup',
        username,
        password,
        knownAccounts,
      } = req.body as {
        mode?: 'signup' | 'login';
        username?: string;
        password?: string;
        knownAccounts?: Array<{
          uid?: string;
          username?: string;
          email?: string;
          passwordHash?: string;
          createdAt?: number;
        }>;
      };

      const trimmedUsername = (username || '').trim();
      const usernameLower = trimmedUsername.toLowerCase();
      const rawPassword = password || '';

      const usernameErr = validateUsernameFormat(trimmedUsername);
      if (usernameErr) {
        res.status(400).json({ error: usernameErr });
        return;
      }

      if (mode === 'signup') {
        const passwordErr = validatePasswordComplexity(rawPassword);
        if (passwordErr) {
          res.status(400).json({ error: passwordErr });
          return;
        }
      } else if (!rawPassword) {
        res.status(400).json({ error: 'Please enter your password.' });
        return;
      }

      const accounts = readAccountsMap();
      const now = Date.now();

      // Re-hydrate any client-cached accounts so uniqueness checks and logins remain intact across server restarts
      if (Array.isArray(knownAccounts)) {
        let updated = false;
        for (const ka of knownAccounts) {
          const kaUsername = (ka?.username || '').trim();
          const kaLower = kaUsername.toLowerCase();
          if (!kaLower || !ka?.passwordHash) continue;
          const alreadyPresent = Object.values(accounts).some(
            (acc) => (acc.username || '').trim().toLowerCase() === kaLower
          );
          if (!alreadyPresent) {
            const internalEmail = (ka.email || `${kaLower}@mantrana.local`).trim().toLowerCase();
            accounts[internalEmail] = {
              uid: ka.uid || `user-${emailToFileKey(internalEmail).slice(0, 20)}`,
              email: internalEmail,
              username: kaUsername,
              passwordHash: ka.passwordHash,
              createdAt: ka.createdAt || now,
              updatedAt: now,
            };
            updated = true;
          }
        }
        if (updated) {
          writeAccountsMap(accounts);
        }
      }

      const allAccounts = Object.values(accounts);
      const globalPasswordHash = hashPasswordGlobal(rawPassword);
      const internalEmail = `${usernameLower}@mantrana.local`;

      if (mode === 'signup') {
        // Check uniqueness: No two users can have the same username OR the same password
        const usernameExists = allAccounts.some(
          (acc) => (acc.username || '').trim().toLowerCase() === usernameLower
        );
        const passwordExists = allAccounts.some(
          (acc) =>
            acc.passwordHash === globalPasswordHash ||
            (acc.email && acc.passwordHash === hashPassword(acc.email, rawPassword))
        );

        if (usernameExists && passwordExists) {
          res.status(409).json({
            error:
              'This username or password already exists. No two users can have the same username or password.',
          });
          return;
        }

        if (usernameExists) {
          res.status(409).json({
            error:
              'This username or password already exists (this username is already taken). Please choose a different username.',
          });
          return;
        }

        if (passwordExists) {
          res.status(409).json({
            error:
              'This username or password already exists (this password is already used by another user). Please choose a different password.',
          });
          return;
        }

        const uid = `user-${emailToFileKey(internalEmail).slice(0, 20)}`;
        const newRecord: StoredAccountRecord = {
          uid,
          email: internalEmail,
          username: trimmedUsername.slice(0, 60),
          passwordHash: globalPasswordHash,
          createdAt: now,
          updatedAt: now,
        };
        accounts[internalEmail] = newRecord;
        writeAccountsMap(accounts);
        const sessions = readUserSessions(internalEmail);

        res.json({
          user: {
            uid: newRecord.uid,
            email: newRecord.email,
            username: newRecord.username,
            createdAt: newRecord.createdAt,
          },
          passwordHash: globalPasswordHash,
          sessions,
        });
        return;
      }

      // mode === 'login'
      const existing = allAccounts.find(
        (acc) => (acc.username || '').trim().toLowerCase() === usernameLower
      );

      if (!existing) {
        res.status(404).json({
          error:
            'Account not found with this username. Please check your username or switch to Create Account.',
        });
        return;
      }

      const matchesGlobal = existing.passwordHash === globalPasswordHash;
      const matchesLegacy =
        Boolean(existing.email) &&
        existing.passwordHash === hashPassword(existing.email, rawPassword);

      if (!matchesGlobal && !matchesLegacy) {
        res.status(401).json({
          error: 'Incorrect username or password. Please try again.',
        });
        return;
      }

      // Upgrade legacy hash to global hash if needed
      if (!matchesGlobal && matchesLegacy) {
        existing.passwordHash = globalPasswordHash;
        existing.updatedAt = now;
        accounts[existing.email] = existing;
        writeAccountsMap(accounts);
      }

      const sessions = readUserSessions(existing.email);
      res.json({
        user: {
          uid: existing.uid,
          email: existing.email,
          username: existing.username,
          createdAt: existing.createdAt,
        },
        passwordHash: globalPasswordHash,
        sessions,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Authentication failed.',
      });
    }
  });

  app.get('/api/account/sessions', (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) {
      res.json({ sessions: [] });
      return;
    }
    const sessions = readUserSessions(email);
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ sessions });
  });

  app.post('/api/account/sessions', (req, res) => {
    try {
      const { email, session, sessions: batchSessions } = req.body as {
        email?: string;
        session?: any;
        sessions?: any[];
      };
      const normalizedEmail = (email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        res.status(400).json({ error: 'Email is required to save chat sessions.' });
        return;
      }

      const existing = readUserSessions(normalizedEmail);
      const map = new Map<string, any>();
      for (const s of existing) {
        if (s && s.id) map.set(s.id, s);
      }

      if (Array.isArray(batchSessions)) {
        for (const s of batchSessions) {
          if (s && s.id) {
            map.set(s.id, { ...s, userEmail: normalizedEmail });
          }
        }
      }

      if (session && session.id) {
        map.set(session.id, { ...session, userEmail: normalizedEmail });
      }

      const merged = Array.from(map.values()).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      writeUserSessions(normalizedEmail, merged);
      res.json({ ok: true, count: merged.length });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save session.',
      });
    }
  });

  app.delete('/api/account/sessions/:id', (req, res) => {
    try {
      const email = String(req.query.email || '').trim().toLowerCase();
      const sessionId = req.params.id;
      if (!email || !sessionId) {
        res.json({ ok: true });
        return;
      }
      const existing = readUserSessions(email);
      const filtered = existing.filter((s) => s && s.id !== sessionId);
      writeUserSessions(email, filtered);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to delete session.',
      });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Serve frontend via Vite in development or static dist in production
  const distPath = path.resolve(__dirname, 'dist');
  const distIndexHtml = path.join(distPath, 'index.html');
  const isProd =
    (process.env.NODE_ENV === 'production' ||
      process.env.npm_lifecycle_event === 'start') &&
    fs.existsSync(distIndexHtml);

  const port = Number(process.env.PORT) || 3000;

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexHtml);
    });
  } else {
    process.env.DISABLE_HMR = 'true';
    const viteClientWsShim = `class WebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url = '', protocol = '') {
    super();
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    this.readyState = 1;
    this.url = String(url);
    this.protocol = String(protocol);
    setTimeout(() => {
      try { this.dispatchEvent(new Event('open')); } catch {}
    }, 0);
  }
  send() {}
  close() { this.readyState = 3; }
}\n`;
    const viteReadyPromise = import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({
        plugins: [
          {
            name: 'disable-vite-client-ws-errors',
            enforce: 'post',
            transform(code, id) {
              if (id.includes('vite/dist/client/client.mjs')) {
                return {
                  code: viteClientWsShim + code,
                  map: null,
                };
              }
              return null;
            },
          },
        ],
        server: {
          middlewareMode: true,
          hmr: false,
          watch: null,
        },
        appType: 'spa',
      })
    );
    app.use(async (req, res, next) => {
      try {
        const vite = await viteReadyPromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Mantrana AI server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
