# 交接筆記 · 2026-11-18（第四次）

> 給下一個 session（或三天後的自己）。先讀這份，再動手。

## 一句話現況

**Typeless 付費路徑與 Gemini 免費路徑都完成了，全部驗證綠燈。**
剩下唯一一件事：拿真的 Gemini key 跑一場會議，確認免費額度、音質與斷句。

| 驗證 | 結果 |
| --- | --- |
| `npm run typecheck` | 0 錯誤 |
| `npm test` | 73 項通過（另含改名／改時間規則、逐字稿校正、與會者解析、會後補充標註）；原 61 項（WAV 檔頭、MIME／時長解析、重複偵測、靜音判定、開場白清除、現場轉錄的重試／換模型／切半、截圖編號與三家多模態格式） |
| `npm run smoke` | 45 項通過（含截圖上傳／讀回／路徑穿越／格式白名單／刪除；Typeless + Gemini 兩條路徑、假 HTTP server；假音訊改成有起伏的正弦波，全 0 會被靜音判定擋掉）。偶發 EPERM，見已知問題 |
| `npm run build` | 成功（JS 36.9 kB / CSS 11.0 kB） |
| `npm run e2e` | 36 項通過（真 headless Edge + 假麥克風，console 零錯誤；含新版面、與會者、模擬 Ctrl+V 貼截圖、會後改逐字稿與筆記） |
| `npm run typography` | 孤行 0 處（1440px 與 390px） |

## 分支 `feat/exe-packaging`（2026-11-25，尚未合併）

讓同事不用 clone、不用裝 Node 就能用：打包成單一 `meeting-assistant.exe`，並把資料搬出專案資料夾。
裁決過程見「待辦」第 9 項。

- **資料位置**：`server/paths.ts`。`%APPDATA%\meeting-assistant\location.json` 記兩個路徑（會議、設定）；
  它不存在＝第一次啟動，前端先顯示引導頁（`src/ui/setup.ts`），API 除了 `/api/setup`、`/api/health` 一律回 409。
  `MEETING_ASSISTANT_DATA_DIR`（smoke／e2e）會略過引導頁，行為跟以前一樣。
- **選資料夾視窗**：`pickFolder()` 由伺服器開 PowerShell 的 `FolderBrowserDialog`（掛在 TopMost 的隱形視窗下，
  才不會被瀏覽器蓋住）；Mac 用 `osascript`。`/api/setup/*` 與 `/api/settings/move` 會擋非本機 Origin，
  別的網站不能叫出視窗或改位置。2026-11-25 改用 `IFileOpenDialog`（FOS_PICKFOLDERS，Add-Type 即時編譯 C#），
  失敗才退回 `FolderBrowserDialog`；使用者已實際點過。**已知限制**：視窗沒有 Windows 11 外觀（PowerShell 沒有宣告
  新版外觀），而且顯示英文（PowerShell 的介面語言）。要修得在 C# 裡手動切換外觀設定、指定語言，每次都要人工驗證，
  使用者表示目前可接受，先不修。
- **紅字**：`cloudRisk()`，設定資料夾在「文件」、「桌面」（讀登錄檔的真實位置，OneDrive 轉向也抓得到）、
  任何 OneDrive 資料夾（含「OneDrive - 公司名」）底下時提示。只提示，不擋存檔。
- **換位置**：會議資料夾換了不搬舊會議（錄音中擋下）；設定資料夾「搬到這裡」搬 `settings.json` 與 `.env`
  （先複製、比對內容，再刪舊的；目的地已有同名檔就拒絕）。兩者都先試寫確認有權限。
- **exe**：`npm run package`（`scripts/package.ts`）→ `release/meeting-assistant.exe`，約 101 MB。
  rolldown 打包伺服器成 CJS、`dist/` 當 SEA asset、`node --build-sea`。exe 雙擊後自動開瀏覽器；
  port 被占用時，若是自己就只開瀏覽器；被其他程式占用就自動換下一個（最多到 8796），設定頁用小字說明
  深淺色偏好可能不同。自己設了 `PORT`、或 `npm run dev`（Vite proxy 固定 8787，`dev.ts` 設
  `MEETING_ASSISTANT_FIXED_PORT`）時不換，改成提示原因。
- **開發模式也用新位置**（裁決）：專案裡的 `server/.data/`、`.env`、`meetings/` 不再讀，啟動時列出要手動搬的檔。
- **修了既有的換頁競態**（`src/ui/app.ts` 的 `route()`）：網址沒有 `#` 時，補上 `#/` 觸發的 hashchange 跟啟動時
  直接呼叫的 `route()` 會同時跑，`/api/settings` 回得慢時兩份首頁疊在一起、各有捲軸。exe 每次開瀏覽器都不帶 `#`，
  所以必中。改成每次換頁領序號，等完 API 發現已有更新的換頁就丟掉。重現方式：用 CDP 的 Fetch 把 `/api/settings`
  延遲 400ms、開不帶 `#` 的網址，修前每次 2 份，修後 1 份。
- 驗證：`npm test` 82 項、`npm run smoke`（原 smoke＋新的 `smoke-setup.ts` 27 項）、`npm run smoke:exe`
  （同一套 smoke 對 exe 跑，含 WebSocket relay）、`npm run e2e`、引導頁與設定頁截圖（淺色、深色、390px）皆過。
  typography 6 處孤行是既有的（在 main 上同樣 6 處，都在示範會議的筆記文字）。

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
npm run package     # 打包 release/meeting-assistant.exe（Node 25.5 以上）
npm run smoke:exe   # 對打包好的 exe 跑 smoke
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
  - Gemini：key、模型（現在預設 `gemini-3-flash-preview`，清單在 `GEMINI_TRANSCRIBE_MODELS`）、免費額度提示、測試 key
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

### 7. 純 `.env` 設定與只綁本機

- `server/config.ts` 新增 `TRANSCRIBER=gemini|typeless`：引擎也能只靠 `.env` 決定。
  優先序不變：設定頁（`settings.json`）> `.env` > 預設。
- `server/index.ts` 的 `listen()` 改成預設 `127.0.0.1`。原本沒給 host，Node 會綁 `::`，
  同一個 Wi-Fi 下的裝置其實連得到（app 沒有登入機制）。要開放才設 `HOST=0.0.0.0`。
- `.env.example`、`README.md` 補上：兩邊都填時設定頁優先、改 `.env` 要重啟、
  key 只存在伺服器端，瀏覽器只拿得到 `••••1234` 遮罩。
- 設定頁目前沒有「清除已存 key」按鈕；要改用 `.env` 得手動刪
  `server/.data/settings.json` 的 `geminiApiKey` / `llmKeys.gemini`。

### 8. 狀態標示修正（`ready` 不等於「進行中」）

- 首頁 badge 原本只有 `ended` / 其他兩種，建立後沒錄音的會議會一直顯示「進行中」，
  時間也跟著牆上時鐘長到 20 小時。現在：`ready` → 未開始、`recording` → 錄音中、
  `paused` → 已暫停、`ended` → 已整理／待整理。
- 紀錄頁的 `ready` 會議顯示「尚未開始」，並多一顆「開始錄音」連到 `#/live/:id`；
  沒有逐字稿時提示先開始錄音。原本只有「標記為已結束」。
- **這一版仍然只能即時收音轉錄，沒有「上傳錄音檔解析」**（CLI 有，畫面沒有）。收音來源
  現在有麥克風、麥克風＋分頁／系統音訊、只有系統音訊三種（見第 11 節）。在「參考資料」選音檔
  只會被當附件存進 `reference/`，不會轉錄、也不會有進度。
- `POST /api/meetings/:id/finish` 對 `ready` 且 0 段的會議把 `endedAt` 設成 `startedAt`，
  不會留下「20 小時」的假時長。

### 9. 既有錄音檔轉錄（拍板：真的用 ffmpeg 切段）

- 新增 `server/gemini-file.ts`：Files API resumable 上傳、等 `ACTIVE`、48 小時內同檔名＋同大小
  自動沿用、`countFileTokens()`、`modelLimits()`、`transcribeUploadedFile()`。
  上傳免費，單檔上限 2 GB、專案 20 GB、保留 48 小時。
- 新增 `server/ffmpeg.ts`：`resolveFfmpeg()`（`FFMPEG_PATH` → `tools/ffmpeg` → `%LOCALAPPDATA%` →
  `%TEMP%\opencode` → PATH）與 `splitAudio()`，用 `-c copy` + segment muxer，2 小時幾秒鐘切完。
- 新增 `scripts/transcribe-file.ts`：`--meeting / --out / --model / --chunk-min / --replace`。
  超過 `--chunk-min`（預設 30）就真的切成獨立檔案再逐段上傳，逐字稿按時間段落寫回 `transcript.md`。
- **踩過的坑（不要重犯）**：整場 2 小時只上傳一份、用「請只轉錄 30:00–60:00」提示時間範圍，
  模型會忽略範圍、每次都從開場重轉一點就停（實測 4,586 字，內容重複）。必須真的切檔。
- 實測：2 小時 m4a / 112 MB / 231,576 input tokens、輸出上限 65,536。
  `gemini-2.5-flash` 對這個帳號已 404；`gemini-3.5-flash-lite` 對大請求一直 503；
  `gemini-3.8-flash` 也 503／連線中斷。整場單次請求一定撞 `MAX_TOKENS`，所以一定要切 30 分鐘。
- **第二個坑：模型會卡在「重複同一句」**。`gemini-3.1-flash-lite` 轉 10 分鐘音訊，會把
  「那個時候，」重複三千多次直到撞 65,536 輸出上限（10 分鐘吐出 109,170 字）。`temperature: 0`、
  加重複懲罰都救不了（這個模型直接回 `Penalty is not enabled for this model`），
  改 0.4 反而變成 `RECITATION` 被擋。`gemini-flash-latest` 同一個檔案 1,535 字正常結束，
  但它延遲太高（見下面第四點），最後改用 `gemini-3-flash-preview`。
- `server/transcript-guard.ts`：尾端出現「同一段 2–80 字連續重複 ≥10 次且 ≥400 字」就砍掉，
  避免正常口語重複被誤砍。`scripts/transcribe-file.ts` 偵測到重複或 MAX_TOKENS 時，
  會把該段切成兩半重跑（最多三層，段落 < 5 分鐘就只保留砍完的內容）。
- **第三個坑：`fetch` 5 分鐘就放棄等回應**。Node 內建 fetch（undici）的 `headersTimeout` 是 300 秒，
  30 分鐘音訊的生成常常超過，錯誤長成 `fetch failed（HTTP/2: "headers timeout after 300000"）`。
  `transcribeUploadedFile()` 改走 `node:https`（只設 10 分鐘「閒置」上限），所以可以等很久。
- **第四個坑：模型延遲差很多**。同一句五個字的測試：`gemini-3-flash-preview` 1.6 秒、
  `gemini-flash-lite-latest` 4.5 秒、`gemini-3.1-flash-lite` 1 秒、`gemini-flash-latest` **106 秒**
  （它不吃 `thinkingLevel: minimal`，`thinkingBudget: 0` 反而直接超時）。
  所以預設是 `gemini-3-flash-preview`。預設切段也從 30 分鐘改成 15 分鐘。
- **第五個坑：模型會自己加開場白**。實測 9 段裡有 2 段開頭是「好的，以下是該（段）音訊的完整逐字稿：」。
  `cleanText()` 現在會砍掉開頭那一行的這類說法（只砍開頭，內文的「以下是」不動）。

### 10. 設定頁「測試連線」吃不到 `.env`

- 原本 `POST /api/settings/ping` 只測「已儲存的 provider」。沒存過 `settings.json` 時 provider 預設
  `anthropic`，所以就算 `.env` 有 `GEMINI_API_KEY`，按下測試也只會說「尚未設定 API key」。
- 現在 ping 會帶上畫面上的 `provider` / `model` / 剛貼上的 key，**不用先儲存**；
  成功訊息會註明 key 來源（`設定頁` / `.env` 的 X / Gemini 轉錄共用）。
- `server/config.ts`：
  - `settings()` 快取改成比對 `settings.json` 與 `.env` 的 mtime，**改 `.env` 不用重啟**。
  - 沒存過 provider 時自動挑「有 key 的那一家」（anthropic → openai → gemini）。
  - 新增 `llmKeyFor()` / `llmKeySource()`，`settingsView()` 改用它，不再自己複製一份優先序。

### 11. 第二個輸入來源：分頁／系統音訊

線上會議裡「對方」的聲音是從喇叭／耳機放出來的，麥克風收不到（藍牙耳機的麥克風更收不到，
ANC 還會主動把它濾掉）。所以錄音頁多了一個來源選單：

| 選項 | 收什麼 | 怎麼用 |
| --- | --- | --- |
| 麥克風 | 只有你 | 實體會議、預設值 |
| 麥克風＋會議音訊 | 你＋對方 | 線上會議建議用這個 |
| 只有會議音訊 | 只有對方 | 不想錄到自己時 |

- `src/ui/audio.ts` 改成 `startCapture({ mic, system })`：
  - 麥克風走 `getUserMedia`（EC／NS／AGC 開）。
  - 系統音訊走 `getDisplayMedia({ video: true, audio: {...} })`，**EC／NS／AGC 全關**，
    不然 Chrome 會把會議的聲音當成回音濾掉。一定要 `video: true`（Chrome 不支援純音訊的
    分頁分享），video track 留著不理它；使用者按瀏覽器分享列的「停止分享」時，
    `onEnded` 會提示並自動退回「麥克風」。
  - 兩條 stream 各接一個 gain（0.7）再進**同一個** AudioWorkletNode，Web Audio 會自動相加，
    所以送出去就是一路 16 kHz PCM，伺服器完全不用改。
  - worklet 宣告 `channelCount: 1` + `channelCountMode: 'explicit'`，讓立體聲的系統音訊
    先混成單聲道；不然只讀 channel 0 會漏掉偏右聲道的聲音。
- 錄音頁（`src/ui/live.ts`）：
  - 來源選單存 `localStorage['meeting-assistant.audio-source']`，下次自動套用。
  - 錄音中把選單鎖住（同一場不能換來源，換了會斷）。
  - 選單下面是實際收到的裝置名稱（`MediaStreamTrack.label`），例如
    「麥克風 (Realtek…) ＋ 分頁音訊」，一眼看出選錯裝置。
  - 分享被取消、或分享時沒勾音訊 → 跳提示並**退回只收麥克風**（不會整場錄不到）。
- 音量條加大到 112×6 px 並加邊框（原本 96×3 px 深色疊深色，根本看不到）。

**Chrome 的分享音訊條件**（網站要在 secure context，`localhost` 算）：

- 網頁版 Meet／Teams／Zoom：選那個**分頁**，勾「分享分頁音訊」。
- 桌面版 Teams／Zoom：選**整個螢幕**，勾「分享系統音訊」。
- 藍牙耳機在通話模式時，Windows 會把輸出切成 Hands-Free 裝置，系統音訊常常抓不到；
  要收系統音，用有線耳機或喇叭最穩。

### 12. 錄音頁的逐字稿可以直接校正

- 每段逐字稿是一個 `<textarea class="seg-text">`（平常看起來就是內文，hover／focus 才出框線）。
  `done` 與 `failed` 段落可編輯；收音中／轉錄中的沒有文字，不給改。
- 存檔走既有的 WebSocket：`{ type: 'edit', index, transcript }` → `LiveSession.editTranscript()`。
  **不能另開 HTTP 直接寫 `meeting.json`**：錄音中的 session 記憶體裡有一份 meeting，下次存檔會把修改蓋掉。
- 停手 0.8 秒或離開輸入框就送；沒連線時先留在 `drafts`，重新連上（`open`）、按結束會議、離開頁面時補送。
- 改過的段落 `Segment.edited = true`，標題旁顯示「已校正」。
- `renderSegments()` 改成以段落 index 為 key 的增量更新：`state` 訊息每秒都會重畫，原本整塊
  `innerHTML` 重寫會把正在打的字洗掉。正在編輯的段落不吃伺服器更新，離開輸入框才補畫。

### 13. 現場轉錄：重試、換模型、防鬼打牆

`server/live-transcribe.ts` 的 `transcribeLiveSegment()`，relay 的 `transcribeGemini()` 只負責呼叫與寫回。

| 情況 | 處理 |
| --- | --- |
| 503／500／502／504、非每日 429、網路錯誤（`TransientGeminiError`） | 同一顆等 10 秒、20 秒各重送一次，再不行換備援模型（**只換這一段**，不改會議主模型） |
| 每日額度用完（`DailyQuotaError`） | 直接換下一顆；`quotaExhausted` 含主模型時才把 `meeting.transcribeModel` 改掉 |
| `MAX_TOKENS`（`MaxTokensError`，帶已吐出的文字）或尾端鬼打牆 | ≥ 40 秒就切兩半各自重送（最多兩層：180 → 90 → 45）；切到底仍卡住就保留砍掉重複後的文字並提示使用者補 |
| key 錯、模型不存在、內容政策 | 不重試，直接失敗 |

- 最壞情況一段要 1–2 分鐘，所以 `end()` 等待收尾從 120 秒改 180 秒，前端 `watchEnded()` 從 150 秒改 200 秒。
- 重試／換模型時用 `notice` 告訴使用者（「第 N 段：Gemini 暫時忙線（503），10 秒後重送同一段」）。

### 14. 筆記可以貼截圖，產生紀錄時一起送 LLM

- **上傳與筆記分兩步**：`POST /api/meetings/:id/images`（`{ mime, base64 }`）只存檔、回傳檔名；
  筆記本身走 WebSocket `{ type: 'note', ..., image }` 加進錄音中的 session。理由同逐字稿校正：
  直接寫 `meeting.json` 會被 session 下次存檔蓋掉。
- `MeetingNote.image` 是 `images/` 底下的檔名。檔名由伺服器產生（`img-<時間>-<亂數>.jpg`），
  讀寫都用 `isImageName()` 檢查，擋掉路徑穿越；格式只收 JPEG／PNG／WebP（SVG 可以藏 script）。
- 前端 `src/ui/image.ts` 的 `shrinkImage()`：長邊縮到 1568px（Claude 建議值）、透明鋪白、轉 JPEG 0.88。
- 上限 `MAX_NOTE_IMAGES = 30`（`src/core/protocol.ts`），上傳時以 `images/` 的檔案數判斷（含貼了沒送的）。
  預覽按 × 會 `DELETE` 那張；已經掛在筆記上的圖不能直接刪檔（409），要用 `{ type: 'delete-note' }` 刪筆記，連檔案一起刪。
- 摘要：`noteImages()` 依時間編號，`notesForPrompt()` 在筆記後標「（附截圖 N）」，
  圖片接在整份文字素材後面，每張前面一行 `imageCaption()`（「截圖 N（X 分鐘貼上，筆記：…）」）。
  三家格式在 `server/llm.ts` 的 `anthropicContent()`／`openaiContent()`／`geminiParts()`。
  系統提示詞要求把圖上的數字、表格、決議整合進紀錄並標「（截圖 N）」，不要逐張描述。
- `MOCK_LLM=1` 時假紀錄最後會多一行「收到 N 張截圖：…」，smoke／e2e 靠它確認圖有送到 LLM 這一層。
- 尚未用真的 LLM 驗證截圖整合的品質；只有在錄音中（有 live session）才能貼，會後的紀錄頁只能看、不能貼。

### 15. 介面改版：Apple 備忘錄版型＋筆記置中，深淺色模式

用 Impeccable 走完：PRODUCT.md（產品背景）→ 兩輪比稿（使用者指定融合 Apple 備忘錄版型＋Granola 筆記置中）→
設計契約 `.impeccable/surfaces/src-ui-app-ts.md` → 實作 → 五輪截圖 → 獨立審查。

**裁決（2026-11-24）**：抽中的「公文・簽呈」方向被否決，第二輪也未採單一參考，改由使用者指定融合 Apple 備忘錄版型＋Granola 筆記置中（理由未述）。

- **外殼**（`src/ui/app.ts`）：左側欄＝搜尋＋新會議＋依今天／這週／更早分組的會議清單＋底部設定與主題切換；
  首頁就是「新會議」表單（`home.ts`），清單不在首頁重複。任何頁改到會議清單就呼叫 `meetingsChanged()`（`dom.ts`）。
  ≤880px 側邊欄變抽屜；工作區用 container query（≤760px）把兩欄改上下疊。
- **主題**（`theme.ts`＋`index.html` 行內腳本）：`localStorage['meeting-assistant.theme']`，預設跟隨系統；
  所有顏色是 `src/styles.css` 開頭兩組同名變數。黃色只給主要動作，紅色只給正在錄。
- **錄音頁**（`live.ts`）：`#live-body[data-view]` 用 grid-template-areas 切三種版面；分隔線拖曳寬度存
  `meeting-assistant.transcript-width`；「逐字稿」版面把筆記依 `segmentIndex` 插回段落下（`paintInlineNotes`）。
- **標題／時間／與會者**（`meeting-head.ts`＋`PATCH /api/meetings/:id`＋`applyInfoPatch`）：名稱隨時改，時間只在
  ready 且 0 段時能改（伺服器同樣擋）；錄音頁開著時改記憶體裡那份（`LiveSession.updateInfo`）。資料夾名稱不跟著改。
- **與會者**（`src/core/attendees.ts`）：`Meeting.attendees: {name, role}[]`，「王小明（PM）、Amy（廠商 IT）」格式；
  Gemini 轉錄附上名單（明講不要拿來標說話者），摘要提示詞多「與會者」一節。
- **會後修改**：逐字稿 `PATCH /api/meetings/:id/segments/:index`、筆記 `POST/PATCH/DELETE /api/meetings/:id/notes[/:noteId]`。
  錄音頁開著時交給 session（`editTranscript`／`mutate`），否則直接改檔；直接改檔一律經 `withMeetingLock` 排隊，
  否則「改內容」與「換類型」同時送出會互相蓋掉（e2e 實際撞到過）。會後新增的筆記標 `postMeeting`，提示詞寫「會後補充」。
  `Segment.editedAt`／`MeetingNote.editedAt` 晚於 `minutes.generatedAt` 時，紀錄頁提醒重新產生。
- **存檔重試**：`writeFileAtomic` 的 rename 撞到 EPERM／EBUSY／EACCES 等 30→80→200→500ms 重試（待辦 8 已處理）。

## 待辦（只剩這些）

1. **用真的 Gemini key 跑一場 20–30 分鐘會議**（<https://aistudio.google.com/apikey>）：
   - 看逐字稿斷句、專有名詞、中英夾雜的表現
   - 確認免費層實際 RPM／RPD 夠不夠一場會議（3 分鐘一段 → 45 分鐘約 15 次請求）
   - 429 時的錯誤訊息是否看得懂；必要時把 `autoSegmentSeconds` 調大減少請求數
2. 依試跑結果微調 `server/gemini.ts` 的 `SYSTEM_PROMPT`（目前：逐字、不摘要、不標講者）。
3. 比較同一場會議的 Gemini 與 Typeless 逐字稿，決定預設引擎。
4. ~~選配：`git init` 後第一次 commit~~ 已完成：`main` 分支，first commit `4c37ce6`。
5. ~~（新需求，待確認）上傳既有錄音檔轉錄＋解析進度~~ 已完成 CLI（`scripts/transcribe-file.ts`），
   但**還沒接進畫面**：目前只能在終端機跑，app 內看不到粗進度。要做的是「上傳頁 → 背景工作 → 進度條」。
6. `.env` 的 `GEMINI_TRANSCRIBE_MODEL` 已改成 `gemini-3-flash-preview`（原本 `gemini-3.5-flash-lite` 對大請求 503）。
   設定頁按「儲存」會把值寫進 `settings.json`，之後兩邊不同步時以設定頁為準。
7. **現場轉錄的失敗率**（2026-11-24 盤點 5 場實際會議，180 秒一段）：失敗 22 段，其中
   503 負載過高 9 段、`MAX_TOKENS` 9 段、靜音 3 段、斷線 1 段。180 秒中文講話約 1–2 千 token，碰不到 8192 上限，
   `MAX_TOKENS` 幾乎可確定是模型鬼打牆重複同一句；現場路徑目前 503 不重試、`MAX_TOKENS` 直接丟掉整段。
   ~~處理方式待裁決~~ 已裁決（2026-11-24）：**維持 180 秒，加重試與防鬼打牆**（不縮短切段：請求數會加倍、
   對 503 幫助很小）。見第 13 節；要用真的會議再驗一次失敗率。
8. ~~**smoke 偶發 EPERM**~~ 已處理（第 15 節，rename 重試；改完 smoke 連跑 4 次皆過）。原記錄：（4 次 1 次）：`meeting.json.*.tmp` rename 成 `meeting.json` 時 Windows 回
   EPERM（目標檔正被讀取）。實際使用時可能讓某次存檔失敗；可考慮 rename 撞 EPERM 時短暫重試。
9. **設定頁的會議資料夾選擇器**：2026-11-24 裁決「先不動」，維持手動輸入。曾提的做法：伺服器叫出系統原生的
   「瀏覽資料夾」視窗（瀏覽器網頁本身拿不到完整路徑）。日後要做時注意：換資料夾後舊會議不會跟著搬，
   首頁會變空，要提示或提供搬移；欄位其實已接受絕對路徑，只是標籤寫「相對專案根目錄」。
   **2026-11-25 改裁決**（為了包成 exe，分支 `feat/exe-packaging`；理由未述）：
   - ~~exe 版的資料預設放 `文件\Meeting Assistant`，第一次啟動不跳選資料夾的視窗。~~ 同日再改：
     **第一次啟動跳引導頁**，分兩個位置讓人選：「會議資料」與「含完整 API key 的設定」。設定若選在
     `文件` 底下，用紅字提示可能被 OneDrive 同步上雲端。原建議是設定放 `%APPDATA%`、會議放 `文件`，不跳引導頁。
     理由：公司電腦的「文件」常被 OneDrive 同步，key 會上雲端。細節（皆照建議）：
     - 預設值：會議 `文件\Meeting Assistant`，設定 `%APPDATA%\meeting-assistant`。
     - 紅字條件：設定位置在「文件」、「桌面」或任何 OneDrive 資料夾底下。
     - 設定頁之後可以改設定位置，並自動搬 `settings.json` 與 `.env`（先複製、確認讀得到，再刪舊的）。
     - 兩個位置記在固定的 `%APPDATA%\meeting-assistant\location.json`（只存路徑，不存 key）。
   - 設定頁**加「瀏覽…」按鈕**，由伺服器叫出系統原生的選資料夾視窗。原建議是完全不做視窗，維持手動輸入。
   - 換位置時**舊會議不搬**，只提示「舊會議留在 X，可以用檔案總管把資料夾拖過去」；另外補上新路徑的寫入檢查。
   - 打包用 Node 內建 SEA（不用 Bun），先只出 Windows 版。
   - **開發模式也改用 `文件\Meeting Assistant`**，跟 exe 共用同一份資料（理由未述）。原建議是開發模式維持專案資料夾，
     不搬資料、測試也不用改。
   - 既有的 `meetings/` 與 `server/.data/settings.json` **由使用者自己手動搬**，程式不做遷移，只在啟動訊息與
     README 說明要搬哪些檔案。原建議是第一次啟動時自動複製、原檔保留。
   - **port 被占用時自動換下一個**，在設定頁用小字提示深淺色偏好可能不同。原建議是不換、提示後停住等 Enter。
     理由：只影響深淺色偏好，不值得因此停住。

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
  transcript-guard.ts  鬼打牆重複偵測、靜音／底噪判定（pcmLevels、silenceReason）
  live-transcribe.ts   現場一段音訊的轉錄流程：503 重試、換模型、鬼打牆切半重送
  store.ts 的 saveImage／readImage／removeImage   筆記截圖（會議資料夾 images/）
  gemini.ts   PCM → WAV、Gemini 逐字轉錄、ping
  gemini-file.ts  Files API 上傳／沿用／token 估算／長音檔轉錄
  ffmpeg.ts   找 ffmpeg、把長錄音切成獨立段落
  store.ts    會議資料夾 CRUD、markdown 產生（atomic 寫入）
  prompt.ts   摘要 prompt（規則都在 SYSTEM_PROMPT）
  llm.ts      Claude / OpenAI / Gemini 摘要呼叫 + 錯誤翻譯
  config.ts   設定讀寫（設定資料夾的 settings.json、.env）、引擎與 key 解析
  paths.ts    資料位置：location.json、預設路徑、雲端同步提示、試寫、搬設定檔、系統選資料夾視窗
src/
  core/       protocol.ts（TranscriberKind、Meeting.engine）、notes.ts、markdown.ts、format.ts
  ui/         app.ts、home.ts、live.ts、result.ts、settings.ts、audio.ts（麥克風＋系統音訊混音）、api.ts、dom.ts
              setup.ts（第一次啟動引導頁）、folder-field.ts（資料夾欄位＋瀏覽＋紅字）
  styles.css  深色、極簡、中文行高 1.75
scripts/
  dev.ts        同時跑 API 與 Vite
  transcribe-file.ts  既有錄音檔 → 切段 → 逐段轉錄 → 寫回會議
  smoke.ts      假 Typeless + 假 Gemini + MOCK_LLM（37 項）
  e2e.ts        真瀏覽器 + 假麥克風（18 項）
  typography.ts 中文孤行檢測（1440 / 390）
  preview.ts    首頁／紀錄頁／設定頁截圖
  smoke-setup.ts  第一次啟動流程（隔離的 APPDATA，起真伺服器）
  package.ts    打包 exe（rolldown + SEA）
public/
  pcm-worklet.js  音訊 → 16k PCM16（必須是獨立檔，不能進 bundler）
meetings/
  （已不用：會議改存在使用者選的會議資料夾；示範資料移到 scripts/fixtures/demo-meeting/）
```

## 環境雷（都是實際踩過的）

- **這台機器沒有 ffmpeg**（`ffmpeg -version` 找不到）。要跑 `transcribe-file.ts` 的切段功能，
  得先 `winget install Gyan.FFmpeg`、下載 portable 版，或在 `.env` 設 `FFMPEG_PATH`。
- **Gemini 免費層的每日上限是「每個模型」分開算**（實測：`gemini-3-flash-preview` 用完當天
  20 次時，`gemini-3.1-flash-lite` 與 `gemini-flash-lite-latest` 仍可用）。2 小時會議要 9 段、
  加上重試很容易把當日額度用完；額度是太平洋時間午夜重置（台灣下午 3–4 點）。
  `friendly()` 會分辨「每分鐘限流」與「每日用完」，後者不再重試，直接說明白等明天。
- **現場錄音會自動換模型**：`server/relay.ts` 的 `transcribeGemini()` 用
  `geminiModelChain()`（`server/gemini.ts`）排出「主模型 → 另一顆備援」，遇到
  `DailyQuotaError`（`PerDay` 429）就把**同一段音訊**換下一顆重送，成功後把新模型寫回
  `meeting.json`，後面幾段直接用它，並在畫面跳一則提示。備援只有
  `gemini-flash-lite-latest` 與 `gemini-3-flash-preview` 兩顆（另外兩顆長音檔會出問題）。
  代價是：主模型用完時那一段會多一次 429 往返（約 0.2 秒）。
  注意「設定頁換模型」對進行中的會議仍然無效（模型在第一段就固定了），這是下一步要改的。
- **中斷的段落會標成失敗**：`openLive()` 在連線進來時，把還停在 `open` 的段落改標
  `failed / 連線中斷，這段音訊沒有留下`。那段 PCM 只存在被中斷的行程記憶體裡，
  本來就救不回來，標失敗才不會讓畫面永遠掛著「收音中」。
- **靜音會讓 Gemini 自己編一份假逐字稿**（實測：11 秒數位靜音 → 「大家早安，我們現在開始
  今天的週會…」；60 秒 → 一整段有開場有結尾的假會議）。所以 `transcribeGemini()` 先用
  `pcmLevels()`（`server/transcript-guard.ts`）量音量：每 100 ms 一個音框，看整體 RMS、
  10 百分位（停頓）與 95 百分位（講話）。`silenceReason()` 會擋兩種：
  - `p95 < SILENCE_PEAK (0.01)` → 「幾乎沒有聲音」
  - `p95 < p10 × FLAT_RATIO (1.8)` → 「只有持續底噪、沒有說話的起伏」（風扇、冷氣、
    藍牙耳機的雜訊底噪也是 0.005–0.02，只看 RMS 會漏掉）

  實測正常說話 RMS ≈ 0.077、會議室底噪 ≈ 0.001、一直很平的人造底噪 ≈ 0.02。被擋下的段落
  標成失敗、不呼叫 API（也省額度），`meeting.json` 會留下 `audioRms` / `audioPeak` 方便診斷。
- **錄音頁的音量表以前永遠是 0**：`public/pcm-worklet.js` 的 `process()` 只把資料送去
  `port.postMessage`，沒有寫 `outputs`，所以 analyser 收到的永遠是靜音。現在會把輸入原樣
  複製到輸出（後面接 0 增益，不會從喇叭放出來），音量條才真的會動；連續 20 秒幾乎沒聲音
  也會跳一次提示。
- **刪會議要一併收掉 live session**：以前 `DELETE /api/meetings/:id` 只刪資料夾，記憶體裡的
  `LiveSession` 之後存檔會把資料夾又寫回來。現在先 `dispose()` 再刪。
- **藍牙耳機的麥克風收不到線上會議**：對方聲音是從耳機「播放」出來的，麥克風收不到；
  要收會議音訊只能用分頁／系統音訊。另外藍牙在通話模式會切成 Hands-Free（單聲道、
  Windows 的系統音訊常常抓不到），收系統音請用有線耳機或喇叭。
- **Gemini 免費層 429 很常見**，尤其是連續跑好幾段。`transcribeUploadedFile()` 內建
  503 等 15/30 秒、429 等 60 秒的重試；重試用盡就是真的額度問題。

- **不要用 PowerShell 做原始碼的字串取代**。`Get-Content -Raw` 在 PowerShell 5.1 用 ANSI 讀 UTF-8，
  `Set-Content` 寫回去中文全變亂碼且**不可逆**。改檔一律用 edit / write 工具。
- Node 26：`openSync(file, 'wb')` 會丟 `ERR_INVALID_ARG_VALUE`，要用 `'w'`。
- 跑會輸出中文的指令前先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。
- headless 瀏覽器的 `#/xxx` 導覽不會觸發 load 事件（已修在 `cdp.ts`）。
- `text-wrap: pretty` 對中文幾乎無效；孤行一律先用 `text-wrap: balance`。
- 多個非同步流程可能同時寫 `meeting.json`；atomic 暫存檔名一定要唯一。
- `server.listen(port)` 沒給 host 會綁所有網路介面；本專案已明確綁 `127.0.0.1`。
- 版控已初始化（`main`，first commit `4c37ce6`）；`.gitignore` 已排除 `.env`、
  `server/.data/`、`meetings/`、`dist/`、`preview/`。

## 試跑前你需要準備

- Gemini API key：<https://aistudio.google.com/apikey>（免費層即可）
- 不想在瀏覽器貼 key：把 `.env.example` 複製成 `.env`，填 `GEMINI_API_KEY`，
  再加 `TRANSCRIBER=gemini` 與 `GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash`，
  重啟 `npm run dev`。設定頁沒有存過 key 時才會用 `.env`（設定頁優先）。
- 摘要可以也用 Gemini（同一把 key），或填 Claude / OpenAI
- 逐字稿**只會在切段後出現**，這是兩個引擎共同的限制，不是 bug
- 免費層的內容可能被用於改善服務；敏感的會議請改用付費 key
