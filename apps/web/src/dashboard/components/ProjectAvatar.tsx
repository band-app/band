import { type ReactNode, useState } from "react";
import type { ProjectAvatarInfo } from "../types";

interface ProjectAvatarProps {
  avatar: ProjectAvatarInfo | null | undefined;
  /** Rendered until the image has loaded, and instead of it when there is
   *  no avatar or it fails to load (offline with an empty cache). */
  fallback: ReactNode;
  /** Size and shape classes for the image, e.g. `size-4`. */
  className: string;
  testId?: string;
}

/**
 * A project's GitHub owner avatar, with the existing icon as fallback.
 *
 * The fallback stays on screen while the image loads so the row never
 * flashes empty or shows a broken-image glyph. The browser still fetches
 * an image hidden with the `hidden` attribute, so `onLoad` fires and swaps
 * it in.
 */
export function ProjectAvatar({ avatar, fallback, className, testId }: ProjectAvatarProps) {
  // Keyed by `src` so a new version (refreshed cache) or a different
  // project starts over instead of reusing the previous load state.
  const [loaded, setLoaded] = useState<{ src: string; ok: boolean } | null>(null);
  if (!avatar) return <>{fallback}</>;

  const state = loaded?.src === avatar.src ? loaded.ok : undefined;
  return (
    <>
      {state !== true && fallback}
      {state !== false && (
        <img
          src={avatar.src}
          alt={avatar.label}
          hidden={state !== true}
          draggable={false}
          data-testid={testId}
          // A cached image can finish loading before React attaches
          // `onLoad` (e.g. during hydration); read its state directly.
          ref={(el) => {
            if (el?.complete && state === undefined) {
              setLoaded({ src: avatar.src, ok: el.naturalWidth > 0 });
            }
          }}
          className={`${className} shrink-0 rounded-sm object-cover`}
          onLoad={() => setLoaded({ src: avatar.src, ok: true })}
          onError={() => setLoaded({ src: avatar.src, ok: false })}
        />
      )}
    </>
  );
}
