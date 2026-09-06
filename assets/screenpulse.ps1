# screenpulse.ps1 - screen pulse collector (port of v1, logic unchanged).
# Collects: foreground title + process + rect, focus window, visible top-level
# windows (taskbar-level, cap 20), full-screen screenshot downsampled to
# width 1024.
#
# Privacy discipline (privacy charter v0.9, user-authorized):
#   - visible-window enumeration only (EnumWindows + IsWindowVisible, cap 20);
#     no tray icons, no process enumeration
#   - screenshot force-downsampled to width 1024 (mood-level detail, small
#     text is unreadable)
#   - this script only produces PLAINTEXT intermediates in the caller-provided
#     outdir (which must be data/tmp); encryption at rest is the caller's job
#   - title/process text is sensitive -> DPAPI-encrypted by caller, or burned

param(
    [string]$outdir
)

$ErrorActionPreference = 'Stop'
if (-not $outdir) { throw 'outdir is required (must be the data/tmp dir)' }
New-Item -ItemType Directory -Path $outdir -Force | Out-Null

# -- 1. foreground title + process + rect + focus + visible windows --------
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public static class WinForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }

  public static List<IntPtr> VisibleTopLevel() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static IntPtr FocusWindowOf(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return IntPtr.Zero;
    uint pid = 0;
    uint tid = GetWindowThreadProcessId(hwnd, out pid);
    if (tid == 0) return IntPtr.Zero;
    GUITHREADINFO g = new GUITHREADINFO();
    g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(tid, ref g)) return IntPtr.Zero;
    return g.hwndFocus == IntPtr.Zero ? hwnd : g.hwndFocus;
  }
}
'@

function Get-WinInfo([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 512
    [WinForeground]::GetWindowText($h, $sb, 512) | Out-Null
    $t = $sb.ToString()
    $p = ''
    $procPid = 0
    [WinForeground]::GetWindowThreadProcessId($h, [ref]$procPid) | Out-Null
    if ($procPid -gt 0) {
        try { $p = (Get-Process -Id $procPid -ErrorAction Stop).ProcessName } catch { $p = '' }
    }
    return @{ title = $t; process = $p; pid = [int]$procPid }
}

$h = [WinForeground]::GetForegroundWindow()
$fg = @{ title = ''; process = ''; pid = 0; rect = $null }
if ($h -ne [IntPtr]::Zero) {
    $info = Get-WinInfo $h
    $fg.title = $info.title; $fg.process = $info.process; $fg.pid = $info.pid
    $r = New-Object WinForeground+RECT
    if ([WinForeground]::GetWindowRect($h, [ref]$r)) {
        $fg.rect = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
    }
}

$focusH = [WinForeground]::FocusWindowOf($h)
$focus = @{ title = ''; process = ''; pid = 0 }
if ($focusH -ne [IntPtr]::Zero -and $focusH -ne $h) {
    $fi = Get-WinInfo $focusH
    $focus.title = $fi.title; $focus.process = $fi.process; $focus.pid = $fi.pid
}

$visible = @()
$cap = 20
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($w in [WinForeground]::VisibleTopLevel()) {
    if ($visible.Count -ge $cap) { break }
    if ($w -eq $h -or $w -eq $focusH) { continue }
    $wi = Get-WinInfo $w
    if (-not $wi.title -and -not $wi.process) { continue }
    $key = "$($wi.pid):$($wi.title)"
    if (-not $seen.Add($key)) { continue }
    $visible += @{ title = $wi.title; process = $wi.process; pid = $wi.pid }
}

# -- 2. screenshot, downsampled to width 1024 (degrade to text-only on failure) --
$shotPath = ''
$scr = $null
$sw = 0; $sh = 0
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($null -eq $bounds -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'no desktop' }
    $scr = @([int]$bounds.Width, [int]$bounds.Height)
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()

    $sw = 1024
    $sh = [int]([math]::Round($bounds.Height * ($sw / [double]$bounds.Width)))
    if ($sh -le 0) { throw 'bad resize' }
    $small = New-Object System.Drawing.Bitmap $sw, $sh
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $sw, $sh)
    $sg.Dispose()
    $bmp.Dispose()

    $shotPath = Join-Path $outdir 'screen.raw.jpg'
    $small.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $small.Dispose()
} catch {
    Write-Warning "screen shot skipped: $($_.Exception.Message)"
}

$meta = @{
    title       = $fg.title
    process     = $fg.process
    pid         = $fg.pid
    rect        = $fg.rect
    screen      = $scr
    focus       = $focus
    windows     = $visible
    shot_path   = $shotPath
    captured_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz')
} | ConvertTo-Json -Compress -Depth 5
[IO.File]::WriteAllText((Join-Path $outdir 'screen.raw.json'), $meta, (New-Object System.Text.UTF8Encoding($false)))

Write-Output "SCREENPULSE_OK title='$($fg.title)' process='$($fg.process)' shot=${sw}x${sh} focus='$($focus.title)' windows=$($visible.Count)"
