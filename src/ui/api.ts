import type { Meeting, MeetingSummary, SettingsView } from '../core/protocol.ts';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const message = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const getSettings = (): Promise<SettingsView> => api<SettingsView>('/api/settings');

export const imageUrl = (meetingId: string, name: string): string =>
  `/api/meetings/${encodeURIComponent(meetingId)}/images/${encodeURIComponent(name)}`;

/** 上傳一張已縮好的截圖，回傳伺服器上的檔名 */
export async function uploadNoteImage(meetingId: string, image: { mime: string; base64: string }): Promise<string> {
  const res = await api<{ name: string }>(`/api/meetings/${encodeURIComponent(meetingId)}/images`, {
    method: 'POST',
    body: JSON.stringify(image),
  });
  return res.name;
}

export const deleteNoteImage = (meetingId: string, name: string): Promise<unknown> =>
  api(imageUrl(meetingId, name), { method: 'DELETE' });

export const saveSettings = (patch: Record<string, unknown>): Promise<SettingsView> =>
  api<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });

export const pingLlm = (input: {
  provider: string;
  model: string;
  apiKey?: string;
}): Promise<{ ok: boolean; message: string }> =>
  api('/api/settings/ping', { method: 'POST', body: JSON.stringify(input) });

export const pingGemini = (apiKey?: string, model?: string): Promise<{ ok: boolean; message: string }> =>
  api('/api/settings/ping-gemini', {
    method: 'POST',
    body: JSON.stringify({ apiKey: apiKey ?? '', model: model ?? '' }),
  });

export const listMeetings = (): Promise<{ meetings: MeetingSummary[] }> => api('/api/meetings');

export const createMeeting = (input: {
  title: string;
  startedAt: string;
  agenda: string;
}): Promise<{ meeting: Meeting }> =>
  api('/api/meetings', { method: 'POST', body: JSON.stringify(input) });

export const getMeeting = (id: string): Promise<{ meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}`);

export const finishMeeting = (id: string): Promise<{ meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/finish`, { method: 'POST' });

export const getMinutes = (id: string): Promise<{ markdown: string; meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/minutes`);

export const summarizeMeeting = (id: string, force = false): Promise<{ markdown: string; meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/summarize`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });

export const revealMeeting = (id: string): Promise<{ ok: boolean; path: string }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/reveal`, { method: 'POST' });

export const deleteMeeting = (id: string): Promise<{ ok: boolean }> =>
  api(`/api/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const addReferences = (
  id: string,
  files: { name: string; base64: string }[],
): Promise<{ added: unknown[]; meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/references`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

export const removeReference = (id: string, name: string): Promise<{ meeting: Meeting }> =>
  api(`/api/meetings/${encodeURIComponent(id)}/references?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
