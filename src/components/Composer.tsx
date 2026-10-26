import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  Music,
  Paperclip,
  Search,
  Square,
  X,
} from 'lucide-react';
import {
  ComposerMode,
  FileAttachment,
  GenerationOptions,
  INDIAN_OFFICIAL_LANGUAGES,
  OfficialIndianLanguage,
} from '../types';
import { formatFileSize } from '../utils/fileProcessor';

interface ComposerProps {
  input: string;
  onChangeInput: (val: string) => void;
  mode: ComposerMode;
  onChangeMode: (mode: ComposerMode) => void;
  options: GenerationOptions;
  onChangeOptions: React.Dispatch<React.SetStateAction<GenerationOptions>>;
  attachments: FileAttachment[];
  isProcessingFiles: boolean;
  isGenerating: boolean;
  onAttachFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onVoiceError: (title: string, message: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export const Composer: React.FC<ComposerProps> = ({
  input,
  onChangeInput,
  mode,
  onChangeMode,
  options,
  onChangeOptions,
  attachments,
  isProcessingFiles,
  isGenerating,
  onAttachFiles,
  onRemoveAttachment,
  onSubmit,
  onStop,
  onVoiceError,
  fileInputRef,
  textareaRef: externalTextareaRef,
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = externalTextareaRef || internalTextareaRef;
  const selectedLanguageOption =
    INDIAN_OFFICIAL_LANGUAGES.find((l) => l.name === options.language) ||
    INDIAN_OFFICIAL_LANGUAGES[0];
  const voiceLang = selectedLanguageOption.code;
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [micDeniedMessage, setMicDeniedMessage] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const baseInputBeforeSpeechRef = useRef<string>('');
  const inputRef = useRef<string>(input);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Auto-resize textarea height cleanly for both mobile and laptop viewports
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = typeof window !== 'undefined' && window.innerWidth < 640 ? 130 : 180;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  // Timer during recording
  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setRecordingSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  const stopRecording = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }

    setIsRecording(false);
    setInterimTranscript('');
  };

  const startFallbackAudioRecorder = async (langCode: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicDeniedMessage(null);
      audioChunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size === 0) return;

        setIsTranscribingAudio(true);
        try {
          const buffer = await blob.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          const audioBase64 = btoa(binary);

          const resp = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64,
              mimeType: blob.type || 'audio/webm',
              language:
                selectedLanguageOption.name === 'Auto'
                  ? 'auto'
                  : `${selectedLanguageOption.name} (${langCode})`,
            }),
          });
          const data = await resp.json();
          if (!resp.ok || data.error) {
            throw new Error(data.error || 'Audio transcription failed.');
          }
          if (data.transcript) {
            const prefix = inputRef.current.trim() ? `${inputRef.current.trim()} ` : '';
            onChangeInput(`${prefix}${data.transcript}`);
          }
        } catch (err) {
          onVoiceError(
            'Voice transcription failed',
            err instanceof Error ? err.message : 'Could not transcribe recorded audio.'
          );
        } finally {
          setIsTranscribingAudio(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      setInterimTranscript('Recording audio for Gemini transcription…');
    } catch (err: any) {
      const name = err?.name || '';
      if (
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        String(err?.message || '').toLowerCase().includes('permission')
      ) {
        setMicDeniedMessage(
          'Microphone permission was denied. Please allow microphone access in your browser address bar settings and try again.'
        );
      } else {
        onVoiceError(
          'Microphone unavailable',
          err instanceof Error ? err.message : 'Unable to access microphone.'
        );
      }
      setIsRecording(false);
    }
  };

  const toggleVoiceInput = async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    setMicDeniedMessage(null);
    const resolvedLang =
      voiceLang === 'auto'
        ? typeof navigator !== 'undefined' && navigator.language
          ? navigator.language
          : 'en-US'
        : voiceLang;

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      await startFallbackAudioRecorder(resolvedLang);
      return;
    }

    try {
      const recognition = new SpeechRecognitionCtor();
      recognitionRef.current = recognition;
      recognition.lang = resolvedLang;
      recognition.continuous = true;
      recognition.interimResults = true;

      baseInputBeforeSpeechRef.current = inputRef.current.trim()
        ? `${inputRef.current.trim()} `
        : '';

      let accumulatedFinal = '';

      recognition.onstart = () => {
        setIsRecording(true);
        setInterimTranscript('');
      };

      recognition.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptPiece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            accumulatedFinal += `${transcriptPiece.trim()} `;
            onChangeInput(`${baseInputBeforeSpeechRef.current}${accumulatedFinal.trim()}`);
          } else {
            interim += transcriptPiece;
          }
        }
        setInterimTranscript(interim);
      };

      recognition.onerror = async (event: any) => {
        const errCode = event?.error || '';
        if (errCode === 'not-allowed' || errCode === 'permission-denied') {
          setMicDeniedMessage(
            'Microphone permission was denied. Please click the site permissions icon in your browser address bar to allow microphone access.'
          );
          setIsRecording(false);
          setInterimTranscript('');
        } else if (errCode === 'service-not-allowed' || errCode === 'network') {
          recognitionRef.current = null;
          setIsRecording(false);
          await startFallbackAudioRecorder(resolvedLang);
        } else if (errCode !== 'aborted' && errCode !== 'no-speech') {
          onVoiceError('Voice recognition error', `Speech recognition reported: ${errCode}`);
          setIsRecording(false);
          setInterimTranscript('');
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
        setInterimTranscript('');
      };

      recognition.start();
    } catch {
      await startFallbackAudioRecorder(resolvedLang);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length > 0) {
      e.preventDefault();
      onAttachFiles(pastedFiles);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && isRecording) {
      e.preventDefault();
      e.stopPropagation();
      stopRecording();
      return;
    }

    // Ctrl+Enter (or Cmd+Enter) always sends the message across all devices
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (!isGenerating && !isProcessingFiles && (input.trim() || attachments.length > 0)) {
        if (isRecording) stopRecording();
        onSubmit();
      }
      return;
    }

    // On mobile touch keyboards, plain Enter adds a newline; on laptop/desktop, plain Enter sends
    const isMobileViewport = typeof window !== 'undefined' && window.innerWidth < 640;
    if (e.key === 'Enter' && !e.shiftKey && !isMobileViewport) {
      e.preventDefault();
      if (!isGenerating && !isProcessingFiles && (input.trim() || attachments.length > 0)) {
        if (isRecording) stopRecording();
        onSubmit();
      }
    }
  };

  const hasAttachedImage = attachments.some((a) => a.mimeType.startsWith('image/'));

  const placeholders: Record<ComposerMode, string> = {
    chat: 'Ask Mantrana AI',
    image: 'Ask Mantrana AI',
    video: 'Ask Mantrana AI',
    music: 'Ask Mantrana AI',
  };

  const modeButtons: Array<{
    id: ComposerMode;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { id: 'image', label: 'Image', icon: <ImageIcon className="w-3.5 h-3.5" /> },
    { id: 'video', label: 'Video', icon: <Film className="w-3.5 h-3.5" /> },
    { id: 'music', label: 'Music', icon: <Music className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-2.5 sm:px-6 pb-2 sm:pb-3 pt-1.5 sm:pt-2 pb-safe">
      {/* Microphone permission denied banner */}
      {micDeniedMessage && (
        <div className="mb-2 flex items-start justify-between gap-3 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800/80 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <span>{micDeniedMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setMicDeniedMessage(null)}
            className="text-amber-600 dark:text-amber-400 hover:opacity-80 cursor-pointer shrink-0 p-1"
            aria-label="Dismiss microphone notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Live recording / interim transcript banner */}
      {(isRecording || isTranscribingAudio) && (
        <div className="mb-2 flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl bg-teal-50 dark:bg-teal-950/50 border border-teal-200 dark:border-teal-800/80 text-xs text-teal-900 dark:text-teal-200">
          <div className="flex items-center gap-2 min-w-0">
            {isTranscribingAudio ? (
              <Loader2 className="w-4 h-4 text-teal-600 dark:text-teal-400 animate-spin shrink-0" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping shrink-0" />
            )}
            <span className="font-medium truncate">
              {isTranscribingAudio
                ? `Transcribing audio (${selectedLanguageOption.label})…`
                : `Listening (${selectedLanguageOption.label})`}
            </span>
            {interimTranscript && (
              <span dir="auto" className="text-teal-700 dark:text-teal-300 italic truncate hidden sm:inline">
                “{interimTranscript}”
              </span>
            )}
          </div>
          {isRecording && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-teal-700 dark:text-teal-300">
                0:{recordingSeconds.toString().padStart(2, '0')}
              </span>
              <button
                type="button"
                onClick={stopRecording}
                className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-[11px] font-medium hover:bg-rose-700 cursor-pointer whitespace-nowrap"
              >
                Stop
              </button>
            </div>
          )}
        </div>
      )}

      {/* Composer Box */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs focus-within:border-teal-600 dark:focus-within:border-teal-500 transition-colors">
        {/* Attached File Chips */}
        {(attachments.length > 0 || isProcessingFiles) && (
          <div className="flex flex-wrap items-center gap-2 px-3 sm:px-3.5 pt-2.5 pb-1.5 border-b border-slate-100 dark:border-slate-800/70">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-200 max-w-[220px] sm:max-w-[260px]"
              >
                {att.previewUrl ? (
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    referrerPolicy="no-referrer"
                    className="w-5 h-5 rounded object-cover shrink-0"
                  />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate leading-tight">{att.name}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
                    {att.categoryLabel} · {formatFileSize(att.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(att.id)}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 cursor-pointer shrink-0"
                  title={`Remove ${att.name}`}
                  aria-label={`Remove ${att.name}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}

            {isProcessingFiles && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-600 dark:text-teal-400" />
                <span>Processing attachment…</span>
              </div>
            )}
          </div>
        )}

        {/* Textarea Input (16px on mobile to prevent iOS zoom, 15px on laptop) */}
        <div className="px-3 sm:px-3.5 pt-2.5 sm:pt-3 pb-1.5 sm:pb-2">
          <textarea
            ref={textareaRef}
            dir="auto"
            rows={1}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholders[mode]}
            className="w-full resize-none bg-transparent text-base sm:text-[15px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none leading-relaxed max-h-[130px] sm:max-h-[180px]"
          />
        </div>

        {/* Contextual Mode Options Bar */}
        <div className="flex items-center gap-1.5 px-3 sm:px-3.5 pb-1.5 text-[11px] text-slate-500 dark:text-slate-400 overflow-x-auto no-scrollbar">
          {mode === 'chat' && (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="font-medium text-slate-600 dark:text-slate-300">Grounding:</span>
              <button
                type="button"
                onClick={() =>
                  onChangeOptions((prev) => ({ ...prev, chatGrounding: 'auto' }))
                }
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                  options.chatGrounding === 'auto'
                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                    : 'bg-slate-100 dark:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
                title="Automatically use Google Search or Google Maps Grounding based on your question"
              >
                <span>Auto</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeOptions((prev) => ({ ...prev, chatGrounding: 'search' }))
                }
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                  options.chatGrounding === 'search'
                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                    : 'bg-slate-100 dark:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
                title="Use Google Search Grounding"
              >
                <Search className="w-3 h-3" />
                <span>Search</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeOptions((prev) => ({ ...prev, chatGrounding: 'maps' }))
                }
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                  options.chatGrounding === 'maps'
                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                    : 'bg-slate-100 dark:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
                title="Use Google Maps Grounding"
              >
                <MapPin className="w-3 h-3" />
                <span>Maps</span>
              </button>
            </div>
          )}

          {mode === 'image' && (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {hasAttachedImage ? 'Edit Image:' : 'Image:'}
              </span>
              <select
                value={options.imageAspectRatio}
                onChange={(e) =>
                  onChangeOptions((prev) => ({
                    ...prev,
                    imageAspectRatio: e.target.value as GenerationOptions['imageAspectRatio'],
                  }))
                }
                aria-label="Image aspect ratio"
                className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-none cursor-pointer"
              >
                <option value="1:1">1:1 Square</option>
                <option value="16:9">16:9 Landscape</option>
                <option value="9:16">9:16 Portrait</option>
                <option value="4:3">4:3 Standard</option>
                <option value="3:4">3:4 Vertical</option>
              </select>
              <select
                value={options.imageSize}
                onChange={(e) =>
                  onChangeOptions((prev) => ({
                    ...prev,
                    imageSize: e.target.value as GenerationOptions['imageSize'],
                  }))
                }
                aria-label="Image resolution"
                className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-none cursor-pointer"
              >
                <option value="1K">1K</option>
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
            </div>
          )}

          {mode === 'video' && (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="font-medium text-slate-600 dark:text-slate-300">
                Video:
              </span>
              <select
                value={options.videoAspectRatio}
                onChange={(e) =>
                  onChangeOptions((prev) => ({
                    ...prev,
                    videoAspectRatio: e.target.value as GenerationOptions['videoAspectRatio'],
                  }))
                }
                aria-label="Video aspect ratio"
                className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-none cursor-pointer"
              >
                <option value="16:9">16:9 Landscape</option>
                <option value="9:16">9:16 Portrait</option>
              </select>
              <select
                value={options.videoDuration}
                onChange={(e) =>
                  onChangeOptions((prev) => ({
                    ...prev,
                    videoDuration: e.target.value as GenerationOptions['videoDuration'],
                  }))
                }
                aria-label="Video duration"
                className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-none cursor-pointer"
              >
                <option value="5s">5s</option>
                <option value="10s">10s</option>
              </select>
            </div>
          )}

          {mode === 'music' && (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="font-medium text-slate-600 dark:text-slate-300">
                Music:
              </span>
              <button
                type="button"
                onClick={() =>
                  onChangeOptions((prev) => ({ ...prev, musicTrackType: 'clip' }))
                }
                className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                  options.musicTrackType === 'clip'
                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                    : 'bg-slate-100 dark:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Short Clip (30s)
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeOptions((prev) => ({ ...prev, musicTrackType: 'pro' }))
                }
                className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                  options.musicTrackType === 'pro'
                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                    : 'bg-slate-100 dark:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Full Track
              </button>
            </div>
          )}
        </div>

        {/* Bottom Controls Bar — Adapts cleanly to mobile and laptop screens */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 sm:px-3 pb-2.5 pt-1 overflow-x-auto no-scrollbar">
          {/* Left: Attach button + Mode selector buttons */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onAttachFiles(e.target.files);
                  e.target.value = '';
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingFiles}
              className="inline-flex items-center justify-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              title="Attach files (Images, PDF, Video, Audio, DOCX, PPTX, XLSX, TXT, JSON, CSV, Code)"
            >
              <Paperclip className="w-4 h-4" />
              <span className="hidden md:inline">Attach</span>
            </button>

            <div
              role="group"
              aria-label="Generation mode"
              className="flex items-center gap-0.5 p-0.5 rounded-xl bg-slate-100 dark:bg-slate-800/90"
            >
              {modeButtons.map((btn) => {
                const active = mode === btn.id;
                return (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => onChangeMode(btn.id)}
                    className={`inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-400 shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {btn.icon}
                    <span className="text-[11px] sm:text-xs">{btn.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: Official Indian Language selector + Mic button + Send / Stop button */}
          <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
            <div className="relative flex items-center">
              <Globe className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 absolute left-2 pointer-events-none" />
              <select
                value={selectedLanguageOption.name}
                onChange={(e) =>
                  onChangeOptions((prev) => ({
                    ...prev,
                    language: e.target.value as OfficialIndianLanguage,
                  }))
                }
                aria-label="Select AI response language (Official Languages of India)"
                title={`AI Response & Voice Language: ${selectedLanguageOption.label}`}
                className="pl-6 pr-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] sm:text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700/80 hover:border-teal-500/60 focus:border-teal-500 focus:outline-none cursor-pointer max-w-[115px] sm:max-w-[165px] truncate transition-colors"
              >
                {INDIAN_OFFICIAL_LANGUAGES.map((lang) => (
                  <option key={lang.name} value={lang.name}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={toggleVoiceInput}
              disabled={isTranscribingAudio}
              className={`w-9 h-9 inline-flex items-center justify-center rounded-xl text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                isRecording
                  ? 'bg-rose-600 text-white hover:bg-rose-700'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
              title={isRecording ? 'Stop voice recording' : 'Start voice input'}
              aria-label={isRecording ? 'Stop voice recording' : 'Start voice input'}
            >
              {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            {isGenerating && onStop ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 transition-opacity cursor-pointer shrink-0"
                title="Stop generating (Esc)"
                aria-label="Stop generating"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (isRecording) stopRecording();
                  onSubmit();
                }}
                disabled={
                  isGenerating ||
                  isProcessingFiles ||
                  (!input.trim() && attachments.length === 0)
                }
                className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 text-white disabled:text-slate-400 dark:disabled:text-slate-600 transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
                title="Send message (Ctrl+Enter)"
                aria-label="Send message"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
