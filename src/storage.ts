import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { STORE_FILE, STORE_VERSION } from './constants';
import { NotesStore } from './types';

let saveQueue: Promise<void> = Promise.resolve();

export async function readStore(workspaceFolder: vscode.WorkspaceFolder): Promise<NotesStore> {
  const storePath = getStorePath(workspaceFolder);
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotesStore>;
    if (!Array.isArray(parsed.notes)) {
      return createEmptyStore();
    }
    return { version: parsed.version || STORE_VERSION, notes: parsed.notes };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptyStore();
    }
    throw error;
  }
}

export function writeStore(workspaceFolder: vscode.WorkspaceFolder, store: NotesStore): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    const storageDir = getStorageDir(workspaceFolder);
    await fs.mkdir(storageDir, { recursive: true });
    const payload: NotesStore = {
      version: STORE_VERSION,
      notes: store.notes
    };
    await fs.writeFile(getStorePath(workspaceFolder), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });
  return saveQueue;
}

export async function tryEnsureGitExclude(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  try {
    await ensureGitExclude(workspaceFolder);
  } catch (error) {
    console.warn('Margin could not update .git/info/exclude:', error);
    const warningKey = `margin.gitExcludeWarning.${workspaceFolder.uri.toString()}`;
    if (!context.workspaceState.get(warningKey)) {
      await context.workspaceState.update(warningKey, true);
      vscode.window.showWarningMessage('Margin saved the note, but could not add its storage directory to .git/info/exclude.');
    }
  }
}

function createEmptyStore(): NotesStore {
  return { version: STORE_VERSION, notes: [] };
}

function getStorageDir(workspaceFolder: vscode.WorkspaceFolder): string {
  const configured = vscode.workspace.getConfiguration('margin.notes').get('storageDirectory', '.margin');
  return path.join(workspaceFolder.uri.fsPath, configured || '.margin');
}

function getStorePath(workspaceFolder: vscode.WorkspaceFolder): string {
  return path.join(getStorageDir(workspaceFolder), STORE_FILE);
}

async function ensureGitExclude(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
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
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
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

async function findGitDir(workspacePath: string): Promise<string | undefined> {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
