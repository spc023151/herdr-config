// Exits when the left mouse button is up (at once if it already is; at most 2 minutes).
// my-agents / my-pane start it when a drag begins, and cancel the drag when it exits,
// so letting go anywhere (a terminal, outside the window) ends the drag.
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class WaitUp {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static int Main() {
    var until = DateTime.UtcNow.AddMinutes(2);
    // Swapped buttons: the physical left button is reported as the right one.
    int vk = GetSystemMetrics(23) != 0 ? 0x02 : 0x01;
    while ((GetAsyncKeyState(vk) & 0x8000) != 0 && DateTime.UtcNow < until) Thread.Sleep(15);
    return 0;
  }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
}
