import type { Meeting } from '../core/protocol.ts';
import { formatDateLong, toLocalInputValue } from '../core/format.ts';
import { formatAttendees } from '../core/attendees.ts';
import { updateMeeting } from './api.ts';
import { el, escapeHtml, meetingsChanged, toast } from './dom.ts';
import { errorText } from './home.ts';
import { icon } from './icons.ts';

/**
 * 錄音頁、紀錄頁共用的「日期行＋標題」。
 * - 標題：任何時候點一下就能改；Enter 或離開就存，Esc 取消。
 * - 日期時間：只有還沒開始錄音（ready 且 0 段）時能改；開始後計時與筆記時間點都依它，鎖定。
 * 伺服器端同一套規則（applyInfoPatch），這裡只是不把鎖住的東西做成可點。
 */
export interface MeetingHead {
  node: HTMLElement;
  update(meeting: Meeting, extra?: string): void;
}

export function meetingHead(id: string, onSaved: (meeting: Meeting) => void): MeetingHead {
  const node = el('header', 'm-head');
  node.innerHTML = `
    <div class="m-date" id="meeting-date"></div>
    <h1 class="m-title" id="meeting-title" tabindex="0" role="button" title="點一下修改會議名稱">載入中…</h1>
    <div class="m-people" id="meeting-people"></div>`;
  const dateHost = node.querySelector<HTMLElement>('#meeting-date') as HTMLElement;
  const titleEl = node.querySelector<HTMLElement>('#meeting-title') as HTMLElement;
  const peopleHost = node.querySelector<HTMLElement>('#meeting-people') as HTMLElement;
  let editingPeople = false;

  /** 與會者：任何時候都能改（開會中臨時有人加入也行） */
  function paintPeople(m: Meeting): void {
    if (editingPeople) return;
    const list = m.attendees ?? [];
    peopleHost.innerHTML = list.length
      ? `<span class="m-people-label">與會者</span>${list
          .map((a) => `<span class="person">${escapeHtml(a.name)}${a.role ? `<small>${escapeHtml(a.role)}</small>` : ''}</span>`)
          .join('')}<button type="button" class="m-people-edit" title="修改與會者">${icon('pencil')}<span>修改</span></button>`
      : `<button type="button" class="m-people-edit add" title="加上與會者，幫逐字稿把人名寫對">${icon('plus')}<span>加上與會者</span></button>`;
    peopleHost.querySelector('button')?.addEventListener('click', () => editPeople(m));
  }

  function editPeople(m: Meeting): void {
    editingPeople = true;
    const area = el('textarea', 'm-people-input');
    area.rows = 2;
    area.value = formatAttendees(m.attendees);
    area.placeholder = '王小明（PM）、Amy（廠商 IT）、陳大文（RD）';
    area.setAttribute('aria-label', '與會者');
    const hint = el('span', 'm-people-hint', 'Ctrl+Enter 或點別處儲存，Esc 取消');
    peopleHost.innerHTML = '';
    peopleHost.append(area, hint);
    area.focus();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      editingPeople = false;
      if (commit && area.value.trim() !== formatAttendees(m.attendees)) void save({ attendees: area.value });
      else paintPeople(m);
    };
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) finish(true);
    });
    area.addEventListener('blur', () => finish(true));
  }
  let meeting: Meeting | null = null;
  let editing = false;

  async function save(patch: { title?: string; startedAt?: string; attendees?: string }): Promise<void> {
    try {
      const res = await updateMeeting(id, patch);
      meeting = res.meeting;
      onSaved(res.meeting);
      meetingsChanged();
    } catch (err) {
      toast(errorText(err), 'error', 7000);
      if (meeting) paint(meeting);
    }
  }

  function editTitle(): void {
    if (!meeting || editing) return;
    editing = true;
    const input = el('input', 'm-title-edit');
    input.type = 'text';
    input.maxLength = 80;
    input.value = meeting.title;
    input.setAttribute('aria-label', '會議名稱');
    titleEl.hidden = true;
    titleEl.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      editing = false;
      const next = input.value.replace(/\s+/g, ' ').trim();
      input.remove();
      titleEl.hidden = false;
      if (commit && meeting && next && next !== meeting.title) {
        titleEl.textContent = next;
        void save({ title: next });
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  titleEl.addEventListener('click', editTitle);
  titleEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      editTitle();
    }
  });

  let extraText = '';

  function paint(m: Meeting): void {
    meeting = m;
    if (!editing) titleEl.textContent = m.title;
    paintPeople(m);
    const canReschedule = m.status === 'ready' && m.segments.length === 0;
    const when = formatDateLong(m.startedAt);
    const extra = extraText ? `<span class="m-extra"> · ${escapeHtml(extraText)}</span>` : '';
    if (canReschedule) {
      dateHost.innerHTML = `<button class="m-date-btn" type="button" title="還沒開始錄音，可以改開始時間">${escapeHtml(when)}${icon('pencil')}</button>${extra}`;
      dateHost.querySelector('button')?.addEventListener('click', () => {
        const input = el('input', 'm-date-edit');
        input.type = 'datetime-local';
        input.value = toLocalInputValue(new Date(m.startedAt));
        input.setAttribute('aria-label', '開始時間');
        dateHost.innerHTML = '';
        dateHost.appendChild(input);
        input.focus();
        input.showPicker?.();
        let done = false;
        const finish = (commit: boolean): void => {
          if (done) return;
          done = true;
          const value = input.value;
          if (commit && value) {
            const iso = new Date(value).toISOString();
            if (iso !== new Date(m.startedAt).toISOString()) {
              void save({ startedAt: iso });
              return;
            }
          }
          paint(m);
        };
        input.addEventListener('change', () => finish(true));
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') finish(false);
          if (event.key === 'Enter') finish(true);
        });
      });
    } else {
      dateHost.innerHTML = `<span title="開始錄音後時間就固定了">${escapeHtml(when)}</span>${extra}`;
    }
  }

  return {
    node,
    update(m, extra) {
      if (extra !== undefined) extraText = extra;
      paint(m);
    },
  };
}
