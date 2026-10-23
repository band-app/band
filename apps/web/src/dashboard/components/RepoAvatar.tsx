import {
  REPO_AVATAR_COLOR_COUNT,
  repoAvatarColorIndex,
  repoAvatarInitial,
} from "@band-app/shared/repo-avatar";
import { type ReactNode, useState } from "react";
import { hubAssetUrl } from "../../lib/hub-config";
import type { RepoAvatarInfo } from "../types";

interface RepoAvatarProps {
  /** The repo's name, for the fallback's initial and colour. */
  name: string;
  avatar: RepoAvatarInfo | null | undefined;
  /** Rendered until the image has loaded, and instead of it when there is
   *  no avatar or it fails to load (offline with an empty cache). Defaults
   *  to the initial on a colour picked from the name. */
  fallback?: ReactNode;
  /** Size classes for the image and the fallback, e.g. `size-4`. */
  className: string;
  /** Font size of the fallback initial, e.g. `text-sm` with a `size-9` avatar. */
  textClassName?: string;
  testId?: string;
}

/** The fallback: a rounded square in a name-derived colour with the repo's initial. */
export function RepoAvatarFallback({
  name,
  className,
  textClassName = "text-[9px]",
  testId,
}: {
  name: string;
  className: string;
  /** Font size of the initial; scale it with `className`. */
  textClassName?: string;
  testId?: string;
}) {
  const index = repoAvatarColorIndex(name) % REPO_AVATAR_COLOR_COUNT;
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-color-index={index}
      className={`${className} flex shrink-0 select-none items-center justify-center rounded-sm font-semibold leading-none ${textClassName}`}
      style={{
        backgroundColor: `var(--repo-avatar-${index + 1})`,
        color: "var(--repo-avatar-foreground)",
      }}
    >
      {repoAvatarInitial(name)}
    </span>
  );
}

/**
 * A repo's GitHub owner avatar, with an initial on a coloured square as fallback.
 *
 * The fallback stays on screen while the image loads so the row never
 * flashes empty or shows a broken-image glyph. The browser still fetches
 * an image hidden with the `hidden` attribute, so `onLoad` fires and swaps
 * it in.
 */
export function RepoAvatar({
  name,
  avatar,
  fallback,
  className,
  textClassName,
  testId,
}: RepoAvatarProps) {
  // Keyed by `src` so a new version (refreshed cache) or a different
  // repo starts over instead of reusing the previous load state.
  const [loaded, setLoaded] = useState<{ src: string; ok: boolean } | null>(null);
  const shownFallback = fallback ?? (
    <RepoAvatarFallback
      name={name}
      className={className}
      textClassName={textClassName}
      testId={testId ? `${testId}-fallback` : undefined}
    />
  );
  if (!avatar) return <>{shownFallback}</>;

  const state = loaded?.src === avatar.src ? loaded.ok : undefined;
  return (
    <>
      {state !== true && shownFallback}
      {state !== false && (
        <img
          src={hubAssetUrl(avatar.src)}
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
