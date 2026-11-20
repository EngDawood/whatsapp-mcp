/**
 * The chat viewer: your stored WhatsApp history in the browser, read-only. Signed in with the same session as the
 * dashboard. Everything that comes from a message is put on the page as text (textContent), never as HTML.
 */
import { baseCss, esc, iconLinks } from './ui.js';

const css = String.raw`
html, body { height: 100%; }
body { font-size: 15px; line-height: 1.45; overflow: hidden; }
.app { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; height: 100dvh; }
.side { display: flex; flex-direction: column; border-right: 1px solid var(--rule); min-height: 0; background: var(--fog); }
.top { padding: 12px 14px 8px; display: flex; align-items: center; gap: 10px; }
.top h1 { font-size: 1.35rem; margin: 0; flex: 1; }
.iconbtn { font: inherit; background: none; border: 0; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; font-size: 0.86rem; }
.iconbtn:hover { color: var(--ink); background: var(--code); }
.iconbtn[disabled] { opacity: .5; cursor: default; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.searchbar { padding: 0 14px 8px; }
.searchbar input { max-width: none; padding: 9px 12px; font-size: 0.95rem; }
.tabs { display: flex; gap: 4px; padding: 0 14px 8px; }
.tabs button { flex: 1; font: 600 0.86rem/1 ui-sans-serif, system-ui, sans-serif; padding: 8px; border-radius: 8px; border: 1px solid var(--rule); background: none; color: var(--muted); cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--action); border-color: var(--action); color: var(--action-ink); }
.status { padding: 0 14px 8px; color: var(--muted); font-size: 0.8rem; min-height: 1.2em; }
.list { overflow-y: auto; flex: 1; min-height: 0; }
.row { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-top: 1px solid var(--rule); padding: 10px 14px; cursor: pointer; }
.row:hover, .row[aria-current="true"] { background: var(--code); }
.row .l1 { display: flex; gap: 8px; align-items: baseline; }
.row .name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .t { color: var(--muted); font-size: 0.78rem; flex: none; }
.row .l2 { color: var(--muted); font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.row .badge { display: inline-block; background: var(--action); color: var(--action-ink); border-radius: 999px; font-size: 0.72rem; font-weight: 700; padding: 1px 7px; margin-left: 6px; }
.row mark { background: #ffe58a; color: #14212b; border-radius: 3px; }
.empty { padding: 24px 14px; color: var(--muted); }
/* Arabic, Hebrew and English mixed: each piece of text takes its own direction */
.row .name, .row .l2, .m .who, .m .q, .m .txt, #title { unicode-bidi: plaintext; text-align: start; }
.m .txt { display: block; }

.main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--rule); min-height: 56px; }
.head h2 { margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: inherit; font-size: 1.05rem; }
.head .sub { color: var(--muted); font-size: 0.8rem; font-weight: 400; }
.back { display: none; }
.msgs { flex: 1; overflow-y: auto; padding: 12px 16px 24px; min-height: 0; }
.more { display: block; margin: 4px auto 14px; font: 600 0.85rem/1 ui-sans-serif, system-ui, sans-serif; background: var(--theirs); color: var(--ink); border: 1px solid var(--rule); border-radius: 999px; padding: 8px 14px; cursor: pointer; }
.more:hover { border-color: var(--ink); }
.day { text-align: center; margin: 14px 0 8px; }
.day span { background: var(--code); color: var(--muted); font-size: 0.76rem; padding: 3px 10px; border-radius: 999px; }
.m { max-width: min(78%, 40rem); margin: 3px 0; padding: 6px 10px 4px; border-radius: 10px; background: var(--theirs); box-shadow: 0 1px 0 var(--rule); white-space: pre-wrap; overflow-wrap: anywhere; }
.m.me { margin-left: auto; background: var(--mine); }
.m.hit { outline: 2px solid var(--action); }
.m.note { background: none; box-shadow: none; color: var(--muted); font-size: 0.85rem; text-align: center; margin: 4px auto; }
.m .who { font-weight: 600; font-size: 0.82rem; color: var(--action); white-space: normal; }
.m .q { border-left: 3px solid var(--action); background: var(--code); padding: 3px 8px; border-radius: 4px; font-size: 0.85rem; color: var(--muted); margin: 2px 0 4px; white-space: normal; }
.m .meta { display: block; text-align: right; margin: 2px 0 0 12px; color: var(--muted); font-size: 0.72rem; white-space: nowrap; }
.m img { display: block; max-width: 100%; max-height: 320px; border-radius: 6px; margin: 2px 0 4px; }
.m img.sticker { max-height: 140px; background: none; }
.m audio, .m video { display: block; max-width: 100%; margin: 4px 0; }
.m .load { font: inherit; font-size: 0.85rem; background: var(--code); color: var(--ink); border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; margin: 2px 0 4px; }
.m a { color: var(--action); }
.placeholder { margin: auto; color: var(--muted); text-align: center; padding: 24px; }

@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; }
  .app.open .side { display: none; }
  .app:not(.open) .main { display: none; }
  .back { display: inline-flex; }
  .m { max-width: 88%; }
}
`;

// Plain browser JS. String.raw keeps the backslashes in regexes as written; no backticks or dollar-brace inside.
const js = String.raw`
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), list = $('list'), msgs = $('msgs'), status = $('status'), q = $('q');
  var state = { tab: 'chats', chats: [], chat: null, name: '', isGroup: false, oldest: null, loading: false };
  var MEDIA_FRESH_DAYS = 25; // WhatsApp keeps files a few weeks; older ones need the phone, so they load on request

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'x-wa': '1' } }, opts || {})).then(function (r) {
      if (r.status === 401) { location.href = '/setup'; throw new Error('signed out'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }
  function enc(s) { return encodeURIComponent(s); }
  function mediaUrl(chat, id) { return '/api/media?chat=' + enc(chat) + '&id=' + enc(id); }

  var dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  var shortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  function d(ts) { return new Date(ts * 1000); }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function when(ts) {
    var t = d(ts), now = new Date();
    if (sameDay(t, now)) return timeFmt.format(t);
    if (now - t < 6 * 864e5) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(t);
    return shortFmt.format(t);
  }
  function ago(ms) {
    if (!ms) return 'never';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  // text with links made clickable, built from text nodes only
  function rich(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[),.;:!?]+$/, '');
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = h('a', null, url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      parent.appendChild(a);
      last = m.index + url.length; re.lastIndex = last;
    }
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function highlight(parent, text, terms) {
    if (!terms.length) { parent.textContent = text; return; }
    var low = text.toLowerCase(), i = 0;
    while (i < text.length) {
      var best = -1, len = 0;
      terms.forEach(function (t) { var k = low.indexOf(t, i); if (k >= 0 && (best < 0 || k < best)) { best = k; len = t.length; } });
      if (best < 0) break;
      parent.appendChild(document.createTextNode(text.slice(i, best)));
      parent.appendChild(h('mark', null, text.slice(best, best + len)));
      i = best + len;
    }
    parent.appendChild(document.createTextNode(text.slice(i)));
  }

  // ---------- the sidebar ----------

  function setTab(tab) {
    state.tab = tab;
    ['chats', 'unanswered'].forEach(function (t) { $('tab-' + t).setAttribute('aria-selected', String(t === tab)); });
    if (tab === 'chats') renderChats(); else loadUnanswered();
  }

  function chatRow(c, line2, timeTs, badge) {
    var b = h('button', 'row'); b.type = 'button';
    if (state.chat === c.jid) b.setAttribute('aria-current', 'true');
    var l1 = h('div', 'l1'); var n = h('span', 'name', c.name);
    if (badge) n.appendChild(h('span', 'badge', badge));
    l1.appendChild(n); if (timeTs) l1.appendChild(h('span', 't', when(timeTs)));
    b.appendChild(l1);
    if (line2 != null) b.appendChild(h('div', 'l2', line2));
    return b;
  }

  function renderChats() {
    var f = q.value.trim().toLowerCase();
    list.textContent = '';
    var shown = state.chats.filter(function (c) { return !f || c.name.toLowerCase().indexOf(f) >= 0 || c.jid.indexOf(f) >= 0; });
    if (!shown.length) {
      var e = h('div', 'empty', state.chats.length ? 'No chat names match. Press Enter to search inside messages.' : 'No chats stored yet.');
      list.appendChild(e); return;
    }
    shown.forEach(function (c) {
      var prev = c.last ? (c.last.from_me ? 'You: ' : (c.is_group ? c.last.sender + ': ' : '')) + c.last.body.replace(/\s+/g, ' ') : '';
      var b = chatRow(c, prev, c.last_ts);
      b.onclick = function () { openChat(c.jid, c.name, !!c.is_group); };
      list.appendChild(b);
    });
  }

  function loadChats() {
    return api('/api/chats').then(function (j) {
      state.chats = j.chats;
      status.textContent = j.paired ? 'Updated from WhatsApp ' + ago(j.lastPull) : 'WhatsApp is not linked. Stored messages are shown.';
      if (state.tab === 'chats' && !state.searching) renderChats();
    });
  }

  function loadUnanswered() {
    list.textContent = ''; list.appendChild(h('div', 'empty', 'Loading...'));
    api('/api/unanswered').then(function (j) {
      list.textContent = '';
      if (!j.rows.length) { list.appendChild(h('div', 'empty', 'Nobody is waiting on a reply from the last 14 days.')); return; }
      j.rows.forEach(function (r) {
        var b = chatRow(r, r.last.replace(/\s+/g, ' '), r.last_ts, r.waiting + (r.more ? '+' : ''));
        b.onclick = function () { openChat(r.jid, r.name, false); };
        list.appendChild(b);
      });
    }).catch(fail);
  }

  function runSearch(text) {
    state.searching = true;
    list.textContent = ''; list.appendChild(h('div', 'empty', 'Searching all messages... this takes a few seconds.'));
    var terms = text.toLowerCase().replace(/["*]/g, ' ').split(/\s+/).filter(Boolean);
    api('/api/search?q=' + enc(text)).then(function (j) {
      if (q.value.trim() !== text) return;
      list.textContent = '';
      var top = h('div', 'empty'); top.style.padding = '8px 14px';
      var n = j.hits.length;
      top.textContent = n + (n >= j.limit ? '+' : '') + (n === 1 ? ' match' : ' matches') + ' for "' + text + '". ';
      var clear = h('button', 'text', 'Clear'); clear.type = 'button'; clear.onclick = function () { q.value = ''; state.searching = false; setTab('chats'); };
      top.appendChild(clear); list.appendChild(top);
      j.hits.forEach(function (r) {
        var b = chatRow({ jid: r.chat, name: r.chat_name }, null, r.ts);
        var l2 = h('div', 'l2'); l2.style.whiteSpace = 'normal';
        highlight(l2, r.sender + ': ' + r.body.replace(/\s+/g, ' ').slice(0, 220), terms);
        b.appendChild(l2);
        b.onclick = function () { openAround(r.chat, r.chat_name, r.id); };
        list.appendChild(b);
      });
    }).catch(fail);
  }

  // ---------- one chat ----------

  function header(name, sub) {
    $('title').textContent = name;
    $('sub').textContent = sub || '';
  }

  function mediaBlock(m, box) {
    var kind = m.media_kind, chat = state.chat, url = mediaUrl(chat, m.id);
    var fresh = (Date.now() / 1000 - m.ts) < MEDIA_FRESH_DAYS * 86400;
    function show() {
      var el;
      if (kind === 'image' || kind === 'sticker') { el = h('img', kind === 'sticker' ? 'sticker' : null); el.alt = kind; el.loading = 'lazy'; el.src = url; el.onclick = function () { window.open(url, '_blank', 'noopener'); }; }
      else if (kind === 'audio') { el = h('audio'); el.controls = true; el.preload = 'none'; el.src = url; }
      else if (kind === 'video') { el = h('video'); el.controls = true; el.preload = 'metadata'; el.src = url; }
      else { el = h('a', null, 'Download ' + (m.file_name || 'file')); el.href = url + '&download=1'; }
      el.onerror = function () { var n = h('div', 'q', 'Could not load this file. WhatsApp may have deleted it, or the phone is offline.'); el.replaceWith(n); };
      return el;
    }
    if (kind === 'document') { box.appendChild(show()); return; }
    if ((kind === 'image' || kind === 'sticker') && fresh) { box.appendChild(show()); return; }
    var label = { image: 'Load photo', sticker: 'Load sticker', audio: 'Play voice note', video: 'Load video' }[kind] || 'Load file';
    var btn = h('button', 'load', label); btn.type = 'button';
    btn.onclick = function () { var el = show(); btn.replaceWith(el); if (kind === 'audio' && el.play) el.play().catch(function () {}); };
    box.appendChild(btn);
  }

  function bubble(m, hitId) {
    if (m.type === 'reaction') {
      return h('div', 'm note', (m.from_me ? 'You' : m.sender) + ' ' + m.body.replace(/^\[|\]$/g, ''));
    }
    var b = h('div', 'm' + (m.from_me ? ' me' : '') + (m.id === hitId ? ' hit' : ''));
    b.dataset.id = m.id;
    if (state.isGroup && !m.from_me) b.appendChild(h('div', 'who', m.sender));
    if (m.reply_to) b.appendChild(h('div', 'q', m.reply_to.b || 'a message'));
    if (m.media) mediaBlock(m, b);
    var body = m.body;
    if (m.media) body = body.replace(/^\[(image|video|sticker|voice note[^\]]*|audio[^\]]*|document[^\]]*)\]\s?/, '');
    if (body) { var t = h('span', 'txt'); t.dir = 'auto'; rich(t, body); b.appendChild(t); }
    b.appendChild(h('span', 'meta', timeFmt.format(d(m.ts))));
    return b;
  }

  function render(messages, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment(), prev = opts.prevTs ? d(opts.prevTs) : null;
    messages.forEach(function (m) {
      var t = d(m.ts);
      if (!prev || !sameDay(prev, t)) { var dd = h('div', 'day'); dd.appendChild(h('span', null, dayFmt.format(t))); frag.appendChild(dd); }
      prev = t;
      frag.appendChild(bubble(m, opts.hit));
    });
    return frag;
  }

  function moreButton(fn) {
    var b = h('button', 'load more', 'Load older messages'); b.type = 'button'; b.onclick = function () { b.disabled = true; b.textContent = 'Loading...'; fn(b); };
    return b;
  }

  function show(jid, name, isGroup) {
    state.chat = jid; state.name = name; state.isGroup = isGroup;
    app.classList.add('open');
    history.replaceState(null, '', '#' + enc(jid));
    header(name, isGroup ? 'Group' : '');
    if (state.tab === 'chats' && !state.searching) renderChats();
  }

  function openChat(jid, name, isGroup) {
    show(jid, name, isGroup);
    msgs.textContent = ''; msgs.appendChild(h('div', 'placeholder', 'Loading...'));
    api('/api/messages?chat=' + enc(jid) + '&limit=60').then(function (j) {
      if (state.chat !== jid) return;
      msgs.textContent = '';
      if (j.more) msgs.appendChild(moreButton(older));
      if (!j.messages.length) msgs.appendChild(h('div', 'placeholder', 'No messages.'));
      msgs.appendChild(render(j.messages));
      state.oldest = j.messages.length ? j.messages[0] : null;
      msgs.scrollTop = msgs.scrollHeight;
    }).catch(fail);
  }

  function older(btn) {
    var jid = state.chat, first = state.oldest;
    if (!first) return;
    api('/api/messages?chat=' + enc(jid) + '&limit=80&before=' + first.ts + '&beforeId=' + enc(first.id)).then(function (j) {
      if (state.chat !== jid) return;
      var h0 = msgs.scrollHeight;
      btn.remove();
      var firstDay = msgs.querySelector('.day');
      if (firstDay && j.messages.length && sameDay(d(j.messages[j.messages.length - 1].ts), d(first.ts))) firstDay.remove();
      var frag = render(j.messages);
      if (j.more) frag.insertBefore(moreButton(older), frag.firstChild);
      msgs.insertBefore(frag, msgs.firstChild);
      if (j.messages.length) state.oldest = j.messages[0];
      msgs.scrollTop += msgs.scrollHeight - h0;
    }).catch(fail);
  }

  function openAround(jid, name, id) {
    var c = state.chats.filter(function (x) { return x.jid === jid; })[0];
    show(jid, name, c ? !!c.is_group : /@g\.us$/.test(jid));
    msgs.textContent = ''; msgs.appendChild(h('div', 'placeholder', 'Loading...'));
    api('/api/context?chat=' + enc(jid) + '&id=' + enc(id)).then(function (j) {
      if (state.chat !== jid) return;
      msgs.textContent = '';
      msgs.appendChild(moreButton(older));
      msgs.appendChild(render(j.messages, { hit: id }));
      state.oldest = j.messages.length ? j.messages[0] : null;
      var newer = h('button', 'load more', 'Jump to latest'); newer.type = 'button';
      newer.onclick = function () { openChat(jid, name, state.isGroup); };
      msgs.appendChild(newer);
      var hit = msgs.querySelector('.hit'); if (hit) hit.scrollIntoView({ block: 'center' });
    }).catch(fail);
  }

  function fail(e) { if (e.message !== 'signed out') status.textContent = 'Something went wrong: ' + e.message; }

  // ---------- refresh from WhatsApp ----------

  function sync() {
    var b = $('sync'); if (b.disabled) return;
    b.disabled = true; b.querySelector('svg').classList.add('spin');
    status.textContent = 'Checking WhatsApp for new messages...';
    api('/api/sync', { method: 'POST' }).then(function (j) {
      return loadChats().then(function () {
        if (j.added) status.textContent = j.added + ' new message' + (j.added === 1 ? '' : 's') + '. ' + status.textContent;
        if (j.added && state.chat && !msgs.querySelector('.hit')) openChat(state.chat, state.name, state.isGroup);
      });
    }).catch(fail).then(function () { b.disabled = false; b.querySelector('svg').classList.remove('spin'); });
  }

  // ---------- wiring ----------

  $('tab-chats').onclick = function () { state.searching = false; setTab('chats'); };
  $('tab-unanswered').onclick = function () { state.searching = false; setTab('unanswered'); };
  $('sync').onclick = sync;
  $('back').onclick = function () { app.classList.remove('open'); history.replaceState(null, '', location.pathname); };
  q.oninput = function () { if (!q.value.trim()) state.searching = false; if (state.tab !== 'chats') setTab('chats'); else if (!state.searching) renderChats(); };
  q.onkeydown = function (e) {
    if (e.key === 'Enter' && q.value.trim()) { if (state.tab !== 'chats') setTab('chats'); runSearch(q.value.trim()); }
    if (e.key === 'Escape') { q.value = ''; state.searching = false; renderChats(); }
  };

  loadChats().then(function () {
    var want = decodeURIComponent(location.hash.slice(1));
    var c = want && state.chats.filter(function (x) { return x.jid === want; })[0];
    if (c) openChat(c.jid, c.name, !!c.is_group);
    sync(); // show what is stored straight away, then top it up
  }).catch(fail);
})();
`;

const refreshIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`;
const backIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;

export function chatsPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc('Chats')}</title>${iconLinks}<style>${baseCss}${css}</style></head>
<body>
<div class="app" id="app">
  <aside class="side" aria-label="Chats">
    <div class="top"><h1>Chats</h1>
      <button class="iconbtn" id="sync" type="button" title="Check WhatsApp for new messages" aria-label="Refresh">${refreshIcon}</button>
      <a class="iconbtn" href="/" title="Dashboard">Dashboard</a>
    </div>
    <div class="searchbar"><input id="q" type="search" placeholder="Filter chats, Enter to search messages" aria-label="Filter chats or search messages" autocomplete="off"></div>
    <div class="tabs" role="tablist">
      <button id="tab-chats" role="tab" aria-selected="true" type="button">All chats</button>
      <button id="tab-unanswered" role="tab" aria-selected="false" type="button">Waiting on me</button>
    </div>
    <div class="status" id="status" aria-live="polite">Loading...</div>
    <div class="list" id="list"></div>
  </aside>
  <section class="main" aria-label="Conversation">
    <div class="head"><button class="iconbtn back" id="back" type="button" aria-label="Back to chats">${backIcon}</button>
      <h2><span id="title">Pick a chat</span> <span class="sub" id="sub"></span></h2></div>
    <div class="msgs" id="msgs"><div class="placeholder">Your WhatsApp history, read-only. Pick a chat on the left, or type and press Enter to search every message.</div></div>
  </section>
</div>
<script>${js}</script>
</body></html>`;
}
