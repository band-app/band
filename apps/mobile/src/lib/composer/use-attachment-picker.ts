/**
 * Picks photos (library and camera) and documents and returns them as attachments. Each file
 * is read as base64 here, because the web composer also sends files inline as data URLs.
 */

import { ACCEPTED_MEDIA_TYPES } from "@band-app/client/composer";
import type { PastedFile } from "@mattermost/react-native-paste-input";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useCallback } from "react";
import { Alert } from "react-native";
import {
  type Attachment,
  makeAttachment,
  pastedFileName,
  rejectionFor,
  rejectionMessage,
  resolveMediaType,
} from "./attachments";
import { blobToBase64 } from "./blob-bytes";

/** Reads a picked file as base64 through fetch and FileReader, which React Native supports for file URIs. */
async function readBase64(uri: string): Promise<string> {
  return blobToBase64(await (await fetch(uri)).blob());
}

function accept(
  out: Attachment[],
  name: string,
  mediaType: string,
  size: number,
  base64: string,
): void {
  const why = rejectionFor(mediaType, size);
  if (why) Alert.alert("Can't attach", rejectionMessage(name, why));
  else out.push(makeAttachment(name, mediaType, base64, size));
}

async function fromImages(result: ImagePicker.ImagePickerResult): Promise<Attachment[]> {
  const out: Attachment[] = [];
  if (result.canceled) return out;
  for (const asset of result.assets) {
    const name = asset.fileName ?? `photo-${Date.now()}.jpg`;
    const mediaType = resolveMediaType(asset.mimeType, name);
    const base64 = asset.base64 ?? (await readBase64(asset.uri));
    // base64 is 4/3 of the bytes; `fileSize` is missing for some sources.
    accept(out, name, mediaType, asset.fileSize ?? Math.floor((base64.length * 3) / 4), base64);
  }
  return out;
}

export function useAttachmentPicker() {
  const photos = useCallback(async (): Promise<Attachment[]> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.8,
      base64: true,
    });
    return fromImages(result);
  }, []);

  const camera = useCallback(async (): Promise<Attachment[]> => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera is off", "Allow camera access for Band in Settings to take a photo.");
      return [];
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8, base64: true });
    return fromImages(result);
  }, []);

  const files = useCallback(async (): Promise<Attachment[]> => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ACCEPTED_MEDIA_TYPES,
      multiple: true,
      copyToCacheDirectory: true,
    });
    const out: Attachment[] = [];
    if (result.canceled) return out;
    for (const asset of result.assets) {
      const mediaType = resolveMediaType(asset.mimeType, asset.name);
      const size = asset.size ?? 0;
      // Refuse before reading: base64 of a huge file would sit in memory for nothing.
      const why = rejectionFor(mediaType, size);
      if (why) Alert.alert("Can't attach", rejectionMessage(asset.name, why));
      else accept(out, asset.name, mediaType, size, await readBase64(asset.uri));
    }
    return out;
  }, []);

  /** Turns the files the composer field reports from a paste into attachments, with a picked photo's limits. */
  const pasted = useCallback(async (pasted: PastedFile[]): Promise<Attachment[]> => {
    const out: Attachment[] = [];
    const now = Date.now();
    for (const [index, file] of pasted.entries()) {
      const mediaType = resolveMediaType(file.type, file.fileName);
      const isImage = mediaType.startsWith("image/");
      // Rich text and other data a text paste carries is not an attachment, so it is skipped quietly.
      if (!isImage && !ACCEPTED_MEDIA_TYPES.includes(mediaType)) continue;
      const name = isImage ? pastedFileName(now, mediaType, index) : file.fileName;
      // Refuse before reading, like a picked file.
      const why = rejectionFor(mediaType, file.fileSize);
      if (why) Alert.alert("Can't attach", rejectionMessage(name, why));
      else accept(out, name, mediaType, file.fileSize, await readBase64(file.uri));
    }
    return out;
  }, []);

  return { photos, camera, files, pasted };
}
