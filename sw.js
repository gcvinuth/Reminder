// Reminder app service worker
// Handles: offline app-shell caching, notification display/click, and
// best-effort periodic re-checks of due reminders (where the browser
// supports the Periodic Background Sync API).

const CACHE_NAME = 'reminder-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for app shell, network-first fallback for everything else.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});

// The page posts a message here whenever a reminder becomes due so the
// service worker (not just the page) can raise the OS notification. This
// still requires the browser process to be alive — a true lock-screen
// full-screen alarm is outside what a web app / service worker can do.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SHOW_REMINDER') {
    const { id, title, body } = data.payload;
    event.waitUntil(
      self.registration.showNotification(title || 'Reminder', {
        body: body || '',
        tag: 'reminder-' + id,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [400, 200, 400, 200, 400],
        requireInteraction: true,
        renotify: true,
        data: { id },
      })
    );
  }
});

// Tapping a notification focuses (or opens) the app and tells it which
// reminder fired, so the page can show the full-screen alarm view.
self.addEventListener('notificationclick', (event) => {
  const id = event.notification.data && event.notification.data.id;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'ALARM_TAPPED', id });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./index.html?alarm=' + encodeURIComponent(id));
      }
    })
  );
});

// Best-effort: on supporting browsers, periodic background sync lets the
// service worker wake up roughly every N minutes (interval is decided by
// the browser, not guaranteed) to check for due reminders even if the app
// tab is closed, and notify. This is opt-in and only registers if the page
// requested the 'periodic-background-sync' permission.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkDueReminders());
  }
});

// Also respond to a one-off background sync in case the browser supports
// that instead of periodic sync.
self.addEventListener('sync', (event) => {
  if (event.tag === 'check-reminders-once') {
    event.waitUntil(checkDueReminders());
  }
});

async function checkDueReminders() {
  try {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clientsList.length > 0) {
      // Let an open page do the check; it has the freshest data.
      clientsList.forEach((c) => c.postMessage({ type: 'CHECK_NOW' }));
      return;
    }
    // No open page: read reminders directly. Service workers can't use
    // localStorage, so the page also mirrors reminders into IndexedDB
    // ('reminder-db') specifically so this background path can read them.
    const db = await openDb();
    const tx = db.transaction('reminders', 'readonly');
    const store = tx.objectStore('reminders');
    const all = await requestToPromise(store.getAll());
    const now = Date.now();
    for (const r of all) {
      if (!r.completed && !r.notified && new Date(r.datetime).getTime() <= now) {
        await self.registration.showNotification(r.title || 'Reminder', {
          body: r.description || '',
          tag: 'reminder-' + r.id,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          vibrate: [400, 200, 400, 200, 400],
          requireInteraction: true,
          renotify: true,
          data: { id: r.id },
        });
      }
    }
  } catch (err) {
    // IndexedDB may not be mirrored yet; fail silently.
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('reminder-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('reminders')) {
        db.createObjectStore('reminders', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
