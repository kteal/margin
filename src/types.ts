import * as vscode from 'vscode';

export interface SerializedPosition {
  line: number;
  character: number;
}

export interface NoteAnchor {
  kind: 'line' | 'range';
  start?: SerializedPosition;
  end?: SerializedPosition;
  originalText: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface GitMetadata {
  createdBranch?: string;
  createdCommit?: string;
}

export interface MarginNote {
  id: string;
  file: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  anchor: NoteAnchor;
  git?: GitMetadata;
}

export interface NotesStore {
  version: number;
  notes: MarginNote[];
}

export interface ResolvedAnchor {
  range: vscode.Range;
  confident: boolean;
}

export interface NoteEntry {
  workspaceFolder: vscode.WorkspaceFolder;
  store: NotesStore;
  note: MarginNote;
}

export interface NoteLocation {
  uri: vscode.Uri;
  range?: vscode.Range;
  exists: boolean;
}
