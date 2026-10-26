import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileText,
  Globe,
  Image as ImageIcon,
  Keyboard,
  Link2,
  Loader2,
  LogIn,
  LogOut,
  MapPin,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  Smartphone,
  Sun,
  UploadCloud,
  User,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  ChatMessage,
  ChatSession,
  ComposerMode,
  FileAttachment,
  GeneratedMedia,
  GenerationOptions,
  GroundingSource,
  INDIAN_OFFICIAL_LANGUAGES,
  OfficialIndianLanguage,
  ToastNotice,
  UserAccount,
} from './types';
import {
  deleteSessionById,
  getAllSessions,
  getSavedUserAccount,
  saveSession,
  setSavedUserAccount,
} from './utils/db';
import { auth, firebaseSignOut } from './firebase';
import { formatFileSize, processAttachedFile } from './utils/fileProcessor';
import {
  buildAutoTitle,
  detectGenerationIntent,
  extractUrlsFromText,
} from './utils/intentDetector';
import { Sidebar } from './components/Sidebar';
import { Composer } from './components/Composer';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { GeneratedMediaCard } from './components/GeneratedMediaCard';
import { AuthModal } from './components/AuthModal';

function createFreshSession(userEmail?: string): ChatSession {
  const now = Date.now();
  return {
    id: `chat-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
    userEmail: (userEmail || 'guest').trim().toLowerCase(),
  };
}

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\w-]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^\s*[-+:]{3,}\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSpeechLang(text: string, preferredLanguage?: OfficialIndianLanguage): string {
  const preferredOption = preferredLanguage
    ? INDIAN_OFFICIAL_LANGUAGES.find((l) => l.name === preferredLanguage)
    : undefined;

  if (/[\u0980-\u09FF]/.test(text)) {
    if (
      preferredOption &&
      (preferredOption.name === 'Assamese' ||
        preferredOption.name === 'Bengali' ||
        preferredOption.name === 'Manipuri')
    ) {
      return preferredOption.code;
    }
    return 'bn-IN';
  }
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu-IN'; // Gujarati
  if (/[\u0A00-\u0A7F]/.test(text)) return 'pa-IN'; // Gurmukhi (Punjabi)
  if (/[\u0B00-\u0B7F]/.test(text)) return 'or-IN'; // Odia
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta-IN'; // Tamil
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te-IN'; // Telugu
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn-IN'; // Kannada
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml-IN'; // Malayalam
  if (/[\u1C50-\u1C7F]/.test(text)) return 'sat-IN'; // Ol Chiki (Santali)
  if (/[\uABC0-\uABFF]/.test(text)) return 'mni-IN'; // Meetei Mayek (Manipuri)
  if (/[\u0600-\u06FF]/.test(text)) {
    if (
      preferredOption &&
      (preferredOption.name === 'Urdu' ||
        preferredOption.name === 'Kashmiri' ||
        preferredOption.name === 'Sindhi')
    ) {
      return preferredOption.code;
    }
    return 'ur-IN';
  }
  if (/[\u0900-\u097F]/.test(text)) {
    if (
      preferredOption &&
      (preferredOption.name === 'Hindi' ||
        preferredOption.name === 'Marathi' ||
        preferredOption.name === 'Sanskrit' ||
        preferredOption.name === 'Nepali' ||
        preferredOption.name === 'Konkani' ||
        preferredOption.name === 'Maithili' ||
        preferredOption.name === 'Dogri' ||
        preferredOption.name === 'Bodo' ||
        preferredOption.name === 'Kashmiri' ||
        preferredOption.name === 'Sindhi')
    ) {
      return preferredOption.code;
    }
    return 'hi-IN';
  }
  if (preferredOption && preferredOption.code !== 'auto') {
    return preferredOption.code;
  }
  return 'en-IN';
}

export default function App() {
  // Theme state (default to system preference, persist in localStorage)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('mantrana-theme');
      if (saved === 'light' || saved === 'dark') return saved;
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      ) {
        return 'dark';
      }
    } catch {
      // ignore
    }
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('mantrana-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // User Account & Auth Modal state
  const [userAccount, setUserAccount] = useState<UserAccount | null>(() =>
    getSavedUserAccount()
  );
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Sessions & active chat state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [isDbLoaded, setIsDbLoaded] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isDesktopSidebarOpen, setIsDesktopSidebarOpen] = useState(true);

  // Automatic Mobile & Laptop Screen Detection + Optional Manual Screen Mode Override
  const [screenViewMode, setScreenViewMode] = useState<'auto' | 'laptop' | 'mobile'>(() => {
    try {
      const saved = localStorage.getItem('mantrana-screen-mode');
      if (saved === 'auto' || saved === 'laptop' || saved === 'mobile') return saved;
    } catch {
      // ignore
    }
    return 'auto';
  });

  const [detectedDevice, setDetectedDevice] = useState<'mobile' | 'tablet' | 'laptop'>(() => {
    if (typeof window === 'undefined') return 'laptop';
    if (window.innerWidth < 640) return 'mobile';
    if (window.innerWidth < 1024) return 'tablet';
    return 'laptop';
  });

  useEffect(() => {
    const updateScreenMetrics = () => {
      const w = window.innerWidth;
      if (w < 640) {
        setDetectedDevice('mobile');
      } else if (w < 1024) {
        setDetectedDevice('tablet');
      } else {
        setDetectedDevice('laptop');
      }
    };
    updateScreenMetrics();
    window.addEventListener('resize', updateScreenMetrics);
    window.addEventListener('orientationchange', updateScreenMetrics);
    return () => {
      window.removeEventListener('resize', updateScreenMetrics);
      window.removeEventListener('orientationchange', updateScreenMetrics);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mantrana-screen-mode', screenViewMode);
    } catch {
      // ignore
    }
  }, [screenViewMode]);

  const isEffectiveMobileView =
    screenViewMode === 'mobile' ||
    (screenViewMode === 'auto' && detectedDevice !== 'laptop');

  // Composer state
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ComposerMode>('chat');
  const [generationOptions, setGenerationOptions] = useState<GenerationOptions>({
    language: 'Auto',
    chatGrounding: 'auto',
    imageAspectRatio: '1:1',
    imageSize: '1K',
    videoAspectRatio: '16:9',
    videoDuration: '5s',
    musicTrackType: 'clip',
  });
  const [userLocation, setUserLocation] = useState<
    { latitude: number; longitude: number } | undefined
  >(undefined);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Request user location when Google Maps grounding is selected so nearby place queries have accurate coordinates
  useEffect(() => {
    if (
      generationOptions.chatGrounding === 'maps' &&
      !userLocation &&
      typeof navigator !== 'undefined' &&
      'geolocation' in navigator
    ) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLocation({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          });
        },
        () => {
          // ignore if user declines geolocation
        },
        { timeout: 6000 }
      );
    }
  }, [generationOptions.chatGrounding, userLocation]);

  // Toast notifications, copied message state, text-to-speech & export menu state
  const [toasts, setToasts] = useState<ToastNotice[]>([]);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [transparentLogoSrc, setTransparentLogoSrc] = useState<string>(
    '/assets/aistudio/logo_0f7c0f63.png'
  );

  // Strip the solid white background from the logo image so its background matches the chatbot canvas seamlessly in both Light and Dark themes
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const textThresholdY = Math.floor(canvas.height * 0.72);

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          const minChannel = Math.min(r, g, b);
          const maxChannel = Math.max(r, g, b);
          const saturation = maxChannel - minChannel;

          // Smoothly make white / near-white background pixels transparent
          if (minChannel > 215 && saturation < 30) {
            const alphaFactor = Math.max(0, Math.min(1, (248 - minChannel) / 33));
            data[i + 3] = Math.round(data[i + 3] * alphaFactor);
          } else if (theme === 'dark') {
            // In dark mode, brighten the dark navy wordmark at the bottom so it reads cleanly on dark background
            const pixelIndex = i / 4;
            const y = Math.floor(pixelIndex / canvas.width);
            if (y >= textThresholdY && maxChannel < 110) {
              data[i] = 241;
              data[i + 1] = 245;
              data[i + 2] = 249;
            }
          }
        }

        ctx.putImageData(imageData, 0, 0);
        setTransparentLogoSrc(canvas.toDataURL('image/png'));
      } catch {
        setTransparentLogoSrc('/assets/aistudio/logo_0f7c0f63.png');
      }
    };
    img.src = '/assets/aistudio/logo_0f7c0f63.png';
  }, [theme]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const lastScrollTopRef = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const addToast = useCallback(
    (
      title: string,
      message: string,
      type: 'error' | 'warning' | 'info' = 'error',
      onRetry?: () => void
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { id, title, message, type, onRetry }]);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Load sessions for the current user account (or guest) on mount and when userAccount changes
  useEffect(() => {
    let mounted = true;
    const activeEmail = userAccount?.email || 'guest';
    getAllSessions(activeEmail).then((loaded) => {
      if (!mounted) return;
      if (loaded.length > 0) {
        setSessions(loaded);
        setActiveSessionId(loaded[0].id);
      } else {
        const initial = createFreshSession(activeEmail);
        setSessions([initial]);
        setActiveSessionId(initial.id);
        saveSession(initial, activeEmail);
      }
      setIsDbLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, [userAccount?.email]);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0] || null;

  const activeMessages = activeSession?.messages ?? [];
  const lastMessage =
    activeMessages.length > 0 ? activeMessages[activeMessages.length - 1] : null;
  const isStreamingResponse = Boolean(isGenerating || lastMessage?.isStreaming);

  // Smoothly scroll the message viewport to the latest content
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth', force = false) => {
      if (force) {
        shouldAutoScrollRef.current = true;
        setShowScrollToBottom(false);
      }
      if (!force && !shouldAutoScrollRef.current) return;

      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }

      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const container = scrollContainerRef.current;
        if (!container) {
          messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
          return;
        }

        const targetTop = container.scrollHeight - container.clientHeight;
        if (targetTop <= 0) return;

        isProgrammaticScrollRef.current = true;
        if (programmaticScrollTimeoutRef.current !== null) {
          window.clearTimeout(programmaticScrollTimeoutRef.current);
        }

        container.scrollTo({
          top: container.scrollHeight,
          behavior,
        });

        programmaticScrollTimeoutRef.current = window.setTimeout(() => {
          isProgrammaticScrollRef.current = false;
          if (scrollContainerRef.current) {
            lastScrollTopRef.current = scrollContainerRef.current.scrollTop;
          }
        }, behavior === 'smooth' ? 320 : 60);
      });
    },
    []
  );

  // Clean up pending scroll animation frames and timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      if (programmaticScrollTimeoutRef.current !== null) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
    };
  }, []);

  // Track user scroll position so manual upward scrolling pauses auto-scroll until the user returns near the bottom
  const handleViewportScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const scrolledUpDelta = lastScrollTopRef.current - scrollTop;
    lastScrollTopRef.current = scrollTop;

    // If user manually scrolls upward away from the bottom, pause auto-scroll
    if (!isProgrammaticScrollRef.current && scrolledUpDelta > 6 && distanceFromBottom > 90) {
      shouldAutoScrollRef.current = false;
      setShowScrollToBottom(true);
      return;
    }

    // Re-engage auto-scroll when the viewport is near the bottom
    if (distanceFromBottom <= 65) {
      shouldAutoScrollRef.current = true;
      setShowScrollToBottom(false);
    } else if (!shouldAutoScrollRef.current) {
      setShowScrollToBottom(true);
    }
  }, []);

  // Reset auto-scroll lock and scroll to bottom when switching conversations
  useEffect(() => {
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    scrollToBottom('smooth', true);
  }, [activeSession?.id, scrollToBottom]);

  // Smoothly auto-scroll as new messages arrive or as long AI responses stream in token-by-token
  useEffect(() => {
    if (!activeSession || activeSession.messages.length === 0) {
      setShowScrollToBottom(false);
      return;
    }
    if (shouldAutoScrollRef.current) {
      scrollToBottom('smooth');
    }
  }, [
    activeSession?.messages.length,
    lastMessage?.id,
    lastMessage?.text,
    lastMessage?.isStreaming,
    lastMessage?.sources?.length,
    lastMessage?.generatedMedia,
    lastMessage?.videoProgress?.stepCount,
    lastMessage?.error,
    isGenerating,
    scrollToBottom,
  ]);

  // Observe dynamic height changes in the conversation thread (Markdown blocks, code blocks, media loading) during streaming
  useEffect(() => {
    const contentEl = messagesContentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') return;

    let previousHeight = contentEl.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextHeight = entry.contentRect.height;
        if (nextHeight > previousHeight + 2 && shouldAutoScrollRef.current) {
          scrollToBottom('smooth');
        }
        previousHeight = nextHeight;
      }
    });

    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [activeSession?.id, activeSession?.messages.length, scrollToBottom]);

  const updateSessionState = useCallback(
    (sessionId: string, updater: (prev: ChatSession) => ChatSession) => {
      const activeEmail = userAccount?.email || 'guest';
      setSessions((prevSessions) => {
        const idx = prevSessions.findIndex((s) => s.id === sessionId);
        if (idx === -1) return prevSessions;
        const updated = {
          ...updater(prevSessions[idx]),
          userEmail: activeEmail,
        };
        saveSession(updated, activeEmail);
        const next = [...prevSessions];
        next[idx] = updated;
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        return next;
      });
    },
    [userAccount?.email]
  );

  const handleNewChat = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
    const activeEmail = userAccount?.email || 'guest';
    const fresh = createFreshSession(activeEmail);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setInput('');
    setAttachments([]);
    setMode('chat');
    saveSession(fresh, activeEmail);
    setTimeout(() => {
      composerTextareaRef.current?.focus();
    }, 20);
  }, [userAccount?.email]);

  const handleRenameSession = useCallback(
    (id: string, newTitle: string) => {
      updateSessionState(id, (s) => ({
        ...s,
        title: newTitle,
        updatedAt: Date.now(),
      }));
    },
    [updateSessionState]
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const activeEmail = userAccount?.email || 'guest';
      await deleteSessionById(id, activeEmail);
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        if (remaining.length === 0) {
          const fresh = createFreshSession(activeEmail);
          saveSession(fresh, activeEmail);
          setActiveSessionId(fresh.id);
          return [fresh];
        }
        if (id === activeSessionId) {
          setActiveSessionId(remaining[0].id);
        }
        return remaining;
      });
    },
    [activeSessionId, userAccount?.email]
  );

  const handleAuthSuccess = useCallback(
    async (account: UserAccount, serverSessions: ChatSession[]) => {
      const normalizedEmail = account.email.trim().toLowerCase();

      // If the user had any non-empty guest chats open before signing in, save them into their email account
      const currentNonEmptyGuestChats = sessions.filter(
        (s) =>
          (!s.userEmail || s.userEmail === 'guest') &&
          s.messages &&
          s.messages.length > 0
      );
      for (const guestChat of currentNonEmptyGuestChats) {
        await saveSession(
          { ...guestChat, userEmail: normalizedEmail },
          normalizedEmail
        );
      }

      // Also persist any sessions returned directly by the auth response
      for (const srvSession of serverSessions) {
        if (srvSession && srvSession.id) {
          await saveSession(
            { ...srvSession, userEmail: normalizedEmail },
            normalizedEmail
          );
        }
      }

      setSavedUserAccount(account);
      setUserAccount(account);

      const merged = await getAllSessions(normalizedEmail);
      if (merged.length > 0) {
        setSessions(merged);
        setActiveSessionId(merged[0].id);
      } else {
        const fresh = createFreshSession(normalizedEmail);
        await saveSession(fresh, normalizedEmail);
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      }
    },
    [sessions]
  );

  const handleSignOut = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
    try {
      await firebaseSignOut(auth);
    } catch {
      // ignore
    }
    setSavedUserAccount(null);
    setUserAccount(null);
  }, []);

  // File Attachment handling (Button, Drag-and-Drop, Paste)
  const handleAttachFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      setIsProcessingFiles(true);
      try {
        for (const file of files) {
          try {
            const processed = await processAttachedFile(file);
            setAttachments((prev) => [...prev, processed]);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : `Could not attach "${file.name}".`;
            addToast('Unsupported or invalid file', msg, 'error');
          }
        }
      } finally {
        setIsProcessingFiles(false);
      }
    },
    [addToast]
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Drag & Drop handlers on the workspace
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAttachFiles(e.dataTransfer.files);
    }
  };

  // Execute Chat Stream or Media Generation for a given session & message history
  const executeTurn = useCallback(
    async (
      sessionId: string,
      historyMessages: ChatMessage[],
      userMsg: ChatMessage,
      effectiveMode: ComposerMode
    ) => {
      const modelMsgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const initialModelMsg: ChatMessage = {
        id: modelMsgId,
        role: 'model',
        text: '',
        createdAt: Date.now(),
        mode: effectiveMode,
        isStreaming: effectiveMode === 'chat',
        videoProgress:
          effectiveMode === 'video'
            ? {
                status: 'starting',
                elapsedSeconds: 0,
                stepCount: 0,
              }
            : undefined,
      };

      shouldAutoScrollRef.current = true;
      setShowScrollToBottom(false);

      updateSessionState(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: [...historyMessages, userMsg, initialModelMsg],
      }));

      setIsGenerating(true);
      scrollToBottom('smooth', true);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const referenceImageAtt = userMsg.attachments?.find((a) =>
        a.mimeType.startsWith('image/') && a.base64Data
      );
      const referenceImage = referenceImageAtt?.base64Data
        ? {
            base64Data: referenceImageAtt.base64Data,
            mimeType: referenceImageAtt.mimeType,
          }
        : undefined;

      try {
        // 1. IMAGE CREATION & EDITING (gemini-nano-banana-2.1)
        if (effectiveMode === 'image') {
          const resp = await fetch('/api/generate/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: userMsg.text || 'Generate a detailed high-resolution image',
              aspectRatio: generationOptions.imageAspectRatio,
              imageSize: generationOptions.imageSize,
              referenceImage,
            }),
            signal: abortController.signal,
          });
          const data = await resp.json();

          if (!resp.ok || data.error) {
            const errText = data.error || 'Image generation failed.';
            updateSessionState(sessionId, (s) => ({
              ...s,
              updatedAt: Date.now(),
              messages: s.messages.map((m) =>
                m.id === modelMsgId
                  ? {
                      ...m,
                      isStreaming: false,
                      error: errText,
                      isPaidKeyError: Boolean(data.isPaidKeyError),
                    }
                  : m
              ),
            }));
            addToast('Image generation error', errText, 'error', () => {
              executeTurn(sessionId, historyMessages, userMsg, effectiveMode);
            });
            return;
          }

          updateSessionState(sessionId, (s) => ({
            ...s,
            updatedAt: Date.now(),
            messages: s.messages.map((m) =>
              m.id === modelMsgId
                ? {
                    ...m,
                    isStreaming: false,
                    text: data.text || '',
                    generatedMedia: {
                      type: 'image',
                      mimeType: data.mimeType || 'image/png',
                      base64Data: data.imageBase64,
                      prompt: userMsg.text,
                      aspectRatio: data.aspectRatio || generationOptions.imageAspectRatio,
                      imageSize: data.imageSize || generationOptions.imageSize,
                      modelUsed: data.modelUsed,
                    },
                  }
                : m
            ),
          }));
          return;
        }

        // 2. VIDEO GENERATION (gemini-omni-1.1-flash via Interactions API with 16:9 or 9:16 aspect ratio)
        if (effectiveMode === 'video') {
          const startTime = Date.now();
          const startResp = await fetch('/api/generate/video/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: userMsg.text || 'Animate this scene with smooth cinematic motion',
              aspectRatio: generationOptions.videoAspectRatio,
              duration: generationOptions.videoDuration,
              referenceImage,
            }),
            signal: abortController.signal,
          });

          const startData = await startResp.json();
          if (!startResp.ok || startData.error) {
            const errText = startData.error || 'Video generation could not be started.';
            updateSessionState(sessionId, (s) => ({
              ...s,
              updatedAt: Date.now(),
              messages: s.messages.map((m) =>
                m.id === modelMsgId
                  ? {
                      ...m,
                      isStreaming: false,
                      videoProgress: undefined,
                      error: errText,
                      isPaidKeyError: Boolean(startData.isPaidKeyError),
                    }
                  : m
              ),
            }));
            addToast('Video generation error', errText, 'error', () => {
              executeTurn(sessionId, historyMessages, userMsg, effectiveMode);
            });
            return;
          }

          if (
            startData.status === 'completed' &&
            (startData.videoBase64 || startData.videoUri)
          ) {
            updateSessionState(sessionId, (s) => ({
              ...s,
              updatedAt: Date.now(),
              messages: s.messages.map((m) =>
                m.id === modelMsgId
                  ? {
                      ...m,
                      isStreaming: false,
                      videoProgress: undefined,
                      text: `Generated video (${generationOptions.videoAspectRatio}) for: "${userMsg.text}"`,
                      generatedMedia: {
                        type: 'video',
                        mimeType: startData.mimeType || 'video/mp4',
                        base64Data: startData.videoBase64,
                        uri: startData.videoUri,
                        prompt: userMsg.text,
                        aspectRatio: startData.aspectRatio || generationOptions.videoAspectRatio,
                        duration: startData.duration || generationOptions.videoDuration,
                      },
                    }
                  : m
              ),
            }));
            return;
          }

          const interactionId = startData.interactionId;
          while (!abortController.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 4000));
            if (abortController.signal.aborted) break;

            const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
            const pollResp = await fetch(`/api/generate/video/status/${interactionId}`, {
              signal: abortController.signal,
            });
            const pollData = await pollResp.json();

            if (!pollResp.ok || pollData.error) {
              throw new Error(pollData.error || 'Failed while polling video status.');
            }

            if (pollData.status === 'completed') {
              updateSessionState(sessionId, (s) => ({
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map((m) =>
                  m.id === modelMsgId
                    ? {
                        ...m,
                        isStreaming: false,
                        videoProgress: undefined,
                        text: `Generated video (${generationOptions.videoAspectRatio}) for: "${userMsg.text}"`,
                        generatedMedia: {
                          type: 'video',
                          mimeType: pollData.mimeType || 'video/mp4',
                          base64Data: pollData.videoBase64,
                          uri: pollData.videoUri,
                          prompt: userMsg.text,
                          aspectRatio: generationOptions.videoAspectRatio,
                          duration: generationOptions.videoDuration,
                        },
                      }
                    : m
                ),
              }));
              return;
            }

            if (pollData.status === 'failed' || pollData.status === 'cancelled') {
              throw new Error(`Video generation ${pollData.status}.`);
            }

            updateSessionState(sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === modelMsgId
                  ? {
                      ...m,
                      videoProgress: {
                        interactionId,
                        status: 'in_progress',
                        elapsedSeconds,
                        stepCount: pollData.stepCount || 0,
                        latestNote: pollData.latestNote,
                      },
                    }
                  : m
              ),
            }));
          }
          return;
        }

        // 3. MUSIC GENERATION (lyria-3-clip-preview or lyria-3-pro-preview)
        if (effectiveMode === 'music') {
          const resp = await fetch('/api/generate/music', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: userMsg.text || 'Generate a 30-second instrumental track',
              trackType: generationOptions.musicTrackType,
              referenceImage,
            }),
            signal: abortController.signal,
          });
          const data = await resp.json();

          if (!resp.ok || data.error) {
            const errText = data.error || 'Music generation failed.';
            updateSessionState(sessionId, (s) => ({
              ...s,
              updatedAt: Date.now(),
              messages: s.messages.map((m) =>
                m.id === modelMsgId
                  ? {
                      ...m,
                      isStreaming: false,
                      error: errText,
                      isPaidKeyError: Boolean(data.isPaidKeyError),
                    }
                  : m
              ),
            }));
            addToast('Music generation error', errText, 'error', () => {
              executeTurn(sessionId, historyMessages, userMsg, effectiveMode);
            });
            return;
          }

          updateSessionState(sessionId, (s) => ({
            ...s,
            updatedAt: Date.now(),
            messages: s.messages.map((m) =>
              m.id === modelMsgId
                ? {
                    ...m,
                    isStreaming: false,
                    text: `Generated ${
                      generationOptions.musicTrackType === 'pro' ? 'full-length track' : 'music clip'
                    } for: "${userMsg.text}"`,
                    generatedMedia: {
                      type: 'music',
                      mimeType: data.mimeType || 'audio/wav',
                      base64Data: data.audioBase64,
                      lyrics: data.lyrics,
                      prompt: userMsg.text,
                      modelUsed: data.modelUsed,
                    },
                  }
                : m
            ),
          }));
          return;
        }

        // 4. STREAMING CHAT + FILE UNDERSTANDING + URL CONTEXT + GOOGLE SEARCH & GOOGLE MAPS GROUNDING
        const allValidMessages = [...historyMessages, userMsg].filter((m) => !m.error);
        const recentWindow = allValidMessages.slice(-12);
        const conversationForApi = recentWindow.map((m, idx) => {
          const isRecentTurn = idx >= recentWindow.length - 2;
          return {
            role: m.role,
            text: m.text,
            attachments: m.attachments?.map((att) => ({
              name: att.name,
              mimeType: att.mimeType,
              kind: att.kind,
              base64Data: isRecentTurn ? att.base64Data : undefined,
              fileUri: isRecentTurn ? att.fileUri : undefined,
              extractedText:
                att.extractedText && !isRecentTurn
                  ? att.extractedText.slice(0, 3000)
                  : att.extractedText,
            })),
          };
        });

        const urlsInPrompt = extractUrlsFromText(userMsg.text);

        let accumulatedText = '';
        let collectedSources: GroundingSource[] = [];
        let lastStreamErrorMsg = '';
        let lastIsPaidKeyError = false;

        const readChunkWithTimeout = (
          reader: ReadableStreamDefaultReader<Uint8Array>,
          timeoutMs = 15000
        ): Promise<ReadableStreamReadResult<Uint8Array>> => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reader.cancel().catch(() => {});
              reject(new Error('Stream read timed out'));
            }, timeoutMs);
            reader.read().then(
              (res) => {
                clearTimeout(timer);
                resolve(res);
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              }
            );
          });
        };

        for (let attempt = 0; attempt < 2; attempt++) {
          if (abortController.signal.aborted) break;
          lastStreamErrorMsg = '';

          try {
            const response = await fetch('/api/chat/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: conversationForApi,
                urls: urlsInPrompt,
                groundingMode:
                  attempt > 0 && generationOptions.chatGrounding === 'auto'
                    ? 'auto'
                    : generationOptions.chatGrounding,
                language: generationOptions.language,
                userLocation,
              }),
              signal: abortController.signal,
            });

            if (!response.ok || !response.body) {
              throw new Error(`Server returned status ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let attemptAbortedOnError = false;

            const processSseBlock = (block: string) => {
              const dataLines = block
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.startsWith('data:'));

              for (const line of dataLines) {
                const jsonStr = line.replace(/^data:\s*/, '');
                try {
                  const evt = JSON.parse(jsonStr);
                  if (evt.type === 'delta' && evt.text) {
                    accumulatedText += evt.text;
                    updateSessionState(sessionId, (s) => ({
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === modelMsgId
                          ? {
                              ...m,
                              text: accumulatedText,
                              isStreaming: true,
                              error: undefined,
                            }
                          : m
                      ),
                    }));
                  } else if (evt.type === 'sources' && Array.isArray(evt.sources)) {
                    collectedSources = evt.sources;
                  } else if (evt.type === 'error') {
                    attemptAbortedOnError = true;
                    lastStreamErrorMsg = evt.error || 'Stream error occurred.';
                    lastIsPaidKeyError = Boolean(evt.isPaidKeyError);
                  }
                } catch {
                  // ignore malformed SSE chunk
                }
              }
            };

            while (true) {
              const { value, done } = await readChunkWithTimeout(reader, 15000);
              if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) {
                  processSseBlock(buffer);
                }
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const blocks = buffer.split('\n\n');
              buffer = blocks.pop() || '';

              for (const block of blocks) {
                processSseBlock(block);
                if (attemptAbortedOnError) break;
              }
              if (attemptAbortedOnError) break;
            }
          } catch (streamErr: any) {
            if (streamErr?.name === 'AbortError' || abortController.signal.aborted) {
              throw streamErr;
            }
            lastStreamErrorMsg =
              streamErr instanceof Error ? streamErr.message : 'Stream connection interrupted.';
          }

          if (accumulatedText.trim().length > 0) {
            break;
          }
        }

        if (!accumulatedText.trim()) {
          const errToShow =
            lastStreamErrorMsg ||
            'The response stream timed out due to temporary high demand. Click Retry to try again.';
          updateSessionState(sessionId, (s) => ({
            ...s,
            updatedAt: Date.now(),
            messages: s.messages.map((m) =>
              m.id === modelMsgId
                ? {
                    ...m,
                    text: '',
                    isStreaming: false,
                    error: errToShow,
                    isPaidKeyError: lastIsPaidKeyError,
                  }
                : m
            ),
          }));
          addToast('Chat error', errToShow, 'error', () => {
            executeTurn(sessionId, historyMessages, userMsg, effectiveMode);
          });
          return;
        }

        updateSessionState(sessionId, (s) => ({
          ...s,
          updatedAt: Date.now(),
          messages: s.messages.map((m) =>
            m.id === modelMsgId
              ? {
                  ...m,
                  text: accumulatedText,
                  sources: collectedSources.length > 0 ? collectedSources : undefined,
                  isStreaming: false,
                  error: undefined,
                }
              : m
          ),
        }));
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          updateSessionState(sessionId, (s) => ({
            ...s,
            updatedAt: Date.now(),
            messages: s.messages.map((m) =>
              m.id === modelMsgId
                ? {
                    ...m,
                    isStreaming: false,
                    videoProgress: undefined,
                    text: m.text || 'Generation stopped by user.',
                  }
                : m
            ),
          }));
          return;
        }

        const errMessage =
          err instanceof Error ? err.message : 'Network request failed. Please try again.';
        updateSessionState(sessionId, (s) => ({
          ...s,
          updatedAt: Date.now(),
          messages: s.messages.map((m) =>
            m.id === modelMsgId
              ? {
                  ...m,
                  isStreaming: false,
                  videoProgress: undefined,
                  error: errMessage,
                }
              : m
          ),
        }));
        addToast('Request failed', errMessage, 'error', () => {
          executeTurn(sessionId, historyMessages, userMsg, effectiveMode);
        });
      } finally {
        setIsGenerating(false);
        abortControllerRef.current = null;
      }
    },
    [addToast, generationOptions, scrollToBottom, updateSessionState, userLocation]
  );

  // Load a generated image into Composer as a reference attachment for editing with gemini-nano-banana-2.1
  const handleEditGeneratedImage = useCallback((media: GeneratedMedia) => {
    if (!media.base64Data) return;
    const mimeType = media.mimeType || 'image/png';
    const previewUrl = `data:${mimeType};base64,${media.base64Data}`;
    const approxSize = Math.round((media.base64Data.length * 3) / 4);
    const editAttachment: FileAttachment = {
      id: `att-edit-${Date.now()}`,
      name: `reference-image.${mimeType.includes('svg') ? 'svg' : 'png'}`,
      size: approxSize,
      mimeType,
      categoryLabel: 'Image',
      kind: 'inline',
      base64Data: media.base64Data,
      previewUrl,
    };
    setAttachments([editAttachment]);
    setMode('image');
  }, []);

  // Submit handler from Composer
  const handleSend = useCallback(
    async (overrideInput?: string, overrideMode?: ComposerMode) => {
      if (!activeSession || isGenerating || isProcessingFiles) return;

      const textToSend = (overrideInput !== undefined ? overrideInput : input).trim();
      if (!textToSend && attachments.length === 0) return;

      const hasNonImageAtt = attachments.some((a) => !a.mimeType.startsWith('image/'));
      const activeMode = overrideMode || mode;
      const effectiveMode = detectGenerationIntent(textToSend, activeMode, hasNonImageAtt);

      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        text: textToSend,
        createdAt: Date.now(),
        mode: effectiveMode,
        attachments: attachments.length > 0 ? [...attachments] : undefined,
      };

      const currentMessages = activeSession.messages;
      const isFirstTurn = currentMessages.length === 0;

      if (isFirstTurn) {
        const autoTitle = buildAutoTitle(
          textToSend,
          attachments.map((a) => a.name)
        );
        updateSessionState(activeSession.id, (s) => ({
          ...s,
          title: autoTitle,
        }));
      }

      setInput('');
      setAttachments([]);
      await executeTurn(activeSession.id, currentMessages, userMsg, effectiveMode);
    },
    [
      activeSession,
      attachments,
      executeTurn,
      input,
      isGenerating,
      isProcessingFiles,
      mode,
      updateSessionState,
    ]
  );

  // Global Keyboard Shortcuts:
  // - Ctrl+Enter / Cmd+Enter: Send message
  // - Ctrl+N / Cmd+N (or Alt+N): Start a new chat
  // - Esc: Close modals, dropdown menus, sidebars, or stop active generation/speech
  // - Ctrl+B / Cmd+B: Toggle sidebar
  // - Ctrl+/ / Cmd+/: Toggle keyboard shortcuts guide
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const keyLower = e.key.toLowerCase();
      const hasPrimaryModifier = e.ctrlKey || e.metaKey;

      // 1. Ctrl+Enter or Cmd+Enter -> Send message globally
      if (hasPrimaryModifier && e.key === 'Enter') {
        if (isAuthModalOpen || isShortcutsModalOpen) return;
        if (!isGenerating && !isProcessingFiles && (input.trim() || attachments.length > 0)) {
          e.preventDefault();
          handleSend();
        }
        return;
      }

      // 2. Ctrl+N / Cmd+N (or Alt+N fallback) -> Start a new chat
      if (
        (hasPrimaryModifier && !e.shiftKey && keyLower === 'n') ||
        (e.altKey && !e.ctrlKey && !e.metaKey && keyLower === 'n')
      ) {
        e.preventDefault();
        setIsAuthModalOpen(false);
        setIsShortcutsModalOpen(false);
        setIsExportMenuOpen(false);
        setIsMobileSidebarOpen(false);
        handleNewChat();
        return;
      }

      // 3. Ctrl+B / Cmd+B -> Toggle sidebar
      if (hasPrimaryModifier && !e.shiftKey && keyLower === 'b') {
        e.preventDefault();
        if (isEffectiveMobileView) {
          setIsMobileSidebarOpen((prev) => !prev);
        } else {
          setIsDesktopSidebarOpen((prev) => !prev);
        }
        return;
      }

      // 4. Ctrl+/ or Cmd+/ -> Toggle Keyboard Shortcuts Modal
      if (hasPrimaryModifier && e.key === '/') {
        e.preventDefault();
        setIsShortcutsModalOpen((prev) => !prev);
        return;
      }

      // 5. Escape (Esc) -> Close modals, menus, sidebars, or stop active generation/TTS
      if (e.key === 'Escape') {
        if (isShortcutsModalOpen) {
          e.preventDefault();
          setIsShortcutsModalOpen(false);
          return;
        }
        if (isAuthModalOpen) {
          e.preventDefault();
          setIsAuthModalOpen(false);
          return;
        }
        if (isExportMenuOpen) {
          e.preventDefault();
          setIsExportMenuOpen(false);
          return;
        }
        if (isDraggingOver) {
          e.preventDefault();
          setIsDraggingOver(false);
          return;
        }
        if (isMobileSidebarOpen) {
          e.preventDefault();
          setIsMobileSidebarOpen(false);
          return;
        }
        if (toasts.length > 0) {
          e.preventDefault();
          setToasts((prev) => prev.slice(0, -1));
          return;
        }
        if (isGenerating && abortControllerRef.current) {
          e.preventDefault();
          abortControllerRef.current.abort();
          return;
        }
        if (speakingMsgId) {
          e.preventDefault();
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
          }
          setSpeakingMsgId(null);
          return;
        }
        if (!isEffectiveMobileView && isDesktopSidebarOpen) {
          // If an input or textarea is focused, blur it first or collapse desktop sidebar
          const activeEl = document.activeElement as HTMLElement | null;
          if (
            activeEl &&
            (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') &&
            activeEl !== composerTextareaRef.current
          ) {
            activeEl.blur();
            return;
          }
          e.preventDefault();
          setIsDesktopSidebarOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [
    attachments.length,
    handleNewChat,
    handleSend,
    input,
    isAuthModalOpen,
    isDesktopSidebarOpen,
    isDraggingOver,
    isEffectiveMobileView,
    isGenerating,
    isMobileSidebarOpen,
    isProcessingFiles,
    isShortcutsModalOpen,
    isExportMenuOpen,
    speakingMsgId,
    toasts.length,
  ]);

  // Regenerate a model message (or retry a failed message)
  const handleRegenerateMessage = useCallback(
    (modelMessageIndex: number) => {
      if (!activeSession || isGenerating) return;
      const msgs = activeSession.messages;
      // Find the preceding user message
      let userIdx = modelMessageIndex - 1;
      while (userIdx >= 0 && msgs[userIdx].role !== 'user') {
        userIdx--;
      }
      if (userIdx < 0) return;

      const userMsg = msgs[userIdx];
      const historyBeforeUser = msgs.slice(0, userIdx);
      executeTurn(activeSession.id, historyBeforeUser, userMsg, userMsg.mode || 'chat');
    },
    [activeSession, executeTurn, isGenerating]
  );

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId(null), 1800);
    } catch {
      // ignore
    }
  };

  const handleToggleSpeakMessage = useCallback(
    (msgId: string, rawText: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        addToast(
          'Text-to-speech unavailable',
          'Your browser does not support the Web Speech Synthesis API.',
          'warning'
        );
        return;
      }

      const synth = window.speechSynthesis;

      if (speakingMsgId === msgId) {
        synth.cancel();
        setSpeakingMsgId(null);
        return;
      }

      synth.cancel();
      const cleanText = stripMarkdownForSpeech(rawText);
      if (!cleanText) return;

      const utterance = new SpeechSynthesisUtterance(cleanText);
      const targetLang = detectSpeechLang(cleanText, generationOptions.language);
      utterance.lang = targetLang;

      const voices = synth.getVoices();
      if (voices && voices.length > 0) {
        const langPrefix = targetLang.split('-')[0].toLowerCase();
        const exactVoice =
          voices.find((v) => v.lang.toLowerCase() === targetLang.toLowerCase()) ||
          voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));
        if (exactVoice) {
          utterance.voice = exactVoice;
        }
      }

      utterance.onend = () => {
        setSpeakingMsgId((prev) => (prev === msgId ? null : prev));
      };

      utterance.onerror = () => {
        setSpeakingMsgId((prev) => (prev === msgId ? null : prev));
      };

      setSpeakingMsgId(msgId);
      synth.speak(utterance);
    },
    [addToast, generationOptions.language, speakingMsgId]
  );

  const handleExportChat = useCallback(
    (format: 'json' | 'markdown') => {
      setIsExportMenuOpen(false);
      if (!activeSession || activeSession.messages.length === 0) {
        addToast(
          'Nothing to export',
          'Start a conversation first before exporting chat history.',
          'info'
        );
        return;
      }

      const safeSlug =
        (activeSession.title || 'chat')
          .toLowerCase()
          .replace(/[^a-z0-9\u0900-\u097F-_]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'chat';

      let content = '';
      let mimeType = 'text/plain;charset=utf-8';
      let extension = 'txt';

      if (format === 'json') {
        const exportPayload = {
          id: activeSession.id,
          title: activeSession.title,
          exportedAt: new Date().toISOString(),
          createdAt: new Date(activeSession.createdAt).toISOString(),
          updatedAt: new Date(activeSession.updatedAt).toISOString(),
          messageCount: activeSession.messages.length,
          messages: activeSession.messages.map((m) => ({
            id: m.id,
            role: m.role,
            mode: m.mode,
            createdAt: new Date(m.createdAt).toISOString(),
            text: m.text,
            attachments: m.attachments?.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              categoryLabel: a.categoryLabel,
            })),
            sources: m.sources,
            generatedMedia: m.generatedMedia
              ? {
                  type: m.generatedMedia.type,
                  mimeType: m.generatedMedia.mimeType,
                  prompt: m.generatedMedia.prompt,
                  lyrics: m.generatedMedia.lyrics,
                }
              : undefined,
            error: m.error,
          })),
        };
        content = JSON.stringify(exportPayload, null, 2);
        mimeType = 'application/json;charset=utf-8';
        extension = 'json';
      } else {
        const lines: string[] = [
          `# ${activeSession.title || 'Mantrana AI Chat'}`,
          '',
          `Exported from Mantrana AI on ${new Date().toLocaleString()}`,
          '',
          '---',
          '',
        ];

        for (const m of activeSession.messages) {
          const speaker = m.role === 'user' ? 'You' : 'Mantrana AI';
          const timeStr = new Date(m.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          lines.push(`### ${speaker} · ${timeStr}`);
          lines.push('');

          if (m.attachments && m.attachments.length > 0) {
            lines.push(
              `**Attachments:** ${m.attachments
                .map((a) => `${a.name} (${a.categoryLabel}, ${formatFileSize(a.size)})`)
                .join(', ')}`
            );
            lines.push('');
          }

          if (m.text) {
            lines.push(m.text);
            lines.push('');
          }

          if (m.generatedMedia) {
            lines.push(
              `*[Generated ${m.generatedMedia.type} (${m.generatedMedia.mimeType}) — Prompt: "${m.generatedMedia.prompt}"]*`
            );
            if (m.generatedMedia.lyrics) {
              lines.push('');
              lines.push('**Lyrics:**');
              lines.push(m.generatedMedia.lyrics);
            }
            lines.push('');
          }

          if (m.sources && m.sources.length > 0) {
            lines.push('**Sources:**');
            for (const src of m.sources) {
              lines.push(`- [${src.title || src.uri}](${src.uri})`);
            }
            lines.push('');
          }

          lines.push('---');
          lines.push('');
        }

        content = lines.join('\n');
        mimeType = 'text/markdown;charset=utf-8';
        extension = 'md';
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mantrana-${safeSlug}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [activeSession, addToast]
  );

  const welcomeSuggestions = [
    {
      id: 'file',
      category: 'File · Document & Media Analysis',
      title: 'Attach a PDF, image, video, or DOCX to question',
      description: 'Supports native PDF/image/audio/video + browser DOCX, PPTX, XLSX',
      icon: <FileText className="w-4 h-4 text-teal-600 dark:text-teal-400" />,
      onClick: () => {
        setMode('chat');
        setInput('Summarize the key findings, structure, and action items from the attached file.');
        fileInputRef.current?.click();
      },
    },
    {
      id: 'image',
      category: 'Image · Studio Generation',
      title: 'Generate an architectural atrium illustration',
      description: 'Creates inline downloadable artwork via Gemini image generation',
      icon: <ImageIcon className="w-4 h-4 text-teal-600 dark:text-teal-400" />,
      onClick: () => {
        setMode('image');
        handleSend(
          'A minimalist sunlit botanical research library with warm timber arches, glass atrium roof, and indoor terraced gardens, architectural photography, 8k',
          'image'
        );
      },
    },
    {
      id: 'link',
      category: 'Link · URL Context & Grounding',
      title: 'Read and summarize a live web page URL',
      description: 'Uses Gemini URL context & Search grounding with source chips',
      icon: <Link2 className="w-4 h-4 text-teal-600 dark:text-teal-400" />,
      onClick: () => {
        setMode('chat');
        handleSend(
          'Read https://www.w3.org/standards/ and summarize the core web standards areas in bullet points.',
          'chat'
        );
      },
    },
  ];

  if (!isDbLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300">
        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
      </div>
    );
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex h-[100dvh] w-full overflow-hidden bg-slate-100 dark:bg-[#060911] text-slate-900 dark:text-slate-100 relative ${
        screenViewMode === 'mobile' && detectedDevice === 'laptop'
          ? 'items-center justify-center p-2 sm:p-4'
          : ''
      }`}
    >
      <div
        className={`flex h-full w-full overflow-hidden bg-white dark:bg-[#090d16] relative transition-all duration-200 ${
          screenViewMode === 'mobile' && detectedDevice === 'laptop'
            ? 'max-w-[430px] max-h-[92dvh] rounded-3xl border border-slate-300 dark:border-slate-800 shadow-2xl'
            : ''
        }`}
      >
        {/* Full-window Drag and Drop Overlay */}
        {isDraggingOver && (
          <div className="fixed inset-0 z-50 bg-teal-950/60 backdrop-blur-xs flex items-center justify-center p-6 pointer-events-none">
            <div className="max-w-md w-full rounded-2xl border-2 border-dashed border-teal-400 bg-slate-900/95 p-8 text-center text-white space-y-3">
              <UploadCloud className="w-10 h-10 text-teal-400 mx-auto" />
              <p className="text-lg font-semibold font-display">Drop files to attach to Mantrana AI</p>
              <p className="text-xs text-slate-300 leading-relaxed">
                Images, PDF, Video, Audio, TXT, JSON, CSV, HTML, Code, and Office files (DOCX, PPTX, XLSX)
              </p>
            </div>
          </div>
        )}

        {/* Toast Notifications with Retry */}
        {toasts.length > 0 && (
          <div className="fixed top-16 right-3 sm:right-4 left-3 sm:left-auto z-50 flex flex-col gap-2 sm:max-w-sm w-auto sm:w-full pointer-events-auto">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className="rounded-xl border border-rose-200 dark:border-rose-900/80 bg-white dark:bg-slate-900 p-3.5 shadow-lg flex items-start justify-between gap-3"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {toast.title}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 break-words leading-relaxed">
                      {toast.message}
                    </p>
                    {toast.onRetry && (
                      <button
                        type="button"
                        onClick={() => {
                          const retryFn = toast.onRetry;
                          dismissToast(toast.id);
                          retryFn?.();
                        }}
                        className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Retry</span>
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
                  aria-label="Close notification"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Sign In / Create Account Modal (Email, Username, Password) */}
        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
          onAuthSuccess={handleAuthSuccess}
        />

        {/* Keyboard Shortcuts Reference Modal */}
        {isShortcutsModalOpen && (
          <div
            onClick={() => setIsShortcutsModalOpen(false)}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-xs"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 sm:p-6 pb-safe"
            >
              <div className="flex items-center justify-between gap-3 pb-3.5 border-b border-slate-200/80 dark:border-slate-800/80">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
                    <Keyboard className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm sm:text-base font-bold font-display text-slate-900 dark:text-white">
                      Keyboard Shortcuts
                    </h2>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Navigate and control Mantrana AI faster
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsShortcutsModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Close (Esc)"
                  aria-label="Close keyboard shortcuts modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-4 space-y-2.5 text-xs">
                {[
                  {
                    label: 'Send message',
                    keys: ['Ctrl', 'Enter'],
                  },
                  {
                    label: 'Start a new chat',
                    keys: ['Ctrl', 'N'],
                  },
                  {
                    label: 'Close sidebars, modals, or stop generation',
                    keys: ['Esc'],
                  },
                  {
                    label: 'Toggle chat history sidebar',
                    keys: ['Ctrl', 'B'],
                  },
                  {
                    label: 'Insert a new line in message box',
                    keys: ['Shift', 'Enter'],
                  },
                  {
                    label: 'Show / hide keyboard shortcuts',
                    keys: ['Ctrl', '/'],
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3 py-2 px-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800"
                  >
                    <span className="text-slate-700 dark:text-slate-200 font-medium">
                      {item.label}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k, i) => (
                        <React.Fragment key={k}>
                          {i > 0 && (
                            <span className="text-slate-400 dark:text-slate-500 text-[10px]">
                              +
                            </span>
                          )}
                          <kbd className="px-2 py-1 text-[11px] font-mono font-semibold rounded-md bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-700 shadow-2xs">
                            {k}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-4 text-[11px] text-slate-500 dark:text-slate-400 text-center">
                On macOS, you can also use <kbd className="font-mono">⌘ Cmd</kbd> in place of{' '}
                <kbd className="font-mono">Ctrl</kbd>, or <kbd className="font-mono">Alt+N</kbd> for a new chat.
              </p>
            </div>
          </div>
        )}

        {/* Left Sidebar (Laptop persistent collapsible + Mobile slide-over drawer) */}
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSession?.id || ''}
          isOpenMobile={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
          isOpenDesktop={isDesktopSidebarOpen}
          onToggleDesktop={() => setIsDesktopSidebarOpen((prev) => !prev)}
          forceMobileLayout={screenViewMode === 'mobile'}
          onSelectSession={(id) => setActiveSessionId(id)}
          onNewChat={handleNewChat}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          quickActions={welcomeSuggestions}
          userAccount={userAccount}
          onOpenAuthModal={() => setIsAuthModalOpen(true)}
          onSignOut={handleSignOut}
          canExportChat={Boolean(activeSession && activeSession.messages.length > 0)}
          onExportChat={handleExportChat}
          onOpenShortcutsModal={() => setIsShortcutsModalOpen(true)}
          theme={theme}
          onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
        />

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 h-full">
          {/* Top Header */}
          <header className="h-14 px-3 sm:px-6 border-b border-slate-200 dark:border-slate-800/90 bg-white/85 dark:bg-slate-900/85 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4 shrink-0 pt-safe">
            {/* Zone 1: Menu / Sidebar Toggle + Mantrana AI Wordmark */}
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* Mobile Drawer Toggle */}
              <button
                type="button"
                onClick={() => setIsMobileSidebarOpen(true)}
                className={`${
                  screenViewMode === 'mobile' ? 'inline-flex' : 'lg:hidden inline-flex'
                } items-center justify-center w-9 h-9 -ml-1 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0`}
                aria-label="Open chat history sidebar"
                title="Open chat history (Ctrl+B)"
              >
                <Menu className="w-5 h-5" />
              </button>

              {/* Laptop Sidebar Expand Button (shown when sidebar is collapsed on laptop) */}
              {screenViewMode !== 'mobile' && !isDesktopSidebarOpen && (
                <button
                  type="button"
                  onClick={() => setIsDesktopSidebarOpen(true)}
                  className="hidden lg:inline-flex items-center justify-center w-9 h-9 -ml-1 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
                  aria-label="Expand sidebar"
                  title="Expand chat history sidebar (Ctrl+B)"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
              )}

              <button
                type="button"
                onClick={handleNewChat}
                title="Start a new chat (Ctrl+N)"
                className="text-base sm:text-lg font-bold tracking-tight font-display text-slate-900 dark:text-white whitespace-nowrap shrink-0 cursor-pointer"
              >
                Mαɳƚɾαɳα AI ✨
              </button>
            </div>


            {/* Zone 3: Responsive Screen Mode Switcher, Email Login / User Badge, Export & Theme Toggle */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                type="button"
                onClick={handleNewChat}
                className="sm:hidden inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="New chat (Ctrl+N)"
                aria-label="New chat"
              >
                <Plus className="w-4 h-4" />
              </button>

              {/* Adaptive Screen Layout Switcher (Auto / Laptop / Mobile) */}
              <button
                type="button"
                onClick={() =>
                  setScreenViewMode((prev) =>
                    prev === 'auto' ? 'mobile' : prev === 'mobile' ? 'laptop' : 'auto'
                  )
                }
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                title={`Screen layout: ${
                  screenViewMode === 'auto'
                    ? `Auto (${detectedDevice} screen detected)`
                    : screenViewMode === 'mobile'
                      ? 'Mobile View'
                      : 'Laptop View'
                } — Click to switch`}
                aria-label="Switch screen layout mode"
              >
                {isEffectiveMobileView ? (
                  <Smartphone className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                ) : (
                  <Monitor className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                )}
                <span className="hidden md:inline">
                  {screenViewMode === 'auto'
                    ? `Auto (${detectedDevice === 'mobile' ? 'Mobile' : detectedDevice === 'tablet' ? 'Tablet' : 'Laptop'})`
                    : screenViewMode === 'mobile'
                      ? 'Mobile'
                      : 'Laptop'}
                </span>
              </button>

              {/* Sign In / Logged-In User Badge */}
              {userAccount ? (
                <div className="inline-flex items-center gap-1 sm:gap-1.5 pl-2 pr-1 py-1 rounded-lg border border-teal-200 dark:border-teal-900/80 bg-teal-50/70 dark:bg-teal-950/40 text-xs text-teal-900 dark:text-teal-200">
                  <User className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span
                    className="font-medium max-w-[76px] sm:max-w-[140px] truncate"
                    title={`${userAccount.username} (${userAccount.email})`}
                  >
                    {userAccount.username}
                  </span>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="p-1 rounded-md text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 hover:bg-white/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                    title={`Sign out (${userAccount.email})`}
                    aria-label="Sign out"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsAuthModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-xs font-medium text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  title="Sign in with your email, username, and password to save chats"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Sign in</span>
                </button>
              )}
            </div>
          </header>

          {/* Scrollable Message Viewport */}
          <main
            ref={scrollContainerRef}
            onScroll={handleViewportScroll}
            className="flex-1 overflow-y-auto scroll-smooth px-2.5 sm:px-6 py-4 sm:py-6 flex flex-col min-h-0"
          >
            {!activeSession || activeSession.messages.length === 0 ? (
              /* Centered New Chat Interface — Adaptive for Mobile & Laptop Screens */
              <div className="flex-1 flex flex-col items-center justify-center w-full max-w-3xl mx-auto py-2 sm:pb-16">
                <img
                  src={transparentLogoSrc}
                  alt="Mantrana AI Logo"
                  className="h-20 sm:h-28 w-auto object-contain -mt-1 mb-1 bg-transparent select-none"
                />
                <p className="text-xs sm:text-sm font-medium text-slate-700 dark:text-slate-300 -mt-0.5 mb-5 sm:mb-7 text-center transition-colors">
                  मन्त्रणा - 𝒀𝒐𝒖𝒓 𝒘𝒊𝒔𝒆 𝒄𝒐𝒖𝒏𝒔𝒆𝒍
                </p>
                <div className="w-full">
                  <Composer
                    input={input}
                    onChangeInput={setInput}
                    mode={mode}
                    onChangeMode={setMode}
                    options={generationOptions}
                    onChangeOptions={setGenerationOptions}
                    attachments={attachments}
                    isProcessingFiles={isProcessingFiles}
                    isGenerating={isGenerating}
                    onAttachFiles={handleAttachFiles}
                    onRemoveAttachment={handleRemoveAttachment}
                    onSubmit={() => handleSend()}
                    onStop={() => abortControllerRef.current?.abort()}
                    onVoiceError={(title, message) => addToast(title, message, 'error')}
                    fileInputRef={fileInputRef}
                    textareaRef={composerTextareaRef}
                  />
                </div>
              </div>
            ) : (
              /* Conversation Thread */
              <div
                ref={messagesContentRef}
                className="max-w-3xl w-full mx-auto space-y-5 sm:space-y-6 pb-4"
              >
                {activeSession.messages.map((msg, idx) => {
                  const isUser = msg.role === 'user';

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                    >
                      {/* Author & Mode Meta */}
                      <div className="flex items-center gap-2 mb-1.5 px-1 text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          {isUser ? 'You' : 'Mantrana AI'}
                        </span>
                        {msg.mode !== 'chat' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="capitalize">{msg.mode} mode</span>
                          </>
                        )}
                      </div>

                      {/* Message Bubble / Surface */}
                      <div
                        className={`w-full rounded-2xl px-3.5 py-3 sm:px-4 sm:py-3.5 ${
                          isUser
                            ? 'max-w-[92%] sm:max-w-[85%] bg-slate-200/75 dark:bg-slate-800/90 text-slate-900 dark:text-slate-100'
                            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
                        }`}
                      >
                      {/* Attached Files inside Message */}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {msg.attachments.map((att) => (
                            <div
                              key={att.id}
                              className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white/90 dark:bg-slate-950/80 border border-slate-200/80 dark:border-slate-700/80 text-xs"
                            >
                              {att.previewUrl ? (
                                <img
                                  src={att.previewUrl}
                                  alt={att.name}
                                  referrerPolicy="no-referrer"
                                  className="w-7 h-7 rounded object-cover shrink-0"
                                />
                              ) : (
                                <FileText className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <p className="font-medium text-slate-900 dark:text-slate-100 truncate max-w-[200px]">
                                  {att.name}
                                </p>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                  {att.categoryLabel} · {formatFileSize(att.size)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Message Text / Markdown */}
                      {isUser ? (
                        msg.text && (
                          <p
                            dir="auto"
                            className="text-[15px] leading-relaxed whitespace-pre-wrap break-words"
                          >
                            {msg.text}
                          </p>
                        )
                      ) : (
                        <>
                          {msg.text ? (
                            <MarkdownRenderer content={msg.text} />
                          ) : msg.isStreaming ? (
                            <div className="flex items-center gap-2.5 py-1 text-xs text-slate-500 dark:text-slate-400">
                              <Loader2 className="w-4 h-4 animate-spin text-teal-600 dark:text-teal-400" />
                              <span>Thinking and generating response…</span>
                            </div>
                          ) : null}
                        </>
                      )}

                      {/* Generated Media (Image, Video, Music) or Async Video Progress */}
                      {(msg.generatedMedia || msg.videoProgress) && (
                        <GeneratedMediaCard
                          media={msg.generatedMedia}
                          videoProgress={msg.videoProgress}
                          onEditImage={handleEditGeneratedImage}
                        />
                      )}

                      {/* Error Banner inside Model Message with Retry */}
                      {msg.error && (
                        <div className="mt-3 p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/70 text-xs text-rose-900 dark:text-rose-200 space-y-2">
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <p className="font-semibold">
                                {msg.isPaidKeyError
                                  ? 'Paid API Key / Billing Required'
                                  : 'Request could not be completed'}
                              </p>
                              <p className="leading-relaxed">{msg.error}</p>
                            </div>
                          </div>
                          <div>
                            <button
                              type="button"
                              onClick={() => handleRegenerateMessage(idx)}
                              disabled={isGenerating}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium transition-colors cursor-pointer"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>Retry</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Google Search & Google Maps Grounding Links under the Answer */}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800/80 space-y-2.5">
                          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                            {msg.sources.some((s) => s.kind === 'maps') ? (
                              <MapPin className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                            ) : (
                              <Globe className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                            )}
                            <span>
                              {msg.sources.some((s) => s.kind === 'maps')
                                ? `Google Maps & Web Sources (${msg.sources.length})`
                                : `Sources (${msg.sources.length})`}
                            </span>
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {msg.sources.map((src, sIdx) => (
                              <a
                                key={`${src.uri}-${sIdx}`}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-teal-50 dark:hover:bg-teal-950/50 border border-slate-200/80 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-200 hover:text-teal-700 dark:hover:text-teal-300 transition-colors max-w-[280px]"
                              >
                                {src.kind === 'maps' ? (
                                  <MapPin className="w-3 h-3 text-teal-600 dark:text-teal-400 shrink-0" />
                                ) : (
                                  <Globe className="w-3 h-3 text-slate-400 shrink-0" />
                                )}
                                <span className="truncate">{src.title || src.uri}</span>
                                <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
                              </a>
                            ))}
                          </div>
                          {msg.sources.some(
                            (s) => s.reviewSnippets && s.reviewSnippets.length > 0
                          ) && (
                            <div className="space-y-1.5 pt-1">
                              {msg.sources
                                .filter((s) => s.reviewSnippets && s.reviewSnippets.length > 0)
                                .map((s, rIdx) => (
                                  <div
                                    key={`reviews-${rIdx}`}
                                    className="rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800 p-2.5 text-xs text-slate-600 dark:text-slate-300 space-y-1"
                                  >
                                    <p className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1">
                                      <MapPin className="w-3 h-3 text-teal-600 dark:text-teal-400" />
                                      <span>{s.title} · Place Reviews</span>
                                    </p>
                                    {s.reviewSnippets?.slice(0, 2).map((snip, snipIdx) => (
                                      <p key={snipIdx} className="italic text-[11px] leading-relaxed">
                                        “{snip}”
                                      </p>
                                    ))}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Per-Message Actions: Copy, Read Aloud (TTS) & Regenerate */}
                    {!msg.isStreaming && (
                      <div className="flex items-center gap-2 mt-1.5 px-1">
                        {msg.text && (
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(msg.id, msg.text)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
                            title="Copy message"
                          >
                            {copiedMsgId === msg.id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                                <span className="text-teal-600 dark:text-teal-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        )}

                        {!isUser && msg.text && (
                          <button
                            type="button"
                            onClick={() => handleToggleSpeakMessage(msg.id, msg.text)}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                              speakingMsgId === msg.id
                                ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 font-medium'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
                            }`}
                            title={
                              speakingMsgId === msg.id ? 'Stop reading aloud' : 'Read response aloud'
                            }
                            aria-label={
                              speakingMsgId === msg.id ? 'Stop reading aloud' : 'Read response aloud'
                            }
                          >
                            {speakingMsgId === msg.id ? (
                              <>
                                <VolumeX className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                                <span>Stop</span>
                              </>
                            ) : (
                              <>
                                <Volume2 className="w-3.5 h-3.5" />
                                <span>Listen</span>
                              </>
                            )}
                          </button>
                        )}

                        {!isUser && (
                          <button
                            type="button"
                            onClick={() => handleRegenerateMessage(idx)}
                            disabled={isGenerating}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 disabled:opacity-40 transition-colors cursor-pointer"
                            title="Regenerate response"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Regenerate</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div ref={messagesEndRef} className="h-1" />
            </div>
          )}
        </main>

        {/* Bottom Composer (shown when conversation has messages) */}
        {activeSession && activeSession.messages.length > 0 && (
          <div className="relative">
            {showScrollToBottom && (
              <div className="absolute -top-11 left-1/2 -translate-x-1/2 z-20">
                <button
                  type="button"
                  onClick={() => scrollToBottom('smooth', true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/95 dark:bg-slate-900/95 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200/90 dark:border-slate-700/90 shadow-md backdrop-blur-sm text-xs font-medium transition-all cursor-pointer"
                  title="Scroll to latest message"
                  aria-label="Scroll to latest message"
                >
                  {isStreamingResponse ? (
                    <span className="w-2 h-2 rounded-full bg-teal-500 animate-pulse" />
                  ) : null}
                  <span>{isStreamingResponse ? 'Follow live response' : 'Scroll to bottom'}</span>
                  <ArrowDown className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                </button>
              </div>
            )}
            <Composer
              input={input}
              onChangeInput={setInput}
              mode={mode}
              onChangeMode={setMode}
              options={generationOptions}
              onChangeOptions={setGenerationOptions}
              attachments={attachments}
              isProcessingFiles={isProcessingFiles}
              isGenerating={isGenerating}
              onAttachFiles={handleAttachFiles}
              onRemoveAttachment={handleRemoveAttachment}
              onSubmit={() => handleSend()}
              onStop={() => abortControllerRef.current?.abort()}
              onVoiceError={(title, message) => addToast(title, message, 'error')}
              fileInputRef={fileInputRef}
              textareaRef={composerTextareaRef}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
