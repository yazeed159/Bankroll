window.__loadPeerJS = function(){
  return new Promise(function(resolve,reject){
    if(typeof window.Peer === "function") return resolve(window.Peer);
    var srcs=["https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js","https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"];
    var i=0;
    function next(){
      if(typeof window.Peer === "function") return resolve(window.Peer);
      if(i>=srcs.length) return reject(new Error("PeerJS could not be loaded. Check your internet connection or browser extensions."));
      var sc=document.createElement("script"); sc.src=srcs[i++]; sc.async=true;
      sc.onload=function(){ if(typeof window.Peer === "function") resolve(window.Peer); else next(); };
      sc.onerror=next; document.head.appendChild(sc);
    }
    next();
  });
};
