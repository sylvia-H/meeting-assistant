import { llmKeyFor, llmKeySource, settings } from './config.ts';
import { isDailyQuota } from './gemini.ts';

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
}

const TIMEOUT_MS = 300_000;

/** 跟著提示詞一起送的截圖；caption 是圖前面那行說明（「截圖 3（12 分貼上，筆記：…）」） */
export interface PromptImage {
  caption: string;
  mime: string;
  data: Buffer;
}

// 三家的多模態格式不一樣，但順序一樣：先放整份文字素材，再依序「說明 → 圖」。
// 圖片跟說明緊貼著，LLM 才對得上提示詞裡的「截圖 N」。

export function anthropicContent(user: string, images: PromptImage[]): unknown {
  if (!images.length) return user;
  return [
    { type: 'text', text: user },
    ...images.flatMap((img) => [
      { type: 'text', text: img.caption },
      { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data.toString('base64') } },
    ]),
  ];
}

export function openaiContent(user: string, images: PromptImage[]): unknown {
  if (!images.length) return user;
  return [
    { type: 'text', text: user },
    ...images.flatMap((img) => [
      { type: 'text', text: img.caption },
      { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data.toString('base64')}` } },
    ]),
  ];
}

export function geminiParts(user: string, images: PromptImage[]): unknown[] {
  return [
    { text: user },
    ...images.flatMap((img) => [
      { text: img.caption },
      { inlineData: { mimeType: img.mime, data: img.data.toString('base64') } },
    ]),
  ];
}

function friendly(status: number, body: string): string {
  const snippet = body.slice(0, 400);
  if (status === 401 || status === 403) return `API key 無效或沒有權限（${status}）。請到設定頁確認。\n${snippet}`;
  if (status === 402) return `帳戶餘額不足（402）。請先儲值。\n${snippet}`;
  if (status === 429 && isDailyQuota(body)) {
    return `Gemini 免費層「今天」的額度用完了（每個模型每天 20 次）。太平洋時間午夜重置，急用請換付費 key。\n${snippet}`;
  }
  if (status === 429) return `請求太頻繁或額度用完（429）。稍後再試。\n${snippet}`;
  return `LLM 回應 ${status}：${snippet}`;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  images: PromptImage[],
): Promise<string> {
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
      messages: [{ role: 'user', content: anthropicContent(user, images) }],
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

async function callOpenai(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  images: PromptImage[],
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 8192,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: openaiContent(user, images) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, text));
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

async function callGemini(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  images: PromptImage[],
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // gemini-3 系列預設會先「想」很久，思考的 token 也算在 maxOutputTokens 裡；
  // 摘要不需要推理，關到 minimal 才不會吃掉輸出額度或拖到逾時。
  const thinking =
    model.startsWith('gemini-3') || model.startsWith('gemini-4')
      ? { thinkingConfig: { thinkingLevel: 'minimal' } }
      : {};
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: geminiParts(user, images) }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.3, ...thinking },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, text));
  const data = JSON.parse(text) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const out = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  // 被截斷至少要看得出原因，不要讓使用者拿到一份悄悄斷掉的紀錄
  if (!out) {
    const reason = data.candidates?.[0]?.finishReason ?? '沒有回傳內容';
    throw new Error(`Gemini 沒有產出會議紀錄（${reason}）。請再按一次，或換一個摘要模型。`);
  }
  return out;
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

export async function generateMinutes(system: string, user: string, images: PromptImage[] = []): Promise<LlmResult> {
  if (process.env.MOCK_LLM === '1') {
    await new Promise((r) => setTimeout(r, 300));
    // 讓 smoke／e2e 看得出截圖有沒有真的送到 LLM 這一層
    const shots = images.length ? `\n- 收到 ${images.length} 張截圖：${images.map((i) => i.caption).join('；')}` : '';
    return { text: MOCK_MINUTES + shots, provider: 'mock', model: 'mock-1' };
  }
  const s = settings();
  if (!s.llmApiKey) throw new Error('尚未設定 LLM API key。請到設定頁填入 Claude / OpenAI / Gemini 其中一把。');

  const model = s.llmModel;
  let text = '';
  switch (s.llmProvider) {
    case 'anthropic':
      text = await callAnthropic(s.llmApiKey, model, system, user, images);
      break;
    case 'openai':
      text = await callOpenai(s.llmApiKey, model, system, user, images);
      break;
    case 'gemini':
      text = await callGemini(s.llmApiKey, model, system, user, images);
      break;
    default:
      throw new Error(`不支援的 LLM provider：${s.llmProvider}`);
  }
  if (!text) throw new Error('LLM 回傳空內容，請換一個 model 再試。');
  return { text, provider: s.llmProvider, model };
}

/** 設定頁的「測試連線」用：花最少的 token 確認 key 可用 */
export interface PingOptions {
  /** 畫面上選的 provider；沒填就用已存的設定 */
  provider?: string;
  model?: string;
  /** 畫面上剛貼上、還沒存的 key */
  apiKey?: string;
}

const ENV_NAME: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export async function pingLlm(options: PingOptions = {}): Promise<string> {
  const s = settings();
  const provider = options.provider || s.llmProvider;
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'gemini') {
    throw new Error(`不支援的 LLM provider：${provider}`);
  }
  const apiKey = options.apiKey?.trim() || (provider === s.llmProvider ? s.llmApiKey : llmKeyFor(provider));
  const model = options.model?.trim() || s.llmModels[provider];
  if (!apiKey) {
    const where = ENV_NAME[provider] ?? 'API key';
    throw new Error(
      `尚未設定 ${provider} 的 API key。可以在這裡貼上並儲存，或把 ${where} 放進專案根目錄的 .env 再按一次。`,
    );
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '回覆 ok' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(friendly(res.status, text));
    return `${model} 可用（key 來源：${sourceLabel(provider, options.apiKey)}）`;
  }
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(friendly(res.status, await res.text()));
    return `${model}（key 可用，實際呼叫時才會驗證模型名稱；來源：${sourceLabel(provider, options.apiKey)}）`;
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
    { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(friendly(res.status, await res.text()));
  return `${model} 可用（key 來源：${sourceLabel(provider, options.apiKey)}）`;
}

function sourceLabel(provider: string, typedKey?: string): string {
  if (typedKey?.trim()) return '剛貼上的欄位';
  const source = llmKeySource(provider as 'anthropic' | 'openai' | 'gemini');
  if (source === 'env') return `.env 的 ${ENV_NAME[provider]}`;
  if (source === 'settings') return '設定頁';
  if (source === 'shared') return 'Gemini 轉錄共用的那把';
  return '未知';
}
