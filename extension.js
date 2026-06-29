const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const STORE_FILE = 'notes.json';
const STORE_VERSION = 1;
const VISIBLE_STATE_KEY = 'margin.notes.visible';

const LINE_COMMENT_BY_LANGUAGE = new Map([
  ['bat', '::'],
  ['c', '//'],
  ['clojure', ';;'],
  ['coffeescript', '#'],
  ['cpp', '//'],
  ['csharp', '//'],
  ['css', '/*'],
  ['dart', '//'],
  ['dockerfile', '#'],
  ['fsharp', '//'],
  ['go', '//'],
  ['groovy', '//'],
  ['html', '<!--'],
  ['ini', ';'],
  ['java', '//'],
  ['javascript', '//'],
  ['javascriptreact', '//'],
  ['jsonc', '//'],
  ['kotlin', '//'],
  ['lua', '--'],
  ['makefile', '#'],
  ['markdown', '<!--'],
  ['objective-c', '//'],
  ['objective-cpp', '//'],
  ['perl', '#'],
  ['php', '//'],
  ['powershell', '#'],
  ['properties', '#'],
  ['python', '#'],
  ['r', '#'],
  ['ruby', '#'],
  ['rust', '//'],
  ['scss', '//'],
  ['shellscript', '#'],
  ['sql', '--'],
  ['swift', '//'],
  ['typescript', '//'],
  ['typescriptreact', '//'],
  ['vb', "'"],
  ['vue', '<!--'],
  ['xml', '<!--'],
  ['yaml', '#']
]);

let contextRef;
let inlineDecoration;
let refreshTimer;
let saveQueue = Promise.resolve();

function activate(context) {
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

function deactivate() {}

function registerCommand(context, name, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(name, () => {
    return handler().catch(reportError);
  }));
}

async function addNote() {
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
  const note = {
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
  await tryEnsureGitExclude(workspaceFolder);
  scheduleRefresh();
}

async function editNote() {
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

async function deleteNote() {
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

async function toggleNotes() {
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

async function searchNotes() {
  const entries = await collectAllNoteEntries();
  if (entries.length === 0) {
    vscode.window.showInformationMessage('No Margin notes found in this workspace.');
    return;
  }

  const items = [];
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

async function pickNoteNearCursor(title) {
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
    .filter((item) => item.resolved);
  const cursorLine = editor.selection.active.line;
  const nearby = resolved.filter((item) => rangeContainsOrTouchesLine(item.resolved.range, cursorLine));

  if (nearby.length === 0) {
    vscode.window.showInformationMessage('No Margin note found at the cursor.');
    return undefined;
  }

  let selected = nearby[0];
  if (nearby.length > 1) {
    selected = await vscode.window.showQuickPick(nearby.map((item) => ({
      label: trimForUi(item.note.text, 90),
      description: `${item.resolved.range.start.line + 1}`,
      item
    })), { title });
    selected = selected?.item;
  }

  return selected ? { workspaceFolder, store, note: selected.note } : undefined;
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshActiveEditor().catch(reportError);
  }, 50);
}

async function refreshActiveEditor() {
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
  const decorations = [];
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

async function reconcileDocumentAnchors(document) {
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

function clearDecorations(editor = vscode.window.activeTextEditor) {
  if (editor && inlineDecoration) {
    editor.setDecorations(inlineDecoration, []);
  }
}

function getNotesVisible() {
  const configured = vscode.workspace.getConfiguration('margin.notes').get('visibleByDefault', true);
  return contextRef.workspaceState.get(VISIBLE_STATE_KEY, configured);
}

function createAnchor(document, selection) {
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

function resolveAnchor(document, anchor) {
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

function updateAnchorFromResolution(document, anchor, range) {
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

function normalizeSelectionRange(selection) {
  const start = selection.start.isBeforeOrEqual(selection.end) ? selection.start : selection.end;
  const end = selection.end.isAfterOrEqual(selection.start) ? selection.end : selection.start;
  return new vscode.Range(start, end);
}

function serializePosition(position) {
  return { line: position.line, character: position.character };
}

function deserializeRange(anchor, document) {
  if (!anchor.start || !anchor.end || document.lineCount === 0) {
    return undefined;
  }

  const startLine = clamp(anchor.start.line, 0, document.lineCount - 1);
  const endLine = clamp(anchor.end.line, startLine, document.lineCount - 1);
  const startCharacter = clamp(anchor.start.character, 0, document.lineAt(startLine).range.end.character);
  const endCharacter = clamp(anchor.end.character, 0, document.lineAt(endLine).range.end.character);
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
}

function rangeTextMatches(document, range, anchor) {
  if (anchor.kind === 'line') {
    return document.lineAt(range.start.line).text === anchor.originalText;
  }
  return document.getText(range) === anchor.originalText;
}

function findTextRange(document, text, preferredLine) {
  const fullText = document.getText();
  const matches = [];
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

function findBestMatchingLine(document, text, preferredLine, anchor) {
  const candidates = [];
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

function contextScore(document, line, anchor) {
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

function collectContext(document, startLine, direction) {
  const context = [];
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

function rangeContainsOrTouchesLine(range, line) {
  return line >= range.start.line - 1 && line <= range.end.line + 1;
}

function formatInlineComment(languageId, text) {
  const marker = LINE_COMMENT_BY_LANGUAGE.get(languageId) || '//';
  const prefix = vscode.workspace.getConfiguration('margin.notes').get('inlinePrefix', 'margin:').trim();
  const maxLength = vscode.workspace.getConfiguration('margin.notes').get('inlineMaxLength', 120);
  const content = trimForUi(normalizeNoteText(text), maxLength);
  const body = prefix ? `${prefix} ${content}` : content;

  if (marker === '/*') {
    return `/* ${body} */`;
  }
  if (marker === '<!--') {
    return `<!-- ${body} -->`;
  }
  return `${marker} ${body}`;
}

function buildHover(note, workspaceFolder) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  markdown.appendMarkdown('**Margin note**\n\n');
  markdown.appendMarkdown(escapeMarkdown(note.text));
  markdown.appendMarkdown('\n\n');
  markdown.appendMarkdown(`_${escapeMarkdown(note.file)}_`);
  if (note.git?.createdBranch) {
    markdown.appendMarkdown(`\n\nCreated on branch \`${escapeMarkdown(note.git.createdBranch)}\``);
  }
  if (note.git?.createdCommit) {
    markdown.appendMarkdown(` at \`${escapeMarkdown(note.git.createdCommit.slice(0, 12))}\``);
  }
  if (workspaceFolder.name) {
    markdown.appendMarkdown(`\n\nWorkspace: ${escapeMarkdown(workspaceFolder.name)}`);
  }
  return markdown;
}

async function resolveNoteLocation(workspaceFolder, note) {
  const fileUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, note.file));
  try {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const resolved = resolveAnchor(document, note.anchor);
    return { uri: fileUri, range: resolved?.range, exists: true };
  } catch {
    return { uri: fileUri, range: undefined, exists: false };
  }
}

async function openNoteLocation(workspaceFolder, note, location) {
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

async function collectAllNoteEntries() {
  const folders = vscode.workspace.workspaceFolders || [];
  const entries = [];
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

function formatLocation(workspaceFolder, note, location) {
  const line = location?.range ? location.range.start.line + 1 : (note.anchor?.start?.line ?? 0) + 1;
  const status = location?.exists === false ? 'missing file' : location?.range ? `line ${line}` : `line ${line}, unverified`;
  return `${workspaceFolder.name}/${note.file}:${status}`;
}

async function readStore(workspaceFolder) {
  const storePath = getStorePath(workspaceFolder);
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.notes)) {
      return createEmptyStore();
    }
    return { version: parsed.version || STORE_VERSION, notes: parsed.notes };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyStore();
    }
    throw error;
  }
}

async function writeStore(workspaceFolder, store) {
  saveQueue = saveQueue.then(async () => {
    const storageDir = getStorageDir(workspaceFolder);
    await fs.mkdir(storageDir, { recursive: true });
    const payload = {
      version: STORE_VERSION,
      notes: store.notes
    };
    await fs.writeFile(getStorePath(workspaceFolder), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });
  return saveQueue;
}

function createEmptyStore() {
  return { version: STORE_VERSION, notes: [] };
}

function getStorageDir(workspaceFolder) {
  const configured = vscode.workspace.getConfiguration('margin.notes').get('storageDirectory', '.margin');
  return path.join(workspaceFolder.uri.fsPath, configured || '.margin');
}

function getStorePath(workspaceFolder) {
  return path.join(getStorageDir(workspaceFolder), STORE_FILE);
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function ensureGitExclude(workspaceFolder) {
  const shouldAdd = vscode.workspace.getConfiguration('margin.notes').get('addToGitExclude', true);
  if (!shouldAdd) {
    return;
  }

  const storageDirectory = vscode.workspace.getConfiguration('margin.notes').get('storageDirectory', '.margin') || '.margin';
  const gitDir = await findGitDir(workspaceFolder.uri.fsPath);
  if (!gitDir) {
    return;
  }

  const infoDir = path.join(gitDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  const normalizedEntry = `${storageDirectory.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  await fs.mkdir(infoDir, { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const hasEntry = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === normalizedEntry || line === `/${normalizedEntry}`);

  if (!hasEntry) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await fs.writeFile(excludePath, `${existing}${prefix}${normalizedEntry}\n`, 'utf8');
  }
}

async function tryEnsureGitExclude(workspaceFolder) {
  try {
    await ensureGitExclude(workspaceFolder);
  } catch (error) {
    console.warn('Margin could not update .git/info/exclude:', error);
    const warningKey = `margin.gitExcludeWarning.${workspaceFolder.uri.toString()}`;
    if (!contextRef.workspaceState.get(warningKey)) {
      await contextRef.workspaceState.update(warningKey, true);
      vscode.window.showWarningMessage('Margin saved the note, but could not add its storage directory to .git/info/exclude.');
    }
  }
}

async function findGitDir(workspacePath) {
  const dotGit = path.join(workspacePath, '.git');
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) {
      return dotGit;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(dotGit, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        return path.resolve(workspacePath, match[1].trim());
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function getGitMetadata(workspacePath) {
  const branch = await execGit(workspacePath, ['branch', '--show-current']);
  const commit = await execGit(workspacePath, ['rev-parse', 'HEAD']);
  return {
    createdBranch: branch || undefined,
    createdCommit: commit || undefined
  };
}

function execGit(cwd, args) {
  return new Promise((resolve) => {
    childProcess.execFile('git', ['-C', cwd, ...args], { timeout: 1500 }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function validateNoteText(value) {
  if (!normalizeNoteText(value)) {
    return 'Enter a note.';
  }
  return undefined;
}

function normalizeNoteText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function trimForUi(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function reportError(error) {
  console.error(error);
  vscode.window.showErrorMessage(`Margin failed: ${error.message || error}`);
}

module.exports = {
  activate,
  deactivate
};
