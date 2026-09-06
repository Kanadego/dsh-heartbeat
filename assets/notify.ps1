# notify.ps1 - Windows toast channel (port of v1, D12 discipline applied).
# The toast is an ATTENTION HINT ONLY: it never carries the expression body.
# Mechanism: desktop toast identity = Start Menu shortcut (AppUserModelID)
# + HKCU registry DisplayName. Self-registers once per machine/user (HKCU and
# %APPDATA% are writable without elevation). Sends via WinRT
# ToastNotificationManager with the registered AUMID: no focus stealing,
# lands in the notification center.

param(
    [string]$Title = "Heartbeat",
    [string]$Message = "You have a new message",
    [switch]$RegisterOnly,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$AUMID = 'DshHeartbeat.App'
$DisplayName = 'DSH Heartbeat'
$lnkDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnkPath = Join-Path $lnkDir 'DshHeartbeat.lnk'
$regPath = "HKCU:\Software\Classes\AppUserModelId\$AUMID"

function Test-Registered {
    $hasLnk = Test-Path $lnkPath
    $hasReg = (Test-Path $regPath) -and (Get-ItemProperty $regPath -Name DisplayName -ErrorAction SilentlyContinue)
    return ($hasLnk -and $hasReg)
}

function Register-HeartbeatNotifier {
    New-Item -ItemType Directory -Force -Path $lnkDir | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -Command Write-Host 'dsh-heartbeat'"
    $lnk.Save()
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name DisplayName -Value $DisplayName
    Set-ItemProperty -Path $regPath -Name IconUri -Value "powershell.exe,0"
    Write-Host "REGISTERED: $AUMID"
}

function Send-HeartbeatToast([string]$t, [string]$m) {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $escT = [System.Security.SecurityElement]::Escape($t)
    $escM = [System.Security.SecurityElement]::Escape($m)
    $xml = "<toast><visual><binding template='ToastGeneric'><text>$escT</text><text>$escM</text></binding></visual></toast>"
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID)
    $notifier.Show((New-Object Windows.UI.Notifications.ToastNotification $doc))
    Write-Host "TOAST_SENT"
}

if ($Check) {
    if (Test-Registered) { Write-Host "REGISTERED: yes" } else { Write-Host "REGISTERED: no" }
    exit 0
}

if (-not (Test-Registered)) { Register-HeartbeatNotifier }

if ($RegisterOnly) { exit 0 }

if ([string]::IsNullOrWhiteSpace($Message)) {
    Write-Host "ERROR: -Message required (or use -RegisterOnly / -Check)"
    exit 1
}

Send-HeartbeatToast $Title $Message
