# herdr 個人化設定

給 [herdr](https://github.com/herdr-app)（herdr-app＋herdr-core）在 Windows 上用的自訂 mod、版面與重開機自動恢復 agent session 的腳本。不含任何個人的 agent 清單、群組、session 紀錄或筆記內容。

## 內容

| 路徑 | 放到 | 作用 |
|---|---|---|
| `herdr-app/mods/my-agents` | `~/.config/herdr-app/mods/` | agent 列表：同分頁多個 agent 各自顯示標題、依分頁自動分組、自訂群組、拖曳與右鍵選單；Ctrl+C 有反白就複製，沒有就送中斷（`my-agents.smartcopy`） |
| `herdr-app/mods/my-menu` | 同上 | 終端機右鍵選單，加上複製／貼上 |
| `herdr-app/mods/my-pane` | 同上 | 窗格工具列（分割、縮放、關閉、拖曳） |
| `herdr-app/mods/my-spaces` | 同上 | Space 列表：按 + 先選資料夾，space 名稱＝資料夾名 |
| `herdr-app/mods/notes` | 同上 | 分頁列上方的記事區，自動存到 `~/herdr-notes/notes.md`，每天另存一份 |
| `herdr-app/layouts/my-main.json` | `~/.config/herdr-app/layouts/` | 使用上面這些 mod 的版面 |
| `herdr-app/keys.json`、`settings.json` | `~/.config/herdr-app/` | 快速鍵（含 Ctrl+C）與基本設定（遙測關閉） |
| `herdr-app/tools/*.cs` | `~/.config/herdr-app/tools/` | `clipseq`（讀剪貼簿變更計數，判斷複製是否成功）、`waitup` 的原始碼；用 `csc` 編譯成 .exe |
| `herdr-core/config.toml` | `~/.config/herdr-core/` | 新終端機改用 `herdr-shell.ps1` 啟動；把 `<USER>` 換成自己的使用者名稱 |
| `herdr-resume/` | `~/.claude/herdr-resume/` | 重開機後依 `HC_TERMINAL_ID` 自動 `claude --resume`／`codex resume` 原本的 session |
| `powershell/Microsoft.PowerShell_profile.ps1` | `~/Documents/WindowsPowerShell/` | 補救：在 config.toml 改之前建立的終端機，被 herdr-core 重建時也會跑恢復腳本 |

## 自動恢復的接法

`map.mjs` 要掛成 Claude Code 的 SessionStart／SessionEnd hook（`~/.claude/settings.json`）：

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/herdr-resume/map.mjs start" }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node ~/.claude/herdr-resume/map.mjs end" }] }]
}
```

Codex 則在 `~/.codex/config.toml` 頂層設 `notify = ["node", "<路徑>/map.mjs", "codex"]`。

對照表存在 `herdr-resume/sessions.json`（不在 repo 裡，執行時自動產生）。故意退出的 session 會被移除，不會自動恢復。

## 注意

- 改 shipped mod 前先 `herdr-app do mod.clone`；新 mod 資料夾一定先寫 `mod.json` 再寫 `main.js`，否則 herdr 會把它當成空白區塊停靠。
- `keys.json` 變成自己的檔案後，herdr 升級不會再自動加入新的預設快速鍵。
- 不要用 `hc server stop/restart`，會結束所有終端機。
