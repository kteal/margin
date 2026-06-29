import * as vscode from 'vscode';

import { MarginNote } from './types';
import { escapeMarkdown, normalizeNoteText, trimForUi } from './utils';

const LINE_COMMENT_BY_LANGUAGE = new Map<string, string>([
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

export function formatInlineComment(languageId: string, text: string): string {
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

export function buildHover(note: MarginNote, workspaceFolder: vscode.WorkspaceFolder): vscode.MarkdownString {
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
