'use strict';
/* Apaaman front end: a small single-page app with hash routes. */

const $app = document.getElementById('app');
const CATEGORIES = ['Crops & Food', 'Livestock', 'Tools & Equipment', 'Household', 'Services', 'Other'];
const CAT_ICON = { 'Crops & Food': '🌾', Livestock: '🐐', 'Tools & Equipment': '🛠️', Household: '🏠', Services: '🤝', Other: '📦' };
const COLORS = ['#1f7a4d', '#c2571a', '#2a6f97', '#8e44ad', '#b5838d', '#6a994e', '#bc4749', '#b8860b'];
const isTouch = matchMedia('(pointer: coarse)').matches;

let token = localStorage.getItem('apaaman_token');
let me = null;
let socket = null;
let convs = [];
let chat = null;          // state of the open chat screen
let renderSeq = 0;        // guards against slow screens overwriting newer ones
const market = { q: '', cat: '' };
let peopleQ = '';

// ------------------------------------------------------------ small helpers
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message); }
};

function toast(msg) {
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error(data.error || 'Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Check your connection.');
  return data;
}

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';

function avatar(u, size = 44) {
  const el = h('div', {
    class: 'avatar',
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${COLORS[(u.id || 0) % COLORS.length]}`,
  });
  if (u.avatar) el.append(h('img', { src: u.avatar, alt: '' }));
  else el.textContent = initials(u.name || '?');
  return el;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(ts) {
  const t = fmtTime(ts);
  if (t.includes(':')) return 'Today';
  return t === 'Yesterday' ? t : new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

const empty = (icon, title, text, action) =>
  h('div', { class: 'empty' }, h('div', { class: 'big' }, icon), h('h3', {}, title), h('p', {}, text), action);

function searchBox(placeholder, value, onChange) {
  let timer;
  return h('input', {
    type: 'search', class: 'search', placeholder, value,
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => onChange(e.target.value.trim()), 300); },
  });
}

function openImage(src) {
  const v = h('div', { class: 'viewer', onclick: () => v.remove() }, h('img', { src, alt: '' }));
  document.body.append(v);
}

// ------------------------------------------------------------ photos
function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// Shrinks photos before upload so they send fast on slow mobile data.
function shrink(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
    img.src = url;
  });
}

async function uploadImage(file, max = 1280) {
  const blob = await shrink(file, max);
  const res = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data.url;
}

// ------------------------------------------------------------ session & realtime
function saveSession(r) {
  token = r.token;
  me = r.user;
  localStorage.setItem('apaaman_token', token);
}

function logout() {
  if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  token = null; me = null; convs = []; chat = null;
  localStorage.removeItem('apaaman_token');
  if (socket) { socket.disconnect(); socket = null; }
  history.replaceState(null, '', '#/');
  render();
}

function connectSocket() {
  if (typeof io === 'undefined') return; // offline
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('message', onIncoming);
  socket.on('refresh', () => refreshConvs());
  socket.on('connect', () => refreshConvs());
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });
}

async function loadConvs() {
  convs = (await api('GET', '/api/conversations')).conversations;
}

async function refreshConvs() {
  if (!me) return;
  try { await loadConvs(); } catch { return; }
  if (route().name === 'chats') render();
  else updateNav();
}

async function onIncoming(msg) {
  if (chat && chat.id === msg.conversation_id) {
    addMessage(msg, true);
    if (document.visibilityState === 'visible') markRead(msg.id);
  } else if (msg.sender_id !== me.id && 'vibrate' in navigator) {
    navigator.vibrate(80);
  }
  refreshConvs();
}

function markRead(id) {
  if (!chat) return;
  const c = convs.find((x) => x.id === chat.id);
  if (c) c.unread = 0;
  api('POST', `/api/conversations/${chat.id}/read`, { lastId: id }).catch(() => {});
}

async function messageUser(userId, draft) {
  const { conversation } = await api('POST', '/api/conversations/direct', { userId });
  await loadConvs();
  if (draft) sessionStorage.setItem(`draft:${conversation.id}`, draft);
  location.hash = `#/chat/${conversation.id}`;
}

// ------------------------------------------------------------ layout & routing
function route() {
  const [name = 'chats', param] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'chats', param };
}

const TAB_FOR = { chats: 'chats', chat: 'chats', newgroup: 'chats', market: 'market', listing: 'market', sell: 'market', rides: 'rides', ride: 'rides', newride: 'rides', people: 'people', person: 'people', me: 'me' };

function bottomNav() {
  const active = TAB_FOR[route().name] || 'chats';
  const unread = convs.reduce((s, c) => s + (c.unread || 0), 0);
  const tabs = [['chats', '💬', 'Chats'], ['market', '🛒', 'Market'], ['rides', '🚗', 'Rides'], ['people', '👥', 'People'], ['me', '👤', 'Me']];
  return h('nav', { class: 'bottomnav' }, tabs.map(([key, icon, label]) =>
    h('a', { href: `#/${key}`, class: active === key ? 'active' : '' },
      h('span', { class: 'ic' }, icon, key === 'chats' && unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null),
      h('span', {}, label))));
}

function updateNav() {
  const nav = $app.querySelector('.bottomnav');
  if (nav) nav.replaceWith(bottomNav());
}

function layout(title, content, { back, actions = [], nav = true, subtitle, titleHref, fixed = false } = {}) {
  const heading = h('h1', {}, title);
  const header = h('header', { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { location.hash = back; } }, '‹') : null,
    h('div', { class: 'title' }, titleHref ? h('a', { href: titleHref }, heading) : heading, subtitle ? h('small', {}, subtitle) : null),
    h('div', { class: 'actions' }, actions));
  const main = h('main', { class: fixed ? 'fixed' : '' }, content);
  $app.replaceChildren(header, main, nav ? bottomNav() : '');
  return main;
}

async function render() {
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  chat = null;

  if (!token) return renderAuth('login');
  try {
    if (!me) {
      me = (await api('GET', '/api/me')).user;
      await loadConvs();
      connectSocket();
      if (!alive()) return;
    }
    const { name, param } = route();
    const id = Number(param);
    switch (name) {
      case 'chat': return await renderChat(id, alive);
      case 'newgroup': return await renderNewGroup(alive);
      case 'market': return await renderMarket(alive);
      case 'listing': return await renderListing(id, alive);
      case 'sell': return renderSell();
      case 'rides': return await renderRides(alive);
      case 'ride': return await renderRide(id, alive);
      case 'newride': return renderNewRide();
      case 'people': return await renderPeople(alive);
      case 'person': return await renderPerson(id, alive);
      case 'me': return await renderMe(alive);
      default: return await renderChats(alive);
    }
  } catch (e) {
    if (!token) return;
    if (!me) {
      $app.replaceChildren(empty('📡', 'Cannot reach Apaaman', e.message,
        h('button', { class: 'btn primary', onclick: () => render() }, 'Try again')));
    } else toast(e.message);
  }
}

window.addEventListener('hashchange', render);

// ------------------------------------------------------------ screens: login / register
function renderAuth(mode) {
  const err = h('p', { class: 'error' });
  const login = mode === 'login';
  const inp = (name, attrs) => h('input', { name, ...attrs });
  const fields = login
    ? [
      field('Phone number', inp('phone', { type: 'tel', autocomplete: 'tel', required: true })),
      field('PIN', inp('pin', { type: 'password', inputmode: 'numeric', maxlength: 6, required: true })),
    ]
    : [
      field('Your name', inp('name', { required: true, maxlength: 40, autocomplete: 'name' })),
      field('Phone number', inp('phone', { type: 'tel', autocomplete: 'tel', required: true })),
      field('Choose a 4–6 digit PIN', inp('pin', { type: 'password', inputmode: 'numeric', maxlength: 6, minlength: 4, required: true })),
      field('What do you do? (farmer, teacher, shop…)', inp('role', { maxlength: 40 })),
      field('Your area or street', inp('area', { maxlength: 40 })),
    ];

  const form = h('form', {
    class: 'card auth-card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(form));
        saveSession(await api('POST', login ? '/api/login' : '/api/register', body));
        await loadConvs();
        connectSocket();
        if (location.hash === '#/chats') render(); else location.hash = '#/chats';
      } catch (x) {
        err.textContent = x.message;
      } finally {
        btn.disabled = false;
      }
    },
  },
  ...fields,
  err,
  h('button', { class: 'btn primary', type: 'submit' }, login ? 'Log in' : 'Create account'),
  h('p', { class: 'muted center' }, login ? 'New here? ' : 'Already have an account? ',
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(login ? 'register' : 'login'); } },
      login ? 'Create an account' : 'Log in')));

  $app.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'brand' },
      h('img', { src: '/icon.svg', alt: '', width: 76, height: 76 }),
      h('h1', {}, 'Apaaman'),
      h('p', { class: 'muted' }, 'Chat, trade and travel with your village')),
    form));
}

// ------------------------------------------------------------ screens: chats
function preview(c) {
  if (!c.last_kind) return c.type === 'group' ? 'Group created' : 'Say hello 👋';
  let who = '';
  if (c.last_sender === me.id) who = 'You: ';
  else if (c.type === 'group' && c.last_sender_name) who = `${c.last_sender_name.split(' ')[0]}: `;
  return who + (c.last_kind === 'image' ? '📷 Photo' : c.last_body);
}

async function renderChats(alive) {
  await loadConvs();
  if (!alive()) return;
  const content = convs.length
    ? h('ul', { class: 'list' }, convs.map((c) => h('li', {},
      h('a', { class: 'row', href: `#/chat/${c.id}` },
        avatar({ id: c.avatar_id, name: c.title, avatar: c.avatar }),
        h('div', { class: 'grow' },
          h('div', { class: 'row-top' }, h('strong', { class: 'ellipsis' }, c.title), h('span', { class: 'time' }, c.last_at ? fmtTime(c.last_at) : '')),
          h('div', { class: 'row-bottom' }, h('span', { class: 'muted ellipsis' }, preview(c)), c.unread ? h('span', { class: 'badge' }, c.unread) : null))))))
    : empty('💬', 'No chats yet', 'Find someone in People and send them a message, or start a group.',
      h('a', { class: 'btn primary', href: '#/people' }, 'Find people'));
  layout('Chats', content, { actions: [h('a', { class: 'btn small', href: '#/newgroup' }, '+ Group')] });
}

function messageNodes(m, prev) {
  const nodes = [];
  const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
  if (newDay) nodes.push(h('div', { class: 'day' }, dayLabel(m.created_at)));
  const mine = m.sender_id === me.id;
  const showName = chat.conv.type === 'group' && !mine && (newDay || !prev || prev.sender_id !== m.sender_id);
  const body = m.kind === 'image'
    ? h('img', {
      src: m.body, class: 'msg-img', alt: 'Photo', loading: 'lazy',
      onclick: () => openImage(m.body), onload: () => { if (chat && chat.nearBottom) scrollBottom(); },
    })
    : h('div', { class: 'msg-text' }, m.body);
  nodes.push(h('div', { class: `msg ${mine ? 'mine' : 'theirs'}` },
    showName ? h('div', { class: 'msg-name' }, m.sender_name) : null,
    body,
    h('div', { class: 'msg-time' }, new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
  return nodes;
}

function scrollBottom() {
  if (chat) chat.listEl.scrollTop = chat.listEl.scrollHeight;
}

function addMessage(m, scroll) {
  if (!chat || chat.ids.has(m.id)) return;
  chat.ids.add(m.id);
  const prev = chat.messages.at(-1);
  chat.messages.push(m);
  chat.listEl.append(...messageNodes(m, prev));
  if (scroll && (chat.nearBottom || m.sender_id === me.id)) scrollBottom();
}

function redrawMessages() {
  const { listEl } = chat;
  const nodes = [];
  if (chat.hasMore) {
    nodes.push(h('button', { class: 'btn small load-earlier', onclick: safe(loadEarlier) }, 'Load earlier messages'));
  }
  chat.messages.forEach((m, i) => nodes.push(...messageNodes(m, chat.messages[i - 1])));
  listEl.replaceChildren(...nodes);
}

async function loadEarlier() {
  const c = chat;
  const { messages } = await api('GET', `/api/conversations/${c.id}/messages?before=${c.messages[0].id}`);
  if (chat !== c) return;
  const fromBottom = c.listEl.scrollHeight - c.listEl.scrollTop;
  messages.forEach((m) => c.ids.add(m.id));
  c.messages = [...messages, ...c.messages];
  c.hasMore = messages.length === 50;
  redrawMessages();
  c.listEl.scrollTop = c.listEl.scrollHeight - fromBottom;
}

async function renderChat(id, alive) {
  let conv = convs.find((c) => c.id === id);
  if (!conv) { await loadConvs(); conv = convs.find((c) => c.id === id); }
  if (!conv) { toast('Chat not found'); location.hash = '#/chats'; return; }
  const { messages } = await api('GET', `/api/conversations/${id}/messages`);
  if (!alive()) return;

  const listEl = h('div', { class: 'messages' });
  const input = h('textarea', { rows: 1, placeholder: 'Message', maxlength: 2000, 'aria-label': 'Message' });
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
  const draft = sessionStorage.getItem(`draft:${id}`);
  if (draft) { input.value = draft; sessionStorage.removeItem(`draft:${id}`); }

  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    autosize();
    try {
      const { message } = await api('POST', `/api/conversations/${id}/messages`, { kind: 'text', body });
      addMessage(message, true);
    } catch (e) {
      toast(e.message);
      input.value = body;
      autosize();
    }
    input.focus();
  };

  const photoBtn = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Send a photo',
    onclick: safe(async () => {
      const file = await pickImage();
      if (!file) return;
      photoBtn.disabled = true;
      try {
        const url = await uploadImage(file);
        const { message } = await api('POST', `/api/conversations/${id}/messages`, { kind: 'image', body: url });
        addMessage(message, true);
      } finally {
        photoBtn.disabled = false;
      }
    }),
  }, '📷');

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch) { e.preventDefault(); send(); }
  });
  listEl.addEventListener('scroll', () => {
    if (chat) chat.nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  });

  const composer = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); send(); } },
    photoBtn, input, h('button', { class: 'send-btn', type: 'submit', 'aria-label': 'Send' }, '➤'));

  layout(conv.title, [listEl, composer], {
    back: '#/chats', nav: false, fixed: true,
    subtitle: conv.type === 'group' ? `${conv.member_count} members` : conv.other_role,
    titleHref: conv.type === 'direct' ? `#/person/${conv.other_id}` : null,
  });

  chat = { id, conv, listEl, messages, ids: new Set(messages.map((m) => m.id)), hasMore: messages.length === 50, nearBottom: true };
  redrawMessages();
  scrollBottom();
  if (messages.length) markRead(messages.at(-1).id);
  updateNav();
  if (!isTouch) input.focus();
}

async function renderNewGroup(alive) {
  const { users } = await api('GET', '/api/users');
  if (!alive()) return;
  const others = users.filter((u) => u.id !== me.id);
  const form = h('form', {
    class: 'form pad',
    onsubmit: safe(async (e) => {
      e.preventDefault();
      const name = form.elements.name.value;
      const memberIds = [...form.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
      if (!memberIds.length) throw new Error('Pick at least one person.');
      const { conversation } = await api('POST', '/api/conversations/group', { name, memberIds });
      await loadConvs();
      location.hash = `#/chat/${conversation.id}`;
    }),
  },
  field('Group name', h('input', { name: 'name', required: true, maxlength: 50, placeholder: 'e.g. Farmers group' })),
  h('div', { class: 'field' }, h('span', {}, 'Add people')),
  h('ul', { class: 'list checklist card' }, others.length
    ? others.map((u) => h('li', {}, h('label', { class: 'row' },
      h('input', { type: 'checkbox', value: u.id }), avatar(u, 36),
      h('div', { class: 'grow' }, h('strong', {}, u.name), h('div', { class: 'muted small' }, u.role || '')))))
    : h('li', { class: 'pad muted' }, 'No one else has joined yet. Invite your neighbours!')),
  h('button', { class: 'btn primary', type: 'submit' }, 'Create group'));
  layout('New group', form, { back: '#/chats', nav: false });
}

// ------------------------------------------------------------ screens: market
function listingCard(l) {
  return h('a', { class: 'card listing', href: `#/listing/${l.id}` },
    h('div', { class: 'thumb' },
      l.image ? h('img', { src: l.image, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-icon' }, CAT_ICON[l.category] || '📦'),
      l.status === 'sold' ? h('span', { class: 'sold' }, 'SOLD') : null),
    h('div', { class: 'listing-body' },
      h('div', { class: 'price' }, l.price || 'Ask'),
      h('div', { class: 'ellipsis' }, l.title),
      h('div', { class: 'muted small ellipsis' }, l.seller_name + (l.seller_area ? ` · ${l.seller_area}` : ''))));
}

async function renderMarket(alive) {
  const grid = h('div', { class: 'grid' });
  const load = async () => {
    const p = new URLSearchParams();
    if (market.q) p.set('q', market.q);
    if (market.cat) p.set('category', market.cat);
    const { listings } = await api('GET', `/api/listings?${p}`);
    if (!alive()) return;
    grid.replaceChildren(...(listings.length
      ? listings.map(listingCard)
      : [empty('🧺', 'Nothing here yet', market.q || market.cat ? 'Try another search or category.' : 'Be the first to sell something to your neighbours.',
        h('a', { class: 'btn primary', href: '#/sell' }, 'Sell something'))]));
  };
  const chips = h('div', { class: 'chips' }, ['', ...CATEGORIES].map((c) => h('button', {
    type: 'button',
    class: `chip${market.cat === c ? ' active' : ''}`,
    onclick: safe(async (e) => {
      market.cat = c;
      chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
      await load();
    }),
  }, c ? `${CAT_ICON[c]} ${c}` : 'All')));

  layout('Market', [
    h('div', { class: 'toolbar' }, searchBox('Search the market', market.q, safe(async (v) => { market.q = v; await load(); })), chips),
    grid,
  ], { actions: [h('a', { class: 'btn small', href: '#/sell' }, '+ Sell')] });
  await load();
}

async function renderListing(id, alive) {
  const { listing: l } = await api('GET', `/api/listings/${id}`);
  if (!alive()) return;
  const mine = l.user_id === me.id;
  const actions = mine
    ? [
      h('button', {
        class: 'btn',
        onclick: safe(async () => {
          await api('PATCH', `/api/listings/${id}`, { status: l.status === 'sold' ? 'active' : 'sold' });
          render();
        }),
      }, l.status === 'sold' ? 'Mark as available' : 'Mark as sold'),
      h('button', {
        class: 'btn danger',
        onclick: safe(async () => {
          if (!confirm('Delete this listing?')) return;
          await api('DELETE', `/api/listings/${id}`);
          location.hash = '#/market';
        }),
      }, 'Delete'),
    ]
    : [
      h('button', { class: 'btn primary', onclick: safe(() => messageUser(l.user_id, `Hi, is "${l.title}" still available?`)) }, '💬 Message seller'),
      h('a', { class: 'btn', href: `tel:${l.seller_phone}` }, '📞 Call'),
    ];

  layout(l.title, h('div', { class: 'detail' },
    l.image
      ? h('img', { class: 'hero', src: l.image, alt: '', onclick: () => openImage(l.image) })
      : h('div', { class: 'hero placeholder' }, CAT_ICON[l.category] || '📦'),
    h('div', { class: 'pad' },
      h('div', { class: 'price big' }, l.price || 'Ask for price'),
      h('h2', {}, l.title),
      h('div', { class: 'muted small' }, `${CAT_ICON[l.category] || ''} ${l.category} · posted ${fmtTime(l.created_at)}${l.status === 'sold' ? ' · SOLD' : ''}`),
      l.description ? h('p', { class: 'desc' }, l.description) : null,
      h('a', { class: 'row seller', href: `#/person/${l.user_id}` },
        avatar({ id: l.user_id, name: l.seller_name, avatar: l.seller_avatar }),
        h('div', { class: 'grow' }, h('strong', {}, mine ? 'You' : l.seller_name), h('div', { class: 'muted small' }, l.seller_area || 'Seller'))),
      h('div', { class: 'btn-row' }, actions))),
  { back: '#/market' });
}

function renderSell() {
  let imageUrl = null;
  const photo = h('button', {
    type: 'button', class: 'photo-pick',
    onclick: safe(async () => {
      const file = await pickImage();
      if (!file) return;
      photo.textContent = 'Uploading photo…';
      try {
        imageUrl = await uploadImage(file);
        photo.replaceChildren(h('img', { src: imageUrl, alt: '' }));
      } catch (e) {
        photo.textContent = '📷 Add a photo';
        throw e;
      }
    }),
  }, '📷 Add a photo');

  const form = h('form', {
    class: 'form pad',
    onsubmit: safe(async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const body = { ...Object.fromEntries(new FormData(form)), image: imageUrl };
        const { listing } = await api('POST', '/api/listings', body);
        location.hash = `#/listing/${listing.id}`;
      } finally {
        btn.disabled = false;
      }
    }),
  },
  photo,
  field('What are you selling?', h('input', { name: 'title', required: true, maxlength: 80, placeholder: 'e.g. 10 kg of rice' })),
  field('Price', h('input', { name: 'price', maxlength: 30, placeholder: 'e.g. 500, Free, or Negotiable' })),
  field('Category', h('select', { name: 'category' }, CATEGORIES.map((c) => h('option', { value: c }, `${CAT_ICON[c]} ${c}`)))),
  field('Description', h('textarea', { name: 'description', rows: 4, maxlength: 1000, placeholder: 'Condition, quantity, where to pick it up…' })),
  h('button', { class: 'btn primary', type: 'submit' }, 'Post listing'));

  layout('Sell something', form, { back: '#/market', nav: false });
}

// ------------------------------------------------------------ screens: rides
function rideCard(r) {
  const mine = r.user_id === me.id;
  const status = r.status === 'open' ? (r.kind === 'offer' ? 'Seats available' : 'Looking for a ride') :
    r.status === 'accepted' ? 'Matched' : r.status;
  return h('a', { class: 'card ride-card', href: `#/ride/${r.id}` },
    h('div', { class: 'ride-kind' }, r.kind === 'offer' ? '🚗 Driver offer' : '🙋 Ride request'),
    h('div', { class: 'ride-route' },
      h('span', {}, '●'), h('strong', {}, r.pickup),
      h('span', { class: 'route-line' }),
      h('span', {}, '●'), h('strong', {}, r.destination)),
    h('div', { class: 'ride-meta' },
      h('span', {}, mine ? 'You' : r.owner_name),
      h('span', {}, r.ride_time || 'Time flexible'),
      h('span', { class: `ride-status ${r.status}` }, status)));
}

async function renderRides(alive) {
  const list = h('div', { class: 'rides-list' });
  let mine = false;
  const load = async () => {
    const { rides } = await api('GET', `/api/rides?mine=${mine ? '1' : '0'}`);
    if (!alive()) return;
    list.replaceChildren(...(rides.length
      ? rides.map(rideCard)
      : [empty('🚗', mine ? 'No rides yet' : 'No rides available',
        mine ? 'Post a ride request or offer a trip.' : 'Be the first to ask for or offer a ride.',
        h('a', { class: 'btn primary', href: '#/newride' }, 'Post a ride'))]));
  };
  const mineBtn = h('button', { type: 'button', class: 'chip', onclick: async (e) => {
    mine = !mine;
    e.currentTarget.classList.toggle('active', mine);
    await load();
  } }, 'My rides');
  layout('Rides', [
    h('div', { class: 'toolbar' },
      h('div', { class: 'chips' },
        h('button', { type: 'button', class: 'chip active', onclick: async () => { mine = false; mineBtn.classList.remove('active'); await load(); } }, 'Available'),
        mineBtn)),
    list,
  ], { actions: [h('a', { class: 'btn small', href: '#/newride' }, '+ Post')] });
  await load();
}

function renderNewRide() {
  const form = h('form', {
    class: 'form pad',
    onsubmit: safe(async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(form));
        const { ride } = await api('POST', '/api/rides', body);
        location.hash = `#/ride/${ride.id}`;
      } finally {
        btn.disabled = false;
      }
    }),
  },
  field('I am', h('select', { name: 'kind' },
    h('option', { value: 'request' }, '🙋 Looking for a ride'),
    h('option', { value: 'offer' }, '🚗 Offering a ride'))),
  field('Pickup location', h('input', { name: 'pickup', required: true, maxlength: 120, placeholder: 'Village or landmark' })),
  field('Destination', h('input', { name: 'destination', required: true, maxlength: 120, placeholder: 'Town, market or address' })),
  field('Time', h('input', { name: 'ride_time', maxlength: 60, placeholder: 'Today at 4 PM' })),
  field('Seats / passengers', h('input', { name: 'seats', type: 'number', min: 1, max: 8, value: 1 })),
  field('Fare', h('input', { name: 'fare', maxlength: 30, placeholder: 'Negotiable or amount' })),
  field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 500, placeholder: 'Luggage, vehicle, or other details' })),
  h('button', { class: 'btn primary', type: 'submit' }, 'Post ride'));

  layout('Post a ride', form, { back: '#/rides', nav: false });
}

async function renderRide(id, alive) {
  const { ride: r } = await api('GET', `/api/rides/${id}`);
  if (!alive()) return;
  const mine = r.user_id === me.id;
  const acceptedMine = r.accepted_by === me.id;
  const actions = [];
  if (r.status === 'open' && !mine) {
    actions.push(h('button', { class: 'btn primary', onclick: safe(async () => {
      await api('PATCH', `/api/rides/${id}`, { action: 'accept' });
      toast('Ride matched');
      render();
    }) }, r.kind === 'offer' ? 'Request this ride' : 'Offer to drive'));
  }
  if (r.status === 'accepted' && (mine || acceptedMine)) {
    actions.push(h('button', { class: 'btn primary', onclick: safe(async () => {
      await api('PATCH', `/api/rides/${id}`, { action: 'complete' });
      render();
    }) }, 'Mark completed'));
    actions.push(h('button', { class: 'btn danger', onclick: safe(async () => {
      if (!confirm('Cancel this ride?')) return;
      await api('PATCH', `/api/rides/${id}`, { action: 'cancel' });
      render();
    }) }, 'Cancel ride'));
  }

  layout(r.kind === 'offer' ? 'Ride offer' : 'Ride request', h('div', { class: 'pad ride-detail' },
    h('div', { class: 'card ride-route-card' },
      h('div', { class: 'muted small' }, r.kind === 'offer' ? 'DRIVER' : 'PASSENGER'),
      h('a', { class: 'row ride-owner', href: `#/person/${r.user_id}` },
        avatar({ id: r.user_id, name: r.owner_name, avatar: r.owner_avatar }),
        h('div', { class: 'grow' }, h('strong', {}, mine ? 'You' : r.owner_name),
          h('div', { class: 'muted small' }, r.owner_area || 'Community member'))),
      h('div', { class: 'ride-route detail-route' },
        h('span', {}, '●'), h('strong', {}, r.pickup),
        h('span', { class: 'route-line' }),
        h('span', {}, '●'), h('strong', {}, r.destination))),
    h('div', { class: 'ride-facts' },
      h('div', {}, h('span', { class: 'muted small' }, 'Time'), h('strong', {}, r.ride_time || 'Flexible')),
      h('div', {}, h('span', { class: 'muted small' }, r.kind === 'offer' ? 'Seats' : 'Passengers'), h('strong', {}, r.seats)),
      h('div', {}, h('span', { class: 'muted small' }, 'Fare'), h('strong', {}, r.fare || 'Negotiable'))),
    r.notes ? h('p', { class: 'desc' }, r.notes) : null,
    r.accepted_name ? h('div', { class: 'matched-box' }, `Matched with ${r.accepted_name}`,
      r.accepted_phone ? h('a', { class: 'btn small', href: `tel:${r.accepted_phone}` }, '📞 Call') : null) : null,
    h('div', { class: 'btn-row' },
      ...actions,
      r.status === 'open' ? h('a', { class: 'btn', href: `tel:${r.owner_phone}` }, '📞 Call') : null)),
  { back: '#/rides' });
}

// ------------------------------------------------------------ screens: people
async function renderPeople(alive) {
  const list = h('ul', { class: 'list' });
  const load = async () => {
    const { users } = await api('GET', `/api/users?q=${encodeURIComponent(peopleQ)}`);
    if (!alive()) return;
    list.replaceChildren(...(users.length
      ? users.map((u) => h('li', {}, h('a', { class: 'row', href: `#/person/${u.id}` },
        avatar(u),
        h('div', { class: 'grow' },
          h('strong', {}, u.name, u.id === me.id ? ' (you)' : ''),
          h('div', { class: 'muted small ellipsis' }, [u.role, u.area].filter(Boolean).join(' · ') || 'Villager')))))
      : [h('li', {}, empty('🔎', 'No one found', 'Try a different name, job or area.'))]));
  };
  layout('People', [
    h('div', { class: 'toolbar' }, searchBox('Search by name, job or area', peopleQ, safe(async (v) => { peopleQ = v; await load(); }))),
    list,
  ]);
  await load();
}

async function renderPerson(id, alive) {
  if (id === me.id) { location.hash = '#/me'; return; }
  const { user: u, listings } = await api('GET', `/api/users/${id}`);
  if (!alive()) return;
  layout(u.name, h('div', { class: 'pad' }, h('div', { class: 'profile' },
    avatar(u, 96),
    h('h2', {}, u.name),
    h('div', { class: 'muted' }, [u.role, u.area].filter(Boolean).join(' · ') || 'Villager'),
    u.bio ? h('p', { class: 'desc' }, u.bio) : null,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: safe(() => messageUser(u.id)) }, '💬 Message'),
      h('a', { class: 'btn', href: `tel:${u.phone}` }, '📞 Call')),
    listings.length ? h('div', { class: 'section' }, h('h3', {}, 'Selling'), h('div', { class: 'grid' }, listings.map(listingCard))) : null)),
  { back: '#/people' });
}

// ------------------------------------------------------------ screens: me
async function renderMe(alive) {
  const { listings } = await api('GET', '/api/listings?mine=1');
  if (!alive()) return;

  const avatarBtn = h('button', {
    type: 'button', class: 'avatar-edit', 'aria-label': 'Change photo',
    onclick: safe(async () => {
      const file = await pickImage();
      if (!file) return;
      const url = await uploadImage(file, 512);
      me = (await api('PUT', '/api/me', { ...me, avatar: url })).user;
      render();
    }),
  }, avatar(me, 96), h('span', { class: 'avatar-badge' }, '📷'));

  const form = h('form', {
    class: 'form',
    onsubmit: safe(async (e) => {
      e.preventDefault();
      me = (await api('PUT', '/api/me', { ...Object.fromEntries(new FormData(form)), avatar: me.avatar })).user;
      toast('Saved');
    }),
  },
  field('Name', h('input', { name: 'name', value: me.name, required: true, maxlength: 40 })),
  field('What do you do?', h('input', { name: 'role', value: me.role, maxlength: 40, placeholder: 'farmer, teacher, shop…' })),
  field('Area or street', h('input', { name: 'area', value: me.area, maxlength: 40 })),
  field('About you', h('textarea', { name: 'bio', rows: 3, maxlength: 300 }, me.bio)),
  h('button', { class: 'btn primary', type: 'submit' }, 'Save profile'));

  layout('Me', h('div', { class: 'pad' },
    h('div', { class: 'profile' }, avatarBtn, h('h2', {}, me.name), h('div', { class: 'muted' }, me.phone)),
    form,
    h('div', { class: 'section' }, h('h3', {}, 'My listings'),
      listings.length
        ? h('div', { class: 'grid' }, listings.map(listingCard))
        : h('p', { class: 'muted' }, 'You are not selling anything yet. ', h('a', { href: '#/sell' }, 'Sell something'))),
    h('button', { class: 'btn danger block', onclick: () => { if (confirm('Log out of Apaaman?')) logout(); } }, 'Log out')));
}

// ------------------------------------------------------------ start
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && chat && chat.messages.length) markRead(chat.messages.at(-1).id);
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render();
