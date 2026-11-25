'use strict';
/* Apaaman front end: a small single-page app with hash routes. */

const $app = document.getElementById('app');
const CATEGORIES = ['Crops & Food', 'Livestock', 'Tools & Equipment', 'Household', 'Services', 'Other'];
const CAT_ICON = { 'Crops & Food': '🌾', Livestock: '🐐', 'Tools & Equipment': '🛠️', Household: '🏠', Services: '🤝', Other: '📦' };
const COMMUNITY_PAGES = {
  education: {
    title: 'Education', icon: '📚', description: 'Learning resources selected by community administrators.',
    emptyTitle: 'No education resources yet', emptyText: 'Check back later for trusted learning resources.',
    adminOnly: true, postTitle: 'Add an education resource', postAction: 'Add resource',
  },
  jobs: {
    title: 'Jobs', icon: '💼', description: 'Find local opportunities or share a job opening with the community.',
    emptyTitle: 'No job openings yet', emptyText: 'Be the first to share a local job opening.',
    postTitle: 'Post a job opening', postAction: 'Post a job',
  },
  health: {
    title: 'Health', icon: '🩺', description: 'Trusted health information and local resources curated by administrators.',
    emptyTitle: 'No health resources yet', emptyText: 'Check back later for trusted health resources.',
    adminOnly: true, postTitle: 'Add a health resource', postAction: 'Add resource',
  },
  news: {
    title: 'News', icon: '📰', description: 'Share useful community announcements and local updates.',
    emptyTitle: 'No community news yet', emptyText: 'Share the first update with your community.',
    postTitle: 'Share a community update', postAction: 'Share update',
  },
};
const COLORS = ['#1f7a4d', '#c2571a', '#2a6f97', '#8e44ad', '#b5838d', '#6a994e', '#bc4749', '#b8860b'];
const isTouch = matchMedia('(pointer: coarse)').matches;

let token = localStorage.getItem('apaaman_token');
let me = null;
let socket = null;
let convs = [];
let chat = null;          // state of the open chat screen
let rideMapCleanup = null;
let renderSeq = 0;        // guards against slow screens overwriting newer ones
const market = { q: '', cat: '' };
let peopleQ = '';
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('Apaaman is installed');
});

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

const TAB_FOR = { dashboard: 'dashboard', education: 'dashboard', jobs: 'dashboard', health: 'dashboard', news: 'dashboard', newcommunity: 'dashboard', chats: 'chats', chat: 'chats', newgroup: 'chats', market: 'market', listing: 'market', sell: 'market', rides: 'rides', ride: 'rides', newride: 'rides', people: 'people', person: 'people', me: 'dashboard', admin: 'dashboard', 'change-pin': 'dashboard' };

function bottomNav() {
  const active = TAB_FOR[route().name] || 'chats';
  const unread = convs.reduce((s, c) => s + (c.unread || 0), 0);
  const tabs = [['chats', '💬', 'Chats'], ['market', '🛒', 'Market'], ['rides', '🚗', 'Rides'], ['people', '👥', 'People'], ['dashboard', '📊', 'Dashboard']];
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
  const profileLink = me
    ? h('a', { class: 'topbar-profile', href: '#/me', 'aria-label': 'Me', title: 'Me' },
      avatar(me, 32), h('span', {}, 'Me'))
    : null;
  const header = h('header', { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { location.hash = back; } }, '‹') : null,
    h('div', { class: 'title' }, titleHref ? h('a', { href: titleHref }, heading) : heading, subtitle ? h('small', {}, subtitle) : null),
    h('div', { class: 'actions' }, actions, profileLink));
  const main = h('main', { class: fixed ? 'fixed' : '' }, content);
  $app.replaceChildren(header, main, nav ? bottomNav() : '');
  return main;
}

async function render() {
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  if (rideMapCleanup) {
    rideMapCleanup();
    rideMapCleanup = null;
  }
  chat = null;

  if (!token) return route().name === 'forgot-pin' ? renderForgotPin() : renderAuth('login');
  try {
    if (!me) {
      me = (await api('GET', '/api/me')).user;
      if (!me.pin_reset_required) {
        await loadConvs();
        connectSocket();
      }
      if (!alive()) return;
    }
    const { name, param } = route();
    if (me.pin_reset_required) {
      if (name !== 'change-pin') { location.hash = '#/change-pin'; return; }
      return renderChangePin();
    }
    if (name === 'change-pin') { location.hash = '#/me'; return; }
    const id = Number(param);
    switch (name) {
      case 'dashboard': return await renderDashboard(alive);
      case 'education':
      case 'jobs':
      case 'health':
      case 'news': return await renderCommunitySection(name, alive);
      case 'newcommunity': return renderCommunityComposer(param);
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
      case 'admin': return renderAdminUsers(alive);
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
        if (me.pin_reset_required) {
          location.hash = '#/change-pin';
          return;
        }
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
  login ? h('p', { class: 'forgot-link' }, h('a', { href: '#/forgot-pin' }, 'Forgot PIN?')) : null,
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

function renderForgotPin() {
  layout('Forgot PIN?', h('div', { class: 'auth pad' },
    h('p', { class: 'muted' }, 'PIN resets are handled by a community administrator. Contact an administrator using a trusted channel and give them the phone number on your Apaaman account. They can issue a temporary PIN, which you must change after signing in.'),
    h('p', { class: 'center small' }, h('a', { href: '#/login' }, 'Back to log in'))),
  { back: '#/login', nav: false });
}

function renderChangePin() {
  const error = h('p', { class: 'error' });
  const form = h('form', {
    class: 'card auth-card',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(form));
        if (body.newPin !== body.confirmPin) throw new Error('The PINs do not match.');
        delete body.confirmPin;
        me = (await api('POST', '/api/me/change-pin', body)).user;
        await loadConvs();
        connectSocket();
        toast('PIN changed.');
        location.hash = '#/chats';
      } catch (e2) {
        error.textContent = e2.message;
      } finally {
        button.disabled = false;
      }
    },
  },
  field('Temporary PIN', h('input', {
    name: 'currentPin', type: 'password', inputmode: 'numeric',
    autocomplete: 'current-password', required: true, minlength: 4, maxlength: 6,
  })),
  field('Choose a new 4–6 digit PIN', h('input', {
    name: 'newPin', type: 'password', inputmode: 'numeric',
    autocomplete: 'new-password', required: true, minlength: 4, maxlength: 6,
  })),
  field('Confirm new PIN', h('input', {
    name: 'confirmPin', type: 'password', inputmode: 'numeric',
    autocomplete: 'new-password', required: true, minlength: 4, maxlength: 6,
  })),
  error,
  h('button', { class: 'btn primary', type: 'submit' }, 'Set new PIN'),
  h('button', { class: 'btn', type: 'button', onclick: () => logout() }, 'Log out'));

  layout('Choose a new PIN', h('div', { class: 'auth pad' },
    h('p', { class: 'muted small' }, 'Your administrator gave you a temporary PIN. Change it before using Apaaman.'),
    form),
  { nav: false });
}

function renderAdminUsers(alive) {
  if (!me.is_admin) {
    layout('Admin access required', h('div', { class: 'pad' },
      h('p', { class: 'muted' }, 'Only an administrator can reset account PINs.')),
    { back: '#/me' });
    return;
  }

  const error = h('p', { class: 'error' });
  const results = h('ul', { class: 'list' });
  let searchSeq = 0;
  let timer;
  const query = h('input', {
    type: 'search', class: 'search', placeholder: 'Search by name or phone',
    maxlength: 60,
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    },
  });
  async function search() {
    const seq = ++searchSeq;
    const value = query.value.trim();
    error.textContent = '';
    if (value.length < 2) {
      results.replaceChildren();
      return;
    }
    try {
      const { users } = await api('GET', `/api/admin/users?q=${encodeURIComponent(value)}`);
      if (!alive() || seq !== searchSeq) return;
      results.replaceChildren(...(users.length ? users.map(renderAccount) : [
        h('li', { class: 'row muted' }, 'No matching accounts.'),
      ]));
    } catch (e) {
      if (alive() && seq === searchSeq) error.textContent = e.message;
    }
  }
  function renderAccount(user) {
    const result = h('p', { class: 'muted small', role: 'status' });
    const button = h('button', {
      class: 'btn danger small',
      onclick: safe(async () => {
        if (!confirm(`Reset the PIN for ${user.name} (${user.phone})? Verify their identity first.`)) return;
        button.disabled = true;
        try {
          const { temporaryPin } = await api('POST', `/api/admin/users/${user.id}/reset-pin`, {});
          result.className = 'admin-pin-result';
          result.textContent = `Temporary PIN: ${temporaryPin}. Share it privately; they must change it when they sign in.`;
        } finally {
          button.disabled = false;
        }
      }),
    }, 'Reset PIN');
    return h('li', { class: 'admin-account' },
      h('div', { class: 'row-top' },
        h('strong', {}, user.name),
        user.is_admin ? h('span', { class: 'muted small' }, 'Admin') : null),
      h('div', { class: 'muted small' }, [user.phone, user.area].filter(Boolean).join(' · ')),
      h('div', { class: 'btn-row' }, button),
      result);
  }

  layout('Admin PIN resets', h('div', { class: 'pad' },
    h('p', { class: 'muted small' }, 'Verify the account holder using a trusted channel before resetting. The temporary PIN is shown once; share it privately.'),
    field('Find account', query),
    error,
    results),
  { back: '#/me', nav: false });
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

async function renderDashboard(alive) {
  const [{ rides }, { listings }] = await Promise.all([
    api('GET', '/api/rides?mine=1'),
    api('GET', '/api/listings?mine=1'),
  ]);
  if (!alive()) return;
  const unread = convs.reduce((sum, conversation) => sum + (conversation.unread || 0), 0);
  const openRides = rides.filter((ride) => ride.status === 'open').length;
  const matchedRides = rides.filter((ride) => ride.status === 'accepted').length;
  const activeListings = listings.filter((listing) => listing.status === 'active').length;
  const stat = (label, value) => h('div', { class: 'card dashboard-stat' },
    h('strong', {}, value), h('span', {}, label));
  const action = (icon, label, href) => h('a', { class: 'card dashboard-action', href },
    h('span', { class: 'dashboard-action-icon' }, icon), h('strong', {}, label), h('span', {}, '›'));
  const content = h('div', { class: 'dashboard-page' },
    h('section', { class: 'dashboard-welcome card' },
      h('span', { class: 'muted small' }, 'Welcome back'),
      h('h2', {}, me.name),
      h('p', { class: 'muted' }, 'Your Apaaman community at a glance.')),
    h('section', {},
      h('h2', { class: 'dashboard-section-title' }, 'Overview'),
      h('div', { class: 'dashboard-stats' },
        stat('Unread messages', unread),
        stat('Open rides', openRides),
        stat('Matched rides', matchedRides),
        stat('Active listings', activeListings))),
    h('section', {},
      h('h2', { class: 'dashboard-section-title' }, 'Quick actions'),
      h('div', { class: 'dashboard-actions' },
        action('🚗', 'Find or request a ride', '#/rides'),
        action('🛒', 'Browse the market', '#/market'),
        action('👥', 'Find people', '#/people'),
        action('💬', 'Open chats', '#/chats'))),
    h('section', {},
      h('h2', { class: 'dashboard-section-title' }, 'Community'),
      h('div', { class: 'dashboard-actions' },
        action('📚', 'Education', '#/education'),
        action('💼', 'Jobs', '#/jobs'),
        action('🩺', 'Health', '#/health'),
        action('📰', 'News', '#/news'))));
  layout('Dashboard', content);
}

function communityPostCard(section, post) {
  const canDelete = post.user_id === me.id || me.is_admin;
  const actions = [];
  if (section === 'jobs' && post.user_id !== me.id) {
    actions.push(h('button', {
      class: 'btn small',
      onclick: safe(() => messageUser(post.user_id, `Hi, I'm interested in "${post.title}".`)),
    }, '💬 Contact poster'));
  }
  if (post.link) {
    actions.push(h('a', {
      class: 'btn small', href: post.link, target: '_blank', rel: 'noopener noreferrer',
    }, 'Open resource'));
  }
  if (canDelete) {
    actions.push(h('button', {
      class: 'btn small danger',
      onclick: safe(async () => {
        if (!confirm('Remove this post?')) return;
        await api('DELETE', `/api/community/${post.id}`);
        toast('Post removed');
        await renderCommunitySection(section, () => true);
      }),
    }, 'Delete'));
  }
  const details = [
    section === 'jobs' ? post.organization : '',
    post.area,
    post.user_id === me.id ? 'Posted by you' : `Posted by ${post.author_name}`,
    fmtTime(post.created_at),
  ].filter(Boolean).join(' · ');
  return h('article', { class: 'card community-post' },
    h('h3', {}, post.title),
    details ? h('div', { class: 'muted small community-post-meta' }, details) : null,
    h('p', { class: 'community-post-body' }, post.body),
    actions.length ? h('div', { class: 'community-post-actions' }, actions) : null);
}

async function renderCommunitySection(section, alive) {
  const page = COMMUNITY_PAGES[section];
  if (!page) { location.hash = '#/dashboard'; return; }
  const { posts } = await api('GET', `/api/community/${section}`);
  if (!alive()) return;
  const canPost = !page.adminOnly || me.is_admin;
  const list = h('div', { class: 'community-posts' },
    ...(posts.length
      ? posts.map((post) => communityPostCard(section, post))
      : [empty(page.icon, page.emptyTitle, canPost
        ? page.emptyText
        : 'Only an administrator can add trusted resources.',
      canPost ? h('a', { class: 'btn primary', href: `#/newcommunity/${section}` }, page.postAction) : null)]));
  const content = h('div', { class: 'community-page' },
    h('section', { class: 'card community-intro' },
      h('p', {}, page.description),
      section === 'health' ? h('p', { class: 'muted small' }, 'For urgent or personal medical concerns, contact a qualified health professional.') : null),
    canPost ? h('div', { class: 'community-page-action' },
      h('a', { class: 'btn primary', href: `#/newcommunity/${section}` }, `+ ${page.postAction}`)) : null,
    list);
  layout(page.title, content, { back: '#/dashboard' });
}

function renderCommunityComposer(section) {
  const page = COMMUNITY_PAGES[section];
  if (!page) { location.hash = '#/dashboard'; return; }
  if (page.adminOnly && !me.is_admin) {
    layout('Admin access required', h('div', { class: 'pad' },
      h('p', { class: 'muted' }, 'Only an administrator can add trusted resources.')),
    { back: `#/${section}` });
    return;
  }
  const form = h('form', {
    class: 'form pad',
    onsubmit: safe(async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        await api('POST', `/api/community/${section}`, Object.fromEntries(new FormData(form)));
        toast('Posted successfully');
        location.hash = `#/${section}`;
      } finally {
        button.disabled = false;
      }
    }),
  },
  field(section === 'jobs' ? 'Job title' : 'Title', h('input', {
    name: 'title', required: true, maxlength: 100,
    placeholder: section === 'jobs' ? 'e.g. Shop assistant' : 'Add a clear title',
  })),
  section === 'jobs' ? field('Employer or organization', h('input', {
    name: 'organization', maxlength: 100, placeholder: 'Business or organization name',
  })) : null,
  ['jobs', 'news'].includes(section) ? field('Area or location', h('input', {
    name: 'area', maxlength: 100, placeholder: 'Town, village or area',
  })) : null,
  field('Details', h('textarea', {
    name: 'body', required: true, rows: 5, maxlength: 3000,
    placeholder: section === 'jobs' ? 'Describe the role and how to apply.' : 'Share useful details.',
  })),
  ['education', 'health'].includes(section)
    ? field('Secure resource link (optional)', h('input', {
      name: 'link', type: 'url', maxlength: 500, placeholder: 'https://…',
    }))
    : field('Website or application link (optional)', h('input', {
      name: 'link', type: 'url', maxlength: 500, placeholder: 'https://…',
    })),
  section === 'health' ? h('p', { class: 'muted small' }, 'Share official or verified resources only. Do not include personal medical details.') : null,
  h('button', { class: 'btn primary', type: 'submit' }, page.postAction));
  layout(page.postTitle, form, { back: `#/${section}`, nav: false });
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
  let showMap = true;
  let mine = false;
  let rideFilters = { pickup: '', destination: '', kind: 'offer' };
  const load = async () => {
    const params = new URLSearchParams({ mine: mine ? '1' : '0' });
    if (rideFilters.pickup) params.set('pickup', rideFilters.pickup);
    if (rideFilters.destination) params.set('destination', rideFilters.destination);
    if (!mine && rideFilters.kind) params.set('kind', rideFilters.kind);
    const { rides } = await api('GET', `/api/rides?${params}`);
    if (!alive()) return;
    const rideType = rideFilters.kind === 'offer' ? 'driver offers' :
      rideFilters.kind === 'request' ? 'ride requests' : 'rides';
    const rideTypeArticle = rideFilters.kind === 'offer' ? 'a driver offer' :
      rideFilters.kind === 'request' ? 'a ride request' : 'a ride';
    const hasRouteFilter = rideFilters.pickup || rideFilters.destination;
    list.replaceChildren(...(rides.length
      ? rides.map(rideCard)
      : [empty('🚗', mine ? 'No rides yet' : hasRouteFilter ? 'No matching rides' : `No ${rideType} available`,
        mine ? 'Post a ride request or offer a trip.' :
          hasRouteFilter ? 'Try another pickup, destination or ride type.' : `Be the first to post ${rideTypeArticle}.`,
        h('a', { class: 'btn primary', href: '#/newride' }, 'Post a ride'))]));
  };
  const availableBtn = h('button', {
    type: 'button',
    class: 'chip active',
    onclick: safe(async () => {
      mine = false;
      availableBtn.classList.add('active');
      mineBtn.classList.remove('active');
      await load();
    }),
  }, 'Available');
  const mineBtn = h('button', {
    type: 'button',
    class: 'chip',
    onclick: safe(async () => {
      mine = true;
      availableBtn.classList.remove('active');
      mineBtn.classList.add('active');
      await load();
    }),
  }, 'My rides');
  const pickupSearchInput = h('input', {
    type: 'search', name: 'pickup', maxlength: 120, placeholder: 'Any pickup',
  });
  const destinationSearchInput = h('input', {
    type: 'search', name: 'destination', maxlength: 120, placeholder: 'Any destination',
  });
  const rideKindSelect = h('select', { name: 'kind' },
    h('option', { value: 'offer' }, 'Driver offers'),
    h('option', { value: 'request' }, 'Ride requests'),
    h('option', { value: 'all' }, 'All open rides'));
  const rideSearchForm = h('form', {
    class: 'ride-search-form',
    onsubmit: safe(async (event) => {
      event.preventDefault();
      rideFilters = {
        pickup: pickupSearchInput.value.trim(),
        destination: destinationSearchInput.value.trim(),
        kind: rideKindSelect.value === 'all' ? '' : rideKindSelect.value,
      };
      mine = false;
      availableBtn.classList.add('active');
      mineBtn.classList.remove('active');
      await load();
    }),
  },
  h('label', { class: 'ride-search-field' }, h('span', {}, 'Pickup'), pickupSearchInput),
  h('label', { class: 'ride-search-field' }, h('span', {}, 'Destination'), destinationSearchInput),
  h('label', { class: 'ride-search-field' }, h('span', {}, 'Ride type'), rideKindSelect),
  h('button', { class: 'btn primary', type: 'submit' }, 'Search rides'));
  const mapImage = h('img', {
    class: 'apam-map-image',
    src: '/apam-map.svg',
    alt: 'Offline street map centered on Apam, Ghana',
    draggable: 'false',
  });
  const onlineMapButton = h('button', {
    type: 'button',
    class: 'btn small apam-map-online',
    onclick: safe(showOnlineMap),
  }, 'Online map');
  const offlineMapView = h('div', {
    class: 'apam-map-view',
    role: 'region',
    'aria-label': 'Offline map of Apam, Ghana',
  },
  mapImage,
  onlineMapButton,
  h('div', { class: 'apam-map-location' },
    h('strong', {}, 'Apam'),
    h('span', {}, 'Ghana · Offline map')),
  h('div', { class: 'apam-map-controls' },
    h('button', {
      type: 'button', class: 'btn map-control', 'aria-label': 'Zoom in',
      onclick: () => setZoom(zoom + 0.5),
    }, '+'),
    h('button', {
      type: 'button', class: 'btn map-control', 'aria-label': 'Zoom out',
      onclick: () => setZoom(zoom - 0.5),
    }, '−'),
    h('button', {
      type: 'button', class: 'btn map-control map-center', 'aria-label': 'Reset map view',
      onclick: () => { zoom = 1; offsetX = 0; offsetY = 0; applyMapTransform(); },
    }, '⌖')),
  h('div', { class: 'apam-map-attribution' },
    h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' },
      'Map data © OpenStreetMap contributors')));
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart = null;
  let onlineMap = null;
  let searchMarker = null;
  let locationMarker = null;
  let tileErrorShown = false;
  function destroyOnlineMap() {
    if (onlineMap) {
      onlineMap.remove();
      onlineMap = null;
    }
    searchMarker = null;
    locationMarker = null;
    tileErrorShown = false;
    searchResults.hidden = true;
  }
  function showOfflineMap() {
    destroyOnlineMap();
    onlineMapView.hidden = true;
    offlineMapView.hidden = false;
  }
  function applyMapTransform() {
    const bounds = offlineMapView.getBoundingClientRect();
    const maxX = (zoom - 1) * bounds.width / 2;
    const maxY = (zoom - 1) * bounds.height / 2;
    offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
    offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
    mapImage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
  }
  function setZoom(value) {
    zoom = Math.max(1, Math.min(3, value));
    if (zoom === 1) { offsetX = 0; offsetY = 0; }
    applyMapTransform();
  }
  offlineMapView.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.apam-map-controls, .apam-map-online, .apam-map-attribution')) return;
    dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
    offlineMapView.setPointerCapture(event.pointerId);
    offlineMapView.classList.add('is-dragging');
  });
  offlineMapView.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    offsetX = event.clientX - dragStart.x;
    offsetY = event.clientY - dragStart.y;
    applyMapTransform();
  });
  const stopMapDrag = () => {
    dragStart = null;
    offlineMapView.classList.remove('is-dragging');
  };
  offlineMapView.addEventListener('pointerup', stopMapDrag);
  offlineMapView.addEventListener('pointercancel', stopMapDrag);

  const onlineMapCanvas = h('div', { class: 'online-map-canvas' });
  const searchResults = h('div', { class: 'online-map-results', hidden: true });
  const searchInput = h('input', {
    type: 'search',
    maxlength: 100,
    placeholder: 'Search places in Ghana',
    'aria-label': 'Search places in Ghana',
    autocomplete: 'off',
  });
  const searchForm = h('form', {
    class: 'online-map-search',
    onsubmit: safe(async (event) => {
      event.preventDefault();
      const query = searchInput.value.trim();
      if (!query) { searchInput.focus(); return; }
      const button = searchForm.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        if (!navigator.onLine) {
          toast('Connect to the internet to search places.');
          return;
        }
        if (!onlineMap) await showOnlineMap();
        if (!onlineMap) return;
        searchResults.hidden = false;
        searchResults.replaceChildren(h('div', { class: 'online-map-result', role: 'status' }, 'Searching OpenStreetMap…'));
        const { places } = await api('GET', `/api/map/search?q=${encodeURIComponent(query)}`);
        if (!alive()) return;
        searchResults.replaceChildren(...(places.length
          ? places.map((place) => h('button', {
            type: 'button',
            class: 'online-map-result',
            onclick: () => {
              const point = [Number(place.lat), Number(place.lon)];
              if (!onlineMap || !point.every(Number.isFinite)) return;
              if (searchMarker) searchMarker.remove();
              searchMarker = L.circleMarker(point, {
                radius: 8, color: '#155c39', fillColor: '#1f7a4d', fillOpacity: 1, weight: 3,
              }).addTo(onlineMap).bindTooltip(place.name);
              onlineMap.setView(point, 16);
              searchResults.hidden = true;
              searchInput.blur();
            },
          }, h('strong', {}, place.name), h('small', {}, place.displayName)))
          : [h('div', { class: 'online-map-result', role: 'status' }, 'No places found in Ghana.')]));
      } catch (error) {
        searchResults.replaceChildren(h('div', { class: 'online-map-result', role: 'status' }, error.message));
        throw error;
      } finally {
        button.disabled = false;
      }
    }),
  }, searchInput, h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
  const searchPanel = h('div', { class: 'online-map-search-panel' }, searchForm, searchResults);
  const locateButton = h('button', {
    type: 'button',
    class: 'btn small online-map-locate',
    onclick: locateUser,
  }, 'My location');
  const offlineModeButton = h('button', {
    type: 'button',
    class: 'btn small online-map-mode',
    onclick: showOfflineMap,
  }, 'Offline map');
  const onlineMapView = h('div', {
    class: 'online-map-view',
    role: 'region',
    'aria-label': 'Online OpenStreetMap',
    hidden: true,
  }, onlineMapCanvas, offlineModeButton, locateButton);
  const mapSurface = h('div', {
    class: 'rides-map-surface',
    role: 'region',
    'aria-label': 'Map of Apam, Ghana',
  }, offlineMapView, onlineMapView, searchPanel);

  async function showOnlineMap() {
    if (!navigator.onLine) {
      toast('Connect to the internet to use the online map. The offline map is still available.');
      return;
    }
    if (typeof L === 'undefined') {
      throw new Error('The online map library is unavailable. You can still use the offline map.');
    }
    offlineMapView.hidden = true;
    onlineMapView.hidden = false;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!alive() || !showMap) return;
    try {
      if (!onlineMap) {
        onlineMap = L.map(onlineMapCanvas, {
          zoomControl: false,
          zoomAnimation: false,
          fadeAnimation: false,
          markerZoomAnimation: false,
        }).setView([5.283297, -0.737975], 15);
        const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          keepBuffer: 1,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
        }).addTo(onlineMap);
        tiles.on('tileerror', () => {
          if (tileErrorShown) return;
          tileErrorShown = true;
          toast('Online map tiles are unavailable. Switch back to the offline map or try again later.');
        });
        tiles.on('tileload', () => { tileErrorShown = false; });
        L.control.zoom({ position: 'topright' }).addTo(onlineMap);
        const scale = L.control({ position: 'bottomright' });
        scale.onAdd = function (map) {
          const maxWidth = 100;
          const container = L.DomUtil.create('div', 'leaflet-control-scale');
          const line = L.DomUtil.create('div', 'leaflet-control-scale-line', container);
          const updateScale = () => {
            const y = map.getSize().y / 2;
            const maxMeters = map.distance(
              map.containerPointToLatLng([0, y]),
              map.containerPointToLatLng([maxWidth, y]));
            if (!Number.isFinite(maxMeters) || maxMeters <= 0) return;
            const magnitude = 10 ** Math.floor(Math.log10(maxMeters));
            const distance = [1, 2, 2.5, 5, 10]
              .map((step) => step * magnitude)
              .filter((step) => step <= maxMeters)
              .pop() || magnitude / 10;
            line.style.width = `${Math.max(1, Math.round(distance / maxMeters * maxWidth))}px`;
            line.textContent = distance < 1000 ? `${distance} m` : `${distance / 1000} km`;
          };
          this._updateScale = updateScale;
          map.on('move zoom resize', updateScale);
          updateScale();
          return container;
        };
        scale.onRemove = function (map) {
          map.off('move zoom resize', this._updateScale);
        };
        scale.addTo(onlineMap);
      } else {
        onlineMap.invalidateSize();
      }
    } catch (error) {
      showOfflineMap();
      throw error;
    }
  }
  function locateUser() {
    if (!onlineMap) return;
    if (!navigator.geolocation) {
      toast('Location is not available in this browser.');
      return;
    }
    locateButton.disabled = true;
    navigator.geolocation.getCurrentPosition((position) => {
      locateButton.disabled = false;
      if (!onlineMap) return;
      const point = [position.coords.latitude, position.coords.longitude];
      if (locationMarker) locationMarker.remove();
      locationMarker = L.circleMarker(point, {
        radius: 9, color: '#fff', fillColor: '#2676d2', fillOpacity: 1, weight: 4,
      }).addTo(onlineMap).bindTooltip('Your location');
      onlineMap.setView(point, 16);
    }, (error) => {
      locateButton.disabled = false;
      toast(error.code === 1 ? 'Allow location access to center the map.' : 'Could not get your location. Please try again.');
    }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 12000 });
  }
  rideMapCleanup = destroyOnlineMap;

  const listView = h('div', { class: 'rides-list-view', hidden: true },
    rideSearchForm,
    h('div', { class: 'toolbar' },
      h('div', { class: 'chips' },
        availableBtn,
        mineBtn)),
    list);
  const toggleView = h('button', {
    type: 'button',
    class: 'btn small',
    onclick: safe(async () => {
      showMap = !showMap;
      mapSurface.hidden = !showMap;
      listView.hidden = showMap;
      toggleView.textContent = showMap ? 'Find rides' : 'Map';
      if (showMap && navigator.onLine) await showOnlineMap();
      else if (showMap) showOfflineMap();
      else {
        destroyOnlineMap();
        await load();
      }
    }),
  }, 'Find rides');
  layout('Rides', [mapSurface, listView], {
    subtitle: 'Apam, Ghana',
    fixed: true,
    actions: [toggleView, h('a', { class: 'btn small', href: '#/newride' }, 'Request a ride')],
  });
  safe(showOnlineMap)();
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

  layout('Request or offer a ride', form, { back: '#/rides', nav: false });
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

  const installBtn = h('button', {
    class: 'btn',
    onclick: safe(async () => {
      if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'accepted') toast('Apaaman is installing');
        else toast('You can install Apaaman later from your browser menu');
      } else if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) {
        toast('Apaaman is already installed');
      } else if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        toast('Tap Share, then Add to Home Screen');
      } else {
        toast('Choose Install app or Add to Home screen from your browser menu');
      }
    }),
  }, '📲 Install Apaaman');

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
    navigator.standalone || matchMedia('(display-mode: standalone)').matches ? null : installBtn,
    form,
    me.is_admin
      ? h('a', { class: 'btn block', href: '#/admin' }, 'Admin: reset member PINs')
      : null,
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
  navigator.serviceWorker.register('/sw.js').catch((error) => console.error('Apaaman offline support could not start:', error));
}

render();
