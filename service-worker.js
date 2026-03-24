// Service Worker for PWA

self.addEventListener('install', (event) => {
    console.log('Service Worker installing...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activating...');
});

self.addEventListener('fetch', (event) => {
    // Network-first strategy for API calls
    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
    }
    // Cache-first strategy for static assets
    else {
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    return response || fetch(event.request);
                })
        );
    }
});

self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-wallet-data') {
        event.waitUntil(syncWalletData());
    }
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            data: data,
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});

async function syncWalletData() {
    // Background sync logic for wallet data
    console.log('Syncing wallet data...');
    // Your wallet syncing logic
}


// Comprehensive logging
self.addEventListener('error', (event) => {
    console.error('Service Worker error:', event);
});