# 會議助手

本機執行的會議紀錄工具：**一邊開會一邊錄音轉逐字稿、一邊打字做筆記，會後用 LLM 產出 markdown 會議紀錄。**

- 轉錄可選 **Gemini（有免費額度）** 或 **Typeless（付費、中文品質好）**
- 錄音檔、逐字稿、筆記、會議紀錄都存在自己的硬碟；音訊會送到你選的轉錄服務（Google 或 Typeless）
- API key 只存在本機伺服器，不會送到瀏覽器
- 摘要可用 Claude、OpenAI 或 Gemini；選 Gemini 時可以跟轉錄共用同一把 key

```
建會議 → 按開始錄音 → 講話（切段後出現逐字稿）→ 打字筆記 → 結束會議 → 產生會議紀錄
```

## 需要什麼

- Windows / macOS 都可，Node.js **22.18 以上**（會直接執行 `.ts`，開發時用 Node 26 測過）
- 一組轉錄用的 key：
  - **Gemini**：到 [Google AI Studio](https://aistudio.google.com/apikey) 建立，有免費額度，不用先綁信用卡
  - **Typeless**：到 [Typeless Console](https://platform.typeless.com) 建立（`tls_sk_...`），預付制
- 一組摘要用的 LLM key：Claude、OpenAI 或 Gemini 任一（選 Gemini 可與轉錄共用）

## 安裝與啟動

```powershell
cd "路徑\meeting-assistant"
npm install
npm run build
npm start
```

打開 <http://127.0.0.1:8787>。

開發時用 `npm run dev`，前端會有熱更新（<http://localhost:5173>，API 仍在 8787）。

## 第一次設定

到右上「**設定**」頁：

1. **選轉錄引擎**
   - **Gemini（免費額度）** — 貼上 Gemini API key，模型先用 `gemini-2.5-flash`。
     免費層的每日請求數與每分鐘次數以 Google 官方公告為準；免費層的內容可能被用於改善服務，
     敏感的會議請改用付費 key。
   - **Typeless（付費）** — 貼上 `tls_sk_...`，選模型：
     Lite `$0.25/小時`、Pro `$0.50/小時`、Max `$2.50/小時`。一般中文會議用 **Pro** 就夠。
2. **摘要用的 LLM** — 選供應商、模型、貼 key。
   - 建議 `claude-sonnet-4-5` 或 `gpt-5`
   - 選 Gemini 時可以留白，直接沿用上面轉錄的 Gemini key

填好後，首頁右上角就不會再顯示「未設定」的提醒。

> **key 存在哪**：設定頁貼上後，key 只會送到本機伺服器，存在 `server/.data/settings.json`
> （已加入 `.gitignore`）；瀏覽器之後只拿得到 `••••1234` 這種遮罩提示，拿不到完整 key。
>
> **也可以放 `.env`**（專案根目錄，已 gitignore）：`GEMINI_API_KEY`、`TYPELESS_API_KEY`、
> `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。只想用 `.env` 的話再加 `TRANSCRIBER=gemini`
> 與 `GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash`，改完要重啟 `npm run dev`。
> 兩邊都填時**設定頁優先**；設定頁目前沒有「清除」按鈕，想改用 `.env` 請用文字編輯器
> 打開 `server/.data/settings.json`，刪掉 `geminiApiKey` 與 `llmKeys.gemini` 後重啟。
>
> 伺服器預設只綁 `127.0.0.1`，同一個 Wi-Fi 的其他裝置連不到；要開放再設 `HOST=0.0.0.0`
> （這個 app 沒有登入機制，開放等於同網段的人都能看你的會議、用你的額度）。

## 開會流程

1. 首頁填**會議主題**、開始時間，需要參考資料（上次紀錄、規格書、提案）可以一起選檔上傳。
2. 按「建立會議」→ 進入錄音頁 → 按「**開始錄音**」→ 瀏覽器問麥克風權限時選允許。
3. 開會。想記事情就在下方輸入框打字（見下一節）。
4. 會議結束按「**結束會議**」，等最後一段轉錄完，會自動跳到紀錄頁。
5. 按「**產生會議紀錄**」，LLM 會依逐字稿＋你的筆記＋參考資料寫出會議紀錄。

### 逐字稿為什麼不是即時跳字

兩個引擎都是**一段音訊處理完才回傳文字**，沒有逐字字幕、也沒有逐句時間戳：

- **Typeless**：每段音訊用一條 WebSocket 串流送出，關閉串流後回傳一次整理好的文字。
- **Gemini**：每段音訊先暫存在記憶體，切段時包成 WAV 上傳，請 Gemini 逐字轉錄。

所以我們用「切段」當成語意單位：

- 每 **3 分鐘**自動切一段（可在設定頁調 60–280 秒）
- 想立刻看到文字：按右上「**切段**」
- 打 `# 環節名稱`：標記會議進入下一個環節，**同時切段**，逐字稿就會跟環節對齊

> 如果一段不到 20 秒，`# 環節` 只會把標籤併進當前段，不會硬切出零碎段落。
> 手動按「切段」則一定生效。

## 打字筆記

輸入框直接打字就是一般筆記；前面加符號可以分類（符號後面要空白，全形符號也可以）：

| 前綴 | 類別 | 用在哪 |
| --- | --- | --- |
| `#` | 環節 | 標記「接下來要談什麼」，會同時切段 |
| `>` | 決議 | 已拍板的結論 |
| `!` | 待辦 | 會後要有人做的事 |
| `?` | 待確認 | 還沒答案的問題 |
| `*` | 想法 | 臨時想到的點子 |
| `-` 或不加 | 筆記 | 一般紀錄 |

也可以寫字母別名：`s:` 環節、`d:` 決議、`t:` 待辦、`q:` 待確認、`i:` 想法、`n:` 筆記。

例：

```
# 需求確認
? 舊資料 600 筆要不要先備份
! 寄報價給 Amy，週五前
> 這一版先做 markdown 匯出
```

### 指令

| 指令 | 作用 |
| --- | --- |
| `/pause` `/resume` | 暫停／繼續收音（休息時間不計費） |
| `/seg 名稱` | 切段並標記接下來的環節名稱 |
| `/end` | 結束會議 |

## 產出在哪裡

會議紀錄存在專案底下的 `meetings/日期-時間-主題/`：

```
meetings/2026-11-18-1000-產品週會/
├── meeting.json     結構化資料（逐字稿、筆記、時間軸、引擎與模型）
├── transcript.md    逐字稿（依環節分段）
├── notes.md         筆記（依類別分組）
├── minutes.md       會議紀錄（LLM 產出，含 YAML frontmatter）
├── reference/       你上傳的參考資料
└── audio/mic.wav    原始錄音（設定頁可開關，1 小時約 110 MB）
```

`minutes.md` 有 frontmatter，可以直接丟進 Obsidian 當筆記：

```markdown
---
title: 產品週會
date: 2026-11-18
start: 10:00
end: 10:45
source: gemini
model: claude-sonnet-4-5
tags:
  - meeting
---
```

`source` 會是這場會議用的轉錄引擎（`gemini` 或 `typeless`）。
紀錄頁右上「開啟資料夾」會直接打開那一天會議的資料夾，「複製 markdown」可以貼到任何地方。

## 費用估算

以一場 **45 分鐘**的會議為例：

| 項目 | 計算 | 大約 |
| --- | --- | --- |
| Gemini 轉錄（免費層） | 3 段音訊上傳 | **$0**（受每日額度限制） |
| Typeless Pro | 0.75 小時 × $0.50 | **$0.38** |
| Typeless Lite | 0.75 小時 × $0.25 | $0.19 |
| Typeless Max | 0.75 小時 × $2.50 | $1.88 |
| LLM 摘要（Claude Sonnet） | 約 15–25k token 輸入 + 3k 輸出 | **$0.05–0.10** |

只走 Gemini 免費轉錄＋免費層摘要，一場會議可以 **$0**，代價是每日次數與速度限制。
每天一場 45 分鐘會議、用 Typeless Pro＋Claude 摘要，一個月約 **$10–14**。

## 常見問題

**完全免費可以嗎？**
可以。轉錄選 Gemini、摘要也選 Gemini，兩邊共用一把免費 key。限制是每日請求數與每分鐘次數，
以及免費層的內容可能被 Google 用於改善服務。要更穩、更不在意資料政策，再換成付費 key 或 Typeless。

**Gemini 轉錄的品質如何？**
`gemini-2.5-flash` 對清楚的中文會議通常夠用，但斷句與專有名詞不一定比 Typeless 好。
如果逐字稿品質是重點，可以用同一場會議切到 Typeless 比較一次。

**為什麼 Gemini 的切段上限是 280 秒？**
Gemini 的 inline 音訊請求有大小限制（約 20 MB）。16 kHz / 16-bit 單聲道在 280 秒時約 9 MB，
包成 WAV 再 base64 後仍在限制內。設定頁最多就是 280 秒。

**可以錄 Google Meet / Zoom 的聲音嗎？**
不行，這版只錄麥克風。要錄系統音訊得另外做虛擬音訊裝置（Windows 的立體聲混音或 macOS 的 BlackHole），不在這版範圍。

**錄到一半關掉瀏覽器會怎樣？**
伺服器會把當前那段收尾、存檔，會議停在「暫停」。重新打開那個會議按「繼續收音」就能接著錄。

**可以換成別的轉錄服務嗎？**
可以。`server/relay.ts` 依 `meeting.engine` 分支，`server/gemini.ts` 是 Gemini 的實作，
換服務大約是新增一個同介面的 `transcribePcm()`。

**可以不要保留錄音嗎？**
設定頁的「保留原始錄音」預設關閉，開啟才會寫 `audio/mic.wav`。

**逐字稿有錯字怎麼辦？**
直接改 `transcript.md` 或 `meeting.json`；重新產生紀錄時會用改過的內容。

## 開發

```powershell
npm test              # 單元測試（prefix 解析、markdown、格式化、WAV 檔頭）
npm run typecheck     # tsc --noEmit
npm run smoke         # 假 Typeless + 假 Gemini + 假 LLM，兩條轉錄路徑都跑，不需要任何 key
npm run build         # 型別檢查 + vite build
npm run e2e           # headless Edge + 假麥克風，真的走一次瀏覽器流程（需先 build）
npm run typography    # 中文孤行檢測，桌機 1440px 與手機 390px
npm run preview       # 拍首頁／紀錄頁／設定頁截圖到 preview/（需先 build + npm start）
```

專案結構：

```
server/     API、Typeless 串流 relay、Gemini 轉錄、檔案存取、摘要 prompt、LLM 呼叫
src/core/   前後端共用：型別、筆記解析、markdown 渲染、格式化
src/ui/     極簡前端：首頁、錄音頁、紀錄頁、設定頁
public/     pcm-worklet.js（麥克風 → 16k PCM16）
scripts/    dev / smoke / e2e / typography / preview
```

## 已知限制

- 只有麥克風，沒有系統音訊
- 沒有即時字幕，逐字稿要切段後才出現
- Gemini 免費層有每日與每分鐘請求上限；超過時要等額度重置或換付費 key
- 沒有講者分離（講者 A／B 不會自動標）
- 沒有 Obsidian / Notion 同步，也沒有待辦自動推送
- 一次只能錄一場會議
