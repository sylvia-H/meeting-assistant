import { settings } from './config.ts';

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
}

const TIMEOUT_MS = 300_000;

function friendly(status: number, body: string): string {
  const snippet = body.slice(0, 400);
  if (status === 401 || status === 403) return `API key 無效或沒有權限（${status}）。請到設定頁確認。\n${snippet}`;
  if (status === 402) return `帳戶餘額不足（402）。請先儲值。\n${snippet}`;
  if (status === 429) return `請求太頻繁或額度用完（429）。稍後再試。\n${snippet}`;
  return `LLM 回應 ${status}：${snippet}`;
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, text));
  const data = JSON.parse(text) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

async function callOpenai(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 8192,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, text));
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

async function callGemini(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, text));
  const data = JSON.parse(text) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

const MOCK_MINUTES = `## TL;DR
- 這是離線測試產生的假會議紀錄，用來驗證整條流程（分段、筆記、存檔、渲染）。
- 真正的內容要填 LLM key 之後才會出現。
- 錄音、逐字稿、筆記的時間軸都是真的。

## 決議
- **先用這版跑一場真會議，再決定要不要調整分段長度** — 依據：測試筆記。

## 待辦
| 事項 | 負責人 | 期限 |
|---|---|---|
| 填好 Typeless 與 LLM 的 API key | Sylvia | 待確認 |
| 找一場 30 分鐘的會議試跑 | Sylvia | 待確認 |

## 各環節摘要
### 測試環節
這一段是為了確認「打字標記環節 → 自動切段 → 逐字稿歸位」的流程有沒有通。

## 未決與風險
- 尚未用真實會議驗證長會議（> 1 小時）的分段品質。

## 我的筆記整理
- 待辦：把 API key 補上。
- 想法：之後可以讓摘要自動產生待辦事項的 markdown checklist。

## 校正紀錄
- 無。`;

export async function generateMinutes(system: string, user: string): Promise<LlmResult> {
  if (process.env.MOCK_LLM === '1') {
    await new Promise((r) => setTimeout(r, 300));
    return { text: MOCK_MINUTES, provider: 'mock', model: 'mock-1' };
  }
  const s = settings();
  if (!s.llmApiKey) throw new Error('尚未設定 LLM API key。請到設定頁填入 Claude / OpenAI / Gemini 其中一把。');

  const model = s.llmModel;
  let text = '';
  switch (s.llmProvider) {
    case 'anthropic':
      text = await callAnthropic(s.llmApiKey, model, system, user);
      break;
    case 'openai':
      text = await callOpenai(s.llmApiKey, model, system, user);
      break;
    case 'gemini':
      text = await callGemini(s.llmApiKey, model, system, user);
      break;
    default:
      throw new Error(`不支援的 LLM provider：${s.llmProvider}`);
  }
  if (!text) throw new Error('LLM 回傳空內容，請換一個 model 再試。');
  return { text, provider: s.llmProvider, model };
}

/** 設定頁的「測試連線」用：花最少的 token 確認 key 可用 */
export async function pingLlm(): Promise<string> {
  const s = settings();
  if (!s.llmApiKey) throw new Error('尚未設定 API key');
  if (s.llmProvider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': s.llmApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.llmModel, max_tokens: 8, messages: [{ role: 'user', content: '回覆 ok' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(friendly(res.status, text));
    return `${s.llmModel} 可用`;
  }
  if (s.llmProvider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${s.llmApiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(friendly(res.status, await res.text()));
    return `${s.llmModel}（key 可用，實際呼叫時才會驗證模型名稱）`;
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.llmModel)}`,
    { headers: { 'x-goog-api-key': s.llmApiKey }, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(friendly(res.status, await res.text()));
  return `${s.llmModel} 可用`;
}
