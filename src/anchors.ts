import * as vscode from 'vscode';

import { clamp } from './utils';
import { NoteAnchor, ResolvedAnchor, SerializedPosition } from './types';

export function createAnchor(document: vscode.TextDocument, selection: vscode.Selection): NoteAnchor {
  const isRange = !selection.isEmpty;
  const normalizedRange = normalizeSelectionRange(selection);
  const range = isRange ? normalizedRange : document.lineAt(selection.active.line).range;
  const originalText = document.getText(range);
  const startLine = range.start.line;
  const endLine = range.end.line;

  return {
    kind: isRange ? 'range' : 'line',
    start: serializePosition(range.start),
    end: serializePosition(range.end),
    originalText,
    contextBefore: collectContext(document, startLine, -1),
    contextAfter: collectContext(document, endLine, 1)
  };
}

export function resolveAnchor(document: vscode.TextDocument, anchor: NoteAnchor | undefined): ResolvedAnchor | undefined {
  if (!anchor) {
    return undefined;
  }

  const storedRange = deserializeRange(anchor, document);
  if (storedRange && rangeTextMatches(document, storedRange, anchor)) {
    return { range: storedRange, confident: true };
  }

  if (anchor.kind === 'range' && anchor.originalText) {
    const exact = findTextRange(document, anchor.originalText, anchor.start?.line ?? 0);
    if (exact) {
      return { range: exact, confident: true };
    }
  }

  if (anchor.kind === 'line' && anchor.originalText) {
    const line = findBestMatchingLine(document, anchor.originalText, anchor.start?.line ?? 0, anchor);
    if (line !== undefined) {
      const range = document.lineAt(line).range;
      return { range, confident: true };
    }
  }

  if (storedRange && storedRange.start.line < document.lineCount) {
    return { range: storedRange, confident: false };
  }

  return undefined;
}

export function updateAnchorFromResolution(
  document: vscode.TextDocument,
  anchor: NoteAnchor,
  range: vscode.Range
): boolean {
  const nextStart = serializePosition(range.start);
  const nextEnd = serializePosition(range.end);
  const changed = anchor.start?.line !== nextStart.line
    || anchor.start?.character !== nextStart.character
    || anchor.end?.line !== nextEnd.line
    || anchor.end?.character !== nextEnd.character;

  if (!changed) {
    return false;
  }

  anchor.start = nextStart;
  anchor.end = nextEnd;
  anchor.originalText = document.getText(range);
  anchor.contextBefore = collectContext(document, range.start.line, -1);
  anchor.contextAfter = collectContext(document, range.end.line, 1);
  return true;
}

export function deserializeRange(anchor: NoteAnchor, document: vscode.TextDocument): vscode.Range | undefined {
  if (!anchor.start || !anchor.end || document.lineCount === 0) {
    return undefined;
  }

  const startLine = clamp(anchor.start.line, 0, document.lineCount - 1);
  const endLine = clamp(anchor.end.line, startLine, document.lineCount - 1);
  const startCharacter = clamp(anchor.start.character, 0, document.lineAt(startLine).range.end.character);
  const endCharacter = clamp(anchor.end.character, 0, document.lineAt(endLine).range.end.character);
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
}

export function rangeContainsOrTouchesLine(range: vscode.Range, line: number): boolean {
  return line >= range.start.line - 1 && line <= range.end.line + 1;
}

function normalizeSelectionRange(selection: vscode.Selection): vscode.Range {
  const start = selection.start.isBeforeOrEqual(selection.end) ? selection.start : selection.end;
  const end = selection.end.isAfterOrEqual(selection.start) ? selection.end : selection.start;
  return new vscode.Range(start, end);
}

function serializePosition(position: vscode.Position): SerializedPosition {
  return { line: position.line, character: position.character };
}

function rangeTextMatches(document: vscode.TextDocument, range: vscode.Range, anchor: NoteAnchor): boolean {
  if (anchor.kind === 'line') {
    return document.lineAt(range.start.line).text === anchor.originalText;
  }
  return document.getText(range) === anchor.originalText;
}

function findTextRange(document: vscode.TextDocument, text: string, preferredLine: number): vscode.Range | undefined {
  const fullText = document.getText();
  const matches: vscode.Range[] = [];
  let index = fullText.indexOf(text);
  while (index !== -1) {
    const start = document.positionAt(index);
    const end = document.positionAt(index + text.length);
    matches.push(new vscode.Range(start, end));
    index = fullText.indexOf(text, index + Math.max(text.length, 1));
  }

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((a, b) => Math.abs(a.start.line - preferredLine) - Math.abs(b.start.line - preferredLine));
  return matches[0];
}

function findBestMatchingLine(
  document: vscode.TextDocument,
  text: string,
  preferredLine: number,
  anchor: NoteAnchor
): number | undefined {
  const candidates: number[] = [];
  for (let line = 0; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text === text) {
      candidates.push(line);
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  candidates.sort((a, b) => {
    const aScore = contextScore(document, a, anchor) - Math.abs(a - preferredLine) / 1000;
    const bScore = contextScore(document, b, anchor) - Math.abs(b - preferredLine) / 1000;
    return bScore - aScore;
  });
  return candidates[0];
}

function contextScore(document: vscode.TextDocument, line: number, anchor: NoteAnchor): number {
  let score = 0;
  const before = collectContext(document, line, -1);
  const after = collectContext(document, line, 1);
  if (anchor.contextBefore?.length && before[0] === anchor.contextBefore[0]) {
    score += 2;
  }
  if (anchor.contextAfter?.length && after[0] === anchor.contextAfter[0]) {
    score += 2;
  }
  return score;
}

function collectContext(document: vscode.TextDocument, startLine: number, direction: -1 | 1): string[] {
  const context: string[] = [];
  let line = startLine + direction;
  while (line >= 0 && line < document.lineCount && context.length < 3) {
    const text = document.lineAt(line).text.trim();
    if (text) {
      context.push(text);
    }
    line += direction;
  }
  return context;
}
