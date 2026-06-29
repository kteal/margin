import * as path from 'path';

export function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function normalizeNoteText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function validateNoteText(value: string): string | undefined {
  if (!normalizeNoteText(value)) {
    return 'Enter a note.';
  }
  return undefined;
}

export function trimForUi(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function escapeMarkdown(value: string): string {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
