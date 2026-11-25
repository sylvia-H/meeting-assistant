---
name: 會議助手
description: 像作業系統內建筆記 App 的本機會議助手：左側會議清單，中央是人的筆記，右側是可拖寬窄的逐字稿素材欄。
colors:
  bg: "#ffffff"
  side: "#f5f5f7"
  raise: "#ffffff"
  fill: "#ececf0"
  fill-2: "#f4f4f7"
  hover: "#e9e9ee"
  ink: "#1d1d1f"
  ink-2: "#3f3f44"
  mute: "#616166"
  line: "#e2e2e7"
  line-strong: "#cfcfd6"
  sel: "#fbe7ad"
  sel-ink: "#1d1d1f"
  acc: "#e8a600"
  acc-hover: "#d69a00"
  acc-ink: "#1d1d1f"
  ring: "#b97f00"
  rec: "#d8342b"
  ok: "#1f6b43"
  danger: "#c0352b"
  danger-bg: "#fdecea"
  warn: "#6f4a00"
  warn-bg: "#fdf3dc"
  thumb: "#c9c9cf"
  thumb-hover: "#a5a5ad"
  k-decision: "#1d6440"
  k-decision-bg: "#e2f3e8"
  k-todo: "#2a4d9c"
  k-todo-bg: "#e6edfb"
  k-question: "#6f4a00"
  k-question-bg: "#fbefd5"
  k-idea: "#563b92"
  k-idea-bg: "#efe8fa"
  k-note: "#45454a"
  k-note-bg: "#ededf0"
  k-section: "#3f3f44"
  k-section-bg: "#e9e9ee"
  bg-dark: "#1c1c1e"
  side-dark: "#232325"
  raise-dark: "#2c2c2f"
  fill-dark: "#333336"
  fill-2-dark: "#28282b"
  hover-dark: "#303034"
  ink-dark: "#f2f2f4"
  ink-2-dark: "#d2d2d7"
  mute-dark: "#a2a2a8"
  line-dark: "#38383c"
  line-strong-dark: "#4a4a50"
  sel-dark: "#4a3d14"
  sel-ink-dark: "#f7f2e2"
  acc-dark: "#f0b429"
  acc-hover-dark: "#f5c34f"
  acc-ink-dark: "#1d1d1f"
  ring-dark: "#f0b429"
  rec-dark: "#ff5a50"
  ok-dark: "#8fdcac"
  danger-dark: "#ff8178"
  danger-bg-dark: "#3e2220"
  warn-dark: "#f1c873"
  warn-bg-dark: "#3d3015"
  thumb-dark: "#4a4a4f"
  thumb-hover-dark: "#616167"
  k-decision-dark: "#95e0b1"
  k-decision-bg-dark: "#1d3a2a"
  k-todo-dark: "#a4bff7"
  k-todo-bg-dark: "#1f2c48"
  k-question-dark: "#f1c873"
  k-question-bg-dark: "#3d3015"
  k-idea-dark: "#ccb8f4"
  k-idea-bg-dark: "#30264a"
  k-note-dark: "#cfcfd4"
  k-note-bg-dark: "#333336"
  k-section-dark: "#dcdce1"
  k-section-bg-dark: "#36363a"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.85
  note:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  transcript:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.8
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  pill:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
  mono:
    fontFamily: "ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace"
    fontSize: "0.88em"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  seg: "9px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  pane: "20px"
  sheet: "32px"
components:
  button:
    backgroundColor: "{colors.fill-2}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.acc}"
    textColor: "{colors.acc-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.acc-hover}"
  button-primary-lg:
    backgroundColor: "{colors.acc}"
    textColor: "{colors.acc-ink}"
    rounded: "{rounded.lg}"
    padding: "8px 20px"
    height: "40px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    size: "30px"
  segmented-control:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.seg}"
    padding: "2px"
  segmented-control-on:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.ink}"
    rounded: "7px"
    padding: "3px 11px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "34px"
  composer:
    backgroundColor: "{colors.fill-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "6px 6px 6px 10px"
  sidebar:
    backgroundColor: "{colors.side}"
    textColor: "{colors.ink}"
    padding: "12px 10px 0"
  sidebar-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
    height: "32px"
  sidebar-row-selected:
    backgroundColor: "{colors.sel}"
    textColor: "{colors.sel-ink}"
  tag-decision:
    backgroundColor: "{colors.k-decision-bg}"
    textColor: "{colors.k-decision}"
    typography: "{typography.pill}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  tag-todo:
    backgroundColor: "{colors.k-todo-bg}"
    textColor: "{colors.k-todo}"
    typography: "{typography.pill}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  tag-question:
    backgroundColor: "{colors.k-question-bg}"
    textColor: "{colors.k-question}"
    typography: "{typography.pill}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  tag-idea:
    backgroundColor: "{colors.k-idea-bg}"
    textColor: "{colors.k-idea}"
    typography: "{typography.pill}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  tag-note:
    backgroundColor: "{colors.k-note-bg}"
    textColor: "{colors.k-note}"
    typography: "{typography.pill}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  status-pill:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  settings-group:
    backgroundColor: "{colors.fill-2}"
    rounded: "{rounded.xl}"
  settings-row:
    padding: "11px 16px"
    height: "54px"
  toast:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
---

# Design System: 會議助手

## Overview

**Creative North Star: "作業系統內建的筆記本"**

會議助手長得像作業系統自帶的筆記 App，而不是一個 AI 產品：左側灰色側欄是會議清單，中央白紙是人自己的筆記（人的判斷是主角），右側是可以拖曳調寬的逐字稿素材欄。整套介面用系統字體、1px 細線、8–12px 的圓角和兩種主題下各自調好的中性灰，安靜到開會時一瞥就懂，眼睛可以留在會議本身。

色彩只在有意義的地方出現：黃色是「你的下一步」與「你選中的那場會議」，紅色只代表「正在錄」，筆記類型（決議、待辦、待確認、想法、筆記）各有一組淡底深字的膠囊色。其餘一切都是灰階與細線。資訊密度維持在工具等級：13–16px 的內文、32px 高的控制項、工具列 56px，不靠大留白或大字製造氣氛。

已確認拒絕的方向：白底卡片＋藍色主按鈕的 SaaS 儀表板、首頁會議卡片牆。

**Key Characteristics:**
- 三欄外殼：灰側欄＋中央 680–720px 版心＋可拖寬窄的側欄（逐字稿／對照素材）。
- 淺色白底配 #f5f5f7 側欄；深色 #1c1c1e 配 #232325 側欄，兩種主題共用同一套變數名稱。
- 黃色只給一個主要動作與選取中的會議，紅色只給錄音中。
- 五色筆記類型膠囊，深淺兩組各自調色。
- 系統字體、1px 分隔線、8–12px 圓角、主題化細捲軸、平面無陰影。
- 動態只用在狀態切換（120–160ms），錄音中沒有持續動畫；`prefers-reduced-motion` 時全部歸零。

## Colors

一套近乎無彩的系統灰，加上一個琥珀黃的行動色、一個錄音紅，以及五組只為筆記類型服務的淡彩膠囊。所有顏色都以 CSS 變數定義在 `src/styles.css` 的 `:root, [data-theme='light']` 與 `[data-theme='dark']` 兩個區塊，名稱完全一致；frontmatter 中帶 `-dark` 後綴的是同一變數在深色主題的值。

### Primary
- **琥珀行動黃**（`acc`，hover `acc-hover`，字色 `acc-ink`）：每個畫面唯一的主要動作按鈕（建立並開始錄音、結束會議、儲存、複製 Markdown）。同一語意延伸到幾個小型「輪到你」的狀態訊號：開關打開、暫停中的錄音點、未儲存變更的小圓點、拖曳中的分隔線。深色主題提亮為較飽和的金黃，字色仍是深墨。
- **選取暖黃**（`sel` / `sel-ink`）：側欄中選取中的會議列與「新會議」列，以及文字選取 `::selection`。它是行動黃的淡化版，表示「你在這裡」。
- **焦點琥珀**（`ring`）：所有 `:focus-visible` 的 2px 外框、輸入框聚焦時的邊框。淺色主題用較深的 #b97f00 以確保在白底上看得到。

### Secondary
- **錄音紅**（`rec`）：只代表「正在錄音」——工具列錄音點的 recording 狀態、側欄會議列的「錄音中」小紅點與文字、紀錄頁的 live 狀態膠囊。

### Tertiary
- **筆記類型膠囊**（`k-decision` 決議綠、`k-todo` 待辦藍、`k-question` 待確認黃、`k-idea` 想法紫、`k-note` 筆記灰，各配 `-bg` 淡底；另有 `k-section` 環節灰）：淡底深字，深色主題改為深底亮字。它們是筆記的語意分類，也被狀態膠囊借用（已整理＝決議綠）。
- **狀態色**（`ok`、`danger`／`danger-bg`、`warn`／`warn-bg`）：成功文字與音量條、錯誤與刪除、橫幅與提醒膠囊。

### Neutral
- **紙白**（`bg`）：主工作區底色、頁尾輸入列與儲存列底色。
- **側欄灰**（`side`）：側欄與右側素材欄的底色，讓中央白紙浮出來。
- **浮層**（`raise`）：選單、提示框、分段控制選中的那格；深色主題比底色亮一階。
- **填色**（`fill`、`fill-2`）：搜尋框、分段控制的槽、膠囊與 chip 底色；一般按鈕與輸入列用較淺的 `fill-2`。
- **滑過灰**（`hover`）：列表列、圖示按鈕、一般按鈕的 hover 底色。
- **墨色三階**（`ink` 主文字、`ink-2` 次要文字與圖示、`mute` 時間、說明、placeholder）。
- **細線**（`line` 一般分隔、`line-strong` 輸入框外框與表頭底線）。
- **捲軸**（`thumb`、`thumb-hover`）：細捲軸的滑塊。

### Named Rules
**The One Yellow Voice Rule.** 每個畫面只有一個黃色按鈕。黃色是「下一步」與「你選中的」，不是裝飾、不是區塊底色、不是連結色；新的小狀態要用黃色，必須同樣是「輪到你處理」的意思。

**The Red Means Live Rule.** 紅色（`rec`）只表示此刻正在錄音。錯誤與刪除用 `danger`，不借用錄音紅；暫停中的錄音點改為黃色。

**The Same Names Rule.** 每個主題變數都同時在淺色與深色區塊宣告，元件只寫 `var(--name)`，不寫死任一主題的色碼；少數例外（開關圓鈕白色、截圖移除鈕的半透明黑）只出現在兩種主題下都成立的地方。

## Typography

**Display Font:** 系統字體（-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif）
**Body Font:** 同上
**Label/Mono Font:** ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace（只用於 `code`、`kbd` 與指令提示）

**Character:** 完全交給作業系統的介面字體，讓 App 看起來就是系統的一部分；層級靠字重（400／600／700）與 13–28px 的小幅級距建立，不靠字體對比。

### Hierarchy
- **Headline**（700，28px，1.3，`text-wrap: balance`）：會議標題（可點擊修改）、設定頁標題、逐字稿版面的大標；首頁標題輸入框用 clamp(20px, 5.4vw, 28px)。
- **Title**（700，18px）：會議紀錄 Markdown 的 h2；h1 為 22px，h3 為 15.5px／600。
- **Note**（400，16px，1.65）：中央筆記內文；會議紀錄本文同為 16px，行高放寬到 1.85。
- **Body**（400，15px，1.7）：全站基準字級，也用於頁尾輸入框。
- **Transcript**（400，14.5px，1.8）：側欄逐字稿與可編輯段落；切到「逐字稿」版面置中閱讀時放大為 17px／1.85。
- **Control**（400，13.5px，1.3）：按鈕與下拉選單；分段控制 13px，選中格 600。
- **Label**（600，13px）：環節小標、設定群組標題、欄位標籤、逐字稿段落標頭；側欄分組與窗格標題為 12–12.5px／600，顏色 `mute`。
- **Caption**（400，12–12.5px）：時間戳、說明、提示、legend。
- **Pill**（600，12px，行高 1）：筆記類型膠囊。

### Named Rules
**The System Voice Rule.** 只用系統字體堆疊，不載入任何外部字型；字級變化不超過 13–28px 這個工具級距。

**The Tabular Time Rule.** 計時器、時間戳、段落編號、日期行一律 `font-variant-numeric: tabular-nums`，數字跳動時不晃動版面。

## Layout

外殼是兩欄 grid：側欄 `clamp(208px, 18vw, 260px)` 加工作區。每個頁面頂端是一條至少 56px 高、以 1px 細線分隔的工具列（padding 10px 20px），下方為可捲動內容。

文件型頁面（首頁、設定）用 680px 置中版心，padding 26px 32px 40px；會議紀錄版心放寬到 720px。錄音頁與紀錄頁是三欄 grid：中央主欄、7px 的拖曳分隔（視覺上是置中的 1px 細線，hover／拖曳時加粗為 3px 黃線）、右側素材欄 `var(--tr-w, clamp(300px, 32%, 560px))`。錄音頁底部有常駐輸入列（dock），內容同樣限制在 680px 置中。

「並排｜筆記｜逐字稿」三種版面切換 grid-template-areas：筆記版面讓筆記占滿，逐字稿版面把逐字稿移到中央 720px 版心以大字閱讀，筆記插在對應段落下。

響應式分兩層：
- **容器查詢 `view` ≤760px**（半個螢幕寬的線上會議）：素材欄移到主欄下方（錄音頁 minmax(140px, 36%)、紀錄頁 minmax(160px, 40%)），分隔線隱藏，版心左右 padding 降為 20px，非主要按鈕只留圖示，設定列改為單欄。
- **視窗 ≤880px**：側欄變成左側抽屜（min(280px, 86vw)），配半透明遮罩與開關按鈕。

間距節奏以 4／8／12 為基礎，窗格內距 20px、版心內距 32px；列表列垂直 padding 5–8px，控制項間距 6–10px。

## Elevation & Depth

整套系統是平面的，深度靠色調分層：白紙（`bg`）放在灰側欄（`side`）旁，浮層（`raise`）在深色主題比底色亮一階，區塊之間用 1px 細線而不是陰影。陰影只留給真正浮在內容上方的東西。

### Shadow Vocabulary
- **浮層陰影**（`--shadow`；淺色 `0 8px 24px rgba(20, 20, 30, 0.12), 0 1px 3px rgba(20, 20, 30, 0.08)`，深色 `0 10px 30px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.4)`）：下拉選單、提示框（toast）、窄畫面的側欄抽屜。
- **選中格微陰影**（`0 1px 2px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.04)`）：分段控制選中的那一格，模仿系統分段控制。
- **開關圓鈕**（`0 1px 3px rgba(0, 0, 0, 0.3)`）：開關的白色圓鈕。

### Named Rules
**The Flat Paper Rule.** 卡片、列表、窗格、設定群組都不帶陰影；只有選單、提示框、抽屜這類暫時浮在上面的東西才用 `--shadow`。

## Shapes

圓角是柔和的系統級圓角：小控制與行內按鈕 6px，按鈕、輸入框、列表列、截圖 8px，分段控制 9px（內格 7px），大按鈕、選單、提示框、提醒框、拖放區 10px，輸入列與設定群組 12px；膠囊、狀態標籤、與會者、捲軸滑塊、開關一律 999px 全圓。邊框幾乎都是 1px（`line` 或 `line-strong`），唯一例外是拖放區的 1.5px 虛線與 `kbd` 底部 2px 的鍵帽厚度。焦點外框 2px、offset 2px（輸入框 offset 0）。

## Components

### Buttons
安靜、系統感，hover 只換底色。
- **Shape:** 柔和圓角（8px），大按鈕 10px。
- **Primary:** 行動黃底、深墨字、600 字重、無邊框；最小高度 32px、padding 5px 12px；大尺寸 40px、padding 8px 20px、15px 字。每個畫面只出現一次。
- **Default:** `fill-2` 底、1px `line` 邊框、`ink` 字，13.5px。
- **Hover / Focus:** hover 換到 `hover`（主按鈕換 `acc-hover`），120ms ease-out 背景與邊框過渡；焦點為 2px `ring` 外框。停用時透明度 0.55。
- **Icon button:** 30×30px 透明底、8px 圓角、`ink-2` 圖示，hover 換 `hover` 底；`.btn.icon-only` 為 32px 寬的方形按鈕。

### Segmented Control
仿系統分段控制，用於「並排｜筆記｜逐字稿」與側欄底部的主題切換（淺色／深色／跟隨系統）。
- `fill` 槽、2px 內距、9px 圓角；未選格透明、`ink-2` 字；選中格 `raise` 底、600 字重、微陰影、7px 圓角。

### Chips
- **筆記類型膠囊：** 22px 高、padding 0 9px、全圓角、12px／600；五種類型各一組淡底深字（深色主題深底亮字），另有環節灰與指令用的 `fill`＋`mute`。紀錄頁可編輯時改為同外觀的下拉選單（`tag-select`），hover 微暗。legend 中縮為 18px 高、11px。
- **狀態膠囊：** padding 2px 10px、12.5px／600；預設 `fill`＋`ink-2`，已整理用決議綠、待整理用 `warn`、錄音中用 `danger-bg`＋`rec`。
- **與會者：** `fill` 底全圓角，名字 `ink`、身分小字 `mute` 11.5px。
- **檔案 chip：** `fill` 底、8px 圓角，右側 22px 移除鈕。

### Cards / Containers
- **Corner Style:** 12px（設定群組）、10px（提醒框、選單、提示框）。
- **Background:** 設定群組淺色用 `fill-2`、深色用 `raise`；提醒框用 `warn-bg`。
- **Shadow Strategy:** 見 Elevation & Depth；容器本身不帶陰影。
- **Border:** 1px `line`；設定列之間以 1px `line` 分隔。
- **Internal Padding:** 設定列 11px 16px、最小高度 54px，標籤欄 minmax(150px, 36%)、控制項靠右，輸入寬度 min(100%, 360px)。

### Inputs / Fields
- **Style:** 最小高度 34px、padding 6px 10px、1px `line-strong` 外框、8px 圓角、`bg` 底、14px；下拉選單用自繪的 16px 箭頭。
- **Focus:** 2px `ring` 外框、offset 0、邊框轉透明。
- **Composer（頁尾輸入列）：** `fill-2` 底、1px `line-strong`、12px 圓角，左側是目前類型膠囊、右側送出按鈕；聚焦時邊框與 1px 外光改為 `ring`。紀錄頁的補筆記輸入列為同款 10px 圓角、`bg` 底。
- **開關：** 42×24px 全圓，關閉 `line-strong`、打開 `acc`，圓鈕 140ms 滑動。
- **拖放區：** 1.5px `line-strong` 虛線、10px 圓角；hover 或拖入時邊框轉 `ring`、底色 `fill-2`。

### Navigation
- **側欄：** `side` 底、右側 1px `line`；頂部品牌名（15px／700）、`fill` 底的搜尋框（聚焦時整個框 2px `ring`）、「新會議」列；會議依「今天／這週」分組（12px／600 `mute` 小標），每列標題 14px／600 單行省略、下方 12px `mute` 時間與狀態。hover 換 `hover`，選中為 `sel` 底。底部 1px 分隔後是設定列與主題分段控制。
- **窄畫面：** ≤880px 變為左側抽屜，160ms 滑入、帶 `--shadow` 與 30% 黑色遮罩。

### Editable-in-place Text（招牌元件）
會議標題、逐字稿段落、紀錄頁筆記、環節小標都可以直接點擊修改：平常看起來就是內文（透明底、透明 1px 邊框），hover 露出 1px `line` 邊框，聚焦時邊框轉 `ring`、底色回到 `bg`。textarea 用 `field-sizing: content` 隨內容長高，不出現捲軸。

### Notes List（招牌元件）
筆記以環節小標分組：小標 13px／600 `ink-2`，右側延伸一條 1px `line` 細線到時間戳。每則筆記是三欄 grid：左邊類型膠囊、中間 16px 內文、右邊 12px tabular 時間；截圖縮圖最寬 300px、8px 圓角、1px 邊框。刪除鈕平常隱藏，hover 列或聚焦時出現（觸控裝置常駐），hover 變 `danger`。

### Transcript Segment
每段以 1px `line` 分隔、padding 12px 0；段頭 13px／600 依序為 tabular 段號、環節名稱、時間、已修改標記（`ok`）與儲存狀態。

### Toast
`raise` 底、1px `line`、10px 圓角、`--shadow`，右下角堆疊；有常駐輸入列的頁面上移到輸入列上方（bottom 120px）。錯誤版本用 `danger-bg` 底與混入 45% `danger` 的邊框。進場 140ms 上移淡入。

## Do's and Don'ts

### Do:
- **Do** 所有顏色都寫 `var(--name)`，新增顏色時同時在淺色與深色兩個區塊宣告同名變數。
- **Do** 每個畫面只放一個黃色主要動作按鈕（`acc`），其餘按鈕用 `fill-2` 預設樣式。
- **Do** 區塊之間用 1px `line` 細線分隔，圓角留在 6–12px 與 999px 全圓膠囊兩種語彙內。
- **Do** 時間、計時、段號、日期使用 `font-variant-numeric: tabular-nums`。
- **Do** 圖示使用 `src/ui/icons.ts` 的 24 格、1.8 線寬、圓角端點、`currentColor` 線條 SVG。
- **Do** 狀態過渡限制在 120–160ms ease-out，並讓 `prefers-reduced-motion: reduce` 把過渡與動畫歸零。
- **Do** 可就地編輯的文字平常看起來就是內文，hover 露出 1px 邊框、聚焦轉 `ring`。
- **Do** 主題預設跟隨系統，手動選擇存在 localStorage `meeting-assistant.theme`，並在第一次繪製前由 index.html 套上 `data-theme`。

### Don't:
- **Don't** 做成白底卡片＋藍色主按鈕的 SaaS 儀表板，也不要把會議做成首頁卡片牆。
- **Don't** 用錄音紅（`rec`）表示錄音以外的任何狀態；錯誤與刪除用 `danger`。
- **Don't** 把黃色當裝飾、區塊底色或第二個主要按鈕。
- **Don't** 用 Unicode 符號或 emoji 充當圖示。
- **Don't** 給卡片、列表、設定群組加陰影；陰影只屬於選單、提示框與抽屜。
- **Don't** 載入外部字型或其他外部資源。
- **Don't** 在錄音中加入持續播放的動畫。
