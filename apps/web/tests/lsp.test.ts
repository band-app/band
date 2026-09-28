import { describe, expect, it } from "vitest";
import { createFrameParser, frameMessage } from "../src/server/infra/lsp/lsp-proxy";

// ---------------------------------------------------------------------------
// Content-Length framing tests
// ---------------------------------------------------------------------------

describe("frameMessage", () => {
  it("wraps a JSON string with Content-Length header", () => {
    const json = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const framed = frameMessage(json);
    const str = framed.toString("utf-8");

    expect(str).toContain("Content-Length:");
    expect(str).toContain("\r\n\r\n");

    // Extract the Content-Length value and verify it matches the body
    const [header, body] = str.split("\r\n\r\n");
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/);
    expect(lengthMatch).toBeTruthy();
    const declaredLength = Number.parseInt(lengthMatch![1], 10);
    expect(Buffer.from(body, "utf-8").byteLength).toBe(declaredLength);
    expect(body).toBe(json);
  });

  it("handles multi-byte UTF-8 characters correctly", () => {
    const json = '{"text":"hello 世界"}';
    const framed = frameMessage(json);
    const str = framed.toString("utf-8");

    const [header, body] = str.split("\r\n\r\n");
    const declaredLength = Number.parseInt(header.match(/Content-Length:\s*(\d+)/)![1], 10);
    // Content-Length is byte length, not character length
    expect(declaredLength).toBe(Buffer.from(json, "utf-8").byteLength);
    expect(body).toBe(json);
  });
});

describe("createFrameParser", () => {
  it("parses a single complete message", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json = '{"jsonrpc":"2.0","id":1,"result":null}';
    const frame = frameMessage(json);
    parse(frame);

    expect(messages).toEqual([json]);
  });

  it("parses multiple messages in a single chunk", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json1 = '{"id":1}';
    const json2 = '{"id":2}';
    const combined = Buffer.concat([frameMessage(json1), frameMessage(json2)]);
    parse(combined);

    expect(messages).toEqual([json1, json2]);
  });

  it("handles messages split across chunks", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}';
    const frame = frameMessage(json);

    // Split the frame at an arbitrary byte boundary
    const splitPoint = Math.floor(frame.byteLength / 2);
    parse(frame.subarray(0, splitPoint));
    expect(messages).toHaveLength(0); // Not yet complete

    parse(frame.subarray(splitPoint));
    expect(messages).toEqual([json]);
  });

  it("handles header split across chunks", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json = '{"id":1}';
    const frame = frameMessage(json);

    // Split in the middle of the header
    parse(frame.subarray(0, 10));
    expect(messages).toHaveLength(0);

    parse(frame.subarray(10));
    expect(messages).toEqual([json]);
  });

  it("handles partial body followed by the rest", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json = '{"result":"some long string with lots of content here"}';
    const frame = frameMessage(json);

    // Give it the full header plus partial body
    const headerEnd = frame.indexOf(Buffer.from("\r\n\r\n")) + 4;
    const bodyPartial = headerEnd + 5;

    parse(frame.subarray(0, bodyPartial));
    expect(messages).toHaveLength(0);

    parse(frame.subarray(bodyPartial));
    expect(messages).toEqual([json]);
  });

  it("handles three messages where the second is split across chunks", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));

    const json1 = '{"id":1}';
    const json2 = '{"id":2,"result":"test"}';
    const json3 = '{"id":3}';

    const frame1 = frameMessage(json1);
    const frame2 = frameMessage(json2);
    const frame3 = frameMessage(json3);

    const splitPoint = Math.floor(frame2.byteLength / 2);

    // Chunk 1: all of msg1 + first half of msg2
    parse(Buffer.concat([frame1, frame2.subarray(0, splitPoint)]));
    expect(messages).toEqual([json1]);

    // Chunk 2: second half of msg2 + all of msg3
    parse(Buffer.concat([frame2.subarray(splitPoint), frame3]));
    expect(messages).toEqual([json1, json2, json3]);
  });

  it("handles empty buffer gracefully", () => {
    const messages: string[] = [];
    const parse = createFrameParser((json) => messages.push(json));
    parse(Buffer.alloc(0));
    expect(messages).toHaveLength(0);
  });
});
