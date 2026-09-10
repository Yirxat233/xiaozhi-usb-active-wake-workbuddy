param(
  [ValidateSet("Existing", "New")] [string]$Mode = "Existing",
  [string]$SessionId,
  [string]$Cwd,
  [string]$MessageBase64,
  [int]$TimeoutMs = 10000
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Drawing
$drawingAssembly = [System.Drawing.Bitmap].Assembly.Location

if (-not ("WorkBuddyBridge.NativeInput" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace WorkBuddyBridge {
  public static class NativeInput {
    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_A = 0x41;
    private const ushort VK_RETURN = 0x0D;
    private static Point lastSendButton = Point.Empty;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public int type; public InputUnion input; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
      [FieldOffset(0)] public MOUSEINPUT mouse;
      [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
      public int dx;
      public int dy;
      public uint mouseData;
      public uint flags;
      public uint time;
      public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
      public ushort virtualKey;
      public ushort scanCode;
      public uint flags;
      public uint time;
      public UIntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }

    private static INPUT Key(ushort virtualKey, ushort scanCode, uint flags) {
      return new INPUT {
        type = INPUT_KEYBOARD,
        input = new InputUnion { keyboard = new KEYBDINPUT {
          virtualKey = virtualKey, scanCode = scanCode, flags = flags,
          time = 0, extraInfo = UIntPtr.Zero
        }}
      };
    }

    private static void Send(params INPUT[] inputs) {
      uint delivered = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      if (delivered != inputs.Length)
        throw new InvalidOperationException("SendInput delivered " + delivered + "/" + inputs.Length +
          " keyboard events (Win32=" + Marshal.GetLastWin32Error() + ", size=" + Marshal.SizeOf(typeof(INPUT)) + ").");
    }

    public static void SelectAll() {
      Send(Key(VK_CONTROL, 0, 0), Key(VK_A, 0, 0),
        Key(VK_A, 0, KEYEVENTF_KEYUP), Key(VK_CONTROL, 0, KEYEVENTF_KEYUP));
    }

    public static void SendText(string text) {
      foreach (char value in text)
        Send(Key(0, value, KEYEVENTF_UNICODE), Key(0, value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }

    public static void Submit() {
      Send(Key(VK_RETURN, 0, 0), Key(VK_RETURN, 0, KEYEVENTF_KEYUP));
    }

    public static void Click(int x, int y) {
      SetCursorPos(x, y);
      mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
      mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    public static void FocusComposer(IntPtr handle) {
      RECT rect;
      if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("Cannot read WorkBuddy window bounds.");
      int x = rect.left + (int)((rect.right - rect.left) * 0.46);
      int y = rect.top + (int)((rect.bottom - rect.top) * 0.84);
      Click(x, y);
    }

    private static bool IsDark(byte[] pixels, int stride, int x, int y) {
      int offset = y * stride + x * 3;
      return pixels[offset] < 85 && pixels[offset + 1] < 85 && pixels[offset + 2] < 85;
    }

    private static Point FindSendButton(IntPtr handle) {
      RECT rect;
      if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("Cannot read WorkBuddy window bounds.");
      int width = rect.right - rect.left;
      int height = rect.bottom - rect.top;
      using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
        using (Graphics graphics = Graphics.FromImage(bitmap)) {
          graphics.CopyFromScreen(rect.left, rect.top, 0, 0, new Size(width, height));
        }
        Rectangle bitmapRect = new Rectangle(0, 0, width, height);
        BitmapData data = bitmap.LockBits(bitmapRect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try {
          int stride = Math.Abs(data.Stride);
          byte[] pixels = new byte[stride * height];
          Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
          bool[] visited = new bool[width * height];
          int xStart = Math.Max(0, (int)(width * 0.55));
          int xEnd = Math.Min(width - 1, (int)(width * 0.99));
          int yStart = Math.Max(0, (int)(height * 0.08));
          int yEnd = Math.Min(height - 1, (int)(height * 0.97));
          double bestScore = Double.MinValue;
          Point best = Point.Empty;

          for (int y = yStart; y <= yEnd; y++) {
            for (int x = xStart; x <= xEnd; x++) {
              int startIndex = y * width + x;
              if (visited[startIndex]) continue;
              visited[startIndex] = true;
              if (!IsDark(pixels, stride, x, y)) continue;

              Queue<int> queue = new Queue<int>();
              queue.Enqueue(startIndex);
              int area = 0, minX = x, maxX = x, minY = y, maxY = y;
              while (queue.Count > 0) {
                int index = queue.Dequeue();
                int currentX = index % width;
                int currentY = index / width;
                area++;
                minX = Math.Min(minX, currentX); maxX = Math.Max(maxX, currentX);
                minY = Math.Min(minY, currentY); maxY = Math.Max(maxY, currentY);
                int[] neighbors = { index - 1, index + 1, index - width, index + width };
                foreach (int neighbor in neighbors) {
                  if (neighbor < 0 || neighbor >= visited.Length || visited[neighbor]) continue;
                  int neighborX = neighbor % width;
                  int neighborY = neighbor / width;
                  if (neighborX < xStart || neighborX > xEnd || neighborY < yStart || neighborY > yEnd) continue;
                  if (Math.Abs(neighborX - currentX) + Math.Abs(neighborY - currentY) != 1) continue;
                  visited[neighbor] = true;
                  if (IsDark(pixels, stride, neighborX, neighborY)) queue.Enqueue(neighbor);
                }
              }

              int componentWidth = maxX - minX + 1;
              int componentHeight = maxY - minY + 1;
              if (componentWidth >= 24 && componentWidth <= 64 && componentHeight >= 24 && componentHeight <= 64 && area >= 260) {
                double score = area + maxX * 2.0 + maxY * 0.05;
                if (score > bestScore) {
                  bestScore = score;
                  best = new Point(rect.left + (minX + maxX) / 2, rect.top + (minY + maxY) / 2);
                }
              }
            }
          }
          if (best == Point.Empty) throw new InvalidOperationException("Cannot visually locate the WorkBuddy send button.");
          return best;
        } finally {
          bitmap.UnlockBits(data);
        }
      }
    }

    public static void FocusComposerFromSendButton(IntPtr handle) {
      RECT rect;
      if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("Cannot read WorkBuddy window bounds.");
      lastSendButton = FindSendButton(handle);
      int horizontalOffset = Math.Max(160, (rect.right - rect.left) / 4);
      Click(Math.Max(rect.left + 80, lastSendButton.X - horizontalOffset), Math.Max(rect.top + 80, lastSendButton.Y - 55));
    }

    public static void ClickDetectedSendButton() {
      if (lastSendButton == Point.Empty) throw new InvalidOperationException("Send button has not been detected.");
      Click(lastSendButton.X, lastSendButton.Y);
    }

  }
}
"@ -ReferencedAssemblies $drawingAssembly
}

if ([string]::IsNullOrWhiteSpace($MessageBase64)) { throw "MessageBase64 is required." }
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageBase64))
if ([string]::IsNullOrWhiteSpace($message)) { throw "Message must not be empty." }

if ($Mode -eq "New") {
  if ([string]::IsNullOrWhiteSpace($Cwd)) { throw "Cwd is required for New mode." }
  if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) { throw "Workspace directory does not exist: $Cwd" }
  $deepLink = "workbuddy://task?action=start&cwd=$([Uri]::EscapeDataString($Cwd))&prompt=$([Uri]::EscapeDataString($message))&welcomeMode=code&mode=craft"
} else {
  if ([string]::IsNullOrWhiteSpace($SessionId)) { throw "SessionId is required for Existing mode." }
  # Existing conversations use a hostless URI so the renderer receives /task/<id>.
  $deepLink = "workbuddy:///task/$([Uri]::EscapeDataString($SessionId))"
}
[Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{ FileName = $deepLink; UseShellExecute = $true }) | Out-Null

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$windowProcess = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $windowProcess) {
  $windowProcess = Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $windowProcess) { Start-Sleep -Milliseconds 200 }
}

if (-not $windowProcess) { throw "WorkBuddy desktop window was not found before timeout." }

[WorkBuddyBridge.NativeInput]::ShowWindowAsync($windowProcess.MainWindowHandle, 9) | Out-Null
[WorkBuddyBridge.NativeInput]::SetForegroundWindow($windowProcess.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds $(if ($Mode -eq "New") { 4000 } else { 2000 })
[WorkBuddyBridge.NativeInput]::FocusComposerFromSendButton($windowProcess.MainWindowHandle)
Start-Sleep -Milliseconds 120
[WorkBuddyBridge.NativeInput]::SelectAll()
[WorkBuddyBridge.NativeInput]::SendText($message)
Start-Sleep -Milliseconds 100
[WorkBuddyBridge.NativeInput]::ClickDetectedSendButton()
Start-Sleep -Milliseconds 150
[WorkBuddyBridge.NativeInput]::Submit()

[pscustomobject]@{ ok = $true; mode = $Mode; sessionId = $SessionId; cwd = $Cwd; processId = $windowProcess.Id } | ConvertTo-Json -Compress
