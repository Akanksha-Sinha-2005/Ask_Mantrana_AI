import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogIn,
  Mail,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import {
  auth,
  createUserWithEmailAndPassword,
  EMAIL_PATTERN,
  ensureFirestoreUserProfile,
  googleProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../firebase';
import { ChatSession, UserAccount } from '../types';

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
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedUsername = username.trim();

    if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
      setErrorMsg('Please enter a valid email address (for example, you@example.com).');
      return;
    }

    if (
      authTab === 'signup' &&
      (trimmedUsername.length < USERNAME_MIN_LENGTH ||
        trimmedUsername.length > USERNAME_MAX_LENGTH)
    ) {
      setErrorMsg(
        `Please create a username between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`
      );
      return;
    }

    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters long.');
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. Authenticate and persist with our server-backed account store
      const resp = await fetch('/api/account/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: authTab,
          email: normalizedEmail,
          username:
            trimmedUsername || normalizedEmail.split('@')[0] || 'MantranaUser',
          password,
        }),
      });
      const data = await resp.json();

      if (!resp.ok || data.error) {
        setErrorMsg(data.error || 'Could not sign in with this email account.');
        setIsSubmitting(false);
        return;
      }

      let resolvedUser: UserAccount = data.user;
      const serverSessions: ChatSession[] = Array.isArray(data.sessions)
        ? data.sessions
        : [];

      // 2. Also attempt Firebase Auth Email/Password so Firestore sync activates if enabled in Firebase Console
      try {
        if (authTab === 'signup') {
          const cred = await createUserWithEmailAndPassword(
            auth,
            normalizedEmail,
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
            normalizedEmail,
            password
          );
          if (cred.user) {
            if (trimmedUsername && cred.user.displayName !== trimmedUsername) {
              await updateProfile(cred.user, { displayName: trimmedUsername });
            }
            resolvedUser = {
              ...resolvedUser,
              uid: cred.user.uid,
              username:
                trimmedUsername ||
                cred.user.displayName ||
                resolvedUser.username,
            };
            await ensureFirestoreUserProfile(resolvedUser);
          }
        }
      } catch (fbErr: any) {
        const code = String(fbErr?.code || '');
        // If user already exists in Firebase Auth during signup, sign in with Firebase Auth
        if (code === 'auth/email-already-in-use') {
          try {
            const cred = await signInWithEmailAndPassword(
              auth,
              normalizedEmail,
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
        // Note: If Email/Password provider is not yet enabled in Firebase Console (auth/operation-not-allowed),
        // the server + IndexedDB email account persistence handles authentication seamlessly.
      }

      onAuthSuccess(resolvedUser, serverSessions);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Network error while signing in. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const fbUser = cred.user;
      const userEmail = (fbUser.email || '').trim().toLowerCase();
      if (!userEmail) {
        throw new Error('Google account did not return an email address.');
      }

      const desiredUsername =
        username.trim() ||
        fbUser.displayName ||
        userEmail.split('@')[0] ||
        'User';

      const resp = await fetch('/api/account/oauth-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: fbUser.uid,
          email: userEmail,
          username: desiredUsername,
        }),
      });
      const data = await resp.json();

      const account: UserAccount = data.user || {
        uid: fbUser.uid,
        email: userEmail,
        username: desiredUsername,
        createdAt: Date.now(),
      };

      await ensureFirestoreUserProfile(account);
      const serverSessions: ChatSession[] = Array.isArray(data.sessions)
        ? data.sessions
        : [];

      onAuthSuccess(account, serverSessions);
      onClose();
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code !== 'auth/popup-closed-by-user') {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Google Sign-In could not be completed.'
        );
      }
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
              Sign in to Mantrana AI
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Save and sync all your previous chats with your email account
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Close modal (Esc)"
            aria-label="Close sign in modal"
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

          {/* 1. Email Field */}
          <div className="space-y-1">
            <label
              htmlFor="auth-email"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-colors"
              />
            </div>
          </div>

          {/* 2. Username Field */}
          <div className="space-y-1">
            <label
              htmlFor="auth-username"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              {authTab === 'signup' ? 'Create Username' : 'Username'}
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-username"
                type="text"
                required={authTab === 'signup'}
                minLength={USERNAME_MIN_LENGTH}
                maxLength={USERNAME_MAX_LENGTH}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={
                  authTab === 'signup'
                    ? 'Create your username (e.g. akanksha_s)'
                    : 'Enter your username'
                }
                className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-colors"
              />
            </div>
          </div>

          {/* 3. Password Field */}
          <div className="space-y-1">
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
                minLength={6}
                autoComplete={
                  authTab === 'signup' ? 'new-password' : 'current-password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
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
          </div>

          <div className="rounded-xl bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200/70 dark:border-teal-900/60 px-3 py-2 flex items-center gap-2 text-[11px] text-teal-800 dark:text-teal-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>
              Your conversations are automatically saved to your email account so you can access them anytime you sign in.
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
                  {authTab === 'signup' ? 'Creating account…' : 'Signing in…'}
                </span>
              </>
            ) : (
              <>
                {authTab === 'signup' ? (
                  <>
                    <UserPlus className="w-4 h-4" />
                    <span>Create Account & Save Chats</span>
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" />
                    <span>Sign In with Email</span>
                  </>
                )}
              </>
            )}
          </button>

          <div className="relative py-1 flex items-center justify-center">
            <div className="border-t border-slate-200 dark:border-slate-800 w-full" />
            <span className="bg-white dark:bg-slate-900 px-2.5 text-[11px] text-slate-400 uppercase tracking-wider">
              or
            </span>
            <div className="border-t border-slate-200 dark:border-slate-800 w-full" />
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isSubmitting}
            className="w-full py-2 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 text-xs font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <Mail className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            <span>Continue with Google Account</span>
          </button>
        </form>
      </div>
    </div>
  );
};
