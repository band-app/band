import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTranscriptionForm, detectAudioType } from "../src/speech-transcription.ts";

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

const CLIPS: [string, Uint8Array, string, string][] = [
  ["m4a", bytes([0, 0, 0, 0x1c], "ftypM4A ", [0, 0, 0, 0]), "m4a", "audio/mp4"],
  ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), "webm", "audio/webm"],
  ["ogg", bytes("OggS", [0, 2, 0, 0]), "ogg", "audio/ogg"],
  ["wav", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "), "wav", "audio/wav"],
  ["flac", bytes("fLaC", [0, 0, 0, 0]), "flac", "audio/flac"],
  ["mp3 id3", bytes("ID3", [4, 0, 0, 0, 0]), "mp3", "audio/mpeg"],
  ["mp3 frame", bytes([0xff, 0xfb, 0x90, 0x00]), "mp3", "audio/mpeg"],
];

test("the container is read from the bytes", () => {
  for (const [label, audio, extension, mimeType] of CLIPS) {
    assert.deepEqual(detectAudioType(audio), { extension, mimeType }, label);
  }
});

test("bytes that match nothing, and ADTS AAC, are not detected", () => {
  assert.equal(detectAudioType(bytes("fake webm audio bytes")), null);
  assert.equal(detectAudioType(bytes([0xff, 0xf1, 0x50, 0x80])), null);
  assert.equal(detectAudioType(new Uint8Array(0)), null);
});

test("the form names the file from the bytes whatever the header said", () => {
  for (const header of ["", "application/octet-stream", "audio/webm;codecs=opus"]) {
    for (const [label, audio, extension, mimeType] of CLIPS) {
      const file = buildTranscriptionForm({
        baseUrl: "http://x",
        model: "m",
        audio,
        mimeType: header,
      }).get("file") as File;
      assert.equal(file.name, `audio.${extension}`, `${label} with "${header}"`);
      assert.equal(file.type, mimeType, `${label} with "${header}"`);
    }
  }
});

test("the header's type is used when the bytes match nothing", () => {
  const file = buildTranscriptionForm({
    baseUrl: "http://x",
    model: "m",
    audio: bytes("????"),
    mimeType: "audio/mp4",
  }).get("file") as File;
  assert.equal(file.name, "audio.m4a");
});
