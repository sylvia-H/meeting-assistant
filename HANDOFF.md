# 交接筆記 · 2026-11-18（第四次）

> 給下一個 session（或三天後的自己）。先讀這份，再動手。

## 一句話現況

**Typeless 付費路徑與 Gemini 免費路徑都完成了，全部驗證綠燈。**
剩下唯一一件事：拿真的 Gemini key 跑一場會議，確認免費額度、音質與斷句。

| 驗證 | 結果 |
| --- | --- |
| `npm run typecheck` | 0 錯誤 |
| `npm test` | 27 項通過（新增 WAV 檔頭測試） |
| `npm run smoke` | 37 項通過（Typeless + Gemini 兩條路徑、假 HTTP server） |
| `npm run build` | 成功（JS 36.9 kB / CSS 11.0 kB） |
| `npm run e2e` | 18 項通過（真 headless Edge + 假麥克風，console 零錯誤；連續跑 3 次皆過） |
| `npm run typography` | 孤行 0 處（1440px 與 390px） |

## 可以直接跑的指令

```powershell
cd "C:\Sylvia\10 side projects\2026-11\meeting-assistant"
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 先設，不然中文輸出全亂碼
npm run dev         # API 8787 + Vite 5173，開 http://localhost:5173
npm start           # 正式版（需先 build），http://127.0.0.1:8787
npm test            # 單元測試
npm run smoke       # 假 Typeless + 假 Gemini + 假 LLM，不需要任何 key
npm run build       # 型別檢查 + vite build
npm run e2e         # 真瀏覽器 + 假麥克風（需先 build）
npm run typography  # 中文孤行檢測（1440 / 390）
npm run preview     # 拍截圖到 preview/（需先 build + npm start）
```

## 這一輪做完的事

### 1. Gemini 免費轉錄路徑

- 新增 `server/gemini.ts`：
  - `pcmToWav()` 把 16 kHz / 16-bit / mono PCM 包成 WAV。
  - `transcribePcm()` 用 `generateContent` 的 `inlineData`（`audio/wav`）上傳，
    system prompt 要求**逐字轉錄、不摘要、不標講者、只輸出逐字稿**。
  - 錯誤翻譯：400 key 無效、403 權限、404 模型、413 太大、429 額度、503 負載。
  - `GEMINI_BASE_URL` 可覆蓋 API 位址（smoke 用本地假 server）。
  - `pingGemini()` 讀模型資訊，設定頁「測試 Gemini」用；會優先用畫面上剛輸入、尚未儲存的 key。
- 分段：Gemini 沒有串流，整段 PCM 先存在 `Channel.queue`，
  切段時一次上傳；280 秒約 9 MB，base64 後仍在 inline 20 MB 限制內。
- `billedSeconds` 在 Gemini 路徑固定 `null`，錄音頁的費用欄改顯示「Gemini 免費額度」。

### 2. 引擎切換與設定

- `Meeting` 新增 `engine: 'typeless' | 'gemini'` 與 `transcribeModel`。
  舊資料只有 `typelessModel`，`readMeeting()` 會自動補成 `engine: 'typeless'`。
- 會議建立時記下引擎；若還沒開始錄音（`segments.length === 0`），按「開始錄音」時
  會改成**當下設定的引擎**，所以「先建會議 → 去填 key → 回來開始」不會卡住。
- 設定頁新增引擎下拉：
  - Typeless：key、模型、計價提示
  - Gemini：key、模型（`gemini-2.5-flash` 預設）、免費額度提示、測試 key
  - 語言、自動切段、保留錄音兩邊共用
- **一把 Gemini key 兩邊共用**：在轉錄欄或摘要欄填 Gemini key，server 會同時寫入
  `geminiApiKey` 與 `llmKeys.gemini`。
- 首頁、topbar 的「未設定」提示會依目前引擎顯示 Typeless 或 Gemini。

### 3. 測試

- `scripts/smoke.ts` 改成兩場會議：
  1. Typeless（原本的 18 項 WAV／筆記／摘要檢查）
  2. Gemini（假 HTTP server 回傳逐字稿，驗證引擎、模型、兩段逐字稿、`billedSeconds: null`、
     `transcript.md` 內容、meeting.json 欄位）
- 新增 `server/gemini.test.ts`（WAV 檔頭與空音訊）。
- `scripts/e2e.ts` 多檢查「切換引擎會換欄位」，共 18 項。

### 4. 修掉一個併發寫檔 bug

Gemini 兩段幾乎同時完成時，`end()` 的直接存檔與背景 `queuePersist()` 會用同一個
`meeting.json.<pid>.tmp`，其中一個 rename 失敗（smoke 抓到 ENOENT）。
`writeFileAtomic` 的暫存檔名改成 `${pid}.${seq}` 唯一化，已修。

### 5. 文件

- `README.md` 改寫：免費 Gemini 路徑為主、Typeless 為付費選項、費用表、免費層限制與資料政策。
- `.env.example` 加入 `GEMINI_API_KEY`、`GEMINI_TRANSCRIBE_MODEL`。

### 6. 修掉「按結束但畫面沒跳頁」的間歇問題

e2e 偶爾會出現：伺服器其實已經 `ended`、兩段都 `done`，但瀏覽器停在錄音頁，
因為 WebSocket 的 `ended` 訊息漏掉（連線抖一下就可能發生）。

- `src/ui/live.ts` 的 `endMeeting()` 現在按下去就停麥克風，並啟動 `watchEnded()`：
  每秒讀一次 `GET /api/meetings/:id`，看到 `status === 'ended'` 就自己跳紀錄頁。
- 這同時是使用者層級的保險：就算 WebSocket 斷線，也不會卡在「收尾中…」。
- e2e 的結束步驟加上「沒跳頁就再點一次」與失敗診斷（頁面狀態＋伺服器 segment 狀態＋console）。

## 待辦（只剩這些）

1. **用真的 Gemini key 跑一場 20–30 分鐘會議**（<https://aistudio.google.com/apikey>）：
   - 看逐字稿斷句、專有名詞、中英夾雜的表現
   - 確認免費層實際 RPM／RPD 夠不夠一場會議（3 分鐘一段 → 45 分鐘約 15 次請求）
   - 429 時的錯誤訊息是否看得懂；必要時把 `autoSegmentSeconds` 調大減少請求數
2. 依試跑結果微調 `server/gemini.ts` 的 `SYSTEM_PROMPT`（目前：逐字、不摘要、不標講者）。
3. 比較同一場會議的 Gemini 與 Typeless 逐字稿，決定預設引擎。
4. ~~選配：`git init` 後第一次 commit~~ 已完成：`main` 分支，first commit `4c37ce6`。

## 設計決策（不要隨便改，會動到資料格式）

- **切段就是語意單位**：兩個引擎都不會即時吐字，段落結束才有逐字稿。
  「環節標記」同時是切段訊號，逐字稿才會跟環節對齊。
- **手動切段一律生效**（`cut` 訊息），只有打 `# 環節` 才套用「未滿 20 秒就併段」。
- **引擎跟著會議走**：`meeting.engine` 決定 relay 走 WebSocket 還是 HTTP。
  已開始錄音的會議不會因為改設定而換引擎。
- **Gemini 上限 280 秒**：inline audio 約 20 MB 的硬限制；設定頁的 `autoSegmentSeconds`
  本來就夾在 60–280。
- **Typeless 每段一條 WebSocket、自己的待送佇列**：切段時舊連線可能還在握手，
  佇列跟著段走才不會丟音訊。
- **寫檔一律 atomic**（`.tmp` + rename），且暫存檔名唯一。
- **環境變數**：`TYPELESS_WS_URL`、`GEMINI_BASE_URL` 只給測試覆蓋用；其餘以設定檔為準。

## 檔案地圖

```
server/
  index.ts    HTTP 路由、靜態檔、WS upgrade、settings PUT
  relay.ts    LiveSession：分段、Typeless / Gemini 分支、WAV、存檔
  gemini.ts   PCM → WAV、Gemini 逐字轉錄、ping
  store.ts    會議資料夾 CRUD、markdown 產生（atomic 寫入）
  prompt.ts   摘要 prompt（規則都在 SYSTEM_PROMPT）
  llm.ts      Claude / OpenAI / Gemini 摘要呼叫 + 錯誤翻譯
  config.ts   設定讀寫（server/.data/settings.json）、引擎與 key 解析
src/
  core/       protocol.ts（TranscriberKind、Meeting.engine）、notes.ts、markdown.ts、format.ts
  ui/         app.ts、home.ts、live.ts、result.ts、settings.ts、audio.ts、api.ts、dom.ts
  styles.css  深色、極簡、中文行高 1.75
scripts/
  dev.ts        同時跑 API 與 Vite
  smoke.ts      假 Typeless + 假 Gemini + MOCK_LLM（37 項）
  e2e.ts        真瀏覽器 + 假麥克風（18 項）
  typography.ts 中文孤行檢測（1440 / 390）
  preview.ts    首頁／紀錄頁／設定頁截圖
public/
  pcm-worklet.js  麥克風 → 16k PCM16（必須是獨立檔，不能進 bundler）
meetings/
  2026-11-18-1000-demo/  示範資料，可在 UI 刪除
```

## 環境雷（都是實際踩過的）

- **不要用 PowerShell 做原始碼的字串取代**。`Get-Content -Raw` 在 PowerShell 5.1 用 ANSI 讀 UTF-8，
  `Set-Content` 寫回去中文全變亂碼且**不可逆**。改檔一律用 edit / write 工具。
- Node 26：`openSync(file, 'wb')` 會丟 `ERR_INVALID_ARG_VALUE`，要用 `'w'`。
- 跑會輸出中文的指令前先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。
- headless 瀏覽器的 `#/xxx` 導覽不會觸發 load 事件（已修在 `cdp.ts`）。
- `text-wrap: pretty` 對中文幾乎無效；孤行一律先用 `text-wrap: balance`。
- 多個非同步流程可能同時寫 `meeting.json`；atomic 暫存檔名一定要唯一。
- 版控已初始化（`main`，first commit `4c37ce6`）；`.gitignore` 已排除 `.env`、
  `server/.data/`、`meetings/`、`dist/`、`preview/`。

## 試跑前你需要準備

- Gemini API key：<https://aistudio.google.com/apikey>（免費層即可）
- 摘要可以也用 Gemini（同一把 key），或填 Claude / OpenAI
- 逐字稿**只會在切段後出現**，這是兩個引擎共同的限制，不是 bug
- 免費層的內容可能被用於改善服務；敏感的會議請改用付費 key
