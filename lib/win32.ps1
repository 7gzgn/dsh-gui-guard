<#
  dsh-gui-guard -- Win32 action layer (PowerShell backend)

  NOTE: this file is deliberately ALL-ASCII. Windows PowerShell 5.1 reads .ps1
  files as ANSI unless they carry a BOM, so any non-ASCII source here would be
  mangled into a syntax error on a GBK machine. Localized text lives in the
  node side (tool descriptions / README), never in this file.

  Why this layer exists -- it folds the four things that most often break when
  an agent tries to operate a Windows window into one atomic call:

    1. the window may be MINIMIZED  -> clicks land on the desktop instead
    2. the window may not be FOREGROUND -> the first click only activates it
    3. the system may have DPI scaling -> screenshot/OCR pixels vs GetWindowRect
       logical pixels are two different coordinate spaces
    4. the first typed character gets eaten -> when activation and typing happen
       in the same call

  Usage:
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win32.ps1 -Action <action> -Payload '<json>'
  Output: one line of JSON.

  Actions: list | probe | prepare | click | type
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Payload = '{}',
  [string]$Payload64 = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GG {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
"@

function Get-WinText([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][GG]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

function Get-Target([string]$needle, $pidValue) {
  $all = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($pidValue) {
    return ($all | Where-Object { $_.Id -eq [int]$pidValue } | Select-Object -First 1)
  }
  if ([string]::IsNullOrWhiteSpace($needle)) { return $null }
  $exact = @($all | Where-Object { (Get-WinText $_.MainWindowHandle) -eq $needle })
  if ($exact.Count -gt 0) { return $exact[0] }
  $partial = @($all | Where-Object { (Get-WinText $_.MainWindowHandle) -like "*$needle*" })
  if ($partial.Count -gt 0) { return $partial[0] }
  return $null
}

function Get-Snapshot([IntPtr]$h) {
  $r = New-Object GG+RECT
  [void][GG]::GetWindowRect($h, [ref]$r)
  $p = New-Object GG+POINT
  [void][GG]::GetCursorPos([ref]$p)
  $dpiWin = 0
  try { $dpiWin = [GG]::GetDpiForWindow($h) } catch { $dpiWin = 0 }
  $logicalW = [GG]::GetSystemMetrics(0)
  $logicalH = [GG]::GetSystemMetrics(1)
  $scale = if ($dpiWin -gt 0) { [math]::Round($dpiWin / 96.0, 4) } else { 1.0 }
  return [ordered]@{
    hwnd       = [int64]$h
    title      = (Get-WinText $h)
    minimized  = [bool][GG]::IsIconic($h)
    visible    = [bool][GG]::IsWindowVisible($h)
    foreground = ([GG]::GetForegroundWindow() -eq $h)
    rect       = [ordered]@{ left = $r.Left; top = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    cursor     = [ordered]@{ x = $p.X; y = $p.Y }
    dpi        = [ordered]@{ window = $dpiWin; scale = $scale }
    screen     = [ordered]@{
      logicalWidth   = $logicalW
      logicalHeight  = $logicalH
      physicalWidth  = [int][math]::Round($logicalW * $scale)
      physicalHeight = [int][math]::Round($logicalH * $scale)
    }
  }
}

function Ensure-Foreground([IntPtr]$h) {
  $wasForeground = ([GG]::GetForegroundWindow() -eq $h)
  $wasMinimized = [bool][GG]::IsIconic($h)
  if ($wasMinimized) { [void][GG]::ShowWindow($h, 9) }
  [void][GG]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0003)
  [void][GG]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 450
  return [ordered]@{
    wasForeground = $wasForeground
    wasMinimized  = $wasMinimized
    isForeground  = ([GG]::GetForegroundWindow() -eq $h)
  }
}

function Out-Json($obj) {
  Write-Output ($obj | ConvertTo-Json -Depth 8 -Compress)
}

try {
  $a = @{}
  $rawPayload = $Payload
  if (-not [string]::IsNullOrWhiteSpace($Payload64)) {
    # base64 keeps the command line free of quoting/escaping problems entirely
    $rawPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload64))
  }
  if (-not [string]::IsNullOrWhiteSpace($rawPayload)) {
    $parsed = $rawPayload | ConvertFrom-Json
    if ($parsed) { $parsed.PSObject.Properties | ForEach-Object { $a[$_.Name] = $_.Value } }
  }

  switch ($Action) {

    'list' {
      $rows = @()
      foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object Id)) {
        $t = Get-WinText $p.MainWindowHandle
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        $rows += [ordered]@{
          pid       = $p.Id
          name      = $p.ProcessName
          title     = $t
          minimized = [bool][GG]::IsIconic($p.MainWindowHandle)
        }
      }
      Out-Json ([ordered]@{ ok = $true; action = 'list'; count = $rows.Count; windows = $rows })
    }

    'probe' {
      $t = Get-Target $a['window'] $a['pid']
      if (-not $t) { Out-Json ([ordered]@{ ok = $false; action = 'probe'; error = 'window-not-found' }); break }
      $snap = Get-Snapshot $t.MainWindowHandle
      $snap['pid'] = $t.Id
      $snap['process'] = $t.ProcessName
      $notes = @()
      if ($snap.minimized) { $notes += 'Window is MINIMIZED: clicking by coordinates now would land on the desktop. Run action=prepare first.' }
      if (-not $snap.foreground) { $notes += 'Window is NOT foreground: a first click may only activate it and not reach the control. Use action=click, which handles this.' }
      if ($snap.dpi.scale -ne 1.0) {
        $notes += ("DPI scaling is active (" + [int]($snap.dpi.scale * 100) + "%): screenshot/OCR tools report PHYSICAL pixels while GetWindowRect reports LOGICAL pixels. Do not convert by hand -- use the coordinates the screenshot/OCR tool itself returned.")
      }
      $snap['notes'] = $notes
      $snap['ok'] = $true
      $snap['action'] = 'probe'
      Out-Json $snap
    }

    'prepare' {
      $t = Get-Target $a['window'] $a['pid']
      if (-not $t) { Out-Json ([ordered]@{ ok = $false; action = 'prepare'; error = 'window-not-found' }); break }
      $h = $t.MainWindowHandle
      $before = Ensure-Foreground $h
      if ($a.ContainsKey('width') -and $a.ContainsKey('height')) {
        $x = if ($a.ContainsKey('x')) { [int]$a['x'] } else { 0 }
        $y = if ($a.ContainsKey('y')) { [int]$a['y'] } else { 0 }
        [void][GG]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, [int]$a['width'], [int]$a['height'], 0x0040)
        Start-Sleep -Milliseconds 450
        [void][GG]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 250
      }
      $snap = Get-Snapshot $h
      $snap['ok'] = $true
      $snap['action'] = 'prepare'
      $snap['before'] = $before
      $snap['pid'] = $t.Id
      Out-Json $snap
    }

    'click' {
      $t = Get-Target $a['window'] $a['pid']
      if (-not $t) { Out-Json ([ordered]@{ ok = $false; action = 'click'; error = 'window-not-found' }); break }
      $h = $t.MainWindowHandle
      $fx = [int]$a['x']
      $fy = [int]$a['y']
      # Coordinate space matters: screenshot/OCR tools report PHYSICAL pixels,
      # while SetCursorPos (called from a DPI-unaware host) speaks LOGICAL
      # pixels. Default to 'physical' because that is what those tools emit.
      $space = if ($a.ContainsKey('space')) { [string]$a['space'] } else { 'physical' }
      $scale = 1.0
      try { $d = [GG]::GetDpiForWindow($h); if ($d -gt 0) { $scale = $d / 96.0 } } catch { $scale = 1.0 }
      $lx = $fx
      $ly = $fy
      if ($space -eq 'physical' -and $scale -ne 1.0) {
        $lx = [int][math]::Round($fx / $scale)
        $ly = [int][math]::Round($fy / $scale)
      }
      $before = Ensure-Foreground $h
      [void][GG]::SetCursorPos($lx, $ly)
      Start-Sleep -Milliseconds 220
      [GG]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 90
      [GG]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 350
      $p = New-Object GG+POINT
      [void][GG]::GetCursorPos([ref]$p)
      Out-Json ([ordered]@{
        ok            = $true
        action        = 'click'
        window        = (Get-WinText $h)
        pid           = $t.Id
        requested     = [ordered]@{ x = $fx; y = $fy; space = $space }
        applied       = [ordered]@{ x = $lx; y = $ly; space = 'logical'; scale = $scale }
        cursorNowAt   = [ordered]@{ x = $p.X; y = $p.Y }
        cursorMatches = ([math]::Abs($p.X - $lx) -le 2 -and [math]::Abs($p.Y - $ly) -le 2)
        wasMinimized  = $before.wasMinimized
        wasForeground = $before.wasForeground
        isForeground  = $before.isForeground
        note          = $(if (-not $before.wasForeground) { 'Window was not foreground: this click first activated it. If the target control did not react, click once more at the same coordinates.' } else { '' })
      })
    }

    'type' {
      $t = Get-Target $a['window'] $a['pid']
      if (-not $t) { Out-Json ([ordered]@{ ok = $false; action = 'type'; error = 'window-not-found' }); break }
      $h = $t.MainWindowHandle
      $before = Ensure-Foreground $h
      Start-Sleep -Milliseconds 250
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait([string]$a['text'])
      Start-Sleep -Milliseconds 200
      Out-Json ([ordered]@{
        ok            = $true
        action        = 'type'
        window        = (Get-WinText $h)
        sentLength    = ([string]$a['text']).Length
        wasMinimized  = $before.wasMinimized
        wasForeground = $before.wasForeground
        isForeground  = $before.isForeground
      })
    }

    default {
      Out-Json ([ordered]@{ ok = $false; error = ("unknown action: " + $Action) })
    }
  }
} catch {
  Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message; action = $Action })
}
