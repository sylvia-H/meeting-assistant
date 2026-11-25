---
version: 1
slug: "src-ui-app-ts"
primary_target: "src/ui/app.ts"
related_targets: ["src/styles.css","src/ui/home.ts","src/ui/live.ts","src/ui/result.ts","src/ui/settings.ts"]
---

# 會議助手 · 全站外殼（Operate）

## Scope
整個 web app：外殼（側邊欄）、首頁／新會議、錄音頁、紀錄頁、設定頁。Visitor mode: Operate。

## Audience & task
團隊成員在會議中（半個螢幕寬、整個筆電、外接大螢幕）一邊錄音一邊打筆記、校正逐字稿；會後產生並複製會議紀錄。不能花俏、不能多餘動畫、不能降低資訊密度、不能長得像通用 AI 工具。深淺色兩種模式，預設跟隨系統。

## Chosen direction
使用者在兩輪比稿後，自己指定融合：「Apple 備忘錄」的整體版型 ＋「Granola」把筆記放在畫面中央、筆記類型用彩色標籤。比稿草圖已於 2026-11-25 刪除；選定的方向以實作與 `DESIGN.md` 為準。

## Direction contract
THESIS: 會議助手長得像作業系統內建的筆記 App：左側欄是會議清單，中央是你的筆記（人的判斷是主角），逐字稿是旁邊可拖寬窄的素材欄。拒絕的類別預設：白底卡片＋藍色主按鈕的 SaaS 儀表板、首頁會議卡片牆。
OWN-WORLD: 淺色白底＋#f5f5f7 灰側欄、深色 #1c1c1e／#232325；黃色 #e8a600 只給主要動作（建立並開始錄音、結束會議、儲存、複製 Markdown）與選取中的會議；錄音紅 #e5342b 只給「正在錄」。筆記類型五色膠囊標籤（決議綠、待辦藍、待確認黃、想法紫、筆記灰），兩種模式各一組。系統字體、圓角 8–12px 分段控制、細 1px 分隔線、主題化的細捲軸。
STORY: 打開就看到左邊所有會議、中間「新會議」表單；開會時中央只有自己的筆記與常駐頁尾的輸入框，逐字稿在右邊滾；會後同一個位置換成會議紀錄本文，右邊切換筆記／逐字稿／參考資料對照。
FIRST VIEWPORT: 錄音頁 1440 寬：左側欄 clamp(200px,18vw,260px)；頂部工具列（錄音紅點、計時、段落狀態、並排／筆記／逐字稿分段控制，右側音訊來源、暫停、切段、黃色結束會議）；中央筆記欄版心 680px 置中，日期行＋28px 標題（可點擊修改）＋以環節小標分組的筆記；頁尾常駐輸入列；右側逐字稿欄預設 30%、以 6px 分隔線拖曳調寬。
FORM: 使用者指定的融合方向（Apple 備忘錄版型＋Granola 筆記置中），非 roll 結果；第二輪為使用者指定的四個參考產品。seed: none (unavailable)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature interaction
「並排｜筆記｜逐字稿」分段控制：並排＝筆記中央＋逐字稿右欄（可拖曳分隔線，記住寬度，雙擊還原，鍵盤左右鍵）；筆記＝筆記占滿；逐字稿＝逐字稿移到中央大字閱讀，筆記依段落插在對應段落下。輸入框三種版面都常駐頁尾。動畫只限狀態切換的淡入（≤150ms），錄音中沒有持續動態。

## Editing rules
會議名稱：任何時候點標題直接改（Enter／失焦存、Esc 取消），資料夾名稱不改。日期時間：只有尚未開始錄音（ready 且 0 段）時可改，開始後鎖定（計時與筆記時間點依它計算）。

## Unresolved
無（摘要提示詞已於 2026-11-25 改成不綁特定人）。
