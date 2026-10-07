/**
 * H-10: asynchronous PowerShell runner.
 *
 * The probes (idle seconds, front window, screen capture, toasts) used
 * `spawnSync`, which blocks the host's event loop for as long as the script
 * runs — 10s to 45s on a slow machine, and the GUI stalls with it. Same
 * arguments, same timeouts, same "never throw, degrade instead" contract, but
 * the loop stays free while the child runs.
 */
import { execFile } from 'node:child_process';

export interface PsResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run `powershell.exe` and resolve with its exit code and streams. Never
 *  rejects: a spawn failure and a non-zero exit both come back as `status !== 0`
 *  so callers keep their existing "probe failed" paths. */
export function runPowerShell(args: string[], timeoutMs: number): Promise<PsResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        const status = err ? (typeof code === 'number' ? code : 1) : 0;
        resolve({ status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    child.on('error', () => { /* surfaced through the callback above */ });
  });
}

/** Convenience for the `-File <script>` shape used by every asset script. */
export function runPowerShellFile(script: string, args: string[], timeoutMs: number): Promise<PsResult> {
  return runPowerShell(['-File', script, ...args], timeoutMs);
}
