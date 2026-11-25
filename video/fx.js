/**
 * 錄影時注入網頁的疊加層：游標、點擊圈、提示氣泡、高亮框、字幕、流程列、符號對照卡、標題卡。
 * 全部畫在頁面裡，所以螢幕錄影時會一起被錄進去；用 window.__fx.* 控制。
 */
(() => {
  if (window.__fx) return;

  const CSS = `
  #__fx{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:"Microsoft JhengHei","Noto Sans TC",sans-serif}
  #__fx *{box-sizing:border-box}
  .fx-cursor{position:absolute;left:0;top:0;width:28px;height:28px;transform:translate(-100px,-100px);transition:transform .7s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));z-index:5}
  .fx-ripple{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:3px solid #60a5fa;background:rgba(96,165,250,.25);animation:fxr .6s ease-out forwards;z-index:4}
  @keyframes fxr{from{transform:scale(.4);opacity:1}to{transform:scale(3.2);opacity:0}}
  .fx-hl{position:absolute;border-radius:10px;box-shadow:0 0 0 9999px rgba(8,10,20,.5),0 0 0 3px #fbbf24;opacity:0;transition:opacity .35s,left .35s,top .35s,width .35s,height .35s;z-index:1}
  .fx-hl.on{opacity:1}
  .fx-bubble{position:absolute;max-width:340px;padding:10px 16px;border-radius:12px;background:#111827;color:#fff;font-size:20px;line-height:1.35;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.18);opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s;z-index:3}
  .fx-bubble.on{opacity:1;transform:none}
  .fx-sub{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);max-width:82%;padding:5px 18px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff;font-size:24px;line-height:1.4;text-align:center;font-weight:500;opacity:0;transition:opacity .2s;z-index:6;white-space:pre-wrap}
  .fx-sub.on{opacity:1}
  .fx-flow{position:absolute;left:50%;top:22px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;opacity:0;transition:opacity .4s;z-index:3}
  .fx-flow.on{opacity:1}
  .fx-flow .st{padding:8px 18px;border-radius:999px;background:rgba(17,24,39,.85);color:#9ca3af;font-size:20px;font-weight:700;border:2px solid transparent;transition:all .4s}
  .fx-flow .st.on{background:#2563eb;color:#fff;border-color:#93c5fd;transform:scale(1.08)}
  .fx-flow .ar{color:#e5e7eb;font-size:22px;text-shadow:0 1px 3px #000}
  .fx-sym{position:absolute;right:28px;top:90px;padding:14px 18px;border-radius:14px;background:rgba(17,24,39,.92);color:#fff;font-size:22px;opacity:0;transform:translateX(20px);transition:all .4s;z-index:3;min-width:230px}
  .fx-sym.on{opacity:1;transform:none}
  .fx-sym .row{display:flex;gap:14px;align-items:center;padding:6px 8px;border-radius:8px;opacity:.45;transition:all .3s}
  .fx-sym .row.on{opacity:1;background:rgba(255,255,255,.12);transform:scale(1.05)}
  .fx-sym kbd{display:inline-block;min-width:36px;text-align:center;padding:2px 8px;border-radius:6px;font:700 24px/1.2 Consolas,monospace;color:#111827}
  .fx-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;color:#fff;opacity:0;transition:opacity .8s;z-index:20;background:linear-gradient(120deg,#0f172a,#1e3a8a,#4c1d95,#0f172a);background-size:300% 300%;animation:fxg 9s ease-in-out infinite}
  .fx-title.on{opacity:1}
  @keyframes fxg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  .fx-title h1{margin:0;font-size:84px;letter-spacing:.12em;font-weight:800;transform:translateY(14px);transition:transform 1s}
  .fx-title.on h1{transform:none}
  .fx-title p{margin:0;font-size:32px;opacity:.85;letter-spacing:.08em}
  `;

  let root, cursor, hl, sub, flow, sym, title;
  const bubbles = new Map();

  function init() {
    if (document.getElementById('__fx')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    root = document.createElement('div');
    root.id = '__fx';
    cursor = div('fx-cursor');
    cursor.innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 2l7.5 19 2.7-7.6L21 10.7z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    hl = div('fx-hl');
    sub = div('fx-sub');
    flow = div('fx-flow');
    sym = div('fx-sym');
    title = div('fx-title');
    root.append(hl, cursor, sub, flow, sym, title);
    document.documentElement.append(style, root);
  }
  function div(cls) {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function rectOf(target) {
    if (typeof target === 'string') {
      const n = document.querySelector(target);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return target;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  window.__fx = {
    moveTo(target, fx = 0.5, fy = 0.5) {
      const r = rectOf(target);
      if (!r) return null;
      const x = r.x + r.w * fx;
      const y = r.y + r.h * fy;
      cursor.style.transform = `translate(${x - 4}px,${y - 3}px)`;
      cursor.dataset.x = x;
      cursor.dataset.y = y;
      return { x, y };
    },
    click() {
      const x = Number(cursor.dataset.x || 0);
      const y = Number(cursor.dataset.y || 0);
      const r = div('fx-ripple');
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      root.append(r);
      setTimeout(() => r.remove(), 700);
    },
    hideCursor() {
      cursor.style.transform = 'translate(-100px,-100px)';
    },
    highlight(target, pad = 8) {
      const r = rectOf(target);
      if (!r) return;
      hl.style.left = `${r.x - pad}px`;
      hl.style.top = `${r.y - pad}px`;
      hl.style.width = `${r.w + pad * 2}px`;
      hl.style.height = `${r.h + pad * 2}px`;
      hl.classList.add('on');
    },
    clearHighlight() {
      hl.classList.remove('on');
    },
    /** side: bottom | top | left | right */
    bubble(id, target, text, side = 'bottom') {
      const r = rectOf(target);
      if (!r) return;
      this.clearBubble(id);
      const b = div('fx-bubble');
      b.textContent = text;
      root.append(b);
      const bw = b.offsetWidth;
      const bh = b.offsetHeight;
      let x = r.x + r.w / 2 - bw / 2;
      let y = r.y + r.h + 14;
      if (side === 'top') y = r.y - bh - 14;
      if (side === 'left') {
        x = r.x - bw - 14;
        y = r.y + r.h / 2 - bh / 2;
      }
      if (side === 'right') {
        x = r.x + r.w + 14;
        y = r.y + r.h / 2 - bh / 2;
      }
      b.style.left = `${clamp(x, 12, innerWidth - bw - 12)}px`;
      b.style.top = `${clamp(y, 12, innerHeight - bh - 90)}px`;
      requestAnimationFrame(() => b.classList.add('on'));
      bubbles.set(id, b);
    },
    clearBubble(id) {
      const b = bubbles.get(id);
      if (!b) return;
      b.classList.remove('on');
      setTimeout(() => b.remove(), 400);
      bubbles.delete(id);
    },
    clearBubbles() {
      for (const id of [...bubbles.keys()]) this.clearBubble(id);
    },
    subtitle(text) {
      if (!text) {
        sub.classList.remove('on');
        return;
      }
      sub.textContent = text;
      sub.classList.add('on');
    },
    flow(steps, active) {
      if (!steps) {
        flow.classList.remove('on');
        return;
      }
      flow.innerHTML = steps
        .map((s, i) => `${i ? '<span class="ar">→</span>' : ''}<span class="st ${i <= active ? 'on' : ''}">${s}</span>`)
        .join('');
      flow.classList.add('on');
    },
    symbols(items, active) {
      if (!items) {
        sym.classList.remove('on');
        return;
      }
      sym.innerHTML = items
        .map(
          (it, i) =>
            `<div class="row ${active === -1 || i === active ? 'on' : ''}"><kbd style="background:${it.color}">${it.key}</kbd><span>${it.label}</span></div>`,
        )
        .join('');
      sym.classList.add('on');
    },
    title(h, p) {
      if (!h) {
        title.classList.remove('on');
        return;
      }
      title.innerHTML = `<h1>${h}</h1><p>${p ?? ''}</p>`;
      requestAnimationFrame(() => title.classList.add('on'));
    },
  };
})();
