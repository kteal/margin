import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { createAnchor, createLineAnchor, rangeContainsOrTouchesLine, resolveAnchor, updateAnchorFromResolution } from './anchors';
import { buildHover, formatInlineComment } from './comments';
import { NOTE_AT_CURSOR_CONTEXT, VISIBLE_STATE_KEY } from './constants';
import { getGitMetadata } from './git';
import { collectAllNoteEntries, formatLocation, openNoteLocation, resolveNoteLocation } from './search';
import { readStore, tryEnsureGitExclude, writeStore } from './storage';
import { MarginNote, NoteEntry, NoteLocation, NotesStore, ResolvedAnchor } from './types';
import { normalizeNoteText, relativePath, trimForUi, validateNoteText } from './utils';

let contextRef: vscode.ExtensionContext;
let inlineDecoration: vscode.TextEditorDecorationType;
let refreshTimer: NodeJS.Timeout | undefined;
let noteContextTimer: NodeJS.Timeout | undefined;

type ResolvedNote = { note: MarginNote; resolved: ResolvedAnchor };
type ActiveEditorNotes = {
  editor: vscode.TextEditor;
  workspaceFolder: vscode.WorkspaceFolder;
  store: NotesStore;
  notes: ResolvedNote[];
};
type PickedNote = NoteEntry & { editor: vscode.TextEditor; resolved: ResolvedAnchor };

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
  registerCommand(context, 'margin.moveNoteUp', moveNoteUp);
  registerCommand(context, 'margin.moveNoteDown', moveNoteDown);
  registerCommand(context, 'margin.toggleNotes', toggleNotes);
  registerCommand(context, 'margin.searchNotes', searchNotes);

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    scheduleRefresh();
    scheduleNoteContextRefresh();
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => scheduleNoteContextRefresh()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === vscode.window.activeTextEditor?.document) {
      scheduleRefresh();
      scheduleNoteContextRefresh();
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
  scheduleNoteContextRefresh();
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
  scheduleNoteContextRefresh();
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
  scheduleNoteContextRefresh();
}

async function moveNoteUp(): Promise<void> {
  await moveNote(-1);
}

async function moveNoteDown(): Promise<void> {
  await moveNote(1);
}

async function moveNote(direction: -1 | 1): Promise<void> {
  const target = await pickNoteOnCursorLine(direction === -1 ? 'Move Margin note up' : 'Move Margin note down');
  if (!target) {
    return;
  }

  const file = relativePath(target.workspaceFolder.uri.fsPath, target.editor.document.uri.fsPath);
  const occupiedLines = getOccupiedNoteLines(target.editor.document, target.store, file, target.note.id);
  const targetLine = findAdjacentCodeLine(target.editor.document, target.resolved.range.end.line, direction, occupiedLines);
  if (targetLine === undefined) {
    vscode.window.showInformationMessage(
      direction === -1 ? 'No available code line above this note.' : 'No available code line below this note.'
    );
    return;
  }

  target.note.anchor = createLineAnchor(target.editor.document, targetLine);
  target.note.updatedAt = new Date().toISOString();
  await writeStore(target.workspaceFolder, target.store);

  const lineEnd = target.editor.document.lineAt(targetLine).range.end.character;
  const character = Math.min(target.editor.selection.active.character, lineEnd);
  const position = new vscode.Position(targetLine, character);
  target.editor.selection = new vscode.Selection(position, position);
  target.editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  scheduleRefresh();
  scheduleNoteContextRefresh();
}

async function toggleNotes(): Promise<void> {
  const next = !getNotesVisible();
  await contextRef.workspaceState.update(VISIBLE_STATE_KEY, next);
  if (next) {
    scheduleRefresh();
    scheduleNoteContextRefresh();
    vscode.window.showInformationMessage('Margin notes visible.');
  } else {
    clearAllDecorations();
    await vscode.commands.executeCommand('setContext', NOTE_AT_CURSOR_CONTEXT, false);
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
  const nearbyNotes = await getNotesNearCursor(true);
  if (!nearbyNotes) {
    return undefined;
  }

  const selected = await pickResolvedNote(title, nearbyNotes.notes);
  if (!selected) {
    return undefined;
  }
  return { workspaceFolder: nearbyNotes.workspaceFolder, store: nearbyNotes.store, note: selected.note };
}

async function pickNoteOnCursorLine(title: string): Promise<PickedNote | undefined> {
  const notesAtCursor = await getNotesOnCursorLine(true);
  if (!notesAtCursor) {
    return undefined;
  }

  const selected = await pickResolvedNote(title, notesAtCursor.notes);
  if (!selected) {
    return undefined;
  }

  return {
    editor: notesAtCursor.editor,
    workspaceFolder: notesAtCursor.workspaceFolder,
    store: notesAtCursor.store,
    note: selected.note,
    resolved: selected.resolved
  };
}

async function pickResolvedNote(title: string, notes: ResolvedNote[]): Promise<ResolvedNote | undefined> {
  if (notes.length === 1) {
    return notes[0];
  }

  const picked = await vscode.window.showQuickPick(notes.map((item) => ({
    label: trimForUi(item.note.text, 90),
    description: `${item.resolved.range.end.line + 1}`,
    item
  })), { title });
  return picked?.item;
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshVisibleEditors().catch(reportError);
  }, 50);
}

function scheduleNoteContextRefresh(): void {
  if (noteContextTimer) {
    clearTimeout(noteContextTimer);
  }
  noteContextTimer = setTimeout(() => {
    noteContextTimer = undefined;
    updateNoteAtCursorContext().catch(reportError);
  }, 50);
}

async function updateNoteAtCursorContext(): Promise<void> {
  if (!getNotesVisible()) {
    await vscode.commands.executeCommand('setContext', NOTE_AT_CURSOR_CONTEXT, false);
    return;
  }

  const notesAtCursor = await getNotesOnCursorLine(false);
  await vscode.commands.executeCommand('setContext', NOTE_AT_CURSOR_CONTEXT, Boolean(notesAtCursor?.notes.length));
}

async function getActiveEditorNotes(showMessages: boolean): Promise<ActiveEditorNotes | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    if (showMessages) {
      vscode.window.showInformationMessage('Open a source file first.');
    }
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    if (showMessages) {
      vscode.window.showInformationMessage('Margin notes need a workspace folder.');
    }
    return undefined;
  }

  const store = await readStore(workspaceFolder);
  const file = relativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);
  const notes = store.notes.filter((note) => note.file === file);
  const resolved = notes
    .map((note) => ({ note, resolved: resolveAnchor(editor.document, note.anchor) }))
    .filter((item): item is { note: MarginNote; resolved: ResolvedAnchor } => Boolean(item.resolved));

  return { editor, workspaceFolder, store, notes: resolved };
}

async function getNotesNearCursor(showMessages: boolean): Promise<ActiveEditorNotes | undefined> {
  const activeNotes = await getActiveEditorNotes(showMessages);
  if (!activeNotes) {
    return undefined;
  }

  const cursorLine = activeNotes.editor.selection.active.line;
  const nearby = activeNotes.notes.filter((item) => rangeContainsOrTouchesLine(item.resolved.range, cursorLine));

  if (nearby.length === 0) {
    if (showMessages) {
      vscode.window.showInformationMessage('No Margin note found at the cursor.');
    }
    return undefined;
  }

  return { ...activeNotes, notes: nearby };
}

async function getNotesOnCursorLine(showMessages: boolean): Promise<ActiveEditorNotes | undefined> {
  const activeNotes = await getActiveEditorNotes(showMessages);
  if (!activeNotes) {
    return undefined;
  }

  const cursorLine = activeNotes.editor.selection.active.line;
  const onCursorLine = activeNotes.notes.filter((item) => item.resolved.range.end.line === cursorLine);

  if (onCursorLine.length === 0) {
    if (showMessages) {
      vscode.window.showInformationMessage('No Margin note found on the cursor line.');
    }
    return undefined;
  }

  return { ...activeNotes, notes: onCursorLine };
}

async function refreshVisibleEditors(): Promise<void> {
  if (!getNotesVisible()) {
    clearAllDecorations();
    return;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    await refreshEditor(editor);
  }
}

async function refreshEditor(editor: vscode.TextEditor): Promise<void> {
  if (editor.document.uri.scheme !== 'file') {
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

function clearAllDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    clearDecorations(editor);
  }
}

function getNotesVisible(): boolean {
  const configured = vscode.workspace.getConfiguration('margin.notes').get('visibleByDefault', true);
  return contextRef.workspaceState.get(VISIBLE_STATE_KEY, configured);
}

function getOccupiedNoteLines(
  document: vscode.TextDocument,
  store: NotesStore,
  file: string,
  ignoredNoteId: string
): ReadonlySet<number> {
  const occupiedLines = new Set<number>();
  for (const note of store.notes.filter((item) => item.file === file && item.id !== ignoredNoteId)) {
    const resolved = resolveAnchor(document, note.anchor);
    if (resolved) {
      occupiedLines.add(resolved.range.end.line);
    }
  }
  return occupiedLines;
}

function findAdjacentCodeLine(
  document: vscode.TextDocument,
  currentLine: number,
  direction: -1 | 1,
  occupiedLines: ReadonlySet<number>
): number | undefined {
  let line = currentLine + direction;
  while (line >= 0 && line < document.lineCount) {
    if (document.lineAt(line).text.trim() && !occupiedLines.has(line)) {
      return line;
    }
    line += direction;
  }
  return undefined;
}

function reportError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Margin failed: ${message}`);
}
