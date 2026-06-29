import * as childProcess from 'child_process';

import { GitMetadata } from './types';

export async function getGitMetadata(workspacePath: string): Promise<GitMetadata> {
  const branch = await execGit(workspacePath, ['branch', '--show-current']);
  const commit = await execGit(workspacePath, ['rev-parse', 'HEAD']);
  return {
    createdBranch: branch || undefined,
    createdCommit: commit || undefined
  };
}

function execGit(cwd: string, args: string[]): Promise<string> {
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
