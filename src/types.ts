export type ComposerMode = 'chat' | 'image' | 'video' | 'music';

export type AttachmentKind = 'inline' | 'fileApi' | 'extractedText';

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  categoryLabel: string; // e.g. 'PDF', 'Image', 'Video', 'Audio', 'DOCX', 'PPTX', 'XLSX', 'Code', 'Text'
  kind: AttachmentKind;
  base64Data?: string;
  previewUrl?: string;
  fileUri?: string;
  extractedText?: string;
  uploading?: boolean;
  error?: string;
}

export interface GroundingSource {
  uri: string;
  title: string;
  kind?: 'web' | 'maps';
  reviewSnippets?: string[];
}

export type OfficialIndianLanguage =
  | 'Auto'
  | 'English'
  | 'Assamese'
  | 'Bengali'
  | 'Bodo'
  | 'Dogri'
  | 'Gujarati'
  | 'Hindi'
  | 'Kannada'
  | 'Kashmiri'
  | 'Konkani'
  | 'Maithili'
  | 'Malayalam'
  | 'Manipuri'
  | 'Marathi'
  | 'Nepali'
  | 'Odia'
  | 'Punjabi'
  | 'Sanskrit'
  | 'Santali'
  | 'Sindhi'
  | 'Tamil'
  | 'Telugu'
  | 'Urdu';

export interface IndianLanguageOption {
  name: OfficialIndianLanguage;
  nativeName: string;
  code: string;
  label: string;
}

export const INDIAN_OFFICIAL_LANGUAGES: readonly IndianLanguageOption[] = [
  { name: 'Auto', nativeName: 'Detect Language', code: 'auto', label: 'Detect Language' },
  { name: 'English', nativeName: 'English', code: 'en-IN', label: 'English' },
  { name: 'Assamese', nativeName: 'অসমীয়া', code: 'as-IN', label: 'Assamese (অসমীয়া)' },
  { name: 'Bengali', nativeName: 'বাংলা', code: 'bn-IN', label: 'Bengali (বাংলা)' },
  { name: 'Bodo', nativeName: "बर'", code: 'brx-IN', label: "Bodo (बर')" },
  { name: 'Dogri', nativeName: 'डोगरी', code: 'doi-IN', label: 'Dogri (डोगरी)' },
  { name: 'Gujarati', nativeName: 'ગુજરાતી', code: 'gu-IN', label: 'Gujarati (ગુજરાતી)' },
  { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi-IN', label: 'Hindi (हिन्दी)' },
  { name: 'Kannada', nativeName: 'ಕನ್ನಡ', code: 'kn-IN', label: 'Kannada (ಕನ್ನಡ)' },
  { name: 'Kashmiri', nativeName: 'कॉशुर / کٲشُر', code: 'ks-IN', label: 'Kashmiri (कॉशुर / کٲشُر)' },
  { name: 'Konkani', nativeName: 'कोंकणी', code: 'kok-IN', label: 'Konkani (कोंकणी)' },
  { name: 'Maithili', nativeName: 'मैथिली', code: 'mai-IN', label: 'Maithili (मैथिली)' },
  { name: 'Malayalam', nativeName: 'മലയാളം', code: 'ml-IN', label: 'Malayalam (മലയാളം)' },
  { name: 'Manipuri', nativeName: 'মৈতৈলোন্', code: 'mni-IN', label: 'Manipuri (মৈতৈলোন্)' },
  { name: 'Marathi', nativeName: 'मराठी', code: 'mr-IN', label: 'Marathi (मराठी)' },
  { name: 'Nepali', nativeName: 'नेपाली', code: 'ne-IN', label: 'Nepali (नेपाली)' },
  { name: 'Odia', nativeName: 'ଓଡ଼ିଆ', code: 'or-IN', label: 'Odia (ଓଡ଼ିଆ)' },
  { name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', code: 'pa-IN', label: 'Punjabi (ਪੰਜਾਬੀ)' },
  { name: 'Sanskrit', nativeName: 'संस्कृतम्', code: 'sa-IN', label: 'Sanskrit (संस्कृतम्)' },
  { name: 'Santali', nativeName: 'ᱥᱟᱱᱛᱟᱲᱤ', code: 'sat-IN', label: 'Santali (ᱥᱟᱱᱛᱟᱲᱤ)' },
  { name: 'Sindhi', nativeName: 'सिन्धी / سنڌي', code: 'sd-IN', label: 'Sindhi (सिन्धी / سنڌي)' },
  { name: 'Tamil', nativeName: 'தமிழ்', code: 'ta-IN', label: 'Tamil (தமிழ்)' },
  { name: 'Telugu', nativeName: 'తెలుగు', code: 'te-IN', label: 'Telugu (తెలుగు)' },
  { name: 'Urdu', nativeName: 'اردو', code: 'ur-IN', label: 'Urdu (اردو)' },
] as const;

export interface GenerationOptions {
  language: OfficialIndianLanguage;
  chatGrounding: 'auto' | 'search' | 'maps';
  imageAspectRatio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  imageSize: '1K' | '2K' | '4K';
  videoAspectRatio: '16:9' | '9:16';
  videoDuration: '5s' | '10s';
  musicTrackType: 'clip' | 'pro';
}

export interface GeneratedMedia {
  type: 'image' | 'video' | 'music';
  mimeType: string;
  base64Data?: string;
  uri?: string;
  prompt: string;
  lyrics?: string;
  aspectRatio?: string;
  imageSize?: string;
  duration?: string;
  modelUsed?: string;
}

export interface VideoProgressState {
  interactionId?: string;
  status: 'starting' | 'in_progress' | 'completed' | 'failed';
  elapsedSeconds: number;
  stepCount: number;
  latestNote?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  createdAt: number;
  mode: ComposerMode;
  attachments?: FileAttachment[];
  sources?: GroundingSource[];
  generatedMedia?: GeneratedMedia;
  videoProgress?: VideoProgressState;
  isStreaming?: boolean;
  error?: string;
  isPaidKeyError?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  userEmail?: string;
}

export interface UserAccount {
  uid: string;
  email: string;
  username: string;
  createdAt: number;
}

export interface ToastNotice {
  id: string;
  title: string;
  message: string;
  type: 'error' | 'warning' | 'info';
  onRetry?: () => void;
}

