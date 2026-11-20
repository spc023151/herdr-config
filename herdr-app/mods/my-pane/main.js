// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "my-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
//
// Drag: press the header and hold (ARM_MS) to pick the session up, then let go
//  - on another session's header: the pane moves there (same tab: they trade places);
//  - on a group in the Agents list (my-agents): it joins that group / moves to that tab;
//  - anywhere else: nothing happens.
// The drag lives in shared "agents.drag" so my-agents sees it. tools/waitup.exe exits when
// the mouse button is released anywhere, which ends a drag nobody caught.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, agents, props, run, theme, home, shared, setShared, exec, appHome } from "herdr";

const DRAG = "agents.drag";
const ARM_MS = 180;
const WAITUP = () => `${appHome()}/tools/waitup.exe`;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Panes with terminals, in the order the Agents list (and the screen) shows them.
function ordered() {
  const order = agents().map((a) => a.address);
  const at = (t) => { const i = order.indexOf(t); return i < 0 ? 1e9 : i; };
  return panes().filter((p) => p.terminal).sort((x, y) => at(x.terminal) - at(y.terminal));
}

// Moves `addr`'s pane to where `near`'s pane is. Same tab: they trade places
// (one before the other becomes after, and the reverse). Another tab: right of it.
// Park it (the program keeps running), focus the pane to follow, give it a pane again
// to the right of that; to land first, place it after and swap it left.
function movePane(addr, near, cx) {
  const ps = ordered();
  const src = ps.find((p) => p.terminal === addr);
  const dst = ps.find((p) => p.terminal === near);
  if (!src || !dst || src === dst) return;
  const there = ps.filter((p) => p.tab === dst.tab && p.terminal !== addr);
  const i = there.indexOf(dst);
  let anchor = dst;
  let swapLeft = false;
  if (src.tab === dst.tab) {
    const mine = ps.filter((p) => p.tab === dst.tab);
    const before = mine.indexOf(src) > mine.indexOf(dst); // src after dst: put it before dst
    if (before) {
      if (i > 0) anchor = there[i - 1];
      else swapLeft = true;
    }
  }
  run("terminal.park", { terminal: addr });
  let tries = 0;
  const settle = (cx) => {
    if (panes().some((p) => p.terminal === addr) && tries++ < 25) return cx.timer.after(120, settle);
    run("pane.focus", { pane: anchor.pane });
    cx.timer.after(150, (cx) => {
      run("terminal.keep", { terminal: addr, place: "right" });
      if (!swapLeft) return;
      let waits = 0;
      const swap = (cx) => {
        if (!panes().some((p) => p.terminal === addr) && waits++ < 25) return cx.timer.after(120, swap);
        run("pane.focus", { terminal: addr });
        cx.timer.after(120, () => run("pane.swap", { direction: "left" }));
      };
      cx.timer.after(120, swap);
    });
  };
  cx.timer.after(120, settle);
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/my-pane/${icon}.svg`).size(14));
  }

  // Press: pick it up (not shown yet). Held past ARM_MS: it's a drag. Released anywhere:
  // whatever didn't take the drop, the waiter clears it.
  press(term, cx) {
    const at = Date.now();
    this.pressAt = at;
    setShared(DRAG, { from: term, at, moving: false });
    cx.timer.after(ARM_MS, (cx) => {
      const d = shared(DRAG);
      if (this.pressAt !== at || d?.from !== term || d.at !== at) return;
      setShared(DRAG, { ...d, moving: true });
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try { await exec(WAITUP()); } catch {}
      if (this.pressAt === at) this.pressAt = null;
      const d = shared(DRAG);
      if (d?.from === term && d.at === at) setShared(DRAG, null);
      cx.notify();
    });
  }

  release(term, cx) {
    this.pressAt = null;
    const d = shared(DRAG);
    if (d?.from && d.from !== term && d.moving) {
      // Another session dropped on this header: move it here.
      setShared(DRAG, null);
      movePane(d.from, term, cx);
    } else if (d?.from === term) {
      setShared(DRAG, null); // let go on its own header: cancelled (or just a click)
    }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const term = props()?.terminal ?? p.terminal;
    const cur = shared(DRAG);
    const lifted = Boolean(term && cur?.from === term && cur.moving);
    // Another session is being dragged: this header is a place to drop it.
    const target = Boolean(term && cur?.from && cur.from !== term && cur.moving);
    const hot = target && this.hovered;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(lifted ? t.accent : hot ? t.accent + "40" : target ? t.accent + "14" : t.background)
      .border_b(1)
      .border_color(lifted || target ? t.accent : t.border)
      .when(target, (el) => el.border_1().border_dashed())
      .text_size(12)
      .when(Boolean(term), (el) => (lifted || target ? el.cursor_grabbing() : el.cursor_grab()))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .when(Boolean(term), (el) => el
        .on_mouse_down("left", (_e, cx) => this.press(term, cx))
        .on_mouse_up("left", (_e, cx) => this.release(term, cx)))
      .on_click(() => run("pane.focus", { pane }))
      // The grip says "this bar drags"; brighter on hover, white while dragging.
      .when(Boolean(term), (el) => el.child(svg("mods/my-pane/grip.svg").size(12).flex_none().ml(-4)
        .text_color(lifted ? "#ffffff" : this.hovered || target ? t.foreground : t.muted)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(lifted ? "#ffffff" : t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(lifted ? "#ffffffcc" : t.dim).child(folder(p.cwd)))
      .when(lifted, (el) => el.child(div().flex_none().px(8).h(20).flex().items_center().rounded(5)
        .bg(t.background).text_size(11).font_medium().text_color(t.accent).child("放到別的 session 標題列＝換位置；放到左下群組＝加入")))
      .when(target, (el) => el.child(div().flex_none().px(8).h(20).flex().items_center().rounded(5)
        .bg(hot ? t.accent : t.background).text_size(11).font_medium().text_color(hot ? "#ffffff" : t.accent).child("放這裡＝移到這個位置")))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered && !lifted && !target, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
