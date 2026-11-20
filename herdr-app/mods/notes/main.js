// A scratch notepad above the tab bar. Every change is saved to ~/herdr-notes/notes.md
// within SAVE_MS (atomic replace), and right away when it loses the keyboard, so a crash
// or a sudden restart keeps what was typed. A copy of each day's first save is kept as
// ~/herdr-notes/notes-YYYY-MM-DD.md, in case something gets deleted by mistake.
// The header folds the block to a thin bar and back (its height is kept by the layout).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { theme, home, readTextFile, writeTextFile, run, layout } from "herdr";

const SAVE_MS = 400;
const DIR = () => `${home()}/herdr-notes`;
const FILE = () => `${DIR()}/notes.md`;
const FOLDED_PX = 28;
const OPEN_PX = 150;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export default class Notes extends View {
  init(_props, cx) {
    this.loaded = false;
    this.disk = null; // what the file holds, as far as we know (null: no file yet)
    this.state = "載入中…";
    this.seq = 0;
    this.saving = false;
    this.again = false;
    this.backedUp = null;
    this.box = TextareaState.new({ placeholder: "暫存資訊寫在這裡，會自動存檔（~/herdr-notes/notes.md）" });
    this.box.set_soft_wrap(true);
    this.box.on("change", (_e, cx) => this.changed(cx));
    this.box.on("blur", (_e, cx) => this.save(cx));
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(FILE());
        this.disk = text;
        if (text) this.box.set_value(text);
        // No file yet: create it now, so a failing path shows up before anything is typed.
        if (text == null) { await writeTextFile(FILE(), "", null); this.disk = ""; }
        this.state = "已載入";
      } catch (e) {
        this.state = `讀取失敗：${e}`;
      }
      this.loaded = true;
      cx.notify();
    });
  }

  changed(cx) {
    if (!this.loaded) return;
    if (this.box.value() === (this.disk ?? "")) return;
    this.state = "未存檔…";
    const n = ++this.seq;
    cx.timer.after(SAVE_MS, (cx) => { if (n === this.seq) this.save(cx); });
    cx.notify();
  }

  save(cx) {
    if (!this.loaded) return;
    if (this.saving) { this.again = true; return; }
    const text = this.box.value();
    if (text === (this.disk ?? "") && this.disk != null) return;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        try {
          await writeTextFile(FILE(), text, this.disk);
        } catch {
          // The file changed under us (or appeared): take what's there as the base, our text wins.
          const now = await readTextFile(FILE());
          await writeTextFile(FILE(), text, now);
        }
        this.disk = text;
        const d = new Date();
        this.state = `已存檔 ${clock(d)}`;
        if (this.backedUp !== day(d)) {
          this.backedUp = day(d);
          // A day's copy is written once; if it already exists, it stays as it was.
          writeTextFile(`${DIR()}/notes-${day(d)}.md`, text, null).catch(() => {});
        }
      } catch (e) {
        this.state = `存檔失敗：${e}`;
      }
      this.saving = false;
      if (this.again) { this.again = false; this.save(cx); }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const node = find(layout(), "notes");
    const folded = (node?.size?.px ?? OPEN_PX) <= FOLDED_PX + 2;
    const bad = this.state.startsWith("存檔失敗") || this.state.startsWith("讀取失敗");
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(h_flex().id("notes-head").h(FOLDED_PX).flex_none().px(12).gap(8).items_center().text_size(11.5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => {
          if (!folded) this.openPx = node?.size?.px ?? OPEN_PX;
          run("layout.resize", { id: "notes", px: folded ? (this.openPx ?? OPEN_PX) : FOLDED_PX });
        })
        .child(div().font_medium().text_color(t.foreground).child("記事"))
        .child(div().text_color(bad ? t.blocked : t.dim).child(this.state))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(folded ? "展開 ▾" : "收起 ▴")))
      .when(!folded, (el) => el.child(div().flex_1().min_h(0).px(8).pb(6)
        .child(Textarea.new(this.box).size_full().px(8).py(6).rounded(6).border_1().border_color(t.border)
          .bg(t.background).text_size(13).text_color(t.foreground))));
  }
}
