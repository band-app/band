interface PdfPreviewProps {
  src: string;
  filename: string;
}

export function PdfPreview({ src, filename }: PdfPreviewProps) {
  return (
    <div className="flex h-full flex-col">
      <iframe src={src} title={filename} className="h-full w-full border-0" />
    </div>
  );
}
