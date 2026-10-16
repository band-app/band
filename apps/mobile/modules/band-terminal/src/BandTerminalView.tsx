import { requireNativeView } from "expo";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export interface BandTerminalHandle {
  /** Feeds output bytes to the screen. Resolves once the screen has parsed them. */
  write(bytes: Uint8Array): Promise<void>;
  /** Clears the screen and the scrollback. */
  reset(): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
}

export interface BandTerminalProps {
  style?: StyleProp<ViewStyle>;
  fontSize?: number;
  /** `#rrggbb`. */
  background?: string;
  /** `#rrggbb`. */
  foreground?: string;
  /** Keystrokes and pastes, as the text to send to the shell. */
  onInput?: (data: string) => void;
  /** The grid the view fits in its frame, now and after each layout change. */
  onSize?: (size: { cols: number; rows: number }) => void;
  onTitle?: (title: string) => void;
  onBell?: () => void;
  onOpenLink?: (url: string) => void;
}

interface NativeHandle {
  write(base64: string): Promise<void>;
  reset(): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
}

const NativeView = requireNativeView("BandTerminal") as React.ComponentType<
  Record<string, unknown> & { ref?: React.Ref<NativeHandle> }
>;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x1000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The platform-neutral terminal view: iOS draws it with SwiftTerm. */
export const BandTerminalView = forwardRef<BandTerminalHandle, BandTerminalProps>(
  function BandTerminalView({ onInput, onSize, onTitle, onBell, onOpenLink, ...rest }, ref) {
    const native = useRef<NativeHandle>(null);
    useImperativeHandle(
      ref,
      () => ({
        write: (bytes) => native.current?.write(toBase64(bytes)) ?? Promise.resolve(),
        reset: () => native.current?.reset() ?? Promise.resolve(),
        focus: () => native.current?.focus() ?? Promise.resolve(),
        blur: () => native.current?.blur() ?? Promise.resolve(),
      }),
      [],
    );
    return (
      <NativeView
        ref={native}
        {...rest}
        onInput={(e: { nativeEvent: { data: string } }) => onInput?.(e.nativeEvent.data)}
        onSize={(e: { nativeEvent: { cols: number; rows: number } }) => onSize?.(e.nativeEvent)}
        onTitle={(e: { nativeEvent: { title: string } }) => onTitle?.(e.nativeEvent.title)}
        onBell={() => onBell?.()}
        onOpenLink={(e: { nativeEvent: { url: string } }) => onOpenLink?.(e.nativeEvent.url)}
      />
    );
  },
);
