import type { LucideIcon } from "lucide-react";
import {
  Braces,
  Database,
  File,
  FileCode2,
  FileJson,
  FileText,
  Globe,
  Image,
  Lock,
  Music,
  Package,
  Settings,
  Terminal,
  Video,
} from "lucide-react";

const extensionIconMap: Record<string, LucideIcon> = {
  // Code files
  ts: FileCode2,
  tsx: FileCode2,
  js: FileCode2,
  jsx: FileCode2,
  mjs: FileCode2,
  cjs: FileCode2,
  py: FileCode2,
  rb: FileCode2,
  go: FileCode2,
  rs: FileCode2,
  java: FileCode2,
  kt: FileCode2,
  swift: FileCode2,
  c: FileCode2,
  cpp: FileCode2,
  h: FileCode2,
  hpp: FileCode2,
  cs: FileCode2,
  php: FileCode2,
  r: FileCode2,
  lua: FileCode2,
  zig: FileCode2,

  // Web / markup
  html: Globe,
  htm: Globe,
  css: Braces,
  scss: Braces,
  less: Braces,
  sass: Braces,
  vue: FileCode2,
  svelte: FileCode2,

  // Data / config
  json: FileJson,
  jsonc: FileJson,
  json5: FileJson,
  yaml: FileText,
  yml: FileText,
  toml: FileText,
  ini: FileText,
  xml: FileText,
  csv: FileText,

  // Text / docs
  md: FileText,
  mdx: FileText,
  txt: FileText,
  rst: FileText,
  tex: FileText,
  log: FileText,

  // Shell / scripts
  sh: Terminal,
  bash: Terminal,
  zsh: Terminal,
  fish: Terminal,
  ps1: Terminal,
  bat: Terminal,
  cmd: Terminal,

  // Images
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  svg: Image,
  webp: Image,
  ico: Image,
  bmp: Image,
  avif: Image,

  // Audio
  mp3: Music,
  wav: Music,
  ogg: Music,
  flac: Music,
  aac: Music,

  // Video
  mp4: Video,
  webm: Video,
  mov: Video,
  avi: Video,
  mkv: Video,

  // Database
  sql: Database,
  sqlite: Database,
  db: Database,

  // Config / dotfiles
  env: Settings,
  editorconfig: Settings,
  prettierrc: Settings,
  eslintrc: Settings,

  // Lock files
  lock: Lock,

  // Package / archive
  zip: Package,
  tar: Package,
  gz: Package,
  tgz: Package,
  bz2: Package,
  xz: Package,
  "7z": Package,
  rar: Package,
  wasm: Package,
};

/** Well-known filenames that map to a specific icon regardless of extension */
const filenameIconMap: Record<string, LucideIcon> = {
  dockerfile: Settings,
  "docker-compose.yml": Settings,
  "docker-compose.yaml": Settings,
  makefile: Terminal,
  rakefile: Terminal,
  procfile: Terminal,
  ".gitignore": Settings,
  ".gitattributes": Settings,
  ".npmrc": Settings,
  ".nvmrc": Settings,
  ".prettierrc": Settings,
  ".eslintrc": Settings,
  ".editorconfig": Settings,
  ".env": Settings,
  ".env.local": Settings,
  ".env.development": Settings,
  ".env.production": Settings,
};

/**
 * Returns the appropriate lucide-react icon component for a given filename.
 * Falls back to the generic File icon for unrecognized extensions.
 */
export function getFileIcon(filename: string): LucideIcon {
  const lower = filename.toLowerCase();

  // Check full filename first (e.g. Dockerfile, Makefile)
  const basename = lower.split("/").pop() ?? lower;
  if (filenameIconMap[basename]) {
    return filenameIconMap[basename];
  }

  // Check extension
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex !== -1) {
    const ext = basename.slice(dotIndex + 1);
    if (extensionIconMap[ext]) {
      return extensionIconMap[ext];
    }
  }

  return File;
}
