/* Service worker — GAJ CAVA
   Rend la page utilisable hors-ligne sur le terrain (entrepôt, zones
   sans réseau) : l'app-shell (index.html) est mise en cache et servie
   instantanément depuis un onglet de navigateur classique, avec mise
   à jour silencieuse en arrière-plan dès qu'une connexion est
   disponible. Aucune installation d'application : pas de manifeste,
   pas d'icône ajoutée à l'appareil, pas d'invite « Installer ». */
"use strict";
var CACHE_VERSION = "gaj-cava-v2";
var APP_SHELL = ["./", "./index.html"];

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
