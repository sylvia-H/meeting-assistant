import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { MAX_NOTE_IMAGES, type Meeting, type ServerMessage } from '../src/core/protocol.ts';
import { formatClock, formatDate, formatDurationZh } from '../src/core/format.ts';
import { invalidateSettings, projectRoot, settings, settingsView, writeSettings } from './config.ts';
import {
  addReferences,
  countImages,
  createMeeting,
  deleteMeeting,
  imageMime,
  listMeetings,
  meetingDir,
  meetingExists,
  readImage,
  readMeeting,
  readMinutes,
  readReferenceContext,
  removeImage,
  removeReference,
  saveImage,
  saveMeeting,
  writeMinutes,
  writeNotes,
  writeTranscript,
} from './store.ts';
import { buildMinutesPrompt, imageCaption, noteImages } from './prompt.ts';
import { generateMinutes, pingLlm, type PromptImage } from './llm.ts';
import { pingGemini } from './gemini.ts';
import { LiveSession } from './relay.ts';

const PORT = Number(process.env.PORT ?? 8787);
// 預設只綁本機迴路：同一個 Wi-Fi 下的其他裝置不該能打開你的會議、用你的額度。
// 真的要用平板／手機連進來再設 HOST=0.0.0.0（後果自負：沒有任何登入機制）。
const HOST = process.env.HOST || '127.0.0.1';
const DIST = path.join(projectRoot, 'dist');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, '上傳內容太大');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '請求格式不是合法 JSON');
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeMinutes(text: string, meeting: Meeting): string {
  let body = text.trim();
  body = body.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```$/, '').trim();
  if (!body.startsWith('#')) body = `# ${meeting.title}\n\n${body}`;
  const end = meeting.endedAt ?? new Date().toISOString();
  const front = [
    '---',
    `title: ${meeting.title}`,
    `date: ${formatDate(meeting.startedAt)}`,
    `start: ${formatClock(meeting.startedAt)}`,
    `end: ${formatClock(end)}`,
    `duration: ${formatDurationZh((new Date(end).getTime() - new Date(meeting.startedAt).getTime()) / 1000)}`,
    `source: ${meeting.engine}`,
    `model: ${meeting.minutes?.model ?? ''}`,
    'tags:',
    '  - meeting',
    '---',
    '',
  ].join('\n');
  return `${front}${body}\n`;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // /api/settings
  if (parts[1] === 'settings') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, settingsView());
      return;
    }
    if (method === 'PUT' && parts.length === 2) {
      const body = await readJson(req);
      const patch: Parameters<typeof writeSettings>[0] = {};
      let llmKeysPatch: Record<string, string> | null = null;
      if (typeof body.typelessApiKey === 'string') patch.typelessApiKey = body.typelessApiKey.trim();
      if (typeof body.typelessModel === 'string') patch.typelessModel = body.typelessModel;
      if (typeof body.transcriber === 'string' && (body.transcriber === 'typeless' || body.transcriber === 'gemini')) {
        patch.transcriber = body.transcriber;
      }
      if (typeof body.transcribeModel === 'string' && body.transcribeModel.trim()) {
        patch.transcribeModel = body.transcribeModel.trim();
      }
      if (typeof body.geminiApiKey === 'string') {
        const key = body.geminiApiKey.trim();
        patch.geminiApiKey = key;
        // 一把 key 兩邊共用：填在轉錄這裡，摘要選 Gemini 時也直接可用
        if (key) llmKeysPatch = { ...(llmKeysPatch ?? {}), gemini: key };
      }
      if (typeof body.language === 'string') patch.language = body.language;
      if (typeof body.meetingsDir === 'string' && body.meetingsDir.trim()) patch.meetingsDir = body.meetingsDir.trim();
      if (typeof body.autoSegmentSeconds === 'number') patch.autoSegmentSeconds = body.autoSegmentSeconds;
      if (typeof body.keepAudio === 'boolean') patch.keepAudio = body.keepAudio;
      if (typeof body.llmProvider === 'string') patch.llmProvider = body.llmProvider as never;
      if (body.llmKey && typeof body.llmKey === 'object') {
        const { provider, value } = body.llmKey as { provider?: string; value?: string };
        if (provider && typeof value === 'string' && value.trim()) {
          llmKeysPatch = { ...(llmKeysPatch ?? {}), [provider]: value.trim() };
          if (provider === 'gemini') patch.geminiApiKey = value.trim();
        }
      }
      if (typeof body.llmModel === 'object' && body.llmModel) {
        const { provider, value } = body.llmModel as { provider?: string; value?: string };
        if (provider && typeof value === 'string' && value.trim()) {
          patch.llmModels = { [provider]: value.trim() } as never;
        }
      }
      if (llmKeysPatch) patch.llmKeys = llmKeysPatch as never;
      writeSettings(patch);
      invalidateSettings();
      sendJson(res, 200, settingsView());
      return;
    }
    if (method === 'POST' && parts[2] === 'ping') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const message = await pingLlm({
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      });
      sendJson(res, 200, { ok: true, message });
      return;
    }
    if (method === 'POST' && parts[2] === 'ping-gemini') {
      const body = await readJson(req);
      const s = settings();
      const typedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const typedModel = typeof body.model === 'string' ? body.model.trim() : '';
      const message = await pingGemini(typedKey || s.geminiApiKey, typedModel || s.transcribeModels.gemini);
      sendJson(res, 200, { ok: true, message });
      return;
    }
  }

  // /api/meetings
  if (parts[1] === 'meetings') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, { meetings: await listMeetings() });
      return;
    }
    if (method === 'POST' && parts.length === 2) {
      const body = await readJson(req);
      const meeting = await createMeeting({
        title: str(body.title, '未命名會議'),
        startedAt: str(body.startedAt) || undefined,
        agenda: str(body.agenda),
      });
      sendJson(res, 201, { meeting });
      return;
    }

    const id = parts[2] ? decodeURIComponent(parts[2]) : '';
    if (!id) throw new HttpError(404, '找不到會議');
    if (!(await meetingExists(id))) throw new HttpError(404, '找不到會議');

    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, { meeting: await readMeeting(id) });
      return;
    }
    if (method === 'DELETE' && parts.length === 3) {
      // 先收掉進行中的連線，否則那個 session 之後存檔會把資料夾又寫回來
      sessions.get(id)?.dispose();
      sessions.delete(id);
      await deleteMeeting(id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && parts[3] === 'references') {
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files : [];
      const added = await addReferences(
        id,
        files
          .filter((f): f is { name: string; base64: string } => {
            const item = f as { name?: unknown; base64?: unknown };
            return typeof item.name === 'string' && typeof item.base64 === 'string';
          })
          .map((f) => ({ name: f.name, base64: f.base64 })),
      );
      sendJson(res, 200, { added, meeting: await readMeeting(id) });
      return;
    }
    if (method === 'DELETE' && parts[3] === 'references') {
      const name = url.searchParams.get('name') ?? '';
      await removeReference(id, name);
      sendJson(res, 200, { meeting: await readMeeting(id) });
      return;
    }
    // 筆記截圖：上傳只存檔、回傳檔名；筆記本身走 WebSocket 加進錄音中的 session，
    // 不然 session 下次存檔會把直接寫進 meeting.json 的筆記蓋掉
    if (parts[3] === 'images') {
      const name = parts[4] ? decodeURIComponent(parts[4]) : '';
      if (method === 'POST' && parts.length === 4) {
        const body = await readJson(req, 12 * 1024 * 1024);
        const mime = typeof body.mime === 'string' ? body.mime : '';
        const base64 = typeof body.base64 === 'string' ? body.base64 : '';
        if ((await countImages(id)) >= MAX_NOTE_IMAGES) {
          throw new HttpError(409, `這場會議已經有 ${MAX_NOTE_IMAGES} 張截圖（上限）。刪掉用不到的再貼。`);
        }
        try {
          const saved = await saveImage(id, mime, Buffer.from(base64, 'base64'));
          sendJson(res, 201, { name: saved });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : '圖片存檔失敗');
        }
        return;
      }
      if (method === 'GET' && parts.length === 5) {
        const data = await readImage(id, name);
        if (!data) throw new HttpError(404, '找不到這張截圖');
        res.writeHead(200, { 'content-type': imageMime(name), 'cache-control': 'private, max-age=86400' });
        res.end(data);
        return;
      }
      if (method === 'DELETE' && parts.length === 5) {
        // 只刪「還沒掛到任何筆記」的圖（貼了又取消）；掛上去的要刪筆記
        const live = sessions.get(id)?.meeting ?? (await readMeeting(id));
        if (live.notes.some((n) => n.image === name)) throw new HttpError(409, '這張截圖已經在筆記裡，請刪筆記');
        await removeImage(id, name);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (method === 'GET' && parts[3] === 'transcript') {
      const meeting = await readMeeting(id);
      sendJson(res, 200, { meeting });
      return;
    }
    if (method === 'GET' && parts[3] === 'minutes') {
      sendJson(res, 200, { markdown: await readMinutes(id), meeting: await readMeeting(id) });
      return;
    }
    if (method === 'POST' && parts[3] === 'finish') {
      const meeting = await readMeeting(id);
      if (meeting.status !== 'ended') {
        // 建了會議但從沒開始錄音：不該把「牆上時鐘」算成會議長度
        const neverStarted = meeting.status === 'ready' && meeting.segments.length === 0;
        meeting.status = 'ended';
        meeting.endedAt ??= neverStarted ? meeting.startedAt : new Date().toISOString();
        await saveMeeting(meeting);
        await writeTranscript(meeting);
        await writeNotes(meeting);
      }
      sendJson(res, 200, { meeting });
      return;
    }
    if (method === 'POST' && parts[3] === 'reveal') {
      const dir = meetingDir(id);
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch {
        // 開不起來就算了
      }
      sendJson(res, 200, { ok: true, path: dir });
      return;
    }
    if (method === 'POST' && parts[3] === 'summarize') {
      const body = await readJson(req);
      const force = body.force === true;
      let meeting = await readMeeting(id);

      if (meeting.status === 'recording') throw new HttpError(409, '還在錄音中，請先按「結束會議」。');
      if (!meeting.segments.some((s) => s.transcript.trim()) && !meeting.notes.length) {
        throw new HttpError(400, '沒有逐字稿也沒有筆記，沒有東西可以整理。');
      }
      if (meeting.minutes && !force) {
        sendJson(res, 200, { markdown: await readMinutes(id), meeting });
        return;
      }

      if (!meeting.endedAt) {
        meeting.endedAt = new Date().toISOString();
        meeting.status = 'ended';
      }

      const referenceContext = await readReferenceContext(id);
      const { system, user } = buildMinutesPrompt({
        meeting,
        referenceContext,
        provider: settings().llmProvider,
      });
      // 截圖依提示詞裡的編號附上；檔案不見（被手動刪掉）就跳過那張，不讓整份紀錄失敗
      const images: PromptImage[] = [];
      for (const { n, note } of noteImages(meeting)) {
        const data = await readImage(id, note.image);
        if (data) images.push({ caption: imageCaption(n, note), mime: imageMime(note.image), data });
      }
      const result = await generateMinutes(system, user, images);

      meeting = await readMeeting(id);
      meeting.minutes = { generatedAt: new Date().toISOString(), provider: result.provider, model: result.model };
      meeting.status = 'ended';
      meeting.endedAt ??= new Date().toISOString();
      const markdown = normalizeMinutes(result.text, meeting);
      await writeMinutes(meeting, markdown);
      await saveMeeting(meeting);
      sendJson(res, 200, { markdown, meeting });
      return;
    }
  }

  throw new HttpError(404, `沒有這個 API：${method} ${url.pathname}`);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端還沒 build。開發時請用 npm run dev（Vite 在 5173），或先跑 npm run build。');
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) throw new HttpError(403, 'forbidden');
  if (!existsSync(file)) file = path.join(DIST, 'index.html');
  const info = await stat(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const task = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : serveStatic(res, url.pathname);
  task.catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : '伺服器錯誤';
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
    if (status >= 500) console.error(err);
  });
});

const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<string, LiveSession>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = url.pathname.match(/^\/ws\/live\/([^/]+)$/);
  if (!match?.[1]) {
    socket.destroy();
    return;
  }
  const id = decodeURIComponent(match[1]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    void openLive(id, ws);
  });
});

async function openLive(id: string, ws: import('ws').WebSocket): Promise<void> {
  const send = (msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  let meeting: Meeting;
  try {
    meeting = await readMeeting(id);
  } catch {
    send({ type: 'error', message: '找不到這場會議' });
    ws.close();
    return;
  }

  const previous = sessions.get(id);
  if (previous) previous.dispose();

  // 上一次連線如果是被中斷的（伺服器重啟、分頁直接關掉），當時正在錄的那一段音訊
  // 只在記憶體裡，永遠不會有結果；標成失敗，免得畫面一直掛著「收音中」。
  let orphans = false;
  for (const seg of meeting.segments) {
    if (seg.status === 'open' && !seg.transcript.trim()) {
      seg.status = 'failed';
      seg.error = seg.error ?? '連線中斷，這段音訊沒有留下';
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      orphans = true;
    }
  }
  if (orphans) await saveMeeting(meeting);

  const session = new LiveSession(meeting, send);
  sessions.set(id, session);
  send({ type: 'hello', meeting, state: session.state() });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      session.write(buf);
      return;
    }
    let msg: {
      type?: string;
      kind?: string;
      text?: string;
      label?: string;
      index?: unknown;
      transcript?: unknown;
      image?: unknown;
      id?: unknown;
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void (async () => {
      try {
        switch (msg.type) {
          case 'start':
            await session.start();
            break;
          case 'pause':
            await session.pause();
            break;
          case 'resume':
            await session.resume();
            break;
          case 'note':
            await session.addNote(
              (msg.kind ?? 'note') as never,
              msg.text ?? '',
              typeof msg.image === 'string' ? msg.image : undefined,
            );
            break;
          case 'delete-note':
            if (typeof msg.id === 'string') await session.deleteNote(msg.id);
            break;
          case 'section':
            await session.addSection(msg.label ?? '');
            break;
          case 'cut':
            await session.cut();
            break;
          case 'edit':
            if (typeof msg.index === 'number' && typeof msg.transcript === 'string') {
              session.editTranscript(msg.index, msg.transcript);
            }
            break;
          case 'end':
            await session.end();
            sessions.delete(id);
            break;
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : '操作失敗' });
      }
    })();
  });

  ws.on('close', () => {
    if (sessions.get(id) === session) {
      sessions.delete(id);
      void session.suspend().catch(() => undefined);
    }
  });
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  console.log(`[meeting-assistant] API  http://${shown}:${PORT}`);
  console.log(`[meeting-assistant] 會議資料夾  ${path.resolve(projectRoot, settings().meetingsDir)}`);
  if (!existsSync(DIST)) console.log('[meeting-assistant] 開發模式：前端請開 http://localhost:5173');
});
