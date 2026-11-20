// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, appHome, hc, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "custom", label: "自訂群組", icon: "layers" },
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "space", label: "Grouped by space", icon: "layers" },
];
// Anything else (including the old "grouped") reads as custom groups.
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];

// Custom groups, kept in shared state: { groups: [{id, name}], of: {address: groupId},
// order: [address...], folded: [groupId | "none"] }.
const CUSTOM = "agents.custom";
const EXT_DRAG = "agents.drag";
const ARM_MS = 180;
function loadCustom() {
  const c = shared(CUSTOM) ?? {};
  return { groups: [...(c.groups ?? [])], of: { ...(c.of ?? {}) }, order: [...(c.order ?? [])], folded: [...(c.folded ?? [])] };
}
const saveCustom = (c) => setShared(CUSTOM, c);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const openPrompt = (gp) => openOverlay({ mod: "my-agents", kind: "dialog", width: 360, height: 200, props: { groupPrompt: gp } });
// New tabs go last. herdr puts a new tab right after the active one, which pushes the
// numbers of the tabs behind it along. One new tab (the "+", tab.new, a kept terminal) is
// moved to the end; several at once (a restore, a new space) are left where they are.
const KNOWN_TABS = "agents.knownTabs";
function keepNewTabsLast() {
  const ss = spaces();
  const ids = ss.flatMap((s) => s.tabs.map((t) => t.id));
  const known = shared(KNOWN_TABS);
  if (!Array.isArray(known)) return setShared(KNOWN_TABS, ids);
  const fresh = ids.filter((id) => !known.includes(id));
  if (!fresh.length && ids.length === known.length) return;
  if (fresh.length === 1) {
    const s = ss.find((s) => s.tabs.some((t) => t.id === fresh[0]));
    const i = s.tabs.findIndex((t) => t.id === fresh[0]);
    const old = s.tabs.some((t) => known.includes(t.id));
    if (old && i < s.tabs.length - 1) run("tab.move", { id: fresh[0], index: s.tabs.length });
  }
  setShared(KNOWN_TABS, ids);
}
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    const p = props();
    if (p?.groupPrompt) return this.initPrompt(p.groupPrompt, cx);
    if (p?.sortMenu || p?.agentMenu || p?.groupMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // keys.json binds ctrl-c in terminals to "my-agents.smartcopy": with text selected it copies;
    // otherwise the terminal gets a real Ctrl+C (interrupt). terminal.copy leaves the clipboard
    // alone without a selection, so the clipboard change counter (tools/clipseq.exe; never reads
    // the contents) tells which happened.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "smartcopy") this.smartCopy().catch(() => {});
      }
    });
  }

  async smartCopy() {
    const term = focused()?.terminal;
    const seq = async () => (await exec(`${appHome()}/tools/clipseq.exe`).catch(() => null))?.stdout?.trim() ?? null;
    const before = await seq();
    let copied = false;
    if (before != null) {
      run("terminal.copy", {});
      for (let i = 0; i < 3 && !copied; i++) { const now = await seq(); copied = now != null && now !== before; }
    }
    if (!copied && term) await hc(["keys", term, "ctrl+c"]);
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // ---- Custom groups: name dialog ----
  initPrompt(gp, cx) {
    this.text = gp.value ?? "";
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submitPrompt());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submitPrompt() {
    const p = props();
    const gp = p.groupPrompt;
    const name = (this.text ?? "").trim();
    closeOverlay(p.overlay);
    if (!name) return;
    const c = loadCustom();
    if (gp.mode === "rename") {
      const g = c.groups.find((g) => g.id === gp.gid);
      if (g) g.name = name;
    } else {
      const id = newId();
      c.groups.push({ id, name });
      if (gp.move) c.of[gp.move] = id;
    }
    saveCustom(c);
  }

  promptView(t) {
    const p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("ag-prompt").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(p.groupPrompt.mode === "rename" ? "重新命名群組" : "新增群組"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("名稱"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("agp-cancel", "取消", false, () => closeOverlay(p.overlay)))
        .child(button("agp-save", "儲存", true, () => this.submitPrompt())));
  }

  // ---- Custom groups: right-click menus ----
  menuBox(t, title, items) {
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(title))
      .children(items.map(([id, label, action, danger]) => h_flex()
        .id(`agm-${id}`).h(31).px(8).rounded(7).items_center()
        .text_color(danger ? (t.ansi1 ?? t.foreground) : t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(action)
        .child(div().flex_1().truncate().child(label))));
  }

  agentMenu(t, addr) {
    const close = () => closeOverlay(props().overlay);
    const c = loadCustom();
    const cur = c.of[addr];
    const edit = (fn) => () => { const c2 = loadCustom(); fn(c2); saveCustom(c2); close(); };
    const items = [["new", "新增群組並移入…", () => { close(); openPrompt({ mode: "new", move: addr }); }]];
    for (const g of c.groups) if (g.id !== cur) items.push([`to-${g.id}`, `移到「${g.name}」`, edit((c2) => { c2.of[addr] = g.id; })]);
    if (cur && c.groups.some((g) => g.id === cur)) items.push(["out", "移出群組", edit((c2) => { delete c2.of[addr]; })]);
    return this.menuBox(t, "Agent", items);
  }

  groupMenu(t, gid) {
    const close = () => closeOverlay(props().overlay);
    const c = loadCustom();
    const i = c.groups.findIndex((g) => g.id === gid);
    if (i < 0) return this.menuBox(t, "群組", []);
    const g = c.groups[i];
    const edit = (fn) => () => { const c2 = loadCustom(); fn(c2); saveCustom(c2); close(); };
    const swap = (d) => edit((c2) => { const j = i + d; [c2.groups[i], c2.groups[j]] = [c2.groups[j], c2.groups[i]]; });
    const items = [["rename", "重新命名…", () => { close(); openPrompt({ mode: "rename", gid, value: g.name }); }]];
    if (i > 0) items.push(["up", "上移", swap(-1)]);
    if (i < c.groups.length - 1) items.push(["down", "下移", swap(1)]);
    items.push(["del", "刪除群組（agent 移到未分組）", edit((c2) => {
      c2.groups = c2.groups.filter((x) => x.id !== gid);
      for (const k of Object.keys(c2.of)) if (c2.of[k] === gid) delete c2.of[k];
      c2.folded = c2.folded.filter((x) => x !== gid);
    }), true]);
    return this.menuBox(t, g.name, items);
  }

  // ---- Custom groups: drag and drop ----
  // target: { addr, gid, before } for a row, { header: true, gid } for a group header.
  // Adopts a session picked up by long-pressing its pane header (my-pane), shared as
  // "agents.drag"; drops a stale one. Called on render and from the drag handlers.
  syncExt() {
    const ext = shared(EXT_DRAG);
    const live = Boolean(ext?.from) && Date.now() - (ext.at ?? 0) < 120000;
    if (live && this.drag?.from !== ext.from) { this.drag = { from: ext.from, external: true }; this.over = null; }
    if (live && this.drag?.external) this.drag.moving = Boolean(ext.moving);
    if (this.drag?.external && !live) { this.drag = null; this.over = null; }
  }

  // Starts a drag on press; held past ARM_MS it shows as dragging (a quick click doesn't).
  arm(drag, cx) {
    this.drag = drag;
    this.over = null;
    cx.timer.after(ARM_MS, (cx) => {
      if (this.drag !== drag) return;
      drag.moving = true;
      cx.notify();
    });
    // Released anywhere (outside the list too): a drag nobody took ends here.
    cx.spawn(async (cx) => {
      try { await exec(`${appHome()}/tools/waitup.exe`); } catch {}
      if (this.drag === drag) { this.drag = null; this.over = null; cx.notify(); }
    });
  }

  // Ends any drag, including one picked up from a pane header (shared "agents.drag").
  endDrag() {
    this.drag = null;
    this.over = null;
    if (shared(EXT_DRAG)) setShared(EXT_DRAG, null);
  }

  drop(target, cx) {
    const d = this.drag;
    this.endDrag();
    if (!d) return;
    // A group header dropped on another header: it takes that header's place.
    if (d.tab || d.group) {
      if (target.header) this.moveGroup(d, target);
      return;
    }
    const c = loadCustom();
    if (!d.from || target.addr === d.from) return;
    const order = (this.flat ?? []).filter((x) => x !== d.from);
    if (target.addr) {
      const i = order.indexOf(target.addr);
      order.splice(i < 0 ? order.length : i + (target.before ? 0 : 1), 0, d.from);
    } else order.push(d.from);
    if (target.gid) c.of[d.from] = target.gid;
    else delete c.of[d.from];
    c.order = order;
    saveCustom(c);
    // Dropped into a tab's group: really move the session into that tab, beside its panes.
    if (!target.gid && target.tab && cx) this.moveToTab(d.from, target.tab, target.addr, Boolean(target.before), cx);
  }

  // Headers are one sequence (this.seq): tab groups in tab-bar order, custom groups between
  // them (each remembers the tab it follows, `after`, null = top). The dragged header lands
  // where the target was, like tabs in the tab bar. A tab group moves its real tab.
  moveGroup(d, target) {
    const seq = this.seq ?? [];
    const from = seq.findIndex((x) => (d.group ? x.gid === d.group : x.tab === d.tab));
    const to = target.end ? seq.length - 1 : seq.findIndex((x) => (target.gid ? x.gid === target.gid : Boolean(target.tab) && x.tab === target.tab));
    if (from < 0 || to < 0 || from === to) return;
    const rest = seq.filter((_, i) => i !== from);
    const at = rest.indexOf(seq[to]);
    rest.splice(from < to ? at + 1 : at, 0, seq[from]);
    // Custom groups: their new order, each after the nearest tab above it.
    const c = loadCustom();
    const byId = new Map(c.groups.map((g) => [g.id, g]));
    let lastTab = null;
    const ordered = [];
    for (const x of rest) {
      if (x.tab) lastTab = x.tab;
      else if (byId.has(x.gid)) { ordered.push({ ...byId.get(x.gid), after: lastTab }); byId.delete(x.gid); }
    }
    c.groups = [...ordered, ...byId.values()];
    saveCustom(c);
    if (!d.tab) return;
    // The tab: right after the tab above it in the new order (same space), else first.
    const s = spaces().find((s) => s.tabs.some((t) => t.id === d.tab));
    if (!s) return;
    const ids = s.tabs.map((t) => t.id);
    const mine = rest.filter((x) => x.tab && ids.includes(x.tab)).map((x) => x.tab);
    const prev = mine[mine.indexOf(d.tab) - 1];
    const q = ids.indexOf(d.tab);
    const p = prev ? ids.indexOf(prev) : -1;
    const index = p < 0 ? 1 : q < p ? p + 1 : p + 2;
    if (index !== q + 1) run("tab.move", { id: d.tab, index });
  }

  // Moves a terminal's pane so the panes on the right match the list: into `tab`, just
  // before/after the pane of `near` (or at the end). Park it (pane gone, program keeps
  // running), focus the pane it should follow, give it a pane again to the right of that;
  // to land first, place it after `near` and swap it left.
  moveToTab(addr, tab, near, before, cx) {
    const order = agents().map((a) => a.address);
    const ps = panes().filter((p) => p.terminal).sort((x, y) => order.indexOf(x.terminal) - order.indexOf(y.terminal));
    const src = ps.find((p) => p.terminal === addr);
    if (!src) return;
    const there = ps.filter((p) => p.tab === tab && p.terminal !== addr);
    if (!there.length) return;
    let anchor = there.at(-1);
    let swapLeft = false;
    const i = near ? there.findIndex((p) => p.terminal === near) : -1;
    if (i >= 0) {
      if (!before) anchor = there[i];
      else if (i > 0) anchor = there[i - 1];
      else { anchor = there[0]; swapLeft = true; }
    }
    // Already right there: nothing to move.
    if (src.tab === tab && !swapLeft) {
      const mine = ps.filter((p) => p.tab === tab);
      if (mine[mine.indexOf(src) - 1]?.terminal === anchor.terminal) return;
    }
    if (src.tab === tab && swapLeft && ps.filter((p) => p.tab === tab)[0]?.terminal === addr) return;
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

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    const op = props();
    if (op?.sortMenu) return this.sortMenu(t);
    if (op?.groupPrompt) return this.promptView(t);
    if (op?.agentMenu) return this.agentMenu(t, op.agentMenu);
    if (op?.groupMenu) return this.groupMenu(t, op.groupMenu);
    keepNewTabsLast();
    const collapsed = narrow();
    const sort = sortOf();
    const custom = sort.id === "custom";
    const c = custom ? loadCustom() : null;
    // A session picked up by long-pressing its pane header (my-pane) is dragged here too.
    if (custom) this.syncExt();
    // A real drag (not a click): a header drag moved, a row drag reached a target, or a
    // pane-header drag left its header.
    // Local drags turn "moving" after a short hold (see arm), so it shows without waiting for
    // hover events, which don't come while a button is held over the same element.
    const dragging = custom && Boolean(this.drag) && (Boolean(this.drag.moving) || (!this.drag.external && Boolean(this.over) && this.over.addr !== this.drag.from));
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    if (custom) {
      const pos = new Map(c.order.map((x, i) => [x, i]));
      list = [...list].sort((x, y) => (pos.get(x.address) ?? 1e9) - (pos.get(y.address) ?? 1e9) || x.seq - y.seq);
    }
    // Custom groups keep pins in place: the person arranges the list by hand.
    const pinned = custom ? [] : list.filter((a) => a.pinned);
    const rest = custom ? list : list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      // Several agents share a tab: each row reads its own title (e.g. a /rename name).
      const own = clean(a.title);
      const sharing = tab && panes().filter(p => p.tab === tab.id && p.terminal).length > 1;
      // A tab named only a number ("5") says nothing about its agent: the agent's own title wins there too.
      const bare = tab && /^\d+$/.test(tab.name ?? "");
      if ((sharing || bare) && own &&!/^[~/]|^[A-Za-z]:\\/.test(own) && own.toLowerCase() !== a.program?.key) return own;
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || (isPinned && !custom);
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(custom, (el) => {
          const gid = c.groups.some((g) => g.id === c.of[a.address]) ? c.of[a.address] : null;
          const d = this.drag;
          const lifted = d?.from === a.address && dragging;
          const over = d?.from && d.from !== a.address && this.over?.addr === a.address;
          return el
            .relative()
            .when(Boolean(dragging), (el) => el.cursor_grabbing())
            // The one being dragged: outlined in accent, dimmed text.
            .when(Boolean(lifted), (el) => el.bg(t.accent + "1f").border_1().border_dashed().border_color(t.accent).opacity(0.75))
            .when(Boolean(over), (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
              .when(this.over.before, (l) => l.top(0))
              .when(!this.over.before, (l) => l.bottom(0))))
            .on_mouse_down("left", (_e, cx) => this.arm({ from: a.address }, cx))
            .on_mouse_move((e, cx) => {
              this.syncExt();
              // A group header dragged over a row: the row's group is the target.
              if (this.drag?.group || this.drag?.tab) {
                const hid = gid ? `cg-${gid}` : `tg-${a.tab}`;
                if (this.over?.header !== hid) { this.over = { header: hid }; cx.notify(); }
                return;
              }
              if (!this.drag?.from) return;
              const before = (e.local_position?.y ?? 0) < (e.bounds?.height ?? 30) / 2;
              if (this.over?.addr !== a.address || this.over.before !== before) { this.over = { addr: a.address, gid, before }; cx.notify(); }
            })
            .on_mouse_up("left", (_e, cx) => {
              this.syncExt();
              if (this.drag?.group || this.drag?.tab) this.drop({ header: true, gid, tab: gid ? null : a.tab }, cx);
              else if (this.drag?.from && this.drag.from !== a.address) this.drop({ addr: a.address, gid, tab: gid ? null : a.tab, before: this.over?.before ?? true }, cx);
              else this.endDrag();
              cx.notify();
            })
            .on_mouse_down("right", () => openOverlay({ mod: "my-agents", kind: "popup", width: 240, height: 300, props: { agentMenu: a.address } }));
        })
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    if (custom) {
      const valid = new Set(c.groups.map((g) => g.id));
      const tabIds = new Set(spaces().flatMap((s) => s.tabs.map((tb) => tb.id)));
      const afterOf = (g) => (g.after && tabIds.has(g.after) ? g.after : null);
      const cust = (g) => ({ id: `cg-${g.id}`, gid: g.id, label: g.name, status: null, members: list.filter((a) => c.of[a.address] === g.id) });
      // Custom groups sit where they were dragged: at the top, or after a tab's group.
      for (const g of c.groups) if (!afterOf(g)) groups.push(cust(g));
      // Agents nobody put in a group are grouped by the tab they're in, in tab-bar order,
      // one header per tab, named exactly like the tab bar shows it.
      const loose = list.filter((a) => !valid.has(c.of[a.address]));
      const multi = spaces().length > 1;
      const ps = panes();
      // Tab groups mirror the panes on the right: agents() is in space, tab, pane order.
      const native = new Map(agents().map((a, i) => [a.address, i]));
      for (const s of spaces()) s.tabs.forEach((tab) => {
        const members = loose.filter((a) => a.tab === tab.id).sort((x, y) => (native.get(x.address) ?? 0) - (native.get(y.address) ?? 0));
        if (members.length) {
          const program = ps.find((p) => p.tab === tab.id && p.program?.agent)?.program ?? ps.find((p) => p.tab === tab.id)?.program;
          const name = /^tb\d+$/.test(tab.name) ? program?.name ?? "Terminal" : tab.name;
          groups.push({ id: `tg-${tab.id}`, gid: null, tab: tab.id, fk: `tab:${tab.id}`, label: multi ? `${s.name} · ${name}` : name, status: null, members });
        }
        for (const g of c.groups) if (afterOf(g) === tab.id) groups.push(cust(g));
      });
      this.seq = groups.filter((g) => g.gid || g.tab).map((g) => ({ gid: g.gid, tab: g.tab }));
      const placed = new Set(groups.flatMap((g) => g.members.map((a) => a.address)));
      const stray = list.filter((a) => !placed.has(a.address));
      if (stray.length) groups.push({ id: "cg-none", gid: null, label: "其他", status: null, members: stray });
      list = groups.flatMap((g) => g.members);
    } else for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }
    this.flat = list.map((a) => a.address);
    setAgentOrder(this.flat);
    const foldKey = (g) => g.fk ?? g.gid ?? "none";
    const isFolded = (g) => (custom ? c.folded.includes(foldKey(g)) : this.folded.has(g.id));
    const toggleFold = (g) => {
      if (!custom) return this.folded.has(g.id) ? this.folded.delete(g.id) : this.folded.add(g.id);
      const c2 = loadCustom();
      const k = foldKey(g);
      c2.folded = c2.folded.includes(k) ? c2.folded.filter((x) => x !== k) : [...c2.folded, k];
      saveCustom(c2);
    };

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    // Custom groups: drag a header onto another to reorder, drop an agent on it to move it in,
    // right-click to rename, move or delete.
    const header = (g) => {
      const open = !isFolded(g);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const target = custom && this.drag && this.over?.header === g.id && (this.drag.from || (this.drag.group && this.drag.group !== g.gid && Boolean(g.gid || g.tab)) || (this.drag.tab && this.drag.tab !== g.tab && Boolean(g.gid || g.tab)));
      return h_flex()
        .id(g.id)
        .relative()
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .when(Boolean(dragging), (el) => el.cursor_grabbing())
        .rounded(6)
        .hover((s) => s.text_color(t.foreground))
        // While an agent is dragged every header is a drop zone (dashed); the one under the pointer fills.
        .when(Boolean(dragging && this.drag.from), (el) => el.mt(2).border_1().border_dashed().border_color(t.accent + "88"))
        .when(Boolean(target && this.drag.from), (el) => el.bg(t.accent + "26").border_color(t.accent).text_color(t.foreground))
        .when(Boolean(target && (this.drag.group || this.drag.tab)), (el) => el.child(div().absolute().left(0).right(0).top(0).h(2).bg(t.accent)))
        .when(custom && this.drag?.group === g.gid && Boolean(g.gid), (el) => el.opacity(0.5))
        .when(custom && Boolean(g.tab) && this.drag?.tab === g.tab && Boolean(this.drag?.moving), (el) => el.opacity(0.5).border_1().border_dashed().border_color(t.accent))
        .when(!custom, (el) => el.on_click((_e, cx) => {
          toggleFold(g);
          cx.notify();
        }))
        .when(custom, (el) => el
          .on_mouse_down("left", (_e, cx) => {
            if (g.gid) this.arm({ group: g.gid }, cx);
            else if (g.tab) this.arm({ tab: g.tab }, cx);
            else { this.drag = null; this.over = null; }
          })
          .on_mouse_move((_e, cx) => {
            this.syncExt();
            if (this.drag && this.over?.header !== g.id) { this.over = { header: g.id }; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            this.syncExt();
            const d = this.drag;
            const moved = d && (d.from || (d.group && d.group !== g.gid && Boolean(g.gid || g.tab)) || (d.tab && d.tab !== g.tab && Boolean(g.gid || g.tab)));
            if (moved) this.drop({ header: true, gid: g.gid, tab: g.tab }, cx);
            else { this.endDrag(); toggleFold(g); }
            cx.notify();
          })
          .when(Boolean(g.gid), (el) => el.on_mouse_down("right", () => openOverlay({ mod: "my-agents", kind: "popup", width: 240, height: 220, props: { groupMenu: g.gid } }))))
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(isFolded(g) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(h_flex().gap(10).items_center()
              .when(custom, (el) => el.child(
                div()
                  .id("ag-newgroup")
                  .text_size(11)
                  .text_color(t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => openPrompt({ mode: "new" }))
                  .tooltip("新增群組")
                  .child(svg("mods/workspace-chrome/plus.svg").size(14))))
              .child(
                div()
                  .id("ag-sort")
                  .text_size(11)
                  .text_color(t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => openOverlay({ mod: "my-agents", kind: "popup", width: 200, height: 175, props: { sortMenu: true } }))
                  .tooltip(`Sort agents: ${sort.label}`)
                  .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
              )),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .when(Boolean(dragging && this.drag.from && !collapsed), (el) => el.child(
        div().mx(8).mb(4).px(8).py(5).rounded(6).bg(t.accent + "1f").border_1().border_color(t.accent + "66")
          .text_size(11).text_color(t.foreground)
          .child("放到群組標題：分頁群組＝搬到該分頁，自訂群組＝加入")))
      .when(Boolean(dragging && (this.drag.tab || this.drag.group) && !collapsed), (el) => el.child(
        div().mx(8).mb(4).px(8).py(5).rounded(6).bg(t.accent + "1f").border_1().border_color(t.accent + "66")
          .text_size(11).text_color(t.foreground)
          .child("放到別的群組上＝移到那個位置；放最下面的虛線框＝移到最後（上方分頁列一起變）")))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always")
        .when(Boolean(dragging), (el) => el.cursor_grabbing())
        // A release on empty space (or outside a row/header) cancels the drag.
        .on_mouse_up("left", (_e, cx) => {
          if (this.drag) { this.endDrag(); cx.notify(); }
        })
        .on_mouse_down_out(() => this.endDrag())
        .children(rows)
        // Dragging a group header: a place at the bottom, to make it the last group.
        .when(Boolean(dragging && (this.drag.group || this.drag.tab) && !collapsed), (el) => el.child(
          div().id("ag-end").mt(6).mb(8).h(34).flex_none().flex().items_center().justify_center().rounded(6)
            .border_1().border_dashed().border_color(t.accent)
            .bg(this.over?.end ? t.accent + "33" : t.accent + "0f")
            .text_size(11).text_color(this.over?.end ? t.foreground : t.accent)
            .on_mouse_move((_e, cx) => { if (!this.over?.end) { this.over = { end: true }; cx.notify(); } })
            .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drop({ header: true, end: true }, cx); cx.notify(); })
            .child("放這裡＝移到最下面"))))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
