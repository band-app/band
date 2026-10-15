/**
 * Attachments the composer holds before sending. A photo or file the user picks becomes a
 * `ChatEventFile` with a data URL, the shape the web composer sends to `POST /api/chats/:id/messages`.
 */

import { ACCEPTED_MEDIA_TYPES, MAX_ATTACHMENT_BYTES, toWireFile } from "@band-app/client/composer";
import type { ChatEventFile } from "@band-app/shared/chat-events";

export interface Attachment {
  id: string;
  file: ChatEventFile;
  /** Size of the original file in bytes. */
  size: number;
}

export type AttachmentRejection = "too-large" | "unsupported";

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
};

/** The media type the picker reported, or the one the file name's extension implies. */
export function resolveMediaType(reported: string | undefined | null, name: string): string {
  if (reported && reported !== "application/octet-stream") return reported;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? reported ?? "application/octet-stream";
}

/** Why the composer refuses a file, or null when it takes it. */
export function rejectionFor(mediaType: string, size: number): AttachmentRejection | null {
  if (!ACCEPTED_MEDIA_TYPES.includes(mediaType)) return "unsupported";
  if (size > MAX_ATTACHMENT_BYTES) return "too-large";
  return null;
}

export function rejectionMessage(name: string, why: AttachmentRejection): string {
  return why === "too-large"
    ? `${name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`
    : `${name} is not a type the agent can read.`;
}

let counter = 0;

export function makeAttachment(
  name: string,
  mediaType: string,
  base64: string,
  size: number,
): Attachment {
  return { id: `att-${++counter}`, file: toWireFile(mediaType, base64, name), size };
}

/** The wire shape of the attachments, or undefined for none. */
export function toWireFiles(attachments: Attachment[]): ChatEventFile[] | undefined {
  return attachments.length > 0 ? attachments.map((a) => a.file) : undefined;
}
