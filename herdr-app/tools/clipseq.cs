// Prints the clipboard's change counter (GetClipboardSequenceNumber), never its contents.
// my-menu reads it before and after terminal.copy: if it moved, a selection was copied.
using System;
using System.Runtime.InteropServices;
static class ClipSeq {
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  static void Main() { Console.Write(GetClipboardSequenceNumber()); }
}
