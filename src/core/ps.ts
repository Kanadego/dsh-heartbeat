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
 *  so callers keep their existing "probe failed" paths.
 *
 *  ⑤A (2026-10-17 review, HB-08): the optional signal is the beat's cancellation
 *  handle. A cancelled probe kills the child and resolves like any other failed
 *  probe (`status !== 0`, stderr 'aborted') — callers already degrade on that,
 *  and the "never rejects" contract stays intact. */
export function runPowerShell(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<PsResult> {
  if (signal?.aborted) return Promise.resolve({ status: 1, stdout: '', stderr: 'aborted' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: PsResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => {
      try { child.kill(); } catch { /* already gone */ }
      done({ status: 1, stdout: '', stderr: 'aborted' });
    };
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        const status = err ? (typeof code === 'number' ? code : 1) : 0;
        done({ status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    child.on('error', () => { /* surfaced through the callback above */ });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Convenience for the `-File <script>` shape used by every asset script. */
export function runPowerShellFile(script: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<PsResult> {
  return runPowerShell(['-File', script, ...args], timeoutMs, signal);
}
