/* =========================================================================
 * app.js — UI, envío resiliente (Outbox), Background Sync y fallback
 * Requiere db-helper.js cargado antes (funciones globales).
 * Regla del curso: solo new Promise / .then() / .catch() / Promise.all().
 * ========================================================================= */

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const SYNC_TAG = 'sync-reportes';

/* ------------------------------------------------------------------------
 * Registro del Service Worker + puente de mensajes (Fragmento G)
 * ---------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  // Ruta RELATIVA: en GitHub Pages el sitio vive en /practica_pwa/
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
    .catch((err) => console.error('[SW] Error al registrar:', err));

  // Mitad receptora del puente postMessage: sw.js avisa cuando sincronizó
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}

/* ------------------------------------------------------------------------
 * Referencias al DOM
 * ---------------------------------------------------------------------- */
const formIncidencia = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');

/* ------------------------------------------------------------------------
 * Indicador visual de red
 * ---------------------------------------------------------------------- */
function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

function formatearHora(timestamp) {
  return new Date(timestamp).toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/* ------------------------------------------------------------------------
 * READ — Dibuja la cola de IndexedDB en pantalla
 * ---------------------------------------------------------------------- */
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'vacio';
        vacio.textContent = 'La bandeja está vacía.';
        listaOutbox.appendChild(vacio);
        return;
      }

      // Más recientes primero
      registros
        .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
        .forEach((registro) => {
          const li = document.createElement('li');

          const info = document.createElement('div');
          const titulo = document.createElement('div');
          titulo.className = 'item-titulo';
          titulo.textContent = `#${registro.id} · ${registro.titulo}`; // textContent evita inyección HTML
          const hora = document.createElement('div');
          hora.className = 'item-hora';
          hora.textContent = formatearHora(registro.fechaCreacion);
          info.appendChild(titulo);
          info.appendChild(hora);

          const estado = document.createElement('span');
          estado.className = `estado ${registro.estado}`;
          estado.textContent = registro.estado;

          li.appendChild(info);
          li.appendChild(estado);
          listaOutbox.appendChild(li);
        });
    })
    .catch((error) => {
      console.error('[UI] No se pudo leer IndexedDB:', error);
    });
}

/* ------------------------------------------------------------------------
 * CREATE — Envío resiliente con fallback a IndexedDB (Fragmentos B + E)
 * ---------------------------------------------------------------------- */
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: bitácora local como 'sincronizado'
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Detección de soporte para Background Sync API
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register(SYNC_TAG);
              })
              .catch((error) => {
                // El registro queda 'pendiente'; el fallback 'online' o una
                // recarga posterior podrán reintentarlo.
                console.warn('[Outbox] No se pudo registrar Background Sync:', error);
              });
          }
        });
    })
    .then(() => {
      // Repintar la lista en ambos escenarios
      return renderizarColaOutbox();
    });
}

/* ------------------------------------------------------------------------
 * UPDATE (fallback) — Solo para navegadores SIN SyncManager (Safari/iOS,
 * Firefox). En Chrome este trabajo lo hace sw.js con el evento 'sync'.
 * ---------------------------------------------------------------------- */
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Arreglo de objetos de IndexedDB -> arreglo de promesas HTTP + UPDATE
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Esperar a que todos los reenvíos concluyan
      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
      return renderizarColaOutbox();
    });
}

/* ------------------------------------------------------------------------
 * Eventos de red (Fragmento F: evita la condición de carrera con sw.js)
 * ---------------------------------------------------------------------- */
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradación elegante: la UI solo sincroniza si NO hay Background Sync
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

/* ------------------------------------------------------------------------
 * Formulario (submit)
 * ---------------------------------------------------------------------- */
formIncidencia.addEventListener('submit', (e) => {
  e.preventDefault();

  const datosFormulario = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };

  if (!datosFormulario.titulo || !datosFormulario.descripcion) return;

  procesarEnvioReporte(datosFormulario)
    .then(() => formIncidencia.reset())
    .catch((error) => console.error('[UI] No se pudo procesar el reporte:', error));
});

/* ------------------------------------------------------------------------
 * DELETE — Purgar registros ya sincronizados
 * ---------------------------------------------------------------------- */
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then((resultados) => {
      console.log(`[Outbox] Purgados ${resultados.length} registros sincronizados.`);
      return renderizarColaOutbox();
    })
    .catch((error) => console.error('[Outbox] Error al purgar:', error));
});

/* ------------------------------------------------------------------------
 * Arranque: esta promesa rescata los registros de IndexedDB al abrir la
 * página (incluso offline y tras cerrar la pestaña).
 * ---------------------------------------------------------------------- */
actualizarIndicadorRed();
renderizarColaOutbox();

// Si el navegador no tiene SyncManager y abrimos ya con red, vaciamos la cola
if (!('SyncManager' in window) && navigator.onLine) {
  sincronizarPendientesFallback();
}
