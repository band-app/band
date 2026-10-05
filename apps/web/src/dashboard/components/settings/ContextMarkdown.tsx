import { type ImgHTMLAttributes, useState } from "react";
import { Streamdown } from "streamdown";
import { streamdownComponents, streamdownPlugins } from "../../../components/streamdown-components";
import { hubAssetUrl } from "../../../lib/hub-config";

const MEDIA_LINK = /band:\/\/media\/[0-9a-f]{64}/g;

/** The URL a `band://media/<id>` link loads from. Other strings come back unchanged. */
export function mediaSrc(src: string): string {
  return src.replace(MEDIA_LINK, (link) =>
    hubAssetUrl(`/media/${link.slice("band://media/".length)}`),
  );
}

/** An image link, or a video when the blob is not an image (a `![demo](band://media/<id>)` mp4 or webm). */
function ContextMedia({
  src,
  alt,
  node: _node,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const [asVideo, setAsVideo] = useState(false);
  if (!src || typeof src !== "string") return null;
  if (asVideo) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a context's videos are screen recordings with no track
      <video
        src={src}
        controls
        className="max-w-full rounded-md"
        data-testid="context-browser__video"
      />
    );
  }
  return (
    <img
      {...rest}
      src={src}
      alt={alt ?? ""}
      className="max-w-full rounded-md"
      data-testid="context-browser__image"
      onError={() => setAsVideo(true)}
    />
  );
}

/** Renders a context file's markdown with its `band://media` images and videos loaded from the hub. */
export function ContextMarkdown({ source }: { source: string }) {
  return (
    <Streamdown
      className="break-words text-sm leading-relaxed [overflow-wrap:anywhere]"
      plugins={streamdownPlugins}
      components={{ ...streamdownComponents, img: ContextMedia }}
    >
      {mediaSrc(source)}
    </Streamdown>
  );
}
