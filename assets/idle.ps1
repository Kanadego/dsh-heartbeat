# idle.ps1 - presence probe. Privacy boundary: outputs exactly ONE number
# (keyboard/mouse idle seconds). Knows nothing about what the user is doing.

param([string]$out)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    long tick = Environment.TickCount & 0x7FFFFFFF;   // tick wrap protection
    long last = li.dwTime & 0x7FFFFFFF;
    return tick >= last ? (tick - last) / 1000 : 0;
  }
}
'@

$idle = [IdleProbe]::IdleSeconds()
[IO.File]::WriteAllText($out, $idle.ToString())
