import { type ImgHTMLAttributes, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { streamdownComponents, streamdownPlugins } from "../../../components/streamdown-components";
import { hubAssetUrl } from "../../../lib/hub-config";

const MEDIA_IMAGE = /(!\[[^\]\n]*\]\()band:\/\/media\/([0-9a-f]{64})(?=[)\s])/g;

/**
 * Points the image links `![alt](band://media/<id>)` at the hub. Only image syntax is
 * rewritten: on a cross-origin hub the URL carries the device token, so a link or code
 * span that names a media id must stay as written and never show it.
 */
export function mediaSrc(source: string): string {
  return source.replace(
    MEDIA_IMAGE,
    (_all, head: string, id: string) => `${head}${hubAssetUrl(`/media/${id}`)}`,
  );
}

/** An image link, or a video when the blob is not an image (a `![demo](band://media/<id>)` mp4 or webm). */
function ContextMedia(props: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  // Keyed on the source so a reused instance starts as an image again.
  return <ContextMediaItem key={String(props.src)} {...props} />;
}

function ContextMediaItem({
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
const COMPONENTS = { ...streamdownComponents, img: ContextMedia };

export function ContextMarkdown({ source }: { source: string }) {
  const text = useMemo(() => mediaSrc(source), [source]);
  return (
    <Streamdown
      className="break-words text-sm leading-relaxed [overflow-wrap:anywhere]"
      plugins={streamdownPlugins}
      components={COMPONENTS}
    >
      {text}
    </Streamdown>
  );
}
