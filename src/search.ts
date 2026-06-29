import * as path from 'path';
import * as vscode from 'vscode';

import { deserializeRange, resolveAnchor } from './anchors';
import { readStore } from './storage';
import { MarginNote, NoteEntry, NoteLocation } from './types';

export async function resolveNoteLocation(
  workspaceFolder: vscode.WorkspaceFolder,
  note: MarginNote
): Promise<NoteLocation> {
  const fileUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, note.file));
  try {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const resolved = resolveAnchor(document, note.anchor);
    return { uri: fileUri, range: resolved?.range, exists: true };
  } catch {
    return { uri: fileUri, range: undefined, exists: false };
  }
}

export async function openNoteLocation(
  workspaceFolder: vscode.WorkspaceFolder,
  note: MarginNote,
  location: NoteLocation
): Promise<void> {
  if (!location?.exists) {
    vscode.window.showWarningMessage(`Margin note target no longer exists: ${note.file}`);
    return;
  }

  const document = await vscode.workspace.openTextDocument(location.uri);
  const editor = await vscode.window.showTextDocument(document);
  const range = location.range || deserializeRange(note.anchor, document);
  if (range) {
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

export async function collectAllNoteEntries(): Promise<NoteEntry[]> {
  const folders = vscode.workspace.workspaceFolders || [];
  const entries: NoteEntry[] = [];
  for (const workspaceFolder of folders) {
    const store = await readStore(workspaceFolder);
    for (const note of store.notes) {
      entries.push({ workspaceFolder, store, note });
    }
  }
  return entries.sort((a, b) => {
    const fileSort = a.note.file.localeCompare(b.note.file);
    if (fileSort !== 0) {
      return fileSort;
    }
    return (a.note.anchor?.start?.line ?? 0) - (b.note.anchor?.start?.line ?? 0);
  });
}

export function formatLocation(
  workspaceFolder: vscode.WorkspaceFolder,
  note: MarginNote,
  location: NoteLocation
): string {
  const line = location?.range ? location.range.start.line + 1 : (note.anchor?.start?.line ?? 0) + 1;
  const status = location?.exists === false ? 'missing file' : location?.range ? `line ${line}` : `line ${line}, unverified`;
  return `${workspaceFolder.name}/${note.file}:${status}`;
}
