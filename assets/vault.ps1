# vault.ps1 - DPAPI (CurrentUser) whole-file encryption for the heartbeat plugin.
# ASCII-only on purpose: avoids PowerShell 5.1 codepage issues on Windows.
#
# Usage:
#   vault.ps1 protect   -InFile <plain> -OutFile <enc>   plain -> KHBV1 header + DPAPI blob
#   vault.ps1 unprotect -InFile <enc>   -OutFile <plain> KHBV1 blob -> plain
#
# Security model: CurrentUser scope = usable autonomously inside this Windows
# account; other accounts / other machines cannot decrypt. Defends against
# other people, not same-account malware.
#
# The caller (vault.ts) validates every path against the workspace guard
# before invoking this script. This script performs no path policy of its own.

param(
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][string]$InFile,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$MAGIC = [Text.Encoding]::ASCII.GetBytes('KHBV1')

function Protect-File([string]$InPath, [string]$OutPath) {
    $plain = [IO.File]::ReadAllBytes($InPath)
    $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
    $ms = New-Object IO.MemoryStream
    $ms.Write($MAGIC, 0, $MAGIC.Length)
    $ms.Write($blob, 0, $blob.Length)
    [IO.File]::WriteAllBytes($OutPath, $ms.ToArray())
}

function Unprotect-File([string]$InPath, [string]$OutPath) {
    $raw = [IO.File]::ReadAllBytes($InPath)
    if ($raw.Length -lt $MAGIC.Length) { throw "NOT_ENCRYPTED: file shorter than KHBV1 header" }
    $hdr = New-Object byte[] $MAGIC.Length
    [Array]::Copy($raw, $hdr, $MAGIC.Length)
    for ($i = 0; $i -lt $MAGIC.Length; $i++) {
        if ($hdr[$i] -ne $MAGIC[$i]) { throw "NOT_ENCRYPTED: missing KHBV1 header" }
    }
    $blob = New-Object byte[] ($raw.Length - $MAGIC.Length)
    [Array]::Copy($raw, $MAGIC.Length, $blob, 0, $blob.Length)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
    [IO.File]::WriteAllBytes($OutPath, $plain)
}

switch ($Action) {
    'protect'   { Protect-File $InFile $OutFile; Write-Output "PROTECTED: $OutFile" }
    'unprotect' { Unprotect-File $InFile $OutFile; Write-Output "UNPROTECTED: $OutFile" }
    default     { Write-Output "usage: vault.ps1 protect|unprotect -InFile <file> -OutFile <file>"; exit 1 }
}
