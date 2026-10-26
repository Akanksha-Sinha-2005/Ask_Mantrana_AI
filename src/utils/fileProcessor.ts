import mammoth from 'mammoth';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { FileAttachment } from '../types';

const INLINE_SIZE_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MB threshold: <= 8MB inlineData, > 8MB Gemini File API

const CODE_EXTENSIONS: Record<string, string> = {
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/x-python',
  java: 'text/x-java-source',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  cs: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  rb: 'text/plain',
  php: 'text/plain',
  swift: 'text/plain',
  kt: 'text/plain',
  sql: 'text/plain',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  css: 'text/css',
  scss: 'text/css',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  vue: 'text/plain',
  svelte: 'text/plain',
};

const NATIVE_EXTENSIONS: Record<string, { mime: string; label: string }> = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  txt: { mime: 'text/plain', label: 'TXT' },
  json: { mime: 'application/json', label: 'JSON' },
  csv: { mime: 'text/csv', label: 'CSV' },
  html: { mime: 'text/html', label: 'HTML' },
  htm: { mime: 'text/html', label: 'HTML' },
  png: { mime: 'image/png', label: 'Image' },
  jpg: { mime: 'image/jpeg', label: 'Image' },
  jpeg: { mime: 'image/jpeg', label: 'Image' },
  webp: { mime: 'image/webp', label: 'Image' },
  gif: { mime: 'image/gif', label: 'Image' },
  heic: { mime: 'image/heic', label: 'Image' },
  heif: { mime: 'image/heif', label: 'Image' },
  mp4: { mime: 'video/mp4', label: 'Video' },
  webm: { mime: 'video/webm', label: 'Video' },
  mov: { mime: 'video/quicktime', label: 'Video' },
  avi: { mime: 'video/x-msvideo', label: 'Video' },
  mkv: { mime: 'video/x-matroska', label: 'Video' },
  mp3: { mime: 'audio/mp3', label: 'Audio' },
  wav: { mime: 'audio/wav', label: 'Audio' },
  ogg: { mime: 'audio/ogg', label: 'Audio' },
  m4a: { mime: 'audio/mp4', label: 'Audio' },
  aac: { mime: 'audio/aac', label: 'Audio' },
  flac: { mime: 'audio/flac', label: 'Audio' },
};

const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx']);

function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() || '' : '';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  const text = (result.value || '').trim();
  if (!text) {
    return '[DOCX document contained no extractable text.]';
  }
  return text;
}

async function extractPptxText(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
      return numA - numB;
    });

  if (slideFiles.length === 0) {
    return '[PPTX presentation contained no slides.]';
  }

  const slidesOutput: string[] = [];
  const parser = new DOMParser();

  for (let i = 0; i < slideFiles.length; i++) {
    const filePath = slideFiles[i];
    const xmlStr = await zip.files[filePath].async('string');
    const xmlDoc = parser.parseFromString(xmlStr, 'application/xml');
    const textNodes = Array.from(xmlDoc.getElementsByTagName('a:t'));
    const texts = textNodes.map((node) => node.textContent || '').filter(Boolean);
    slidesOutput.push(`--- Slide ${i + 1} ---\n${texts.join(' ')}`);
  }

  return slidesOutput.join('\n\n').trim() || '[PPTX presentation contained no extractable text.]';
}

function extractXlsxText(buffer: ArrayBuffer): string {
  const workbook = XLSX.read(buffer, { type: 'array' });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return '[XLSX workbook contained no sheets.]';
  }

  const sheetOutputs: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    sheetOutputs.push(`--- Sheet: ${sheetName} ---\n${csv.trim()}`);
  }

  return sheetOutputs.join('\n\n').trim() || '[XLSX workbook contained no extractable data.]';
}

export function classifyFileSupport(file: File): {
  supported: boolean;
  reason?: string;
  mode?: 'office' | 'native';
  officeType?: 'docx' | 'pptx' | 'xlsx';
  mimeType?: string;
  categoryLabel?: string;
} {
  const ext = getFileExtension(file.name);
  const rawMime = (file.type || '').toLowerCase();

  if (OFFICE_EXTENSIONS.has(ext)) {
    const officeType = ext as 'docx' | 'pptx' | 'xlsx';
    return {
      supported: true,
      mode: 'office',
      officeType,
      mimeType:
        rawMime ||
        (ext === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : ext === 'pptx'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      categoryLabel: ext.toUpperCase(),
    };
  }

  if (NATIVE_EXTENSIONS[ext]) {
    return {
      supported: true,
      mode: 'native',
      mimeType: rawMime || NATIVE_EXTENSIONS[ext].mime,
      categoryLabel: NATIVE_EXTENSIONS[ext].label,
    };
  }

  if (CODE_EXTENSIONS[ext]) {
    return {
      supported: true,
      mode: 'native',
      mimeType: CODE_EXTENSIONS[ext],
      categoryLabel: `Code (.${ext})`,
    };
  }

  if (rawMime.startsWith('image/')) {
    return {
      supported: true,
      mode: 'native',
      mimeType: rawMime,
      categoryLabel: 'Image',
    };
  }

  if (rawMime.startsWith('video/')) {
    return {
      supported: true,
      mode: 'native',
      mimeType: rawMime,
      categoryLabel: 'Video',
    };
  }

  if (rawMime.startsWith('audio/')) {
    return {
      supported: true,
      mode: 'native',
      mimeType: rawMime,
      categoryLabel: 'Audio',
    };
  }

  if (rawMime === 'application/pdf') {
    return {
      supported: true,
      mode: 'native',
      mimeType: 'application/pdf',
      categoryLabel: 'PDF',
    };
  }

  if (rawMime.startsWith('text/')) {
    return {
      supported: true,
      mode: 'native',
      mimeType: rawMime,
      categoryLabel: 'Text',
    };
  }

  const namedType = ext ? `.${ext} (${rawMime || 'unknown MIME type'})` : rawMime || 'unknown file type';
  return {
    supported: false,
    reason: `Unsupported file type: ${namedType}. Supported formats include Images, PDF, Video, Audio, DOCX, PPTX, XLSX, TXT, JSON, CSV, HTML, and source code files.`,
  };
}

export async function processAttachedFile(file: File): Promise<FileAttachment> {
  const info = classifyFileSupport(file);
  if (!info.supported) {
    throw new Error(info.reason || `Unsupported file type: ${file.name}`);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mimeType = info.mimeType || file.type || 'application/octet-stream';
  const categoryLabel = info.categoryLabel || 'File';

  // 1. Browser text extraction for DOCX, PPTX, XLSX
  if (info.mode === 'office' && info.officeType) {
    const buffer = await file.arrayBuffer();
    let extractedText = '';
    if (info.officeType === 'docx') {
      extractedText = await extractDocxText(buffer);
    } else if (info.officeType === 'pptx') {
      extractedText = await extractPptxText(buffer);
    } else if (info.officeType === 'xlsx') {
      extractedText = extractXlsxText(buffer);
    }

    return {
      id,
      name: file.name,
      size: file.size,
      mimeType,
      categoryLabel,
      kind: 'extractedText',
      extractedText,
    };
  }

  // 2. Native Gemini files: check if small (inlineData) or large (Gemini File API)
  const isTextOrCode =
    categoryLabel.startsWith('Code') ||
    categoryLabel === 'TXT' ||
    categoryLabel === 'JSON' ||
    categoryLabel === 'CSV' ||
    categoryLabel === 'HTML' ||
    mimeType.startsWith('text/') ||
    mimeType === 'application/json';

  if (file.size <= INLINE_SIZE_LIMIT_BYTES) {
    const buffer = await file.arrayBuffer();
    const base64Data = arrayBufferToBase64(buffer);
    let extractedText: string | undefined;

    if (isTextOrCode) {
      try {
        extractedText = new TextDecoder('utf-8').decode(buffer);
      } catch {
        // fallback to base64 inlineData
      }
    }

    const previewUrl = mimeType.startsWith('image/')
      ? `data:${mimeType};base64,${base64Data}`
      : undefined;

    return {
      id,
      name: file.name,
      size: file.size,
      mimeType,
      categoryLabel,
      kind: 'inline',
      base64Data,
      extractedText,
      previewUrl,
    };
  }

  // 3. Large file (> 8MB): Upload to Gemini File API via /api/files/upload
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mimeType', mimeType);
  formData.append('displayName', file.name);

  const response = await fetch('/api/files/upload', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `Failed to upload large file "${file.name}" to Gemini File API.`);
  }

  return {
    id,
    name: file.name,
    size: file.size,
    mimeType: data.mimeType || mimeType,
    categoryLabel: `${categoryLabel} (File API)`,
    kind: 'fileApi',
    fileUri: data.uri,
  };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
