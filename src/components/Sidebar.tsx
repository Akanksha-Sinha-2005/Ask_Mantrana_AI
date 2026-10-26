import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileCode,
  FileText,
  Keyboard,
  LogIn,
  LogOut,
  MessageSquare,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { ChatSession, UserAccount } from '../types';

export interface QuickActionItem {
  id: string;
  category: string;
  title: string;
  description?: string;
  icon: React.ReactNode;
  onClick: () => void;
}

interface SidebarProps {
  sessions: ChatSession[];
  activeSessionId: string;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  isOpenDesktop?: boolean;
  onToggleDesktop?: () => void;
  forceMobileLayout?: boolean;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onDeleteSession: (id: string) => void;
  quickActions?: QuickActionItem[];
  userAccount?: UserAccount | null;
  onOpenAuthModal?: () => void;
  onSignOut?: () => void;
  canExportChat?: boolean;
  onExportChat?: (format: 'markdown' | 'json') => void;
  onOpenShortcutsModal?: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

function getMatchingMessageSnippet(session: ChatSession, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  for (const msg of session.messages) {
    const raw = (msg.text || '').replace(/\s+/g, ' ').trim();
    const idx = raw.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 24);
      const end = Math.min(raw.length, idx + q.length + 36);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < raw.length ? '…' : '';
      return `${prefix}${raw.slice(start, end)}${suffix}`;
    }

    if (msg.attachments) {
      for (const att of msg.attachments) {
        if (att.name.toLowerCase().includes(q)) {
          return `Attachment: ${att.name}`;
        }
      }
    }
  }
  return null;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);

  return (
    <>
      {before}
      <mark className="bg-teal-500/25 text-teal-900 dark:text-teal-200 rounded-xs px-0.5">
        {match}
      </mark>
      {after}
    </>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  isOpenMobile,
  onCloseMobile,
  isOpenDesktop = true,
  onToggleDesktop,
  forceMobileLayout = false,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onDeleteSession,
  quickActions = [],
  userAccount = null,
  onOpenAuthModal,
  onSignOut,
  canExportChat = false,
  onExportChat,
  onOpenShortcutsModal,
  theme = 'light',
  onToggleTheme,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const trimmedQuery = searchQuery.trim();

  const filteredSessions = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return sessions;

    return sessions.filter((s) => {
      if ((s.title || '').toLowerCase().includes(q)) return true;
      return s.messages.some((m) => {
        if ((m.text || '').toLowerCase().includes(q)) return true;
        if (m.generatedMedia?.prompt?.toLowerCase().includes(q)) return true;
        if (m.attachments?.some((a) => a.name.toLowerCase().includes(q))) return true;
        return false;
      });
    });
  }, [sessions, trimmedQuery]);

  const startEditing = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const commitRename = (id: string, e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.stopPropagation();
    const trimmed = editTitle.trim();
    if (trimmed) {
      onRenameSession(id, trimmed);
    }
    setEditingId(null);
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    const now = new Date();
    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartXRef.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartXRef.current;
    const deltaX = endX - touchStartXRef.current;
    // Swipe left to close mobile drawer
    if (deltaX < -55) {
      onCloseMobile();
    }
    touchStartXRef.current = null;
  };

  const sidebarContent = (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="flex flex-col h-full w-[276px] sm:w-[284px] max-w-[84vw] bg-slate-100/95 dark:bg-slate-900/95 border-r border-slate-200 dark:border-slate-800 select-none pb-safe"
    >
      {/* Top Action Bar */}
      <div className="p-3.5 space-y-2.5 border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onCloseMobile();
            }}
            title="Start a new chat (Ctrl+N)"
            className="flex-1 min-h-[42px] inline-flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <span className="inline-flex items-center gap-2">
              <Plus className="w-4 h-4" />
              <span>New chat</span>
            </span>
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-teal-700/80 text-teal-100 rounded border border-teal-500/50">
              Ctrl+N
            </kbd>
          </button>

          {!forceMobileLayout && onToggleDesktop && (
            <button
              type="button"
              onClick={onToggleDesktop}
              className="hidden lg:inline-flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
              title="Collapse sidebar (Esc or Ctrl+B)"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}

          {isOpenMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              className={`${
                forceMobileLayout ? 'inline-flex' : 'lg:hidden inline-flex'
              } items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0`}
              title="Close sidebar (Esc)"
              aria-label="Close sidebar"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Search Input filtering by chat title or message content */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchQuery('');
              }
            }}
            aria-label="Search past chat sessions by title or message content"
            placeholder="Search chats & messages…"
            className="w-full pl-8 pr-7 py-2 sm:py-1.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm sm:text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              aria-label="Clear search"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Chat List & Quick Actions */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4">
        {quickActions.length > 0 && !trimmedQuery && (
          <div className="space-y-1">
            <div className="px-2 pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <span>Quick Actions</span>
            </div>
            {quickActions.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  item.onClick();
                  onCloseMobile();
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                title={item.description || item.title}
              >
                <div className="w-7 h-7 rounded-lg bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-center shrink-0">
                  {item.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{item.title}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                    {item.category}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-1">
          <div className="px-2 pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>{trimmedQuery ? 'Matching Chats' : 'Recent Chats'}</span>
            <span className="font-mono tabular-nums">
              {trimmedQuery
                ? `${filteredSessions.length}/${sessions.length}`
                : filteredSessions.length}
            </span>
          </div>

          {filteredSessions.length === 0 ? (
            <div className="px-3 py-8 text-center space-y-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {trimmedQuery
                  ? `No chats matching “${trimmedQuery}” in title or messages.`
                  : 'No saved conversations yet.'}
              </p>
              {trimmedQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline cursor-pointer"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            filteredSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isEditing = editingId === session.id;
              const snippet = trimmedQuery
                ? getMatchingMessageSnippet(session, trimmedQuery)
                : null;

              return (
                <div
                  key={session.id}
                  onClick={() => {
                    if (!isEditing) {
                      onSelectSession(session.id);
                      onCloseMobile();
                    }
                  }}
                  className={`group flex items-center justify-between gap-2 px-2.5 py-2.5 sm:py-2 rounded-xl text-sm transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-white dark:bg-slate-800/90 text-slate-900 dark:text-slate-100 border border-slate-200/80 dark:border-slate-700/80'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800/40 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <MessageSquare
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        isActive ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400'
                      }`}
                    />
                    {isEditing ? (
                      <form
                        onSubmit={(e) => commitRename(session.id, e)}
                        className="flex items-center gap-1 flex-1 min-w-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="w-full px-1.5 py-0.5 text-xs rounded bg-slate-100 dark:bg-slate-900 border border-teal-500 text-slate-900 dark:text-slate-100 focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="p-1 text-teal-600 dark:text-teal-400 hover:opacity-80 cursor-pointer"
                          title="Save title"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </form>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p dir="auto" className="text-xs font-medium truncate">
                          {highlightMatch(session.title || 'New conversation', trimmedQuery)}
                        </p>
                        {snippet && (
                          <p
                            dir="auto"
                            className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5"
                          >
                            {highlightMatch(snippet, trimmedQuery)}
                          </p>
                        )}
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono tabular-nums mt-0.5">
                          {formatTimestamp(session.updatedAt)} · {session.messages.length} msg
                        </p>
                      </div>
                    )}
                  </div>

                  {!isEditing && (
                    <div
                      className={`flex items-center gap-0.5 shrink-0 transition-opacity ${
                        isActive
                          ? 'opacity-100'
                          : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => startEditing(session, e)}
                        className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/60 cursor-pointer"
                        title="Rename chat"
                        aria-label="Rename chat"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                        title="Delete chat"
                        aria-label="Delete chat"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Bottom Controls (Export, Shortcuts, Theme) & Email Account Section */}
      <div className="p-3 space-y-2.5 border-t border-slate-200/80 dark:border-slate-800/80 bg-slate-100/60 dark:bg-slate-900/90">
        {/* Three Utility Buttons: Export Chat, Keyboard Shortcuts, Theme Toggle */}
        <div className="grid grid-cols-3 gap-1.5">
          {/* 1. Export Chat Menu */}
          <div ref={exportMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsExportMenuOpen((prev) => !prev)}
              disabled={!canExportChat}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-white dark:bg-slate-800/90 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
              title="Export current chat history as Markdown or JSON"
              aria-label="Export chat history"
            >
              <Download className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
              <span>Export</span>
            </button>

            {isExportMenuOpen && (
              <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg py-1.5 z-50">
                <button
                  type="button"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportChat?.('markdown');
                    onCloseMobile();
                  }}
                  className="w-full px-3.5 py-2 text-left text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <FileText className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span>Export as Markdown (.md)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportChat?.('json');
                    onCloseMobile();
                  }}
                  className="w-full px-3.5 py-2 text-left text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <FileCode className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span>Export as JSON (.json)</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. Keyboard Shortcuts Help Button */}
          <button
            type="button"
            onClick={() => {
              onOpenShortcutsModal?.();
              onCloseMobile();
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-white dark:bg-slate-800/90 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer whitespace-nowrap"
            title="Keyboard shortcuts (Ctrl+/)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>Shortcuts</span>
          </button>

          {/* 3. Theme Toggle Button */}
          <button
            type="button"
            onClick={() => onToggleTheme?.()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-white dark:bg-slate-800/90 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors cursor-pointer whitespace-nowrap"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Light</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5 text-slate-700 shrink-0" />
                <span>Dark</span>
              </>
            )}
          </button>
        </div>

        {userAccount ? (
          <div className="rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/80 p-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-teal-600 text-white font-semibold text-xs flex items-center justify-center shrink-0 uppercase">
                {userAccount.username.slice(0, 1) || <User className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {userAccount.username}
                </p>
                <p
                  className="text-[11px] text-slate-500 dark:text-slate-400 truncate flex items-center gap-1"
                  title={`Signed in as ${userAccount.username}`}
                >
                  <User className="w-3 h-3 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span className="truncate">Signed in · Chats saved</span>
                </p>
              </div>
            </div>
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="p-2 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer shrink-0"
                title="Log out"
                aria-label="Log out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              onOpenAuthModal?.();
              onCloseMobile();
            }}
            className="w-full rounded-xl bg-white dark:bg-slate-800/90 hover:bg-teal-50/70 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 p-2.5 flex items-center gap-2.5 text-left transition-colors cursor-pointer group"
          >
            <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0 group-hover:bg-teal-600 group-hover:text-white transition-colors">
              <LogIn className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Log In / Create Account
              </p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                Sign in with username &amp; password
              </p>
            </div>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Laptop / Desktop persistent collapsible sidebar */}
      {!forceMobileLayout && isOpenDesktop && (
        <aside className="hidden lg:block h-full shrink-0">{sidebarContent}</aside>
      )}

      {/* Mobile & Tablet slide-over drawer (or when forced into Mobile View mode) */}
      {isOpenMobile && (
        <div
          className={`fixed inset-0 z-50 ${
            forceMobileLayout ? 'flex' : 'lg:hidden flex'
          }`}
        >
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
          />
          <aside className="relative z-10 h-full max-w-[85vw] shadow-2xl">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};
