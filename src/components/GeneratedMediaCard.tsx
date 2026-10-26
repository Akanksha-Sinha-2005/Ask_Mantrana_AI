import React, { useMemo } from 'react';
import { Download, Film, Image as ImageIcon, Loader2, Music, Wand2 } from 'lucide-react';
import { GeneratedMedia, VideoProgressState } from '../types';

interface GeneratedMediaCardProps {
  media?: GeneratedMedia;
  videoProgress?: VideoProgressState;
  onEditImage?: (media: GeneratedMedia) => void;
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch {
    return `data:${mimeType};base64,${base64}`;
  }
}

export const GeneratedMediaCard: React.FC<GeneratedMediaCardProps> = ({
  media,
  videoProgress,
  onEditImage,
}) => {
  const mediaUrl = useMemo(() => {
    if (!media) return '';
    if (media.base64Data) {
      if (media.type === 'image' || media.mimeType.includes('svg')) {
        return `data:${media.mimeType || 'image/png'};base64,${media.base64Data}`;
      }
      return base64ToBlobUrl(media.base64Data, media.mimeType);
    }
    return media.uri || '';
  }, [media]);

  if (videoProgress && videoProgress.status !== 'completed') {
    return (
      <div className="my-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Generating video with Omni Flash (gemini-omni-1.1-flash)…
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {videoProgress.latestNote ||
                  (videoProgress.status === 'starting'
                    ? 'Submitting video generation job via Gemini Interactions API'
                    : `Polling asynchronous video operation · ${videoProgress.stepCount} step(s) processed`)}
              </p>
            </div>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
            {videoProgress.elapsedSeconds}s
          </span>
        </div>
        <div className="mt-3 w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-teal-600 dark:bg-teal-500 transition-all duration-300"
            style={{
              width: `${Math.min(92, Math.max(12, videoProgress.elapsedSeconds * 3))}%`,
            }}
          />
        </div>
      </div>
    );
  }

  if (!media || !mediaUrl) return null;

  const extension = media.mimeType.includes('svg')
    ? 'svg'
    : media.type === 'image'
      ? media.mimeType.includes('jpeg')
        ? 'jpg'
        : 'png'
      : media.type === 'video'
        ? 'mp4'
        : 'wav';

  const downloadFilename = `mantrana-${media.type}-${Date.now()}.${extension}`;

  return (
    <div className="my-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      {media.type === 'image' && (
        <div className="bg-slate-100 dark:bg-slate-950 flex items-center justify-center max-h-[520px] overflow-hidden">
          <img
            src={mediaUrl}
            alt={media.prompt || 'Generated image'}
            referrerPolicy="no-referrer"
            className="max-h-[520px] w-auto object-contain"
          />
        </div>
      )}

      {media.type === 'video' && (
        <div className="bg-black flex items-center justify-center">
          {media.mimeType.includes('svg') ? (
            <img
              src={mediaUrl}
              alt={media.prompt || 'Generated animated scene'}
              className="w-full max-h-[480px] object-contain"
            />
          ) : (
            <video
              src={mediaUrl}
              controls
              playsInline
              className="w-full max-h-[480px] object-contain"
            />
          )}
        </div>
      )}

      {media.type === 'music' && (
        <div className="p-4 bg-slate-50 dark:bg-slate-900/60 space-y-3">
          <div className="flex items-center gap-2.5 text-xs text-slate-600 dark:text-slate-400">
            <Music className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
            <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
              {media.prompt}
            </span>
          </div>
          <audio src={mediaUrl} controls className="w-full h-10" />
          {media.lyrics && (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
              {media.lyrics}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate">
          {media.type === 'image' && <ImageIcon className="w-3.5 h-3.5 shrink-0" />}
          {media.type === 'video' && <Film className="w-3.5 h-3.5 shrink-0" />}
          {media.type === 'music' && <Music className="w-3.5 h-3.5 shrink-0" />}
          <span className="capitalize">{media.type}</span>
          {media.aspectRatio && (
            <>
              <span aria-hidden="true">·</span>
              <span>{media.aspectRatio}</span>
            </>
          )}
          {media.imageSize && (
            <>
              <span aria-hidden="true">·</span>
              <span>{media.imageSize}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="truncate">{media.mimeType}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {media.type === 'image' && media.base64Data && onEditImage && (
            <button
              type="button"
              onClick={() => onEditImage(media)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer whitespace-nowrap"
              title="Use this image as reference to edit with gemini-nano-banana-2.1"
            >
              <Wand2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              <span>Edit Image</span>
            </button>
          )}

          <a
            href={mediaUrl}
            download={downloadFilename}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </a>
        </div>
      </div>
    </div>
  );
};
