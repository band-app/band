import { VideoOff } from "lucide-react";
import { useState } from "react";

interface VideoPreviewProps {
  src: string;
  filename: string;
}

export function VideoPreview({ src, filename }: VideoPreviewProps) {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div
        data-testid="video-preview__error"
        className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <VideoOff className="size-8" />
        Failed to play video
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-4">
      <video
        data-testid="video-preview__player"
        src={src}
        title={filename}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full rounded-md border border-border/50 bg-background"
        onError={() => setError(true)}
      >
        <track kind="captions" />
      </video>
    </div>
  );
}
