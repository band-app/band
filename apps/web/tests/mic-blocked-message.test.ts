/**
 * `micBlockedMessageFor` chooses the "microphone blocked" text for the shell and platform the
 * page runs in. It is a pure function of the user agent, touch points and shell, so it is
 * called directly. The e2e `voice-dictation.spec.ts` shows the message in the composer.
 */
import { describe, expect, it } from "vite-plus/test";

import { micBlockedMessageFor } from "../src/lib/voice-recorder";

const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("micBlockedMessageFor", () => {
  it("names System Settings in the desktop app", () => {
    const text = micBlockedMessageFor({
      userAgent: MAC_CHROME,
      maxTouchPoints: 0,
      desktopApp: true,
    });
    expect(text).toContain("System Settings");
    expect(text).not.toContain("address bar");
  });

  it("gives iOS steps, with no desktop-app sentence", () => {
    const text = micBlockedMessageFor({
      userAgent: IPHONE_CHROME,
      maxTouchPoints: 5,
      desktopApp: false,
    });
    expect(text).toContain("site settings");
    expect(text).toContain("Settings > your browser app > Microphone");
    expect(text).not.toContain("desktop app");
    expect(text).not.toContain("System Settings >");
  });

  it("treats an iPad that reports a Mac user agent as iOS", () => {
    const text = micBlockedMessageFor({
      userAgent: MAC_CHROME,
      maxTouchPoints: 5,
      desktopApp: false,
    });
    expect(text).toContain("your browser app");
  });

  it("gives Android steps", () => {
    const text = micBlockedMessageFor({
      userAgent: ANDROID_CHROME,
      maxTouchPoints: 5,
      desktopApp: false,
    });
    expect(text).toContain("Permissions > Microphone");
    expect(text).not.toContain("desktop app");
  });

  it("points a desktop browser at the site settings", () => {
    const text = micBlockedMessageFor({
      userAgent: MAC_CHROME,
      maxTouchPoints: 0,
      desktopApp: false,
    });
    expect(text).toContain("Allow the microphone for this site");
  });
});
