import { ImageOff } from "lucide-react";
import { useState } from "react";

interface ImagePreviewProps {
  src: string;
  alt: string;
}

export function ImagePreview({ src, alt }: ImagePreviewProps) {
  const [error, setError] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <ImageOff className="size-8" />
        Failed to load image
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-auto p-4">
      <div
        className="inline-flex rounded-md border border-border/50"
        style={{
          backgroundImage: [
            "linear-gradient(45deg, var(--color-muted) 25%, transparent 25%)",
            "linear-gradient(-45deg, var(--color-muted) 25%, transparent 25%)",
            "linear-gradient(45deg, transparent 75%, var(--color-muted) 75%)",
            "linear-gradient(-45deg, transparent 75%, var(--color-muted) 75%)",
          ].join(", "),
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
        }}
      >
        <img
          src={src}
          alt={alt}
          className="max-h-[70vh] max-w-full object-contain"
          onError={() => setError(true)}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
      </div>
      {dimensions && (
        <span className="mt-2 text-xs text-muted-foreground">
          {dimensions.w} &times; {dimensions.h}
        </span>
      )}
    </div>
  );
}
