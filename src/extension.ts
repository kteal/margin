import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { createAnchor, rangeContainsOrTouchesLine, resolveAnchor, updateAnchorFromResolution } from './anchors';
import { buildHover, formatInlineComment } from './comments';
import { VISIBLE_STATE_KEY } from './constants';
import { getGitMetadata } from './git';
import { collectAllNoteEntries, formatLocation, openNoteLocation, resolveNoteLocation } from './search';
import { readStore, tryEnsureGitExclude, writeStore } from './storage';
import { MarginNote, NoteEntry, NoteLocation, NotesStore, ResolvedAnchor } from './types';
import { normalizeNoteText, relativePath, trimForUi, validateNoteText } from './utils';

let contextRef: vscode.ExtensionContext;
let inlineDecoration: vscode.TextEditorDecorationType;
let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  contextRef = context;
  inlineDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: '0 0 0 1rem',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });

  context.subscriptions.push(inlineDecoration);
  registerCommand(context, 'margin.addNote', addNote);
  registerCommand(context, 'margin.editNote', editNote);
  registerCommand(context, 'margin.deleteNote', deleteNote);
  registerCommand(context, 'margin.toggleNotes', toggleNotes);
  registerCommand(context, 'margin.searchNotes', searchNotes);

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => scheduleRefresh()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === vscode.window.activeTextEditor?.document) {
      scheduleRefresh();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    reconcileDocumentAnchors(document).catch(reportError);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('margin.notes')) {
      scheduleRefresh();
    }
  }));

  scheduleRefresh();
}

export function deactivate(): void {}

function registerCommand(context: vscode.ExtensionContext, name: string, handler: () => Promise<void>): void {
  context.subscriptions.push(vscode.commands.registerCommand(name, () => {
    return handler().catch(reportError);
  }));
}

async function addNote(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a source file before adding a Margin note.');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    vscode.window.showInformationMessage('Margin notes need a workspace folder.');
    return;
  }

  const value = await vscode.window.showInputBox({
    prompt: 'Margin note',
    placeHolder: 'Add private context for future you',
    validateInput: validateNoteText
  });
  if (value === undefined) {
    return;
  }

  const text = normalizeNoteText(value);
  const selection = editor.selection;
  const anchor = createAnchor(editor.document, selection);
  const now = new Date().toISOString();
  const store = await readStore(workspaceFolder);
  const note: MarginNote = {
    id: crypto.randomUUID(),
    file: relativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath),
    text,
    createdAt: now,
    updatedAt: now,
    anchor,
    git: await getGitMetadata(workspaceFolder.uri.fsPath)
  };

  store.notes.push(note);
  await writeStore(workspaceFolder, store);
  await tryEnsureGitExclude(contextRef, workspaceFolder);
  scheduleRefresh();
}

async function editNote(): Promise<void> {
  const target = await pickNoteNearCursor('Edit Margin note');
  if (!target) {
    return;
  }

  const value = await vscode.window.showInputBox({
    prompt: 'Edit Margin note',
    value: target.note.text,
    validateInput: validateNoteText
  });
  if (value === undefined) {
    return;
  }

  target.note.text = normalizeNoteText(value);
  target.note.updatedAt = new Date().toISOString();
  await writeStore(target.workspaceFolder, target.store);
  scheduleRefresh();
}

async function deleteNote(): Promise<void> {
  const target = await pickNoteNearCursor('Delete Margin note');
  if (!target) {
    return;
  }

  const choice = await vscode.window.showWarningMessage('Delete this Margin note?', { modal: true }, 'Delete');
  if (choice !== 'Delete') {
    return;
  }

  target.store.notes = target.store.notes.filter((note) => note.id !== target.note.id);
  await writeStore(target.workspaceFolder, target.store);
  scheduleRefresh();
}

async function toggleNotes(): Promise<void> {
  const next = !getNotesVisible();
  await contextRef.workspaceState.update(VISIBLE_STATE_KEY, next);
  if (next) {
    scheduleRefresh();
    vscode.window.showInformationMessage('Margin notes visible.');
  } else {
    clearDecorations();
    vscode.window.showInformationMessage('Margin notes hidden.');
  }
}

async function searchNotes(): Promise<void> {
  const entries = await collectAllNoteEntries();
  if (entries.length === 0) {
    vscode.window.showInformationMessage('No Margin notes found in this workspace.');
    return;
  }

  const items: Array<vscode.QuickPickItem & { entry: NoteEntry; location: NoteLocation }> = [];
  for (const entry of entries) {
    const location = await resolveNoteLocation(entry.workspaceFolder, entry.note);
    items.push({
      label: trimForUi(entry.note.text, 90),
      description: formatLocation(entry.workspaceFolder, entry.note, location),
      detail: entry.note.git?.createdBranch ? `Created on ${entry.note.git.createdBranch}` : undefined,
      entry,
      location
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Margin: Search Notes',
    placeHolder: 'Search private notes',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }

  await openNoteLocation(picked.entry.workspaceFolder, picked.entry.note, picked.location);
}

async function pickNoteNearCursor(title: string): Promise<NoteEntry | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a source file first.');
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    vscode.window.showInformationMessage('Margin notes need a workspace folder.');
    return undefined;
  }

  const store = await readStore(workspaceFolder);
  const file = relativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);
  const notes = store.notes.filter((note) => note.file === file);
  const resolved = notes
    .map((note) => ({ note, resolved: resolveAnchor(editor.document, note.anchor) }))
    .filter((item): item is { note: MarginNote; resolved: ResolvedAnchor } => Boolean(item.resolved));
  const cursorLine = editor.selection.active.line;
  const nearby = resolved.filter((item) => rangeContainsOrTouchesLine(item.resolved.range, cursorLine));

  if (nearby.length === 0) {
    vscode.window.showInformationMessage('No Margin note found at the cursor.');
    return undefined;
  }

  let selected = nearby[0];
  if (nearby.length > 1) {
    const picked = await vscode.window.showQuickPick(nearby.map((item) => ({
      label: trimForUi(item.note.text, 90),
      description: `${item.resolved.range.start.line + 1}`,
      item
    })), { title });
    if (!picked) {
      return undefined;
    }
    selected = picked.item;
  }

  return { workspaceFolder, store, note: selected.note };
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshActiveEditor().catch(reportError);
  }, 50);
}

async function refreshActiveEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  if (!getNotesVisible()) {
    clearDecorations(editor);
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    clearDecorations(editor);
    return;
  }

  const store = await readStore(workspaceFolder);
  const file = relativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);
  const notes = store.notes.filter((note) => note.file === file);
  const decorations: vscode.DecorationOptions[] = [];
  let changed = false;

  for (const note of notes) {
    const resolved = resolveAnchor(editor.document, note.anchor);
    if (!resolved) {
      continue;
    }

    if (resolved.confident && updateAnchorFromResolution(editor.document, note.anchor, resolved.range)) {
      note.updatedAt = new Date().toISOString();
      changed = true;
    }

    const line = resolved.range.end.line;
    const character = editor.document.lineAt(line).range.end.character;
    const position = new vscode.Position(line, character);
    decorations.push({
      range: new vscode.Range(position, position),
      hoverMessage: buildHover(note, workspaceFolder),
      renderOptions: {
        after: {
          contentText: ` ${formatInlineComment(editor.document.languageId, note.text)}`,
          color: new vscode.ThemeColor('editorCodeLens.foreground'),
          fontStyle: 'italic'
        }
      }
    });
  }

  editor.setDecorations(inlineDecoration, decorations);
  if (changed) {
    await writeStore(workspaceFolder, store);
  }
}

async function reconcileDocumentAnchors(document: vscode.TextDocument): Promise<void> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return;
  }

  const store = await readStore(workspaceFolder);
  const file = relativePath(workspaceFolder.uri.fsPath, document.uri.fsPath);
  let changed = false;
  for (const note of store.notes.filter((item) => item.file === file)) {
    const resolved = resolveAnchor(document, note.anchor);
    if (resolved?.confident && updateAnchorFromResolution(document, note.anchor, resolved.range)) {
      note.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await writeStore(workspaceFolder, store);
  }
}

function clearDecorations(editor = vscode.window.activeTextEditor): void {
  if (editor && inlineDecoration) {
    editor.setDecorations(inlineDecoration, []);
  }
}

function getNotesVisible(): boolean {
  const configured = vscode.workspace.getConfiguration('margin.notes').get('visibleByDefault', true);
  return contextRef.workspaceState.get(VISIBLE_STATE_KEY, configured);
}

function reportError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Margin failed: ${message}`);
}
