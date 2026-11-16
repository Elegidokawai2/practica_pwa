/* =========================================================================
 * db-helper.js — Mini-wrapper promisificado de IndexedDB (Vanilla JS)
 * Se carga en index.html (<script src="./db-helper.js">) y en sw.js
 * mediante importScripts('./db-helper.js').
 * Regla del curso: solo new Promise / .then() / .catch().
 * ========================================================================= */

const DB_NAME = 'pwa-outbox-db';
const DB_VERSION = 1;
const STORE_NAME = 'transacciones_pendientes';

/* Pieza 1: Apertura y migración de esquema ------------------------------ */
function abrirDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Solo se ejecuta si la BD es nueva o sube DB_VERSION.
    // Es el ÚNICO lugar donde se pueden crear/borrar Object Stores.
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // keyPath 'id' + autoIncrement => IDs 1, 2, 3...
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/* Pieza 2: CREATE — Escritura segura ------------------------------------ */
function guardarRegistro(datos) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const req = store.add(datos);
      let idGenerado;

      // add() nos da el ID, pero el dato aún NO está garantizado en disco
      req.onsuccess = (event) => {
        idGenerado = event.target.result;
      };

      // Resolvemos hasta que la transacción confirma la escritura
      tx.oncomplete = () => resolve(idGenerado);
      tx.onerror = (event) => reject(event.target.error);
      tx.onabort = (event) => reject(event.target.error);
    });
  });
}

/* Pieza 3: READ — Lectura completa -------------------------------------- */
function obtenerTodosLosRegistros() {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
    });
  });
}

/* UPDATE — get + put dentro de la MISMA transacción 'readwrite' --------- */
function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // 1. Obtener el registro actual por su llave primaria
      const reqGet = store.get(id);

      reqGet.onsuccess = (event) => {
        const registro = event.target.result;
        if (!registro) {
          reject(new Error(`No se encontró el registro con ID: ${id}`));
          return;
        }

        // 2. Modificar la propiedad y sobrescribir con .put()
        registro.estado = nuevoEstado;
        registro.fechaSincronizacion = Date.now();
        store.put(registro);
      };

      // 3. Resolver cuando la transacción completa el guardado en disco
      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
      tx.onabort = (event) => reject(event.target.error);
    });
  });
}

/* Pieza 4: DELETE — Eliminación por llave primaria ---------------------- */
function eliminarRegistro(id) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.delete(id);

      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
      tx.onabort = (event) => reject(event.target.error);
    });
  });
}
