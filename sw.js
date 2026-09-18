/* Service worker — GAJ CAVA
   Rend l'application utilisable hors-ligne sur le terrain (entrepôt,
   zones sans réseau) : l'app-shell (index.html, manifest, icônes) est
   mise en cache et servie instantanément, avec mise à jour silencieuse
   en arrière-plan dès qu'une connexion est disponible. */
"use strict";
var CACHE_VERSION = "gaj-cava-v1";
var APP_SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function notifyClients(msg) {
  self.clients.matchAll({ type: "window" }).then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  });
}

/* Stale-while-revalidate : réponse instantanée depuis le cache (fonctionne
   hors-ligne), puis rafraîchissement silencieux en tâche de fond. L'appli
   est prévenue (postMessage "gaj-update-ready") si une nouvelle version a
   été récupérée, pour proposer un rechargement à l'utilisateur. */
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.ok) {
            var isAppShell = req.mode === "navigate" || APP_SHELL.some(function (p) { return url.pathname.endsWith(p.replace("./", "")); });
            if (isAppShell) {
              cache.put(req, res.clone());
              if (cached) notifyClients({ type: "gaj-update-ready" });
            }
          }
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});
