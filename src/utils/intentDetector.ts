import { ComposerMode } from '../types';

const URL_REGEX = /https?:\/\/[^\s<>"'`)\]]+/gi;

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  const cleaned = matches.map((u) => u.replace(/[.,;:!?]+$/, ''));
  return Array.from(new Set(cleaned));
}

export function detectGenerationIntent(
  text: string,
  currentMode: ComposerMode,
  hasNonImageAttachments: boolean
): ComposerMode {
  if (currentMode !== 'chat') {
    return currentMode;
  }
  if (hasNonImageAttachments) {
    return 'chat';
  }

  const trimmed = text.trim();
  if (!trimmed) return 'chat';

  // Detect explicit image generation intent
  const imageIntentPattern =
    /^(?:please\s+)?(?:generate|create|draw|paint|render|make|design|sketch|illustrate)\s+(?:an?\s+|me\s+an?\s+)?(?:image|picture|photo|photograph|illustration|artwork|portrait|wallpaper|logo|poster|icon)\b/i;
  if (imageIntentPattern.test(trimmed)) {
    return 'image';
  }

  // Detect explicit video generation intent
  const videoIntentPattern =
    /^(?:please\s+)?(?:generate|create|make|render|animate|produce)\s+(?:an?\s+|me\s+an?\s+)?(?:video|animation|clip|movie|cinematic\s+video|short\s+video)\b/i;
  if (videoIntentPattern.test(trimmed)) {
    return 'video';
  }

  // Detect explicit music generation intent
  const musicIntentPattern =
    /^(?:please\s+)?(?:generate|create|compose|make|play|produce)\s+(?:an?\s+|me\s+an?\s+|some\s+)?(?:music|song|melody|soundtrack|audio\s+track|instrumental|beat|orchestral\s+track|music\s+clip)\b/i;
  if (musicIntentPattern.test(trimmed)) {
    return 'music';
  }

  return 'chat';
}

export function buildAutoTitle(firstUserMessage: string, attachmentNames: string[] = []): string {
  const clean = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (clean) {
    return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
  }
  if (attachmentNames.length > 0) {
    return `Analysis of ${attachmentNames[0]}`;
  }
  return 'New conversation';
}
