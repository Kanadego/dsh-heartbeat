# frontwin.ps1 - lightweight live foreground-window probe (design doc §10.2 /
# v0.9.2 tamako fix). Output: { process, rect, screen, title, captured_at }.
# Used by the gate IMMEDIATELY BEFORE speaking (real-time, not the 2h snapshot).
# Privacy: foreground only; title/process are sensitive -> caller encrypts or burns.

param([string]$out)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Fw {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$scr = if ($bounds) { @([int]$bounds.Width, [int]$bounds.Height) } else { $null }

$h = [Fw]::GetForegroundWindow()
$row = @{ process = ''; title = ''; rect = $null; screen = $scr; captured_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz') }
if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 512
    [Fw]::GetWindowText($h, $sb, 512) | Out-Null
    $row.title = $sb.ToString()
    $procPid = 0
    [Fw]::GetWindowThreadProcessId($h, [ref]$procPid) | Out-Null
    if ($procPid -gt 0) {
        try { $row.process = (Get-Process -Id $procPid -ErrorAction Stop).ProcessName } catch { $row.process = '' }
    }
    $r = New-Object Fw+RECT
    if ([Fw]::GetWindowRect($h, [ref]$r)) {
        $row.rect = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
    }
}
$json = $row | ConvertTo-Json -Compress -Depth 4
[IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
