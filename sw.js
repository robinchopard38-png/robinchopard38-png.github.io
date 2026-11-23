/*
  sw.js — Relais de l'appli du tonneau ouverte à distance.

  La page du parc affiche l'appli d'un tonneau dans un cadre, à l'adresse
  /t/<id>/ (ex. /t/t-8e07e4/). Ce service worker intercepte TOUTES les
  requêtes de ce cadre (pages, scripts, logos, /api/...) et les fait passer
  par la page du parc, qui les envoie au tonneau par MQTT (voir __pont dans
  index.html). Pour l'appli, tout se passe comme sur tonneau.local.

  - /t/<id>/xxx            -> /xxx sur le tonneau <id>
  - /api/..., /logos/...   -> idem, quand la requête vient d'une page /t/<id>/
  - /pont-shim.js, /sw.js, et toute autre adresse : réseau normal (GitHub Pages)
  Dans les pages HTML du tonneau, on ajoute /pont-shim.js (WebSocket relayé).
*/
'use strict';

const DELAI_MS = 35000;            // requête sans réponse : abandon
const CACHE_LOGOS = 'logos-v1';    // logos gardés 24 h (comme sur le tonneau : max-age=86400)
const DUREE_CACHE_LOGOS_MS = 24 * 3600 * 1000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function tonneauDeChemin(chemin){
  const m = /^\/t\/([A-Za-z0-9_-]{1,40})(\/.*)?$/.exec(chemin);
  return m ? { id: m[1], chemin: m[2] || '/' } : null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;               // polices Google, unpkg… : réseau
  if (url.pathname === '/pont-shim.js' || url.pathname === '/sw.js') return;
  const direct = tonneauDeChemin(url.pathname);
  if (direct){ event.respondWith(relayer(event.request, direct.id, direct.chemin + url.search)); return; }
  // Adresse absolue (/api/..., /logos/...) demandée par une page du tonneau
  if (!event.clientId) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId);
    const origine = client ? tonneauDeChemin(new URL(client.url).pathname) : null;
    if (!origine) return fetch(event.request);
    return relayer(event.request, origine.id, url.pathname + url.search);
  })());
});

async function relayer(requete, id, chemin){
  const methode = requete.method.toUpperCase();
  const estLogo = methode === 'GET' && chemin.startsWith('/logos/');
  if (estLogo){
    const enCache = await lireCache(id, chemin);
    if (enCache) return enCache;
  }
  const entetes = {};
  ['content-type', 'x-jeton', 'x-admin-code'].forEach(n => {
    const v = requete.headers.get(n);
    if (v) entetes[n.replace(/(^|-)([a-z])/g, (_, s, c) => s + c.toUpperCase())] = v;
  });
  let corps = null;
  if (methode !== 'GET' && methode !== 'HEAD'){
    const tampon = await requete.arrayBuffer();
    if (tampon.byteLength) corps = tampon;
  }
  let r;
  try{
    r = await demanderAuParc({ id, m: methode, u: chemin, h: entetes, corps });
  }catch(e){
    return pageErreur(503, String(e && e.message || e));
  }
  let contenu = r.corps;
  const type = r.type || 'application/octet-stream';
  if (/^text\/html/i.test(type)) contenu = adapterHtml(new TextDecoder().decode(contenu));
  const reponse = new Response(contenu, { status: r.statut, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  if (estLogo && r.statut === 200) ecrireCache(id, chemin, reponse.clone(), type);
  return reponse;
}

// Ajoute le relais WebSocket en tête de chaque page du tonneau. L'appli
// refuse de démarrer « dans un cadre » : ici le cadre est voulu (page du parc),
// seule une page du tonneau dans une page du tonneau compte.
function adapterHtml(html){
  const injection = '<script src="/pont-shim.js"></script>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + injection) : injection + html;
  return html.replace('dansUnCadre = window.self !== window.top', 'dansUnCadre = window.parent !== window.top');
}

// La page du parc (fenêtre principale, adresse "/") fait le travail MQTT.
async function demanderAuParc(demande){
  const fenetres = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter(c => c.frameType !== 'nested' && /^\/(index\.html)?$/.test(new URL(c.url).pathname));
  if (!fenetres.length) throw new Error('Page du parc fermée');
  let derniere = 'Tonneau injoignable';
  for (const fenetre of fenetres){
    const r = await new Promise((resoudre) => {
      const canal = new MessageChannel();
      const minuteur = setTimeout(() => resoudre({ erreur: 'Le tonneau ne répond pas (délai dépassé)' }), DELAI_MS);
      canal.port1.onmessage = (ev) => { clearTimeout(minuteur); resoudre(ev.data); };
      fenetre.postMessage({ type: 'pont-requete', demande }, [canal.port2]);
    });
    if (!r.erreur) return r;
    derniere = r.erreur;
    if (!r.essayerAutre) break;
  }
  throw new Error(derniere);
}

function pageErreur(statut, message){
  const html = `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;background:#0a0908;color:#f2ece0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px">
<div><p style="font-size:18px;margin:0 0 8px">Tonneau injoignable</p><p style="color:#b9b0a0;font-size:14px;margin:0">${String(message).replace(/[<&>]/g, '')}</p></div>`;
  return new Response(html, { status: statut, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function lireCache(id, chemin){
  try{
    const cache = await caches.open(CACHE_LOGOS);
    const r = await cache.match('/cache/' + id + chemin);
    if (!r) return null;
    if (Date.now() - Number(r.headers.get('X-Mis-En-Cache') || 0) > DUREE_CACHE_LOGOS_MS){ cache.delete('/cache/' + id + chemin); return null; }
    return r;
  }catch(e){ return null; }
}
async function ecrireCache(id, chemin, reponse, type){
  try{
    const corps = await reponse.arrayBuffer();
    const cache = await caches.open(CACHE_LOGOS);
    await cache.put('/cache/' + id + chemin, new Response(corps, { headers: { 'Content-Type': type, 'X-Mis-En-Cache': String(Date.now()) } }));
  }catch(e){}
}
