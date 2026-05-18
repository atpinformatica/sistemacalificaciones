const CACHE_NAME = 'sia-cpem32-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// Instalar y guardar archivos estáticos en el dispositivo
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activar y limpiar cachés antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Interceptar peticiones
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Si es el POST de guardado a Google Sheets
  if (event.request.method === 'POST' && url.includes('script.google.com')) {
    // Si no hay internet, lo mandamos directo a la cola IndexedDB
    if (!navigator.onLine) {
      event.respondWith(
        event.request.clone().json().then(async (body) => {
          await agregarAColaOffline(body);
          return new Response(JSON.stringify({ offline: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
      );
    }
    return;
  }

  // Si es un GET (carga inicial) y no hay red, devolvemos estructura limpia para que no muera la app
  if (event.request.method === 'GET' && url.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Intercepción normal de archivos de la interfaz (offline tracking)
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// Eventos de Sincronización
self.addEventListener('sync', event => {
  if (event.tag === 'sync-notas') {
    event.waitUntil(sincronizarCola());
  }
});

self.addEventListener('message', event => {
  if (event.data === 'SYNC_NOW') {
    sincronizarCola();
  }
});

// --- MANEJO DE INDEXEDDB ---
function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia-offline-db', 1);
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

  const items = await new Promise((resolve) => {
    store.getAll().onsuccess = e => resolve(e.target.result);
  });

  const keys = await new Promise((resolve) => {
    store.getAllKeys().onsuccess = e => resolve(e.target.result);
  });

  if (!items || items.length === 0) return;

  const urlWebApp = 'https://script.google.com/macros/s/AKfycbyhoBBLl995zFUqmSe7Yc7B9_ICWOr4OGKn3vwf0kjpXUDOXNZxuhb2UXLeYlu4onz6NQ/exec';

  for (let i = 0; i < items.length; i++) {
    try {
      let lote = items[i];
      
      // Limpiamos los datos de control internos antes de despachar a Google Sheets
      if (Array.isArray(lote)) {
        lote = lote.map(item => {
          const clon = {...item};
          delete clon._url;
          return clon;
        });
      }

      const response = await fetch(urlWebApp, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lote)
      });

      // Como usamos no-cors, si no tira error de red, asumimos éxito y removemos de la cola
      const dbWrite = await abrirDB();
      const delTx = dbWrite.transaction('cola', 'readwrite');
      delTx.objectStore('cola').delete(keys[i]);
      console.log('✅ Bloque offline enviado a Google Sheets exitosamente.');

    } catch (err) {
      console.warn('⚠️ Intento de sincronización fallido (aún sin red estable):', err);
      break; 
    }
  }

  // Notificar al cliente web que refresque la UI
  const allClients = await self.clients.matchAll();
  allClients.forEach(client => client.postMessage('SYNC_COMPLETADA'));
}