// Service worker do painel Def Commerce.
// Estratégia "rede primeiro": com internet, sempre a versão mais nova; sem
// internet, a última versão guardada do painel abre e avisa que está offline.
// Respostas da API e imagens de lojas nunca são guardadas.
const CACHE = "def-painel-v1";
const SHELL = [
  "/painel",
  "/css/app.css",
  "/css/painel.css",
  "/js/common.js",
  "/js/painel.js",
  "/favicon.svg",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("def-painel-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function handled(url, request) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (request.mode === "navigate") return url.pathname === "/painel" || url.pathname === "/painel/";
  return SHELL.includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!handled(url, event.request)) return;
  const key = event.request.mode === "navigate" ? "/painel" : url.pathname;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)));
        }
        return response;
      })
      .catch(() => caches.match(key).then((cached) => cached || Response.error())),
  );
});
