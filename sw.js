/* ============================================================
   Pedidos HEPA - Service Worker v3.0
   Estrategia: Cache-First con Network-Fallback + Stale-While-Revalidate
   ============================================================ */

const CACHE_NAME = 'pedidos-hepa-cache-v3';
const DYNAMIC_CACHE_NAME = 'pedidos-hepa-dynamic-v3';
const STATIC_ASSETS_CACHE = 'pedidos-hepa-static-v3';
const FIREBASE_CACHE = 'pedidos-hepa-firebase-v3';

const STATIC_ASSETS = [
  '/',
  'index.html',
  'img/Logo_HEPA.png',
  'img/hapa_512.png'
];

const FIREBASE_URLS = [
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'
];

const CDN_URLS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.1/jspdf.plugin.autotable.min.js'
];

// ============================================================
// INSTALL: Precargar assets estáticos críticos
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Instalando nueva versión...');
  
  event.waitUntil(
    Promise.all([
      // Cache de assets estáticos locales
      caches.open(STATIC_ASSETS_CACHE).then(cache => {
        console.log('[SW] Cacheando assets estáticos...');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[SW] Error cacheando assets estáticos:', err);
        });
      }),
      // Cache de Firebase (esencial para funcionamiento offline parcial)
      caches.open(FIREBASE_CACHE).then(cache => {
        console.log('[SW] Cacheando Firebase SDK...');
        return cache.addAll(FIREBASE_URLS).catch(err => {
          console.warn('[SW] Error cacheando Firebase:', err);
        });
      }),
      // Cache de CDNs
      caches.open(DYNAMIC_CACHE_NAME).then(cache => {
        console.log('[SW] Cacheando CDNs...');
        return cache.addAll(CDN_URLS).catch(err => {
          console.warn('[SW] Error cacheando CDNs:', err);
        });
      })
    ]).then(() => {
      console.log('[SW] Instalación completada exitosamente');
      return self.skipWaiting();
    })
  );
});

// ============================================================
// ACTIVATE: Limpiar caches antiguos y tomar control
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activando nuevo Service Worker...');
  
  const cacheWhitelist = [
    CACHE_NAME,
    DYNAMIC_CACHE_NAME,
    STATIC_ASSETS_CACHE,
    FIREBASE_CACHE
  ];

  event.waitUntil(
    Promise.all([
      // Eliminar caches antiguos
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (!cacheWhitelist.includes(cacheName)) {
              console.log('[SW] Eliminando cache antiguo:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      // Tomar control inmediato de todas las páginas abiertas
      self.clients.claim()
    ]).then(() => {
      console.log('[SW] Activación completada - controlando todas las páginas');
    })
  );
});

// ============================================================
// STRATEGY: Network-First con timeout para Firebase (Firestore)
// ============================================================
async function networkFirstWithTimeout(request, timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetch(request.clone()),
      timeoutPromise
    ]);

    if (response && response.ok) {
      // Solo cachear requests GET (Cache API no soporta POST/PUT/DELETE)
      if (request.method === 'GET') {
        const cache = await caches.open(DYNAMIC_CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    }
    throw new Error('Response not OK');
  } catch (err) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      console.log('[SW] Sirviendo desde cache (fallback):', request.url);
      return cachedResponse;
    }
    // Si no hay cache ni red, devolver respuesta offline personalizada
    if (request.destination === 'document') {
      return caches.match('index.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ============================================================
// STRATEGY: Cache-First para assets estáticos
// ============================================================
async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  try {
    const response = await fetch(request.clone());
    if (response && response.ok) {
      // Solo cachear requests GET con scheme soportado (http/https)
      if (request.method === 'GET' && request.url.startsWith('http')) {
        const cache = await caches.open(STATIC_ASSETS_CACHE);
        cache.put(request, response.clone());
      }
    }
    return response;
  } catch (err) {
    return new Response('Offline', { status: 503 });
  }
}

// ============================================================
// STRATEGY: Stale-While-Revalidate para CDNs
// ============================================================
async function staleWhileRevalidate(request) {
  const cache = await caches.open(DYNAMIC_CACHE_NAME);
  
  const cachedResponse = await cache.match(request);
  const fetchPromise = fetch(request.clone()).then(response => {
    if (response && response.ok) {
      // Solo cachear requests GET con scheme soportado (http/https)
      if (request.method === 'GET' && request.url.startsWith('http')) {
        cache.put(request, response.clone());
      }
    }
    return response;
  }).catch(err => {
    console.warn('[SW] Error revalidando:', request.url, err);
    return cachedResponse;
  });

  return cachedResponse || fetchPromise;
}

// ============================================================
// STRATEGY: Network-Only para Firebase Firestore/Auth
// ============================================================
async function networkOnly(request) {
  try {
    const response = await fetch(request.clone());
    return response;
  } catch (err) {
    // Para peticiones Firestore, devolver un error estructurado
    return new Response(
      JSON.stringify({ error: 'offline', message: 'Sin conexión a internet' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// ============================================================
// FETCH: Router principal de estrategias
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar requests que la Cache API no soporta:
  // - Schemes no http/https (chrome-extension, blob, data, etc.)
  // - Métodos que no sean GET (POST, PUT, DELETE, etc.)
  if (!request.url.startsWith('http') || request.method !== 'GET') {
    return;
  }

  // === ESTRATEGIAS POR TIPO DE RECURSO ===

  // 1. Firebase Firestore/Auth - Network Only (datos en tiempo real)
  if (url.hostname.includes('firebase') || url.hostname.includes('firestore')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // 2. Firebase SDK (gstatic) - Cache First
  if (url.hostname === 'www.gstatic.com') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 3. CDNs (Tailwind, Lucide, jsPDF) - Stale While Revalidate
  if (
    url.hostname === 'cdn.tailwindcss.com' ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'cdnjs.cloudflare.com'
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 4. Assets estáticos locales (img, etc.) - Cache First
  if (
    request.destination === 'image' ||
    request.destination === 'font' ||
    request.destination === 'style'
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. Documento principal (index.html) - Network First con timeout
  if (request.destination === 'document') {
    event.respondWith(networkFirstWithTimeout(request, 3000));
    return;
  }

  // 6. Scripts locales - Cache First
  if (request.destination === 'script') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 7. Default: Network First con timeout
  event.respondWith(networkFirstWithTimeout(request, 5000));
});

// ============================================================
// MESSAGE HANDLER: Comunicación con la aplicación
// ============================================================
self.addEventListener('message', event => {
  if (!event.data) return;

  const { action } = event.data;

  switch (action) {
    case 'skipWaiting':
      console.log('[SW] skipWaiting solicitado, activando nuevo SW...');
      self.skipWaiting();
      break;

    case 'clearCache':
      console.log('[SW] Limpiando todos los caches...');
      event.waitUntil(
        caches.keys().then(cacheNames => {
          return Promise.all(
            cacheNames.map(cacheName => caches.delete(cacheName))
          );
        }).then(() => {
          console.log('[SW] Caches limpiados exitosamente');
          if (event.source) {
            event.source.postMessage({ action: 'cacheCleared' });
          }
        })
      );
      break;

    case 'getCacheStatus':
      event.waitUntil(
        caches.keys().then(cacheNames => {
          const cacheInfo = {};
          return Promise.all(
            cacheNames.map(async cacheName => {
              const cache = await caches.open(cacheName);
              const keys = await cache.keys();
              cacheInfo[cacheName] = keys.length;
            })
          ).then(() => {
            if (event.source) {
              event.source.postMessage({ 
                action: 'cacheStatus', 
                caches: cacheInfo 
              });
            }
          });
        })
      );
      break;

    case 'offlineSync':
      // Para futura implementación de sincronización offline
      console.log('[SW] Solicitud de sincronización offline recibida');
      if (event.source) {
        event.source.postMessage({ 
          action: 'syncStatus', 
          status: 'pending',
          message: 'Sincronización pendiente - funcionalidad próximamente'
        });
      }
      break;

    default:
      console.log('[SW] Mensaje recibido:', action);
  }
});

// ============================================================
// SYNC: Sincronización en segundo plano (Background Sync)
// ============================================================
self.addEventListener('sync', event => {
  console.log('[SW] Evento de sincronización:', event.tag);
  
  if (event.tag === 'sync-pedidos') {
    event.waitUntil(
      // Aquí se implementará la lógica de sincronización offline
      // cuando se agregue IndexedDB para almacenamiento local
      Promise.resolve().then(() => {
        console.log('[SW] Sincronización de pedidos completada');
      })
    );
  }
});

// ============================================================
// PUSH: Notificaciones push (preparado para futuro)
// ============================================================
self.addEventListener('push', event => {
  console.log('[SW] Notificación push recibida:', event);

  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Pedidos HEPA';
  const options = {
    body: data.body || 'Tienes una nueva notificación',
    icon: 'img/hapa_512.png',
    badge: 'img/hapa_512.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || './index.html'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ============================================================
// NOTIFICATION CLICK: Manejar clic en notificaciones
// ============================================================
self.addEventListener('notificationclick', event => {
  console.log('[SW] Clic en notificación:', event.notification);
  
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const url = event.notification.data?.url || './index.html';
        
        // Si ya hay una ventana abierta, enfocarla
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        // Si no, abrir una nueva
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});

// ============================================================
// ONLINE/OFFLINE: Notificar cambios de conectividad
// ============================================================
self.addEventListener('online', () => {
  console.log('[SW] Conexión restablecida');
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ action: 'online' });
    });
  });
});

self.addEventListener('offline', () => {
  console.log('[SW] Conexión perdida');
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ action: 'offline' });
    });
  });
});

console.log('[SW] Service Worker Pedidos HEPA v3.0 cargado y listo');
