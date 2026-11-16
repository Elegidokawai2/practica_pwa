/* =========================================================================
 * sw.js — App Shell + Background Sync + postMessage
 * Regla del curso: solo new Promise / .then() / .catch() / Promise.all().
 * ========================================================================= */

// Fragmento A: importar el mini-wrapper de IndexedDB (ruta relativa)
importScripts('./db-helper.js');

const CACHE_STATIC_NAME = 'static-outbox-v2';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

/* ------------------------------------------------------------------------
 * Ciclo de vida: install / activate
 * ---------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando y guardando App Shell...');
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activado. Limpiando cachés antiguas...');
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_STATIC_NAME)
          .map((nombre) => caches.delete(nombre))
      ))
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------------------
 * fetch: Cache First para el App Shell. Los POST y las peticiones a otros
 * orígenes (la API) NO se interceptan: los maneja el patrón Outbox.
 * ---------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((respuestaCache) => {
        if (respuestaCache) return respuestaCache;

        return fetch(req)
          .then((respuestaRed) => {
            const copia = respuestaRed.clone();
            caches.open(CACHE_STATIC_NAME).then((cache) => cache.put(req, copia));
            return respuestaRed;
          })
          .catch(() => {
            // Navegación offline a una ruta no cacheada -> devolver el shell
            if (req.mode === 'navigate') return caches.match('./index.html');
          });
      })
  );
});

/* ------------------------------------------------------------------------
 * Fragmento B: aviso a las pestañas abiertas (mitad emisora del puente)
 * ---------------------------------------------------------------------- */
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

/* ------------------------------------------------------------------------
 * Fragmento C: motor de sincronización en segundo plano
 * ---------------------------------------------------------------------- */
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error(`Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Retornamos TODA la cadena para que event.waitUntil sepa cuándo terminó
      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}

/* ------------------------------------------------------------------------
 * Fragmento D: evento 'sync' (lo dispara el navegador al detectar red,
 * aunque la pestaña esté cerrada)
 * ---------------------------------------------------------------------- */
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch((error) => {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          // Relanzar => la promesa de waitUntil se rechaza => el navegador
          // programa un reintento automático (con backoff).
          throw error;
        })
    );
  }
});
