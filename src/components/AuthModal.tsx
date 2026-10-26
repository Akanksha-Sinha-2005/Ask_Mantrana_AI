import React, { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogIn,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import {
  auth,
  createUserWithEmailAndPassword,
  ensureFirestoreUserProfile,
  PASSWORD_MIN_LENGTH,
  signInWithEmailAndPassword,
  updateProfile,
  USERNAME_ALPHANUMERIC_PATTERN,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../firebase';
import { ChatSession, UserAccount } from '../types';
import { getRegisteredAccounts, saveRegisteredAccount } from '../utils/db';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (account: UserAccount, serverSessions: ChatSession[]) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthSuccess,
}) => {
  const [authTab, setAuthTab] = useState<'signup' | 'login'>('signup');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const trimmedUsername = username.trim();
  const isUsernameLengthOk =
    trimmedUsername.length >= USERNAME_MIN_LENGTH &&
    trimmedUsername.length <= USERNAME_MAX_LENGTH;
  const isUsernameAlphanumeric = USERNAME_ALPHANUMERIC_PATTERN.test(trimmedUsername);
  const isUsernameValid = isUsernameLengthOk && isUsernameAlphanumeric;

  const hasMinLength = password.length >= PASSWORD_MIN_LENGTH;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecialChar = /[^a-zA-Z0-9\s]/.test(password);
  const isPasswordValid =
    hasMinLength && hasLetter && hasDigit && hasSpecialChar;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!trimmedUsername) {
      setErrorMsg('Please enter a username.');
      return;
    }

    if (!isUsernameLengthOk) {
      setErrorMsg(
        `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters long.`
      );
      return;
    }

    if (!isUsernameAlphanumeric) {
      setErrorMsg(
        'Username must contain characters (letters) and numbers only (no spaces or special characters).'
      );
      return;
    }

    if (authTab === 'signup') {
      if (!hasMinLength) {
        setErrorMsg(
          `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`
        );
        return;
      }
      if (!hasLetter || !hasDigit || !hasSpecialChar) {
        setErrorMsg(
          'Password must be at least 8 characters long and include at least 1 character (letter), 1 digit, and 1 special character.'
        );
        return;
      }
    } else if (!password) {
      setErrorMsg('Please enter your password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const knownAccounts = getRegisteredAccounts();

      // 1. Authenticate and persist with our server-backed account store (enforcing unique username & unique password)
      const resp = await fetch('/api/account/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: authTab,
          username: trimmedUsername,
          password,
          knownAccounts,
        }),
      });
      const data = await resp.json();

      if (!resp.ok || data.error) {
        setErrorMsg(
          data.error ||
            (authTab === 'signup'
              ? 'This username or password already exists.'
              : 'Could not log in with these credentials.')
        );
        setIsSubmitting(false);
        return;
      }

      let resolvedUser: UserAccount = data.user;
      const serverSessions: ChatSession[] = Array.isArray(data.sessions)
        ? data.sessions
        : [];

      if (data.passwordHash && resolvedUser) {
        saveRegisteredAccount({
          uid: resolvedUser.uid,
          username: resolvedUser.username,
          email: resolvedUser.email,
          passwordHash: data.passwordHash,
          createdAt: resolvedUser.createdAt,
        });
      }

      // 2. Background Firebase Auth sync using internal synthesized identifier (user is never asked for email)
      const internalEmail =
        resolvedUser.email ||
        `${trimmedUsername.toLowerCase()}@mantrana.local`;
      try {
        if (authTab === 'signup') {
          const cred = await createUserWithEmailAndPassword(
            auth,
            internalEmail,
            password
          );
          if (cred.user) {
            await updateProfile(cred.user, {
              displayName: resolvedUser.username,
            });
            resolvedUser = {
              ...resolvedUser,
              uid: cred.user.uid,
            };
            await ensureFirestoreUserProfile(resolvedUser);
          }
        } else {
          const cred = await signInWithEmailAndPassword(
            auth,
            internalEmail,
            password
          );
          if (cred.user) {
            resolvedUser = {
              ...resolvedUser,
              uid: cred.user.uid,
              username: cred.user.displayName || resolvedUser.username,
            };
            await ensureFirestoreUserProfile(resolvedUser);
          }
        }
      } catch (fbErr: any) {
        const code = String(fbErr?.code || '');
        if (code === 'auth/email-already-in-use') {
          try {
            const cred = await signInWithEmailAndPassword(
              auth,
              internalEmail,
              password
            );
            if (cred.user) {
              resolvedUser = { ...resolvedUser, uid: cred.user.uid };
              await ensureFirestoreUserProfile(resolvedUser);
            }
          } catch {
            // Fall back to server account session
          }
        }
      }

      onAuthSuccess(resolvedUser, serverSessions);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Network error while authenticating. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-xs"
    >
      <div
        className="relative w-full sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl pb-safe"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 sm:px-6 pt-5 pb-3.5 border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md z-10">
          <div>
            <h2 className="text-base font-bold font-display text-slate-900 dark:text-white">
              {authTab === 'signup'
                ? 'Create Account on Mantrana AI'
                : 'Log In to Mantrana AI'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Close modal (Esc)"
            aria-label="Close account modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="px-6 pt-4">
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200/70 dark:border-slate-700/60">
            <button
              type="button"
              onClick={() => {
                setAuthTab('signup');
                setErrorMsg(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                authTab === 'signup'
                  ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create Account</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthTab('login');
                setErrorMsg(null);
              }}
              className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                authTab === 'login'
                  ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Log In</span>
            </button>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3.5">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900/70 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 1. Username Field (Characters & Numbers Only) */}
          <div className="space-y-1.5">
            <label
              htmlFor="auth-username"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Username
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-username"
                type="text"
                required
                minLength={USERNAME_MIN_LENGTH}
                maxLength={USERNAME_MAX_LENGTH}
                autoComplete="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="e.g. abc123"
                className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-colors"
              />
            </div>
            {authTab === 'signup' && (
              <p
                className={`text-[11px] flex items-center gap-1.5 ${
                  !trimmedUsername
                    ? 'text-slate-500 dark:text-slate-400'
                    : isUsernameValid
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                <Check
                  className={`w-3 h-3 shrink-0 ${
                    isUsernameValid ? 'opacity-100' : 'opacity-40'
                  }`}
                />
                <span>
                  Use letters (A–Z, a–z) and numbers (0–9) only — no spaces or symbols
                </span>
              </p>
            )}
          </div>

          {/* 2. Password Field */}
          <div className="space-y-1.5">
            <label
              htmlFor="auth-password"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              {authTab === 'signup' ? 'Create Password' : 'Password'}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={authTab === 'signup' ? PASSWORD_MIN_LENGTH : 1}
                autoComplete={
                  authTab === 'signup' ? 'new-password' : 'current-password'
                }
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="********"
                className="w-full pl-9 pr-10 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>

            {authTab === 'signup' && (
              <div className="grid grid-cols-2 gap-1.5 pt-1 text-[11px]">
                {[
                  { label: 'At least 8 characters', met: hasMinLength },
                  { label: 'At least 1 letter (a–z)', met: hasLetter },
                  { label: 'At least 1 digit (0–9)', met: hasDigit },
                  { label: 'At least 1 special char', met: hasSpecialChar },
                ].map((req) => (
                  <div
                    key={req.label}
                    className={`flex items-center gap-1.5 ${
                      !password
                        ? 'text-slate-500 dark:text-slate-400'
                        : req.met
                          ? 'text-teal-600 dark:text-teal-400 font-medium'
                          : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    <Check
                      className={`w-3 h-3 shrink-0 ${
                        req.met ? 'opacity-100' : 'opacity-35'
                      }`}
                    />
                    <span>{req.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200/70 dark:border-teal-900/60 px-3 py-2 flex items-center gap-2 text-[11px] text-teal-800 dark:text-teal-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>
              No two users can share the same username or password. Your conversations are saved automatically to your account.
            </span>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2.5 px-4 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>
                  {authTab === 'signup' ? 'Creating account…' : 'Logging in…'}
                </span>
              </>
            ) : (
              <>
                {authTab === 'signup' ? (
                  <>
                    <UserPlus className="w-4 h-4" />
                    <span>Create Account</span>
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" />
                    <span>Log In</span>
                  </>
                )}
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
