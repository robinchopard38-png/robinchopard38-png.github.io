/*
  pont-shim.js — Ajouté par sw.js en tête de chaque page du tonneau ouverte depuis
  la page du parc (/t/<id>/...).

  Les pages du tonneau ouvrent un WebSocket vers ws://<tonneau>/ws?sections=...
  À distance, il n'y a pas de connexion directe : ce WebSocket est remplacé par
  un « WebSocket relayé » qui passe par la page du parc (window.top.__pont),
  elle-même reliée au tonneau par MQTT. Les pages ne voient aucune différence
  (onopen, onmessage, onclose, onerror, addEventListener).
*/
(function(){
  'use strict';
  var m = /^\/t\/([A-Za-z0-9_-]{1,40})\//.exec(location.pathname);
  if (!m) return;
  var id = m[1];
  var pont = null;
  try{ pont = window.top.__pont; }catch(e){}
  if (!pont) return;

  function WebSocketRelaye(url){
    var cible = new EventTarget();
    var soi = this;
    var sections = '';
    try{ sections = new URL(url, location.href).searchParams.get('sections') || ''; }catch(e){}
    this.url = String(url);
    this.readyState = 0;
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    this.binaryType = 'blob';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.addEventListener = function(t, f, o){ cible.addEventListener(t, f, o); };
    this.removeEventListener = function(t, f, o){ cible.removeEventListener(t, f, o); };
    this.dispatchEvent = function(e){ return cible.dispatchEvent(e); };

    function emettre(type, ev){
      try{ if (typeof soi['on' + type] === 'function') soi['on' + type].call(soi, ev); }catch(e){ setTimeout(function(){ throw e; }); }
      try{ cible.dispatchEvent(ev); }catch(e){}
    }

    // Appelé par la page du parc
    var rappels = {
      ouvert: function(){
        if (soi.readyState !== 0) return;
        soi.readyState = 1;
        emettre('open', new Event('open'));
      },
      message: function(texte){
        if (soi.readyState !== 1) return;
        emettre('message', new MessageEvent('message', { data: texte }));
      },
      ferme: function(){
        if (soi.readyState === 3) return;
        soi.readyState = 3;
        emettre('close', new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
      }
    };
    var poignee = pont.ouvrirWs(id, sections, rappels);
    this.send = function(){ /* l'appli n'envoie rien par WebSocket */ };
    this.close = function(){
      if (soi.readyState >= 2) return;
      soi.readyState = 2;
      pont.fermerWs(id, poignee);
      setTimeout(function(){
        soi.readyState = 3;
        emettre('close', new CloseEvent('close', { code: 1000, reason: '', wasClean: true }));
      }, 0);
    };
    // Page quittée (cadre fermé, réglage changé) : le tonneau est prévenu.
    window.addEventListener('pagehide', function(){ if (soi.readyState < 2) pont.fermerWs(id, poignee); });
  }
  WebSocketRelaye.CONNECTING = WebSocketRelaye.prototype.CONNECTING = 0;
  WebSocketRelaye.OPEN = WebSocketRelaye.prototype.OPEN = 1;
  WebSocketRelaye.CLOSING = WebSocketRelaye.prototype.CLOSING = 2;
  WebSocketRelaye.CLOSED = WebSocketRelaye.prototype.CLOSED = 3;
  window.WebSocket = WebSocketRelaye;
})();
