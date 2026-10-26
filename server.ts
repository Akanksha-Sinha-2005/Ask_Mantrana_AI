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

// Fault-tolerant loader for the separate git-ignored `apiKey.config.ts` file.
// Avoids static ESM `ERR_MODULE_NOT_FOUND` on Node.js v22 / Cloud Run when git-ignored files are excluded.
let dynamicConfiguredKey = '';
const apiKeyConfigPath = path.join(__dirname, 'apiKey.config.ts');
if (fs.existsSync(apiKeyConfigPath)) {
  const configModuleUrl = new URL('./apiKey.config.ts', import.meta.url).href;
  import(configModuleUrl)
    .then((mod) => {
      if (typeof mod?.getConfiguredApiKey === 'function') {
        dynamicConfiguredKey = String(mod.getConfiguredApiKey() || '').trim();
      } else if (typeof mod?.GEMINI_CONFIGURED_API_KEY === 'string') {
        dynamicConfiguredKey = mod.GEMINI_CONFIGURED_API_KEY.trim();
      }
    })
    .catch(() => {
      // Handled by synchronous file reader fallback below
    });
}

function readKeyFromSeparateConfigFile(): string {
  try {
    if (fs.existsSync(apiKeyConfigPath)) {
      const content = fs.readFileSync(apiKeyConfigPath, 'utf8');
      const match = content.match(/CUSTOM_GEMINI_API_KEY\s*(?::\s*string\s*)?=\s*['"`]([^'"`]*)['"`]/);
      if (match && match[1] && match[1].trim()) {
        return match[1].trim();
      }
    }
  } catch {
    // Ignore file read errors in restricted environments
  }
  return '';
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

function resolveApiKey(): string {
  return (
    readKeyFromSeparateConfigFile() ||
    dynamicConfiguredKey ||
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    ''
  ).trim();
}

function getAiClient(timeoutMs = 15000): GoogleGenAI {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check apiKey.config.ts or AI Studio Settings > Secrets.'
    );
  }
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

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid')) {
    return {
      message:
        'The configured Gemini API key is invalid. Please check your key in apiKey.config.ts or AI Studio Settings > Secrets.',
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
        'The Gemini server experienced a brief traffic spike. Please click Retry to send your message again.',
      isPaidKeyError: false,
      statusCode: 503,
    };
  }

  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      message:
        'Free-tier rate limit reached for the current API key. Please wait a few seconds and retry.',
      isPaidKeyError: false,
      statusCode: 429,
    };
  }

  return {
    message: raw || 'An unexpected error occurred while communicating with Gemini.',
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

async function generateFreeTierText(
  ai: GoogleGenAI,
  contents: unknown,
  systemInstruction?: string
): Promise<string> {
  const candidateModels = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
  let lastErr: unknown;
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
  throw lastErr || new Error('Failed to generate content with free-tier Gemini models.');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // 1. Upload large files via Gemini File API
  app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) {
        res.status(400).json({ error: 'No file received for upload.' });
        return;
      }

      const ai = getAiClient();
      const mimeType = req.body.mimeType || req.file.mimetype || 'application/octet-stream';
      const displayName = req.body.displayName || req.file.originalname || 'uploaded_file';

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
        throw new Error(`Gemini File API processing failed for "${displayName}".`);
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
        userLocation?: { latitude: number; longitude: number };
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        sendEvent({ type: 'error', error: 'No messages provided.' });
        res.end();
        return;
      }

      const ai = getAiClient(14000);

      const targetLang = resolveIndianLanguage(language);
      const effectiveSystemInstruction = buildSystemInstructionForLanguage(targetLang.name);

      const promptLanguageDirective =
        targetLang.name === 'Auto'
          ? '[Detect the language of this message—including if it is Hindi or another Indian language written in English letters such as "kaise ho"—understand its meaning in that language, and reply naturally in the detected language.]'
          : `[Understand this message even if it contains Romanized Indian words written in English letters like "kaise ho", and respond in ${targetLang.name} (${targetLang.nativeScript}) using ${targetLang.scriptDescription}.]`;

      // Keep the most recent 12 turns so context stays fast and never hits free-tier token-per-minute bottlenecks
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

      const lastUserText = (recentMessages.at(-1)?.text || '').toLowerCase();
      const hasUrls = Array.isArray(urls) && urls.length > 0;

      // Detect geography / place / local discovery queries when groundingMode is 'auto'
      const isPlaceOrMapQuery =
        /\b(nearby|near me|restaurants?|cafes?|coffee shops?|hotels?|hospitals?|pharmacies|directions|route to|where is|places to visit|tourist attractions?|things to do in|landmarks? in|distance between|map of|best food in|parks? in|museums? in|temples? in|malls? in|airports? in|stations? in)\b/i.test(
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

      // Note: googleMaps cannot be combined with googleSearch or urlContext in the same request
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

      const candidateModels = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
      const collectedSources = new Map<
        string,
        { uri: string; title: string; kind?: 'web' | 'maps'; reviewSnippets?: string[] }
      >();
      let streamedAnyText = false;
      let completedSuccessfully = false;
      let lastStreamErr: unknown = null;

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

          // Extract groundingChunks from Google Search grounding & Google Maps grounding
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

          // Extract urlContextMetadata if present on candidate
          const urlContextMetadata = candidate?.urlContextMetadata as
            | {
                urlMetadata?: Array<{
                  retrievedUrl?: string;
                  urlRetrievalStatus?: string;
                }>;
              }
            | undefined;

          if (urlContextMetadata?.urlMetadata) {
            for (const um of urlContextMetadata.urlMetadata) {
              if (
                um.retrievedUrl &&
                (!um.urlRetrievalStatus ||
                  um.urlRetrievalStatus.includes('SUCCESS') ||
                  um.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
              ) {
                if (!collectedSources.has(um.retrievedUrl)) {
                  let hostname = um.retrievedUrl;
                  try {
                    hostname = new URL(um.retrievedUrl).hostname.replace(/^www\./, '');
                  } catch {
                    // keep raw
                  }
                  collectedSources.set(um.retrievedUrl, {
                    uri: um.retrievedUrl,
                    title: hostname,
                    kind: 'web',
                  });
                }
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
          const errStr = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
          if (
            tools.length > 0 &&
            (errStr.includes('429') ||
              errStr.includes('resource_exhausted') ||
              errStr.includes('quota'))
          ) {
            markGroundingUnavailable();
          }
          if (streamedAnyText) {
            completedSuccessfully = true;
            break;
          }
        }

        // If grounding tools caused an error or returned empty text, immediately retry without tools on the same fast model
        if (!completedSuccessfully && tools.length > 0) {
          tools.length = 0; // Clear tools for remaining attempts in this request
          try {
            const retryStream = (await withTimeout(
              ai.models.generateContentStream({
                model: modelName,
                contents,
                config: {
                  systemInstruction: effectiveSystemInstruction,
                  ...getFastThinkingConfig(modelName),
                },
              }),
              8500,
              `generateContentStream-notools(${modelName})`
            )) as unknown as AsyncGenerator<GenerateContentResponse, void, unknown>;

            await consumeStreamWithTimeout(retryStream, 8500);
            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          } catch (retryErr) {
            lastStreamErr = retryErr;
            if (streamedAnyText) {
              completedSuccessfully = true;
              break;
            }
          }
        }
      }

      // Final non-streaming fallback if all streaming endpoints experienced 503 spikes or empty streams
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

      const ai = getAiClient(12000);
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

      if (!isPaidModelsInCooldown()) {
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
      const ai = getAiClient(12000);

      if (!isPaidModelsInCooldown()) {
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
      const ai = getAiClient(12000);

      if (!isPaidModelsInCooldown()) {
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

  // 6. Audio Transcription via Gemini (fast free-tier transcription)
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

      const ai = getAiClient(12000);
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

      let transcript = '';
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

  // 7. Email, Username & Password Account Auth + Per-Email Chat Session Persistence
  const dataDir = path.resolve(__dirname, '.data');
  const accountsFilePath = path.join(dataDir, 'accounts.json');

  interface StoredAccountRecord {
    uid: string;
    email: string;
    username: string;
    passwordHash: string;
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

  function emailToFileKey(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
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
      const { mode = 'signup', email, username, password } = req.body as {
        mode?: 'signup' | 'login';
        email?: string;
        username?: string;
        password?: string;
      };

      const normalizedEmail = (email || '').trim().toLowerCase();
      const trimmedUsername = (username || '').trim();
      const rawPassword = password || '';

      if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }

      if (rawPassword.length < 4) {
        res
          .status(400)
          .json({ error: 'Password must be at least 4 characters long.' });
        return;
      }

      const accounts = readAccountsMap();
      const existing = accounts[normalizedEmail];
      const incomingHash = hashPassword(normalizedEmail, rawPassword);
      const now = Date.now();

      if (mode === 'signup') {
        if (!trimmedUsername || trimmedUsername.length < 2) {
          res
            .status(400)
            .json({ error: 'Please create a username (at least 2 characters).' });
          return;
        }

        if (existing) {
          // If the user already registered this email and entered the matching password, sign them in and update username
          if (existing.passwordHash === incomingHash) {
            existing.username = trimmedUsername || existing.username;
            existing.updatedAt = now;
            accounts[normalizedEmail] = existing;
            writeAccountsMap(accounts);
            const sessions = readUserSessions(normalizedEmail);
            res.json({
              user: {
                uid: existing.uid,
                email: existing.email,
                username: existing.username,
                createdAt: existing.createdAt,
              },
              sessions,
            });
            return;
          }
          res.status(409).json({
            error:
              'An account with this email already exists. Switch to Log In or enter your existing password.',
          });
          return;
        }

        const uid = `user-${emailToFileKey(normalizedEmail).slice(0, 20)}`;
        const newRecord: StoredAccountRecord = {
          uid,
          email: normalizedEmail,
          username: trimmedUsername.slice(0, 60),
          passwordHash: incomingHash,
          createdAt: now,
          updatedAt: now,
        };
        accounts[normalizedEmail] = newRecord;
        writeAccountsMap(accounts);
        const sessions = readUserSessions(normalizedEmail);

        res.json({
          user: {
            uid: newRecord.uid,
            email: newRecord.email,
            username: newRecord.username,
            createdAt: newRecord.createdAt,
          },
          sessions,
        });
        return;
      }

      // mode === 'login'
      if (!existing) {
        // If account doesn't exist yet on this server, create it seamlessly using the provided username (or email prefix)
        const fallbackUsername =
          trimmedUsername.length >= 2
            ? trimmedUsername.slice(0, 60)
            : normalizedEmail.split('@')[0].slice(0, 60) || 'User';
        const uid = `user-${emailToFileKey(normalizedEmail).slice(0, 20)}`;
        const createdRecord: StoredAccountRecord = {
          uid,
          email: normalizedEmail,
          username: fallbackUsername,
          passwordHash: incomingHash,
          createdAt: now,
          updatedAt: now,
        };
        accounts[normalizedEmail] = createdRecord;
        writeAccountsMap(accounts);
        const sessions = readUserSessions(normalizedEmail);
        res.json({
          user: {
            uid: createdRecord.uid,
            email: createdRecord.email,
            username: createdRecord.username,
            createdAt: createdRecord.createdAt,
          },
          sessions,
        });
        return;
      }

      if (existing.passwordHash !== incomingHash) {
        res
          .status(401)
          .json({ error: 'Incorrect password for this email account. Please try again.' });
        return;
      }

      if (trimmedUsername.length >= 2) {
        existing.username = trimmedUsername.slice(0, 60);
        existing.updatedAt = now;
        accounts[normalizedEmail] = existing;
        writeAccountsMap(accounts);
      }

      const sessions = readUserSessions(normalizedEmail);
      res.json({
        user: {
          uid: existing.uid,
          email: existing.email,
          username: existing.username,
          createdAt: existing.createdAt,
        },
        sessions,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Authentication failed.',
      });
    }
  });

  app.post('/api/account/oauth-sync', (req, res) => {
    try {
      const { uid, email, username } = req.body as {
        uid?: string;
        email?: string;
        username?: string;
      };
      const normalizedEmail = (email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        res.status(400).json({ error: 'Email is required.' });
        return;
      }
      const accounts = readAccountsMap();
      const now = Date.now();
      const existing = accounts[normalizedEmail];
      const resolvedUsername =
        (username || '').trim() ||
        existing?.username ||
        normalizedEmail.split('@')[0] ||
        'User';
      const resolvedUid = uid || existing?.uid || `user-${emailToFileKey(normalizedEmail).slice(0, 20)}`;

      accounts[normalizedEmail] = {
        uid: resolvedUid,
        email: normalizedEmail,
        username: resolvedUsername.slice(0, 60),
        passwordHash: existing?.passwordHash || '',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      writeAccountsMap(accounts);
      const sessions = readUserSessions(normalizedEmail);
      res.json({
        user: {
          uid: resolvedUid,
          email: normalizedEmail,
          username: resolvedUsername.slice(0, 60),
          createdAt: accounts[normalizedEmail].createdAt,
        },
        sessions,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to sync account.',
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

  // Serve frontend via Vite in development or static dist in production
  const distPath = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Mantrana AI server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
