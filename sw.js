const CACHE_NAME = 'sia-cpem32-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// ============================================================
// INSTALACIÓN: cachea todos los archivos de la app
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ============================================================
// ACTIVACIÓN: limpia cachés viejas
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ============================================================
// FETCH: sirve desde caché si no hay internet
// Las requests POST al Apps Script se guardan en IndexedDB
// ============================================================
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // POST al Apps Script → intentar enviar, si falla guardar en cola offline
  if (event.request.method === 'POST' && url.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request.clone()).catch(async () => {
        // Sin internet: guardar en cola
        const body = await event.request.clone().json();
        await agregarAColaOffline(body);
        return new Response(JSON.stringify({ offline: true, mensaje: 'Guardado localmente. Se enviará cuando haya conexión.' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // GET al Apps Script → intentar red, si falla devolver array vacío (no bloquear la app)
  if (event.request.method === 'GET' && url.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Todo lo demás → caché primero, luego red
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ============================================================
// SYNC EN BACKGROUND: cuando vuelve la conexión
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-notas') {
    event.waitUntil(sincronizarCola());
  }
});

// También escuchar el evento online desde el SW
self.addEventListener('message', event => {
  if (event.data === 'SYNC_NOW') {
    sincronizarCola();
  }
});

// ============================================================
// INDEXEDDB: cola de datos pendientes
// ============================================================
function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia-offline', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('cola', { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function agregarAColaOffline(datos) {
  const db = await abrirDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cola', 'readwrite');
    tx.objectStore('cola').add(datos);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function sincronizarCola() {
  const db = await abrirDB();
  const tx = db.transaction('cola', 'readonly');
  const store = tx.objectStore('cola');

  const items = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });

  const keys = await new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });

  if (items.length === 0) return;

  // Obtener la URL del Apps Script desde los clientes activos
  const clients = await self.clients.matchAll();
  let urlWebApp = null;
  for (const client of clients) {
    // La URL del Apps Script la mandamos desde script.js via postMessage
  }

  // Intentar enviar cada item pendiente
  for (let i = 0; i < items.length; i++) {
    try {
      // Buscar la URL guardada en IndexedDB
      const configDB = await abrirDB();
      const configTx = configDB.transaction('cola', 'readonly');
      
      // La URL la guardamos en el propio item si viene del script
      const item = items[i];
      const url = item._url;
      if (!url) continue;

      const payload = Array.isArray(item) ? item : [item];
      // Limpiar campo interno antes de enviar
      payload.forEach(p => delete p._url);

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (resp.ok || (await resp.text()).includes('xito')) {
        // Borrar de la cola
        const delTx = db.transaction('cola', 'readwrite');
        delTx.objectStore('cola').delete(keys[i]);
        console.log('✅ Item sincronizado y eliminado de la cola');
      }
    } catch (err) {
      console.warn('⚠️ Aún sin conexión, reintentando luego:', err);
      break;
    }
  }

  // Notificar a los clientes que se sincronizó
  const allClients = await self.clients.matchAll();
  allClients.forEach(client => client.postMessage('SYNC_COMPLETADA'));
}
