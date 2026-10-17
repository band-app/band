/**
 * Picks photos (library and camera) and documents and returns them as attachments. Each file
 * is read as base64 here, because the web composer also sends files inline as data URLs.
 */

import { ACCEPTED_MEDIA_TYPES } from "@band-app/client/composer";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useCallback } from "react";
import { Alert } from "react-native";
import {
  type Attachment,
  makeAttachment,
  pastedImageResult,
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

  /** Reads the clipboard image. Only call this from a tap: reading it may show iOS's "Allow Paste" prompt. */
  const pasted = useCallback(async (): Promise<Attachment[]> => {
    const image = await Clipboard.getImageAsync({ format: "png" });
    if (!image) {
      Alert.alert("Nothing to paste", "The clipboard no longer holds an image.");
      return [];
    }
    const result = pastedImageResult(image.data, Date.now());
    if ("why" in result) {
      Alert.alert("Can't attach", rejectionMessage(result.name, result.why));
      return [];
    }
    return [result.attachment];
  }, []);

  return { photos, camera, files, pasted };
}
