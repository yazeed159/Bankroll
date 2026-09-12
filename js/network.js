/* ============================================================
   BANKROLL — ONLINE 8-PLAYER MODE
   Host-authoritative PeerJS room. Up to 8 separate screens/devices.

   Split out of game.js so the networking layer isn't tangled up with
   board/rules/UI code in one giant file. This is plain global script
   (not a module) on purpose, same as every other file here — it must
   load AFTER game.js in index.html, since everything inside relies on
   game.js's top-level `let`/`const`/`function` state (players, tiles,
   rollDice, etc.) already being in scope by the time this IIFE runs.
   ============================================================ */
(function(){
'use strict';
const NET={online:false,host:false,peer:null,roomCode:'',ready:false,assignedId:null,conns:new Map(),peerToPlayer:new Map(),activeIds:['p1'],syncTimer:null,lastStateSig:'',started:false,intentional:false,requestedColor:null,colorWasTaken:false,spectators:new Map(),isSpectator:false,rejoinTokens:new Map(),myRejoinToken:null,
  disconnects:new Map(), // host-only: pid -> pending setTimeout handle for the reconnect grace window
  ownPid:'p1', // which seat THIS device plays as when it is (or becomes) the host — normally 'p1' for whoever first created the room, but a host promoted mid-game via migration keeps whatever seat it already had
  roster:{}, // pid -> peerId for every currently-connected seated player (host's own seat included); broadcast with every state sync so guests can find/replace a host that disappears
  hostPeerId:null, // guest-only: peer id of whoever we currently treat as host (updated on migration handoff)
  migrating:false, migrateTimer:null, migrateDeadline:0 // guest-side: mid-migration bookkeeping while waiting to see whether a new host takes over
};
// exposed globally — a few functions outside this module (e.g. openPowerCards,
// which needs to know if the local user is a spectator) reference NET too, and
// this IIFE would otherwise keep it entirely private to code declared inside it.
window.NET = NET;
const DISCONNECT_GRACE_MS = 30000; // how long a mid-game seat is held open for its player to reconnect before the game gives up on them
const MIGRATION_WAIT_MS = 12000; // how long a guest waits for a replacement host to appear before giving up and returning to the menu
let __lobbyKnownActive = null; // guest-side "who was in the lobby last sync" snapshot — see restoreState()
const original={};
const ACTIONS=['rollDice','payBail','changeCarLobby','changeNameLobby','setReadyLobby','useJailFreeCard','useShieldCard','useSharedShieldCard','useRentDoublerCard','usePooledPaydayCard','useHighRiseHustleCard','resolveTeleportTo','useFreezeCard','resolveSabotageTo','useSwapCard','usePropertySwapCard','cancelPropertySwapPick','resolvePropertySwapPick','propertySwapBack','resolveStealCardPick','relayCard','buyDecision','buyoutDecision','playerEndTurn','borrowLoan','repayLoan','buildHouse','sellHouse','toggleMortgage','buyoutFromManage','buyoutFromInfo','acceptTrade','declineTrade','auctionBid','auctionPass','startOwnAuction','startCardAuction','startCombinedAuction','placeSideBet','cancelSideBet','toggleWantsRematch'];
/* ---- menu navigation: host can end the game for everyone, guests can leave for themselves ---- */
function updateMenuBtnLabel(){
  const el=document.getElementById('menuBtnLabel');
  if(!el)return;
  el.textContent=(NET.online&&!NET.host)?'Leave game':'End game';
}
window.confirmBackToMenu=confirmBackToMenu;
window.updateMenuBtnLabel=updateMenuBtnLabel;
function confirmBackToMenu(){
  if(NET.online&&NET.host){
    if(NET.started) openConfirm('End game for everyone?','This immediately ends the game for all connected players and sends everyone back to the main menu.',endGameForAll,'Yes, end game');
    else openConfirm('Close this lobby?','Everyone who joined will be disconnected and the room code will stop working.',endGameForAll,'Yes, close lobby');
  }else if(NET.online&&!NET.host){
    if(NET.started) openConfirm('Leave this game?','You\'ll return to the main menu. The other players can keep playing without you.',leaveToMenuSelf,'Yes, leave');
    else openConfirm('Leave this lobby?','You\'ll return to the main menu.',leaveToMenuSelf,'Yes, leave');
  }else if(document.getElementById('lobbySection').style.display!=='none'){
    // offline (local test) lobby, not yet started — nothing to "end" yet
    openConfirm('Leave lobby?','You\'ll return to the main menu.',()=>{showStartOverlay();},'Yes, leave');
  }else{
    openConfirm('Back to menu?','This will end the current game.',()=>{showStartOverlay();},'Yes, back to menu');
  }
}
function endGameForAll(){
  if(NET.online&&NET.host){
    NET.conns.forEach(c=>{try{if(c.open)c.send({type:'ended'});}catch(e){}});
  }
  showStartOverlay();
}
/* "Play again" from the game-over screen — takes the whole room back to the SAME
   pre-game lobby (still connected, still the same room code) instead of the "End
   game" flow above, which tears the room down entirely. Host-only: everyone else
   just waits for the host to trigger this, the same as they wait for the host to
   press "Continue to board" the first time around.
   Deliberately does NOT touch NET.conns/NET.peer at all — connections are left
   exactly as they are. It only resets the round-specific game state (nobody's
   ready yet, no game in progress) and lets the normal state-sync path carry that
   to every guest: restoreState() already shows the lobby screen whenever it sees
   started:false (that's also how a guest who's mid-join sees the lobby before the
   host has started anything), so simply broadcasting started:false here is enough
   — no new message type needed. */
function returnToLobbyForAll(){
  if(NET.online && !NET.host) return; // only the host can restart the room for everyone
  setAutoPlayEnabled(false);
  closeGameOverSummary();
  if(auction){ if(auction.interval) clearInterval(auction.interval); auction=null; document.getElementById('auctionOverlay').classList.remove('show'); }
  clearTurnTimerTimeout(); stopTurnTimerVisual();
  hideCardDraw();
  gameOver=false; gameWinnerId=null; gameWinnerIds=[];
  pendingBuy=null; pendingBuyout=null; pendingDebt=null; propertySwapPick=null; stealCardPick=null;
  awaitingEndTurn=false; busy=false;
  activeTrades=[]; sideBets=[];
  if(NET.online){
    PLAYER_IDS.forEach(pid=>{ if(players[pid]){ players[pid].ready=false; players[pid].wantsRematch=false; } }); // everyone — host included — re-confirms readiness, and the rematch vote resets for next time
    NET.started=false;
    enterLobbyUI();
    if(NET.host) sendState();
  } else {
    // local/offline test: "Play again" jumps straight into a fresh game rather
    // than back through the lobby — name/car were already locked in for this
    // session when the lobby ran at startLocalTest(), no need to redo that.
    beginGame();
  }
}
// exposed globally — the "Play again" button's inline onclick lives in the page HTML,
// outside this module, so without this it would throw a bare ReferenceError just like
// renderLobbyPlayers would above.
window.returnToLobbyForAll = returnToLobbyForAll;
/* Lets a non-host player signal "I'm in for another round" from the game-over screen —
   purely a vote/indicator, it never moves anyone off this screen by itself. The host
   still has to click their own "Play again" (returnToLobbyForAll) to actually restart
   the room; this just gives them a live headcount to go on. Registered in ACTIONS so a
   guest's click runs authoritatively on the host (same routing every other guest action
   uses) and then rides the normal state sync back out to everyone, including the guest
   who clicked. */
function toggleWantsRematch(){
  const pid = youAre;
  if(!players[pid]) return;
  players[pid].wantsRematch = !players[pid].wantsRematch;
  refreshGameOverRematchUI();
}
window.toggleWantsRematch = toggleWantsRematch;
function leaveToMenuSelf(){
  showStartOverlay();
}
function ensureNetUI(){const top=document.querySelector('.topbar .you-are');if(top&&!document.getElementById('netStatus')){const b=document.createElement('span');b.id='netStatus';b.style.cssText='margin-left:10px;font-size:10.5px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;color:var(--text-dim);white-space:nowrap';b.textContent='Offline';top.appendChild(b);}}
function showMigrateBanner(text){const b=document.getElementById('migrateBanner');if(!b)return;b.textContent=text;b.classList.add('show');}
function hideMigrateBanner(){const b=document.getElementById('migrateBanner');if(b)b.classList.remove('show');}
// Ticks every second, purely cosmetic: keeps each disconnected-but-still-in-grace
// player's card badge showing a live "Reconnecting… Ns" countdown. Reads
// players[pid].reconnecting/discDeadline, which are ordinary synced state fields —
// this runs identically on the host and on every guest, no network calls involved.
function tickDisconnectBadges(){
  PLAYER_IDS.forEach(pid=>{
    const p=players[pid]; const badge=document.getElementById('discBadge-'+pid); const card=document.getElementById('card-'+pid);
    const kickBtn=document.getElementById('discKick-'+pid);
    if(!badge||!card) return;
    if(p&&p.reconnecting){
      const secsLeft=Math.max(0,Math.ceil((p.discDeadline-Date.now())/1000));
      badge.textContent='Reconnecting… '+secsLeft+'s';
      badge.classList.add('show');
      card.classList.add('is-reconnecting');
      // only the host can boot a stuck seat early, and only someone else's seat —
      // a guest watching another guest's badge, or the host's own reflection of
      // itself (which never actually shows this state), never gets the button
      if(kickBtn){ if(NET.host && pid!==NET.ownPid) kickBtn.classList.add('show'); else kickBtn.classList.remove('show'); }
    } else {
      badge.classList.remove('show');
      card.classList.remove('is-reconnecting');
      if(kickBtn) kickBtn.classList.remove('show');
    }
  });
}
setInterval(tickDisconnectBadges,1000);
function setNetStatus(t,ok){
  ensureNetUI();
  const e=document.getElementById('netStatus');
  if(e){e.textContent=t;e.style.color=ok?'var(--cyan)':'var(--text-dim)';e.style.borderColor=ok?'rgba(79,216,224,.35)':'var(--line)';}
  // #netStatus lives inside #gameRoot, which is hidden for the entire
  // create-room/join/lobby flow — mirror the same text somewhere actually
  // visible on the start screen, or "Connecting to host…" etc. never appears.
  const l=document.getElementById('lobbyNetStatus');
  if(l){
    if(t==='Offline'){l.style.display='none';}
    else{l.style.display='';l.textContent=t;l.style.color=ok?'var(--cyan)':'var(--text-dim)';}
  }
}
function disconnectNet(){
  // Mark this teardown as deliberate BEFORE closing anything — closing our own
  // PeerJS connections fires the same 'close' event a genuine drop would, and
  // those handlers used to treat every close as "lost connection to host" and
  // pop an alert even when the person just clicked Leave/End game themselves.
  NET.intentional=true;
  if(NET.syncTimer){clearInterval(NET.syncTimer);NET.syncTimer=null;}
  NET.conns.forEach(c=>{try{c.close()}catch(e){}});
  NET.conns.clear();
  if(NET.peer){try{NET.peer.destroy()}catch(e){}}
  NET.online=false;NET.host=false;NET.peer=null;NET.roomCode='';NET.ready=false;NET.assignedId=null;
  NET.peerToPlayer.clear();NET.activeIds=['p1'];NET.lastStateSig='';NET.started=false;NET.requestedColor=null;NET.colorWasTaken=false;
  NET.spectators.clear();NET.isSpectator=false;NET.rejoinTokens.clear();NET.myRejoinToken=null;
  NET.disconnects.forEach(t=>clearTimeout(t)); NET.disconnects.clear(); NET.ownPid='p1'; NET.roster={}; NET.hostPeerId=null;
  NET.migrating=false; if(NET.migrateTimer){clearTimeout(NET.migrateTimer);NET.migrateTimer=null;} NET.migrateDeadline=0;
  hideMigrateBanner();
  document.body.classList.remove('spectator-mode');
  const specBtn=document.getElementById('spectatorsBtn'); if(specBtn)specBtn.style.display='none';
  const specPanel=document.getElementById('spectatorsPanel'); if(specPanel)specPanel.style.display='none';
  __lobbyKnownActive = null;
}
/* ---- lobby (waiting room): shown from room-create/join until the host presses
   "Start game", so nobody gets pulled onto the board while others are still
   picking a name/color or before the host is ready ---- */
function enterLobbyUI(){
  document.getElementById('setupPlayers').style.display='none';
  document.getElementById('startActions').style.display='none';
  document.getElementById('joinDivider').style.display='none';
  document.getElementById('joinRow').style.display='none';
  document.getElementById('rulesBtn').style.display=NET.host?'':'none';
  document.getElementById('lobbySection').style.display='';
  document.getElementById('startCodeOut').style.display=(NET.host&&NET.online)?'block':'none';
  document.getElementById('lobbyStartBtn').style.display=NET.host?'':'none';
  document.getElementById('lobbyWaitingText').style.display=NET.host?'none':'';
  const note=document.getElementById('lobbyColorNote');
  if(note){
    if(!NET.host&&NET.colorWasTaken){note.style.display='';note.textContent="Your chosen car was already taken by another player, so you've been given a different one below.";}
    else note.style.display='none';
  }
  document.getElementById('startOverlay').classList.remove('hide');
  document.getElementById('gameRoot').style.display='none';
  renderLobbyPlayers();
}
window.enterLobbyUI = enterLobbyUI; // harmless to expose even though today's only callers already live inside this module
function exitLobbyUI(){
  document.getElementById('setupPlayers').style.display='';
  document.getElementById('startActions').style.display='';
  document.getElementById('joinDivider').style.display='';
  document.getElementById('joinRow').style.display='';
  document.getElementById('rulesBtn').style.display='';
  document.getElementById('lobbySection').style.display='none';
}
function renderLobbyPlayers(){
  const list=document.getElementById('lobbyList'); if(!list)return;
  const joined=PLAYER_IDS.filter(pid=>players[pid].active);
  if(!joined.length){list.innerHTML='<div class="lobby-empty">No one has joined yet.</div>';updateLobbyStartBtnState();return;}
  // only the host, and only while actually running an online room, can remove
  // someone else from the lobby — a local/offline setup has no one to kick
  const canKick = NET.host && NET.online;
  // team pairing is a host-only call too (local or online) — guests just see
  // whatever team badge the host has assigned them
  const canAssignTeam = NET.host;
  // rebuilding the own-name <input> from scratch on every render (host syncs land
  // every ~300ms, plus any lobby action re-renders this whole list) would yank
  // focus/caret away mid-keystroke — snapshot it here and restore it after the
  // innerHTML swap below.
  const nameInputHadFocus = document.activeElement && document.activeElement.id==='lobbyNameInput';
  const savedCaret = nameInputHadFocus ? document.activeElement.selectionStart : null;
  list.innerHTML=joined.map(pid=>{
    const p=players[pid];
    const isYou = pid===youAre;
    let tags='';
    if(pid==='p1')tags+='<span class="lobby-tag">Host</span>';
    if(isYou)tags+='<span class="lobby-tag you">You</span>';
    if(!isYou)tags+=`<span class="lobby-tag ${p.ready?'ready':''}">${p.ready?'Ready':'Not ready'}</span>`;
    const kickBtn = (canKick && pid!=='p1')
      ? `<button class="lobby-kick-btn" title="Remove ${escapeHtml(p.name)}" onclick="confirmKickPlayer('${pid}')">&times;</button>`
      : '';
    let teamCtl='';
    if(CONFIG.teamsEnabled){
      if(canAssignTeam){
        const opts=['',...TEAM_LETTERS].map(t=>`<option value="${t}" ${(p.team||'')===t?'selected':''}>${t?('Team '+t):'No team'}</option>`).join('');
        teamCtl=`<select class="lobby-team-select" title="Assign ${escapeHtml(p.name)} to a team" onchange="setPlayerTeam('${pid}',this.value)">${opts}</select>`;
      } else if(p.team){
        teamCtl=`<span class="lobby-tag" style="color:var(--gold);border-color:var(--gold);">Team ${p.team}</span>`;
      }
    }
    // your own row gets a live-editable name field (instead of plain text) and a
    // Ready toggle; everyone else just sees a name + the "Not ready"/"Ready" badge
    // above, updated live as it syncs in.
    const nameHtml = isYou
      ? `<input type="text" class="chat-input lobby-name-input" id="lobbyNameInput" style="flex:1;min-width:0;padding:6px 10px;font-size:13px;" value="${escapeHtml(p.name)}" maxlength="16" placeholder="${escapeHtml((PLAYER_DEFAULTS[PLAYER_IDS.indexOf(pid)]||[''])[0])}" ${p.ready?'disabled':''} oninput="changeNameLobby('${pid}',this.value)">`
      : `<span class="lobby-player-name">${escapeHtml(p.name)}</span>`;
    const readyBtn = (isYou && NET.online)
      ? `<button type="button" class="action-pill ${p.ready?'danger':''}" style="flex-shrink:0;padding:6px 12px;font-size:10.5px;margin-left:6px;" onclick="setReadyLobby('${pid}',${p.ready?'false':'true'})">${p.ready?'Not ready':'Ready'}</button>`
      : '';
    // for your own row, show a live car picker — every other active player's
    // car is disabled/grayed so it's obvious at a glance what's actually free,
    // instead of silently getting reassigned a car after the fact (see the
    // colorWasTaken note above enterLobbyUI, which now only covers the initial
    // pre-join clash — this covers everything after, live, as people join).
    // Locked (all buttons disabled) once you've marked yourself ready, mirroring
    // changeCarLobby's own guard, so your identity can't drift after you've told
    // everyone else you're set.
    const carRowHtml = isYou ? `<div class="car-pick-row" id="carPickRow" data-pid="${pid}"></div>` : '';
    return `<div class="lobby-player-row">${kickBtn}<div class="lobby-player-top"><span class="lobby-player-dot" style="background:${p.color}"></span>${nameHtml}${readyBtn}</div><div class="lobby-player-meta">${tags}${teamCtl}</div>${carRowHtml}</div>`;
  }).join('');
  syncCarPickRow();
  if(nameInputHadFocus){
    const el=document.getElementById('lobbyNameInput');
    if(el){ el.focus(); if(savedCaret!=null){ try{ el.setSelectionRange(savedCaret,savedCaret); }catch(e){} } }
  }
  updateLobbyStartBtnState();
}
/* The car picker's <model-viewer> elements load a full 3D model each, and
   renderLobbyPlayers() used to rebuild them from raw HTML on every single
   call — which happens on every keystroke while typing your name AND on
   every ~300ms host sync tick while the lobby is open. That meant the whole
   row of 3D cars was tearing down and reloading from scratch continuously:
   visible flicker, wasted bandwidth re-fetching the same models, and a
   generally "unstable" feeling lobby. Now the row's markup (including the
   model-viewer tags) is built exactly once; every later render just patches
   the disabled/selected/title state of the existing buttons in place and
   never touches the model-viewer nodes themselves, so they load once and
   stay put for the rest of the lobby session. */
function syncCarPickRow(){
  const row = document.getElementById('carPickRow');
  if(!row) return;
  const pid = row.dataset.pid;
  const p = players[pid];
  if(!p){ row.innerHTML=''; return; }
  if(row.dataset.builtFor !== pid || row.childElementCount===0){
    row.dataset.builtFor = pid;
    row.innerHTML = CAR_LIST.map(({key,label})=>
      `<button type="button" class="car-pick" data-car="${key}" onclick="changeCarLobby('${pid}','${key}')"><model-viewer class="car-pick-mv" src="${CAR_MODELS[key]}" disable-zoom interaction-prompt="none" camera-orbit="-35deg 72deg auto" field-of-view="28deg" exposure="1.2" environment-image="neutral" loading="eager"></model-viewer><span class="car-pick-label">${label}</span></button>`
    ).join('');
  }
  row.querySelectorAll('.car-pick').forEach(btn=>{
    const key = btn.dataset.car;
    const isMine = p.car===key;
    const takenByOther = PLAYER_IDS.some(x=>x!==pid && players[x] && players[x].active && players[x].car===key);
    const disabled = p.ready || (!isMine&&takenByOther);
    const title = p.ready ? 'Press "Not ready" to change cars' : ((!isMine&&takenByOther) ? `Already taken by ${escapeHtml((PLAYER_IDS.map(x=>players[x]).find(o=>o.active&&o.car===key)||{}).name||'another player')}` : '');
    btn.classList.toggle('selected', isMine);
    if(disabled){ btn.setAttribute('disabled',''); btn.setAttribute('title',title); }
    else{ btn.removeAttribute('disabled'); if(title) btn.setAttribute('title',title); else btn.removeAttribute('title'); }
  });
}
// exposed globally — code declared outside this module (changeCarLobby,
// changeNameLobby, setReadyLobby, and the rules-menu save handler's live
// team-picker refresh) all call this directly to keep the lobby list current;
// without this it's only reachable from inside this IIFE and those calls would
// throw a bare ReferenceError.
window.renderLobbyPlayers = renderLobbyPlayers;
/* host-only: greys out/disables the Start button and shows a live ready-count
   note until every currently-joined player (host included) has pressed Ready —
   guests never see this button at all (see enterLobbyUI). */
function updateLobbyStartBtnState(){
  const btn=document.getElementById('lobbyStartBtn'); if(!btn||!NET.host)return;
  // local test (see startLocalTest) is always solo and offline — there's no
  // one else to wait on, so pressing "Ready" on yourself would just be a
  // pointless extra click before every single test game. Skip the gate
  // entirely whenever we're not actually online; real hosted rooms (NET.online)
  // still require everyone, including the host, to ready up as before.
  if(!NET.online){
    btn.disabled=false; btn.style.opacity=''; btn.style.cursor='';
    const note=document.getElementById('lobbyReadyNote'); if(note) note.style.display='none';
    return;
  }
  const activeIds=PLAYER_IDS.filter(pid=>players[pid].active);
  const readyCount=activeIds.filter(pid=>players[pid].ready).length;
  const allReady=activeIds.length>0 && readyCount===activeIds.length;
  btn.disabled=!allReady;
  btn.style.opacity=allReady?'':'.5';
  btn.style.cursor=allReady?'':'not-allowed';
  const note=document.getElementById('lobbyReadyNote');
  if(note){
    if(allReady){ note.style.display='none'; }
    else { note.style.display=''; note.textContent=`Waiting for everyone to be ready (${readyCount}/${activeIds.length})…`; }
  }
}
/* host-only: pair (or unpair) a lobby player into an alliance — mirrors kickPlayer's
   pattern of the host mutating shared state directly and letting the normal state
   sync (or a local re-render) carry it to everyone else */
function setPlayerTeam(pid, teamLetter){
  if(!NET.host || !players[pid]) return;
  players[pid].team = teamLetter || null;
  renderLobbyPlayers();
  if(NET.online) sendState();
}
window.setPlayerTeam = setPlayerTeam; // called from the lobby's team <select onchange="...">, which resolves in global scope
/* ---- host: remove a player from the room, whether still in the lobby or
   already mid-game — mirrors what happens when a guest disconnects on their
   own, just triggered by the host instead of a dropped connection ---- */
window.confirmKickPlayer=confirmKickPlayer;
function confirmKickPlayer(pid){
  if(!NET.host || pid===NET.ownPid || !players[pid]) return;
  openConfirm(
    'Remove this player?',
    `${players[pid].name} will be disconnected and can rejoin later with the room code.`,
    ()=>kickPlayer(pid),
    'Yes, remove'
  );
}
function kickPlayer(pid){
  if(!NET.host || pid===NET.ownPid || !players[pid]) return;
  let peerId=null;
  for(const [pk,pv] of NET.peerToPlayer){ if(pv===pid){peerId=pk;break;} }
  const conn=peerId?NET.conns.get(peerId):null;
  if(conn){
    try{ if(conn.open) conn.send({type:'kicked'}); }catch(e){}
    // conn's own 'close' handler (in setupHostPeer) already does the full
    // cleanup — freeing the slot, fixing up turn order, re-rendering — so just
    // closing it here is enough to reuse that same path instead of duplicating it.
    try{ conn.close(); }catch(e){}
    return;
  }
  // No live connection to close — this seat is already sitting out its
  // disconnect grace window (see setupHostPeer's conn.on('close')), waiting to
  // see if the player reconnects on their own. The host doesn't want to sit
  // through that timer, so finalize the removal right now instead — same end
  // state (seat freed, turn order fixed up, debt resolved) as letting the
  // timer run out, just without the wait. Their rejoin token is left intact,
  // same as a live kick, so "can rejoin later with the room code" holds either way.
  if(players[pid].reconnecting){
    if(NET.disconnects.has(pid)){ clearTimeout(NET.disconnects.get(pid)); NET.disconnects.delete(pid); }
    finalizeDisconnect(pid,true);
  }
}
// Fires once a disconnected mid-game seat's grace period (DISCONNECT_GRACE_MS)
// runs out without them reconnecting — this is the old "drop them for good" logic
// that used to run immediately on disconnect, now deferred until the grace window
// actually expires. A no-op if they already reconnected (reconnectPlayer clears
// `reconnecting` and cancels this timer) or the host tore the room down first.
function finalizeDisconnect(pid,kicked){
  if(!NET.host || !players[pid] || !players[pid].reconnecting) return;
  NET.disconnects.delete(pid);
  players[pid].reconnecting=false; players[pid].discDeadline=0;
  if(isDebtor(pid)){
    // They disconnected mid-debt (see the matching check in setupHostPeer's
    // conn.on('close'), which deliberately left the turn paused on them instead
    // of advancing) and never made it back to raise the cash. Route through the
    // real bankruptcy path rather than just clearing pendingDebt by hand — it's
    // the only thing that correctly unfreezes `busy`, forfeits their properties
    // to the right place, and fixes up turn order in one already-tested place.
    doBankrupt(pid, pendingDebt.creditorId);
  }
  players[pid].active=false;
  const activeIdx=NET.activeIds.indexOf(pid);
  if(activeIdx!==-1)NET.activeIds.splice(activeIdx,1);
  if(order.includes(pid)&&!players[pid].bankrupt){
    const removedAt=order.indexOf(pid),wasCurrent=removedAt===turnIdx;
    order.splice(removedAt,1);
    if(!order.length)turnIdx=0; else if(wasCurrent)turnIdx=removedAt%order.length; else if(removedAt<turnIdx)turnIdx--; else if(turnIdx>=order.length)turnIdx=0;
    applySkipTurns();
    if(wasCurrent && !gameOver){ busy=false; awaitingEndTurn=false; }
  }
  log(kicked
    ? `<span class="who" style="color:${players[pid].color}">${players[pid].name}</span> was removed by the host.`
    : `<span class="who" style="color:${players[pid].color}">${players[pid].name}</span> didn't reconnect in time and left the game.`);
  renderPlayerCards(); renderLobbyPlayers(); syncTokenVisibility();
  sendState();
}
/* ---- host: manage guests who joined after Start was pressed — they sit as
   spectators (watching live state, no seat, no commands honored — see the
   'hello' handler above) until the host explicitly lets one of them play. ---- */
window.toggleSpectatorsPanel=toggleSpectatorsPanel;
function toggleSpectatorsPanel(){
  const p=document.getElementById('spectatorsPanel'); if(!p)return;
  p.style.display = (p.style.display==='none'||!p.style.display) ? 'flex' : 'none';
}
function renderSpectatorList(){
  const btn=document.getElementById('spectatorsBtn'), label=document.getElementById('spectatorsBtnLabel'), body=document.getElementById('spectatorsPanelBody'), panel=document.getElementById('spectatorsPanel');
  if(!btn||!body)return;
  const n=NET.spectators.size;
  const show = NET.host && NET.online;
  btn.style.display = show ? '' : 'none';
  btn.classList.toggle('has-waiting', show && n>0);
  if(label)label.textContent = `Spectators (${n})`;
  if(!n){
    body.innerHTML='<div class="spectator-empty">No one is waiting to play.</div>';
    if(panel && !show) panel.style.display='none';
    return;
  }
  body.innerHTML=[...NET.spectators.entries()].map(([peerId,info])=>
    `<div class="spectator-row"><span class="spectator-name">${escapeHtml(info.name||'Player')}</span><button class="spectator-allow-btn" onclick="allowSpectatorToPlay('${peerId}')">Let them play</button><button class="spectator-decline-btn" onclick="declineSpectator('${peerId}')">Remove</button></div>`
  ).join('');
}
function allowSpectatorToPlay(peerId){
  if(!NET.host)return;
  const conn=NET.conns.get(peerId), info=NET.spectators.get(peerId);
  if(!conn||!info)return;
  NET.spectators.delete(peerId);
  const pid=assignPlayer(conn,peerId,info);
  if(!pid){ try{conn.send({type:'full'})}catch(e){}; renderSpectatorList(); return; }
  sendState();
  renderSpectatorList();
}
function declineSpectator(peerId){
  if(!NET.host)return;
  const conn=NET.conns.get(peerId);
  NET.spectators.delete(peerId);
  if(conn){ try{conn.send({type:'spectatorDeclined'})}catch(e){}; try{conn.close()}catch(e){} }
  renderSpectatorList();
}
// Called whenever we return to the main menu (leaving/ending a game, or losing
// connection). Without this, a player who joined a previous online game stayed
// marked "active" forever, so the next local or hosted game would start with
// leftover ghost players still occupying seats and showing on the board.
function resetToMenuState(){
  unwireTeamBalances(); // drop any shared-bank getters from the finished game before plain balances get reassigned below
  sideBets = []; // any wagers left mid-air from the finished game shouldn't carry into the next one
  // clear the roll-up counter's memory so the next game's cards paint their
  // starting balances instantly instead of animating down from wherever the
  // last game left off
  Object.keys(balRollFrames).forEach(id=>{ if(balRollFrames[id]) cancelAnimationFrame(balRollFrames[id]); });
  Object.keys(balRollDebounce).forEach(id=>{ if(balRollDebounce[id]) clearTimeout(balRollDebounce[id]); });
  Object.keys(balRollState).forEach(id=>delete balRollState[id]);
  Object.keys(balRollFrames).forEach(id=>delete balRollFrames[id]);
  Object.keys(balRollDebounce).forEach(id=>delete balRollDebounce[id]);
  CONFIG.teamsEnabled = false; // alliances are a per-game choice — the next game starts with teams off until re-enabled
  PLAYER_IDS.forEach((id,i)=>{
    players[id].team = null;
    if(id==='p1')return;
    const car=CAR_LIST[i%CAR_LIST.length].key;
    players[id].active=false;
    players[id].name=PLAYER_DEFAULTS[i][0];
    players[id].car=car;
    players[id].color=colorForCar(car);
    players[id].balance=1500;
    players[id].bankrupt=false;
    players[id].pos=0;
    PLAYER_SETUP[id]={name:'',color:colorForCar(car),car};
  });
  order=[];
  youAre='p1';
  exitLobbyUI();
  setNetStatus('Offline',false);
}
/* ---- short, human-friendly room codes ----
   PeerJS defaults to a random UUID as the peer id, which made the shareable
   "room code" a long unreadable string. Instead the host claims a short
   5-character code (letters/digits only, no easily-confused 0/O/1/I/L) as
   its actual PeerJS id, so the code people read aloud/type/paste IS the
   connection id — no separate lookup table needed. */
const ROOM_CODE_CHARS='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const ROOM_CODE_LEN=5;
const ROOM_ID_PREFIX='bkrl-';
function randomRoomCode(){let s='';for(let i=0;i<ROOM_CODE_LEN;i++)s+=ROOM_CODE_CHARS[Math.floor(Math.random()*ROOM_CODE_CHARS.length)];return s;}
function roomCodeToPeerId(code){return ROOM_ID_PREFIX+String(code).toLowerCase();}
// Used only for the rare post-host-migration case, where the newly-promoted
// host is reusing its own already-open (auto-generated, non-short) peer id
// rather than claiming a fresh short code — see becomeNewHostAfterMigration.
function makeRoomCode(id){return id;}
function parseRoomCode(code){
  const raw=String(code||'').trim();
  if(!raw) return null;
  const legacy=raw.match(/^SKY8\|(.+)$/i); // old long-form codes from earlier builds
  if(legacy) return legacy[1];
  const cleaned=raw.replace(/[\s-]/g,'');
  if(/^[A-Za-z0-9]{4,8}$/.test(cleaned)) return roomCodeToPeerId(cleaned);
  return raw.includes(' ')?null:raw; // fallback: treat as a literal peer id (e.g. a migration code)
}
/* ---- rejoin tokens: let a guest whose connection drops get their own seat (and
   balance/properties/position, untouched) back instead of being treated as a brand
   new joiner. The host hands out a fresh one-time token with every 'welcome' and
   keeps a token->pid map alive across disconnects (cleared only when the room itself
   resets); the guest persists its latest token per-host in localStorage so it
   survives even a page reload, and offers it back on the next 'hello'. ---- */
function makeRejoinToken(){return Math.random().toString(36).slice(2)+Date.now().toString(36)+Math.random().toString(36).slice(2);}
function rejoinStorageKey(hostId){return 'pt_rejoin_'+hostId;}
function saveRejoinToken(hostId,token){NET.myRejoinToken=token;try{localStorage.setItem(rejoinStorageKey(hostId),token);}catch(e){}}
function loadRejoinToken(hostId){try{return localStorage.getItem(rejoinStorageKey(hostId))||null;}catch(e){return null;}}
function serializeState(includeChat){
  const st = {v:3,started:NET.started,CONFIG:JSON.parse(JSON.stringify(CONFIG)),bailoutPot,players:JSON.parse(JSON.stringify(players)),tiles:tiles.map(t=>({owner:t.owner||null,houses:t.houses||0,mortgaged:!!t.mortgaged,frozenTurns:t.frozenTurns||0})),order:order.slice(),turnIdx,busy,turnRollSeq,awaitingEndTurn,pendingBuy,pendingBuyout,pendingDebt:pendingDebt?{pid:pendingDebt.pid,creditorId:pendingDebt.creditorId,resume:pendingDebt.resume}:null,propertySwapPick:propertySwapPick?{pid:propertySwapPick.pid,stage:propertySwapPick.stage,myIdx:propertySwapPick.myIdx}:null,stealCardPick:stealCardPick?{pid:stealCardPick.pid}:null,gameOver,gameWinnerId,gameWinnerIds,netWorthHistory,gameStats,currentRollWasDouble,lastRoll:window.lastRoll||7,lastRollDice:window.lastRollDice||[4,3],cardDraw:cardDraw?{id:cardDraw.id,kind:cardDraw.kind,glyph:cardDraw.glyph,title:cardDraw.title,who:cardDraw.who,text:cardDraw.text,amt:cardDraw.amt}:null,activeTrades:JSON.parse(JSON.stringify(activeTrades)),tradeIdSeq,sideBets:JSON.parse(JSON.stringify(sideBets)),sideBetIdSeq,auction:auction?{items:auction.items.slice(),bids:Object.fromEntries(auction.items.map(idx=>[idx,{currentBid:auction.bids[idx].currentBid,currentBidder:auction.bids[idx].currentBidder,passed:{...auction.bids[idx].passed}}])),seller:auction.seller||null,startBid:auction.startBid,timerSec:auction.timerSec,timeLeft:auction.timeLeft}:null};
  // the chat/history log only grows over the course of a game, so re-reading and re-sending
  // its full HTML on every ~300ms tick (even when nothing chat-related changed) bloats every
  // sync message more and more as a long game goes on — that backlog of oversized snapshots
  // is what was showing up as "laggy, then the car teleports" once the queue finally drained.
  // Only a freshly-joining guest needs the full log (to catch up); everyone already connected
  // gets new lines pushed incrementally instead (see broadcastChatLine below).
  if(includeChat) st.chatHTML = document.getElementById('chatBody')?.innerHTML||'';
  return st;
}
// pid -> peerId for every currently-connected seated player, plus the host's own
// seat under NET.ownPid. Sent with every state sync so guests always have a fresh
// map of who else is in the room and how to reach them directly — see
// attemptHostMigration(), which uses exactly this map to reconnect everyone if the
// host's own connection ever disappears mid-game.
function buildRoster(){
  const r={}; if(NET.peer&&NET.peer.id) r[NET.ownPid]=NET.peer.id;
  NET.peerToPlayer.forEach((pid,peerId)=>{ r[pid]=peerId; });
  return r;
}
function sendState(conn){if(!NET.host)return;const msg={type:'state',state:serializeState(),roster:buildRoster()};if(conn){try{conn.send(msg)}catch(e){}}else NET.conns.forEach(c=>{if(c.open)try{c.send(msg)}catch(e){}});}
// pushed immediately whenever the host logs a new line, instead of waiting for the
// next periodic sync — keeps chat feeling live without bundling it into the state
// snapshot that gets re-diffed and resent every 300ms.
function broadcastChatLine(html){
  if(!NET.host||!NET.online)return;
  const msg={type:'chatLine',html};
  NET.conns.forEach(c=>{if(c.open)try{c.send(msg)}catch(e){}});
}
window.__netBroadcastChatLine=broadcastChatLine;
// Same star-topology push as broadcastChatLine, for the small toast popups — sent
// the instant one fires on the host so every guest's board shows it right away
// instead of waiting for it to ride along on the next periodic state sync.
function broadcastToast(payload){
  if(!NET.host||!NET.online)return;
  const msg={type:'toast',payload};
  NET.conns.forEach(c=>{if(c.open)try{c.send(msg)}catch(e){}});
}
window.__netBroadcastToast=broadcastToast;
// Spectator chat: spectators have no seat/pid, so their messages can't go through
// log()/executeHostCommand's normal "speak as player X" path — this appends a
// clearly-labeled line straight to the host's own log and fans it out the same way
// broadcastChatLine does, without ever touching game state or player actions.
function logSpectatorChat(name,text){
  const chat=document.getElementById('chatBody');
  if(!chat)return;
  const div=document.createElement('div');
  div.className='msg spectator-msg';
  const t=new Date();
  div.innerHTML=`<span class="time">${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}</span><div><span class="log-icon">👁️</span><span class="who">${escapeHtml(name)}</span><span class="spectator-tag">(watching)</span> ${escapeHtml(text)}</div>`;
  chat.appendChild(div);
  chat.scrollTop=chat.scrollHeight;
  broadcastChatLine(div.outerHTML);
}
// Typing indicator relay — same star topology as broadcastChatLine: guests only ever
// talk to the host, so the host is what fans a "typing" signal back out to everyone
// else. excludePeer skips echoing it straight back to whichever guest it came from.
function broadcastTyping(pid,isTyping,excludePeer){
  if(!NET.host||!NET.online)return;
  const msg={type:'typing',pid,typing:isTyping};
  NET.conns.forEach((c,peerId)=>{if(peerId!==excludePeer&&c.open)try{c.send(msg)}catch(e){}});
}
function notifyTyping(isTyping){
  if(!NET.online)return;
  if(NET.host){ broadcastTyping(youAre,isTyping,null); }
  else if(NET.ready){ const c=NET.conns.get('host'); if(c&&c.open)try{c.send({type:'typing',typing:isTyping})}catch(e){} }
}
window.__netNotifyTyping=notifyTyping;
// Reaction emoji relay — same star topology as chat/typing above.
function relayReaction(pid,emoji,excludePeer){
  if(!NET.host||!NET.online)return;
  const msg={type:'reaction',pid,emoji};
  NET.conns.forEach((c,peerId)=>{if(peerId!==excludePeer&&c.open)try{c.send(msg)}catch(e){}});
}
function netSendReaction(emoji){
  if(!NET.online)return;
  if(NET.host){ relayReaction(youAre,emoji,null); }
  else if(NET.ready){ const c=NET.conns.get('host'); if(c&&c.open)try{c.send({type:'reaction',emoji})}catch(e){} }
}
window.__netSendReaction=netSendReaction;
function startHostSync(){if(NET.syncTimer)clearInterval(NET.syncTimer);NET.lastStateSig='';NET.syncTimer=setInterval(()=>{if(!NET.host||!NET.online||!NET.ready)return;const st=serializeState();const sig=JSON.stringify(st);if(sig!==NET.lastStateSig){NET.lastStateSig=sig;sendState();}},300);}
function restoreState(st){if(!st||!(st.v===2||st.v===3))return;NET.executing=true;try{CONFIG={...st.CONFIG};updateSpecialTileVisuals();refreshTileInfoIfOpen();Object.keys(st.players||{}).forEach(id=>{if(players[id])Object.assign(players[id],st.players[id]);});NET.started=!!st.started;if(!NET.started){
  // Host hasn't started the game yet — stay on the lobby screen and just refresh
  // the player list instead of running the (board-only) restore logic below,
  // which is what used to yank guests straight onto the board the instant they
  // connected, before the host had even finished setting things up.
  // Guests only ever see this as periodic full-state syncs (no discrete "someone
  // joined" event like the host gets in assignPlayer/conn.close), so detect the
  // change by diffing against the last snapshot of who was active. The very first
  // sync after connecting just seeds __lobbyKnownActive silently — otherwise
  // everyone already in the room would "join" the moment you yourself connect.
  const __lobbyNowActive = new Set(PLAYER_IDS.filter(pid=>players[pid].active));
  if(__lobbyKnownActive){
    for(const pid of __lobbyNowActive) if(pid!==youAre && !__lobbyKnownActive.has(pid)) playLobbyJoinSound();
    for(const pid of __lobbyKnownActive) if(pid!==youAre && !__lobbyNowActive.has(pid)) playLobbyLeaveSound();
  }
  __lobbyKnownActive = __lobbyNowActive;
  closeGameOverSummary(); // in case the previous game's summary is still open on this screen — e.g. right after the host starts a rematch
  enterLobbyUI();
  return;
}
__lobbyKnownActive = null; // game started — reset so a later rejoin/new lobby starts clean
wireTeamBalances(false); // keep this browser's local getters pointed at whatever pooled figure the host just sent — never re-sum, since a synced balance is already the correct shared total
bailoutPot=Number(st.bailoutPot)||0;updateBailoutPotLabel();const __prevPendingBuyForSound=pendingBuy;const __prevOwnersForPulse=tiles.map(t=>t.owner);st.tiles.forEach((d,i)=>{if(tiles[i]){tiles[i].owner=d.owner;tiles[i].houses=d.houses;tiles[i].mortgaged=d.mortgaged;tiles[i].frozenTurns=Number(d.frozenTurns)||0;}});order=Array.isArray(st.order)?st.order.filter(id=>players[id]?.active&&!players[id].bankrupt):[];turnIdx=Math.max(0,Math.min(Number(st.turnIdx)||0,Math.max(0,order.length-1)));busy=!!st.busy;turnRollSeq=Number(st.turnRollSeq)||0;awaitingEndTurn=!!st.awaitingEndTurn;pendingBuy=st.pendingBuy;pendingBuyout=st.pendingBuyout;pendingDebt=st.pendingDebt||null;propertySwapPick=st.propertySwapPick||null;stealCardPick=st.stealCardPick||null;const __prevGameOverForSound=gameOver;gameOver=!!st.gameOver;gameWinnerId=st.gameWinnerId||null;gameWinnerIds=Array.isArray(st.gameWinnerIds)?st.gameWinnerIds:(gameWinnerId?[gameWinnerId]:[]);if(Array.isArray(st.netWorthHistory))netWorthHistory=st.netWorthHistory;if(st.gameStats)gameStats=st.gameStats;currentRollWasDouble=!!st.currentRollWasDouble;window.lastRoll=st.lastRoll||7;const __syncIsInitial=document.getElementById('gameRoot').style.display==='none';updateGameOverBtn();if(!__syncIsInitial&&!__prevGameOverForSound&&gameOver){playWinSound();spawnConfetti();setTimeout(openGameOverSummary,1000);}if(!__syncIsInitial&&__prevPendingBuyForSound!=null&&pendingBuy==null&&tiles[__prevPendingBuyForSound]&&tiles[__prevPendingBuyForSound].owner)playBuySound();{const rd=Array.isArray(st.lastRollDice)&&st.lastRollDice.length===2?st.lastRollDice:[4,3];const key=rd[0]+','+rd[1];if(key!==__syncedDiceKey){__syncedDiceKey=key;drawDice(rd[0],rd[1]);if(!__syncIsInitial)playDiceSound();}}if(st.cardDraw){if(shownCardDrawId!==st.cardDraw.id){showCardDraw(st.cardDraw);if(!__syncIsInitial){playCardPopupSound();if(st.cardDraw.kind==='jail')playJailSound();else if(st.cardDraw.kind==='debt')playNegativeSound();}}}else if(shownCardDrawId!==null){hideCardDraw();}{const __prevTradeCount=activeTrades.length;activeTrades=Array.isArray(st.activeTrades)?st.activeTrades:[];if(!__syncIsInitial&&activeTrades.length>__prevTradeCount)playTradeSound();}tradeIdSeq=st.tradeIdSeq||1;sideBets=Array.isArray(st.sideBets)?st.sideBets:[];sideBetIdSeq=st.sideBetIdSeq||1;refreshSideBetPanelIfOpen();if(typeof st.chatHTML==='string'){const chat=document.getElementById('chatBody');if(chat){chat.innerHTML=st.chatHTML;chat.scrollTop=chat.scrollHeight;}}const __wasAuctionOpen=!!auction;if(auction&&auction.interval)clearInterval(auction.interval);auction=null;if(st.auction){if(!__wasAuctionOpen&&!__syncIsInitial)playAuctionSound();const a=st.auction;const items=Array.isArray(a.items)?a.items.slice():[];const bids={};items.forEach(idx=>{const b=(a.bids&&a.bids[idx])||{};bids[idx]={currentBid:Number(b.currentBid)||0,currentBidder:b.currentBidder||null,passed:{...(b.passed||{})}};});auction={items,bids,seller:a.seller||null,startBid:Number(a.startBid)||10,timerSec:Number(a.timerSec)||CONFIG.auctionTimerSec,timeLeft:Number(a.timeLeft)||0,onComplete:null,interval:null,remote:true};document.getElementById('auctionOverlay').classList.add('show');renderAuction();auction.interval=setInterval(()=>{if(!auction)return;auction.timeLeft=Math.max(0,auction.timeLeft-1);renderAuction();if(auction.timeLeft>0)playAuctionTickSound(auction.timeLeft<=3);},1000);}else{document.getElementById('auctionOverlay').classList.remove('show');}tiles.forEach((t,i)=>{if(!purchasable(t))return;if(t.owner){markOwnership(i,teamDisplayColor(t.owner));if(!__syncIsInitial&&t.owner!==__prevOwnersForPulse[i])pulseTile(i,teamDisplayColor(t.owner));}else clearOwnershipRing(i);setMortgageVisual(i,!!t.mortgaged);setFrozenVisual(i,t.frozenTurns>0);});PLAYER_IDS.forEach(pid=>{if(!tokenEls[pid])return;const hide=!players[pid].active||players[pid].bankrupt;tokenEls[pid].style.display=hide?'none':'';if(hide){remoteAnimPos[pid]=players[pid].pos;if(remoteAnimTimers[pid]){clearTimeout(remoteAnimTimers[pid]);remoteAnimTimers[pid]=null;}return;}glideTokenRemote(pid,players[pid].pos);});document.getElementById('startOverlay').classList.add('hide');const gameRootEl=document.getElementById('gameRoot');const firstReveal=gameRootEl.style.display==='none';gameRootEl.style.display='';if(firstReveal){
  // #gameRoot was display:none until just now, so text/board measurements taken before
  // this point were all against a 0x0 layout — redo them, and only on this first reveal.
  // This used to run on every restoreState() (i.e. on every single state sync from the
  // host, which happens after nearly every action), so resetView() kept yanking back
  // any pan/zoom a player had set up mid-game — the view "reset itself" constantly.
  fitAllTileLabels();resetView();
}renderPlayerCards();refreshPlayerVisuals();updateTradesTabCount();renderTradesList();refreshUI();syncPendingPanels();setOnlineControls();}finally{NET.executing=false;}}
function setOnlineControls(){
  const yn=document.getElementById('youAreName');
  if(yn)yn.textContent=NET.isSpectator?'(spectating — waiting for host)':(players[youAre]?.name||'Player');
  document.body.classList.toggle('spectator-mode',!!(NET.online&&!NET.host&&NET.isSpectator));
  const ci=document.getElementById('chatInput');
  if(ci)ci.placeholder=(NET.online&&!NET.host&&NET.isSpectator)?'Chat as a spectator…':'Send a message…';
  if(NET.host)renderSpectatorList();
  updateMenuBtnLabel();refreshUI();
}
function executeHostCommand(msg,fromPid){if(!NET.host||!msg||msg.type!=='cmd')return;const name=msg.name,args=Array.isArray(msg.args)?msg.args:[];const oldYou=youAre;youAre=fromPid;NET.executing=true;window.__netImpersonating=true;try{if(name==='sendChat'){const input=document.getElementById('chatInput');const old=input.value;input.value=String(args[0]||'');original.sendChat();input.value=old;}else if(name==='sendTrade'){const payload=args[0]||{};const a=fromPid,b=payload.b;tradeOffer={a,b,sides:{}};tradeOffer.sides[a]={cash:Number(payload.sa?.cash)||0,props:new Set(payload.sa?.props||[]),cards:{...(payload.sa?.cards||{})}};tradeOffer.sides[b]={cash:Number(payload.sb?.cash)||0,props:new Set(payload.sb?.props||[]),cards:{...(payload.sb?.cards||{})}};original.sendTrade();}else if(name==='doBankrupt'){original.doBankrupt(fromPid,args[1]);}else if(name==='startOwnAuction'){original.startOwnAuction(fromPid,args[1],args[2],args[3]);}else if(name==='startCardAuction'){original.startCardAuction(fromPid,args[1],args[2],args[3]);}else if(name==='startCombinedAuction'){original.startCombinedAuction(fromPid,args[1],args[2],args[3]);}else if(name==='auctionBid'){original.auctionBid(fromPid,args[1],args[2]);}else if(name==='auctionPass'){original.auctionPass(fromPid,args[1]);}else if(typeof original[name]==='function')original[name](...args);}catch(e){console.error(e)}finally{youAre=oldYou;NET.executing=false;window.__netImpersonating=false;
  // the action we just ran (e.g. the guest ending their turn) painted the UI while
  // youAre was temporarily swapped to the guest's id — now that it's restored to the
  // host's own identity, repaint once more so the host's screen reflects whose turn
  // it actually is, instead of sitting stale until something else (like clicking a
  // player card) happens to trigger a refresh.
  refreshUI();
}sendState();}
function sendCommand(name,args,retriesLeft){if(!NET.online||NET.host)return false;
  const msg={type:'cmd',name,args:Array.isArray(args)?args:[]};
  const c=NET.conns.values().next().value;
  // NET.ready flips true the instant our data channel opens (see setupGuestPeer),
  // which can still land a beat before the channel is actually ready to send, or
  // before a reconnect after a brief drop has fully settled. Previously any send
  // attempted in that window was just dropped with no feedback and no retry — from
  // the lobby that looked exactly like "pressing ready did nothing." Retry a few
  // times on a short delay instead of giving up on the first miss.
  if(!NET.ready || !c?.open){
    const left = retriesLeft==null ? 5 : retriesLeft;
    if(left>0) setTimeout(()=>sendCommand(name,args,left-1), 250);
    else setNetStatus('Connection lost',false);
    return false;
  }
  try{c.send(msg);return true}catch(e){
    const left = retriesLeft==null ? 5 : retriesLeft;
    if(left>0){ setTimeout(()=>sendCommand(name,args,left-1), 250); return false; }
    setNetStatus('Connection lost',false); return false;
  }
}
function assignPlayer(conn,peerId,info){
  const used=new Set([NET.ownPid,...NET.peerToPlayer.values()]);
  const pid=PLAYER_IDS.find(x=>!used.has(x));
  if(!pid)return null;
  NET.peerToPlayer.set(peerId,pid);
  NET.conns.set(peerId,conn);
  NET.activeIds.push(pid);
  // Rebuilding `order` from NET.activeIds is only safe before the host has clicked
  // "Continue to board" — beginGame() re-derives `order` from scratch anyway once
  // that happens. A join AFTER the game is already running must not replace the
  // whole array: `turnIdx` is a plain index into it, so swapping it out for a
  // differently-ordered/sized array silently hands the current turn to a different
  // player. Fold the newcomer onto the end of the existing rotation instead.
  const midGame = NET.started;
  if(midGame){
    if(!order.includes(pid)) order.push(pid);
  } else {
    order = NET.activeIds.slice();
  }
  players[pid].active=true;
  players[pid].balance=CONFIG.startingCash;
  players[pid].bankrupt=false;
  players[pid].pos=0;
  players[pid].skipNextTurn=false;
  // fresh join always starts unready — a seat that was previously kicked/vacated
  // must never hand its new occupant someone else's leftover "ready" state, and a
  // just-joined player hasn't actually confirmed anything yet.
  players[pid].ready=false;
  // Apply the joining player's requested name/color BEFORE anything is broadcast
  // about them — the 'welcome' message below hands them back their own player
  // object, so if we sent it first (with the slot's still-default name/color)
  // their own client would lock in the wrong identity from the start.
  players[pid].name=sanitizeName((info&&info.name)||players[pid].name)||players[pid].name;
  // Cars are now exclusive: with exactly 8 cars and 8 player slots, every
  // joiner can always get one nobody else currently has. If their requested
  // car is invalid or already driven by another active player, hand them the
  // first car nobody's using instead — CAR_LIST.length === PLAYER_IDS.length
  // guarantees one is free (this pid isn't active yet, so at most 7 others
  // can be holding a car when we get here).
  const takenCars=new Set(PLAYER_IDS.filter(x=>x!==pid&&players[x]&&players[x].active).map(x=>players[x].car));
  const requestedCar=info&&info.car;
  const requestedCarOk=CAR_LIST.some(c=>c.key===requestedCar)&&!takenCars.has(requestedCar);
  players[pid].car = requestedCarOk ? requestedCar : (CAR_LIST.find(c=>!takenCars.has(c.key))||CAR_LIST[0]).key;
  players[pid].color=colorForCar(players[pid].car);
  // applyPlayerIdentity() normally re-derives name/color from PLAYER_SETUP, which
  // has no entry for a remote guest — sync it first so it doesn't stomp what we
  // just set back to the slot's defaults.
  PLAYER_SETUP[pid]={name:players[pid].name,color:players[pid].color,car:players[pid].car||CAR_LIST[PLAYER_IDS.indexOf(pid)%CAR_LIST.length].key};
  applyPlayerIdentity();
  renderLobbyPlayers(); // keep the host's own lobby list live as people join
  if(!midGame) playLobbyJoinSound(); // pre-game only — a mid-game reconnect isn't a "lobby" event
  if(midGame){
    // otherwise the host's own screen never learns to show this player's car —
    // syncTokenVisibility() is normally only called from beginGame() / a disconnect
    syncTokenVisibility();
    const c=tileEls[0];
    if(c) setTokenPos(pid, c.x, c.y-4, {instant:true, pos:0});
  }
  const rejoinToken=issueRejoinToken(pid);
  conn.send({type:'welcome',pid,player:players[pid],state:serializeState(true),rejoinToken,roster:buildRoster()});
  return pid;
}
// Hands pid a fresh one-time rejoin token, discarding any older one that pointed
// at the same seat (a stale token must never be able to resurrect a seat that's
// since been reassigned by a new fresh join).
function issueRejoinToken(pid){
  for(const [tok,p] of NET.rejoinTokens){ if(p===pid) NET.rejoinTokens.delete(tok); }
  const token=makeRejoinToken();
  NET.rejoinTokens.set(token,pid);
  return token;
}
// A peer offering a rejoin token gets their old seat back — with balance,
// properties, and board position exactly as they left them — instead of being
// dropped into the spectator queue or handed a fresh seat. Only honored when that
// seat is actually empty right now (nobody's currently connected to it); a token
// for a seat someone else already reconnected to (or that's still live) is ignored.
function reconnectPlayer(conn,peerId,pid,info){
  if(NET.disconnects.has(pid)){ clearTimeout(NET.disconnects.get(pid)); NET.disconnects.delete(pid); }
  players[pid].reconnecting=false; players[pid].discDeadline=0;
  NET.peerToPlayer.set(peerId,pid);
  NET.conns.set(peerId,conn);
  if(!NET.activeIds.includes(pid))NET.activeIds.push(pid);
  players[pid].active=true;
  players[pid].name=sanitizeName((info&&info.name)||players[pid].name)||players[pid].name;
  // a reconnect that lands back in the lobby (game never actually started) should
  // require re-confirming ready, same as any fresh join — otherwise a stale ready
  // flag from before the drop could let the game start without them noticing.
  if(!NET.started) players[pid].ready=false;
  PLAYER_SETUP[pid]={name:players[pid].name,color:players[pid].color,car:players[pid].car};
  applyPlayerIdentity();
  renderLobbyPlayers();
  if(NET.started){
    if(!order.includes(pid))order.push(pid);
    syncTokenVisibility();
    placeTokenInstant(pid,players[pid].pos,false);
    log(`<span class="who" style="color:${players[pid].color}">${players[pid].name}</span> reconnected.`);
  } else {
    order=NET.activeIds.slice();
    playLobbyJoinSound();
  }
  const rejoinToken=issueRejoinToken(pid);
  conn.send({type:'welcome',pid,player:players[pid],state:serializeState(true),rejoinToken,roster:buildRoster()});
  return pid;
}
// Wires the standard host<->seated-peer message protocol onto a DataConnection —
// shared by the normal "someone joined my room" path (peer.on('connection') below)
// and by a promoted host reattaching to already-known seats after a host migration
// (see becomeNewHostAfterMigration). Everything before a connection exists differs
// between those two callers; this covers what's identical once one does.
function wireHostConnection(conn){
  conn.on('data',msg=>{
    if(msg?.type==='hello'){
      // Reconnect attempt: if this peer is holding a still-valid token for a
      // seat that's currently empty (its previous connection dropped and
      // nobody else has since taken/reclaimed it), restore them to that exact
      // seat — balance, properties and position untouched — instead of running
      // them through the spectator/new-seat logic below.
      const rejoinPid=msg.rejoinToken?NET.rejoinTokens.get(msg.rejoinToken):null;
      const seatIsFree=rejoinPid&&players[rejoinPid]&&!players[rejoinPid].active&&![...NET.peerToPlayer.values()].includes(rejoinPid);
      if(rejoinPid)NET.rejoinTokens.delete(msg.rejoinToken); // one-time use either way
      if(seatIsFree){
        reconnectPlayer(conn,conn.peer,rejoinPid,msg.info||{});
        sendState();
        setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true);
        return;
      }
      // A join that arrives after the host has already pressed Start is not
      // handed a seat automatically — that used to let anyone spam-join mid
      // game, collect a fresh CONFIG.startingCash balance, trade it all onto
      // an accomplice, then disconnect and repeat, pumping free money into the
      // game. Now a mid-game joiner only spectates (they still get the live
      // state so they can watch) until the host explicitly lets them play.
      if(NET.started){
        NET.spectators.set(conn.peer,{name:sanitizeName((msg.info&&msg.info.name)||'')||'Player',car:(msg.info&&msg.info.car)||null});
        try{conn.send({type:'spectating',state:serializeState(true),roster:buildRoster()})}catch(e){}
        renderSpectatorList();
        setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true);
        return;
      }
      const pid=assignPlayer(conn,conn.peer,msg.info||{});
      if(!pid){try{conn.send({type:'full'})}catch(e){};return;}
      sendState();
      setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true);
    } else if(msg?.type==='typing'){
      const pid=NET.peerToPlayer.get(conn.peer);
      if(!pid)return; // spectators have no seat to speak from
      updateTypingIndicator(pid,!!msg.typing);
      broadcastTyping(pid,!!msg.typing,conn.peer); // fan out to every other guest too
    } else if(msg?.type==='reaction'){
      const pid=NET.peerToPlayer.get(conn.peer);
      if(!pid)return; // spectators have no seat to speak from
      if(REACTION_EMOJIS.includes(msg.emoji)){
        spawnReactionPopup(pid,msg.emoji);
        relayReaction(pid,msg.emoji,conn.peer); // fan out to every other guest too
      }
    } else if(msg?.type==='spectatorChat'){
      // Only a peer the host currently has recorded as a spectator gets to use
      // this path — a seated player always speaks through the normal 'cmd'
      // sendChat below, tagged with their own name/color, not this one.
      const info=NET.spectators.get(conn.peer);
      if(!info)return;
      const text=String(msg.text||'').replace(/[<>]/g,'').trim().slice(0,240);
      if(!text)return;
      logSpectatorChat(info.name||'Spectator',text);
    } else {
      // Note the lack of a "||'p1'" fallback here (there used to be one): a
      // peer with no assigned seat — i.e. a spectator — must never have its
      // commands silently attributed to the host's own player. If they're not
      // in peerToPlayer, drop whatever they sent instead of running it as p1.
      const pid=NET.peerToPlayer.get(conn.peer);
      if(!pid)return;
      executeHostCommand(msg,pid);
    }
  });
  conn.on('close',()=>{
    const pid=NET.peerToPlayer.get(conn.peer);
    NET.conns.delete(conn.peer); NET.peerToPlayer.delete(conn.peer);
    if(NET.spectators.has(conn.peer)){ NET.spectators.delete(conn.peer); renderSpectatorList(); }
    if(pid && players[pid]){
      updateTypingIndicator(pid,false); // don't leave a stale "typing…" for someone who just left
      if(!NET.started){
        // Pre-game (lobby): no grace period — a lobby seat is cheap to lose and
        // easy to rejoin, so drop it immediately like before.
        playLobbyLeaveSound();
        players[pid].active=false;
        const activeIdx=NET.activeIds.indexOf(pid);
        if(activeIdx!==-1)NET.activeIds.splice(activeIdx,1);
        renderPlayerCards(); renderLobbyPlayers(); syncTokenVisibility();
      } else if(!players[pid].reconnecting){
        // Mid-game: hold the seat open instead of silently vanishing them — a
        // dropped wifi connection or an accidentally-closed tab shouldn't cost a
        // player their spot. Everyone else sees a "reconnecting…" badge and a
        // countdown (see tickDisconnectBadges) instead of the token just freezing
        // with no explanation.
        players[pid].reconnecting=true;
        players[pid].discDeadline=Date.now()+DISCONNECT_GRACE_MS;
        log(`<span class="who" style="color:${players[pid].color}">${players[pid].name}</span> lost connection — holding their seat for ${Math.round(DISCONNECT_GRACE_MS/1000)}s.`);
        if(order.includes(pid) && order[turnIdx]===pid && !gameOver){
          // it was their turn — don't leave everyone else stuck waiting on a
          // dropped connection; pass play on immediately. applySkipTurns() will
          // keep hopping over this seat on every future lap for as long as
          // they're still reconnecting, and drop back into normal rotation the
          // instant they do.
          //
          // EXCEPT if they're mid-debt (isDebtor): `busy` stays true for as long as
          // pendingDebt is unresolved, and nothing except tryResumeAfterDebt() or
          // doBankrupt() ever clears it — advancing the turn out from under them
          // here would leave `busy` stuck true forever, since neither of those is
          // ever going to fire for a player who just left. That freezes rollDice()
          // for literally everyone, permanently, for the rest of the game. So leave
          // the turn paused on them instead (same as it already would be for any
          // debtor who's merely gone quiet) — finalizeDisconnect() below forces a
          // real bankruptcy through the normal path if they don't make it back,
          // which is what actually clears busy/pendingDebt correctly.
          if(!isDebtor(pid)){
            awaitingEndTurn=false; pendingBuy=null; pendingBuyout=null;
            advanceTurn();
          }
        }
        const timer=setTimeout(()=>finalizeDisconnect(pid),DISCONNECT_GRACE_MS);
        NET.disconnects.set(pid,timer);
        renderPlayerCards();
      }
    }
    sendState(); setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true);
  });
  conn.on('error',()=>{});
}
async function setupHostPeer(){
  disconnectNet(); NET.intentional=false; NET.host=true; NET.online=true; NET.activeIds=['p1']; setNetStatus('Loading online connection…',false);
  try{
    const PeerCtor=await window.__loadPeerJS();
    claimHostPeer(PeerCtor,0);
  }catch(e){
    console.error(e); NET.online=false; NET.host=false; NET.ready=false;
    setNetStatus('PeerJS unavailable',false);
    alert('Online multiplayer could not start.\n\n'+(e?.message||e));
  }
}
// Claims a short room code as the host's actual PeerJS id. Short codes are
// cheap to guess-collide with someone else's in-progress room (or, in rare
// cases, an unrelated PeerJS app sharing the same public broker), so a
// handful of attempts with a freshly-rolled code covers that before giving
// up and showing a real error.
const ROOM_CODE_MAX_ATTEMPTS=6;
function claimHostPeer(PeerCtor,attempt){
  setNetStatus('Creating room…',false);
  const code=randomRoomCode();
  const peer=new PeerCtor(roomCodeToPeerId(code)); NET.peer=peer;
  let opened=false, retrying=false;
  const timeout=setTimeout(()=>{
    if(!opened&&!retrying){
      try{peer.destroy();}catch(e){}
      NET.peer=null; NET.online=false; NET.host=false; NET.ready=false;
      setNetStatus('Could not create room — check internet',false);
      alert('The online connection could not be created. Make sure the browser has internet access and that PeerJS is not blocked by an extension/firewall.');
    }
  },15000);
  peer.on('open',id=>{
    opened=true; clearTimeout(timeout);
    NET.roomCode=code; NET.ready=true;
    applyPlayerIdentity(); // lock in the host's own typed name/color before the lobby list renders it
    const f=document.getElementById('startCodeField'); if(f)f.value=NET.roomCode;
    const l=document.getElementById('startCodeLabel'); if(l)l.textContent='Room code';
    enterLobbyUI();
    setNetStatus('Room ready • 1/8',true);
    startHostSync();
  });
  peer.on('connection',conn=>{
    if(NET.conns.size>=7){try{conn.close()}catch(e){};return;}
    NET.conns.set(conn.peer,conn);
    conn.on('open',()=>setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true));
    wireHostConnection(conn);
  });
  peer.on('error',e=>{
    console.error('PeerJS error:',e);
    if(!opened&&e?.type==='unavailable-id'&&attempt<ROOM_CODE_MAX_ATTEMPTS){
      retrying=true; clearTimeout(timeout);
      try{peer.destroy();}catch(err){}
      claimHostPeer(PeerCtor,attempt+1);
      return;
    }
    clearTimeout(timeout);
    setNetStatus(`Room error: ${e?.type||'connection failed'}`,false);
    if(!opened){NET.online=false;NET.host=false;NET.ready=false;}
  });
  peer.on('disconnected',()=>setNetStatus('Signaling server disconnected',false));
  peer.on('close',()=>{if(opened)setNetStatus('Room closed',false);});
}
// Deterministic so every remaining guest reaches the same answer independently with
// zero coordination: sort every pid the dying host's last-known roster told us about
// (excluding the dead host's own seat) into a stable order, lowest pid first. Ties
// can't happen — pids are unique.
function pickMigrationOrder(deadHostPid){
  return Object.keys(NET.roster||{})
    .filter(pid=>pid!==deadHostPid)
    .sort((a,b)=>PLAYER_IDS.indexOf(a)-PLAYER_IDS.indexOf(b));
}
// Fires when a guest's connection to the current host disappears unexpectedly
// mid-game. Rather than immediately declaring the room dead, everyone still
// connected checks the last roster the (now-gone) host broadcast and elects a
// replacement: the lowest-ranked candidate takes over almost immediately, and each
// later-ranked candidate is staggered a few seconds behind as a fallback in case a
// lower-ranked one has also dropped. Every other guest just waits for either an
// incoming connection from whoever wins, or the whole thing to time out.
function attemptHostMigration(deadHostId){
  if(NET.intentional) return; // a deliberate Leave/End — never migrate away from that
  if(!NET.started || !NET.roster || Object.keys(NET.roster).length<2){
    // Either still in the lobby, or nobody else is known to fail over to — there's
    // no room left to save, so fall back to the plain "lost the host" experience.
    alert('Lost connection to the host.');
    showStartOverlay();
    return;
  }
  const deadHostPid=Object.keys(NET.roster).find(pid=>NET.roster[pid]===deadHostId)||'p1';
  const candidates=pickMigrationOrder(deadHostPid);
  const myPid=NET.assignedId;
  const myRank=candidates.indexOf(myPid);
  if(myPid===null||myRank===-1){ alert('Lost connection to the host.'); showStartOverlay(); return; }
  NET.migrating=true;
  showMigrateBanner(myRank===0 ? 'Host disconnected — taking over hosting…' : 'Host disconnected — waiting for a new host…');
  setNetStatus('Host disconnected — migrating…',false);
  setTimeout(()=>becomeNewHostAfterMigration(deadHostPid), myRank===0 ? 300 : myRank*4000);
  NET.migrateDeadline=Date.now()+MIGRATION_WAIT_MS;
  NET.migrateTimer=setTimeout(()=>{
    if(NET.migrating){
      NET.migrating=false;
      hideMigrateBanner();
      alert("Lost connection to the host and no one else could take over. Returning to the menu.");
      showStartOverlay();
    }
  },MIGRATION_WAIT_MS);
}
// Promotes THIS client to host, in place — no reset, no new room. players/order/
// turnIdx/etc. are already live locally (kept current by the last several state
// syncs from the old host), so "becoming host" mid-migration is really just: start
// accepting/making connections and start being the one who broadcasts sendState().
// Reuses this device's own already-open PeerJS peer — no new peer id is needed for
// the promoted device itself, only for the guests it reaches back out to.
function becomeNewHostAfterMigration(deadHostPid){
  if(!NET.migrating) return; // already resolved — someone else got there first, or we gave up
  NET.migrating=false;
  if(NET.migrateTimer){clearTimeout(NET.migrateTimer);NET.migrateTimer=null;}
  const myPid=NET.assignedId;
  const oldRoster=NET.roster||{};
  NET.host=true; NET.online=true; NET.ready=true;
  NET.ownPid=myPid; NET.assignedId=null; NET.isSpectator=false;
  NET.conns.delete('host');
  NET.peerToPlayer.clear(); NET.rejoinTokens.clear();
  NET.roomCode=makeRoomCode(NET.peer.id);
  applyPlayerIdentity();
  log(`<span class="who" style="color:${players[myPid].color}">${players[myPid].name}</span> is now hosting — the previous host disconnected.`);
  showMigrateBanner('You are now the host — reconnecting the room…');
  setNetStatus('Reconnecting room as host…',true);
  // Reach out directly to every other seat the old host last told us about —
  // nobody needs a new room code for this: PeerJS lets any peer connect to any
  // other peer it already has the id for, and the roster (broadcast with every
  // state sync) is exactly that list of ids.
  let pending=0;
  Object.keys(oldRoster).forEach(pid=>{
    if(pid===myPid||pid===deadHostPid||!players[pid]||!players[pid].active) return;
    const peerId=oldRoster[pid];
    if(!peerId) return;
    pending++;
    NET.peerToPlayer.set(peerId,pid);
    const conn=NET.peer.connect(peerId,{reliable:true});
    NET.conns.set(peerId,conn);
    conn.on('open',()=>{
      const rejoinToken=issueRejoinToken(pid);
      try{conn.send({type:'welcome',pid,player:players[pid],state:serializeState(true),rejoinToken,roster:buildRoster(),migrated:true})}catch(e){}
      setNetStatus(`Connected • ${Math.min(8,NET.conns.size+1)}/8`,true);
    });
    wireHostConnection(conn);
  });
  startHostSync();
  sendState();
  // The old host's own seat never went through a conn.on('close') handler — that
  // mechanism only exists for GUEST connections into the host, and the old host
  // obviously wasn't one. Without this, if it was the old host's own turn when
  // they dropped, nobody would ever be prompted to skip it: their seat would just
  // sit "active" and un-flagged forever, freezing the game on their turn for
  // everyone else, permanently, with no countdown and no path to recovery short
  // of them somehow finding their way back into a room whose code has already
  // changed. Give their seat the exact same disconnect-grace treatment any other
  // dropped player gets, now that this client has taken over enforcing it.
  if(players[deadHostPid] && players[deadHostPid].active && !players[deadHostPid].bankrupt && !players[deadHostPid].reconnecting){
    players[deadHostPid].reconnecting = true;
    players[deadHostPid].discDeadline = Date.now() + DISCONNECT_GRACE_MS;
    log(`<span class="who" style="color:${players[deadHostPid].color}">${players[deadHostPid].name}</span> lost connection — holding their seat for ${Math.round(DISCONNECT_GRACE_MS/1000)}s.`);
    if(order.includes(deadHostPid) && order[turnIdx]===deadHostPid && !gameOver && !isDebtor(deadHostPid)){
      // see the matching comment in setupHostPeer's conn.on('close') for why a
      // debtor is deliberately left paused here rather than advanced past
      awaitingEndTurn=false; pendingBuy=null; pendingBuyout=null;
      advanceTurn();
    }
    const deadHostTimer=setTimeout(()=>finalizeDisconnect(deadHostPid),DISCONNECT_GRACE_MS);
    NET.disconnects.set(deadHostPid,deadHostTimer);
    renderPlayerCards();
    sendState();
  }
  setTimeout(hideMigrateBanner,2500);
}
// Wires the standard guest<->host message protocol onto a DataConnection — shared
// by the initial "connect to the room code" path and by a migration handoff (a
// promoted host reaching out to us directly once our old host disappears).
function wireGuestHostConnection(conn){
  conn.on('data',msg=>{
    if(msg?.type==='welcome'){
      const wasMigration=!!msg.migrated;
      NET.assignedId=msg.pid;youAre=msg.pid;NET.isSpectator=false;
      PLAYER_SETUP[msg.pid]={name:msg.player.name,color:msg.player.color,car:msg.player.car};
      NET.colorWasTaken=!!(NET.requestedColor&&msg.player.color!==NET.requestedColor);
      if(msg.roster) NET.roster=msg.roster;
      NET.hostPeerId=conn.peer;
      if(msg.rejoinToken)saveRejoinToken(conn.peer,msg.rejoinToken); // hang onto it in case *this* connection later drops
      restoreState(msg.state);setOnlineControls();
      hideMigrateBanner();
      setNetStatus(wasMigration?'Reconnected • new host':'Connected • in game',true);
    }
    else if(msg?.type==='spectating'){
      NET.assignedId=null;youAre='p1';NET.isSpectator=true;
      if(msg.roster) NET.roster=msg.roster;
      NET.hostPeerId=conn.peer;
      restoreState(msg.state);setOnlineControls();setNetStatus('Connected • spectating',true);
    }
    else if(msg?.type==='spectatorDeclined'){
      setNetStatus('Removed by host',false);alert('The host removed you from the room.');showStartOverlay();
    }
    else if(msg?.type==='state'){ if(msg.roster) NET.roster=msg.roster; restoreState(msg.state); }
    else if(msg?.type==='chatLine'){
      const chat=document.getElementById('chatBody');
      if(chat){ chat.insertAdjacentHTML('beforeend', msg.html); chat.scrollTop = chat.scrollHeight; }
    }
    else if(msg?.type==='toast'){ showToast(msg.payload); }
    else if(msg?.type==='typing'){ updateTypingIndicator(msg.pid,!!msg.typing); }
    else if(msg?.type==='reaction'){ if(REACTION_EMOJIS.includes(msg.emoji)) spawnReactionPopup(msg.pid,msg.emoji); }
    else if(msg?.type==='full'){ setNetStatus('Room is full (8/8)',false); }
    else if(msg?.type==='ended'){ setNetStatus('Host ended the game',false);alert('The host ended the game.');showStartOverlay(); }
    else if(msg?.type==='kicked'){ setNetStatus('Removed by host',false);alert('The host removed you from the room.');showStartOverlay(); }
  });
  conn.on('close',()=>{
    NET.ready=false;
    if(NET.intentional) return; // a deliberate Leave/End — stay silent, no migration
    if(NET.migrating) return; // a handoff is already in flight via a different path
    setNetStatus('Host disconnected',false);
    attemptHostMigration(conn.peer);
  });
  conn.on('error',e=>{console.error(e);});
}
async function setupGuestPeer(hostId){
  disconnectNet(); NET.intentional=false; NET.host=false; NET.online=true; setNetStatus('Loading online connection…',false);
  try{
    const PeerCtor=await window.__loadPeerJS();
    setNetStatus('Connecting to host…',false);
    const peer=new PeerCtor(); NET.peer=peer;
    NET.hostPeerId=hostId;
    const timeout=setTimeout(()=>{try{peer.destroy()}catch(e){};setNetStatus('Connection timed out',false);alert('Could not connect to the host. Check the room code and internet connection.');},15000);
    peer.on('open',()=>{
      const c=peer.connect(hostId,{reliable:true}); NET.conns.set('host',c);
      c.on('open',()=>{
        clearTimeout(timeout); NET.ready=true;
        NET.requestedColor=PLAYER_SETUP.p1?.color||null;
        const savedToken=loadRejoinToken(hostId);
        c.send({type:'hello',info:{name:(PLAYER_SETUP.p1?.name||'').trim()||'Player',color:PLAYER_SETUP.p1?.color,car:PLAYER_SETUP.p1?.car},rejoinToken:savedToken});
        setNetStatus('Connected • waiting for player slot',true);
      });
      wireGuestHostConnection(c);
      c.on('error',e=>{clearTimeout(timeout);setNetStatus('Connection error',false);console.error(e);});
    });
    // This only ever fires later, mid-game, if a fellow guest gets promoted to host
    // after our original host disappears (see attemptHostMigration /
    // becomeNewHostAfterMigration) — a promoted host reaches out to every seat it
    // last knew about using exactly the peer id we're already listening on, so no
    // new room code or fresh join is needed for the handoff to complete.
    peer.on('connection',conn=>{
      NET.migrating=false;
      if(NET.migrateTimer){clearTimeout(NET.migrateTimer);NET.migrateTimer=null;}
      NET.conns.set('host',conn);
      wireGuestHostConnection(conn);
    });
    peer.on('error',e=>{clearTimeout(timeout);console.error(e);setNetStatus(`Join failed: ${e?.type||'connection error'}`,false);});
    peer.on('disconnected',()=>setNetStatus('Signaling server disconnected',false));
  }catch(e){NET.online=false;setNetStatus('PeerJS unavailable',false);alert('Online multiplayer could not start.\n\n'+(e?.message||e));}
}
const originalStartNewGame=window.startNewGame, originalJoin=window.joinWithCode;
ACTIONS.forEach(name=>{original[name]=window[name];window[name]=function(...args){if(NET.online&&!NET.host&&!NET.executing){if(name==='setReadyLobby'||name==='changeCarLobby'||name==='changeNameLobby'){
      // Lobby actions used to ONLY sendCommand() and wait for the host's echo to come
      // back before this guest's own screen showed anything — on a slow/flaky
      // connection that read as "the ready button is stuck" even when it worked fine.
      // Apply it locally right away for instant feedback (original[name] here is the
      // real, unwrapped function — no network call of its own), then still tell the
      // host, whose reply remains authoritative and will correct us if it disagrees.
      original[name](...args);
      sendCommand(name,args);
      return;
    }if(name==='startOwnAuction'){const pid=youAre;const checks=(Array.isArray(args[1])?args[1]:[]).map(Number).filter(Number.isInteger);const startBid=Math.max(10,Number(args[2])||10);const timerSec=Number(args[3])||CONFIG.auctionTimerSec;sendCommand(name,[pid,checks,startBid,timerSec]);return;}if(name==='startCardAuction'){const pid=youAre;const cardType=String(args[1]||'');const startBid=Math.max(10,Number(args[2])||10);const timerSec=Number(args[3])||CONFIG.auctionTimerSec;sendCommand(name,[pid,cardType,startBid,timerSec]);return;}if(name==='startCombinedAuction'){const pid=youAre;const items=(Array.isArray(args[1])?args[1]:[]).map(v=>(typeof v==='string'&&v.indexOf('card:')===0)?v:Number(v)).filter(v=>typeof v==='string'||Number.isInteger(v));const startBid=Math.max(10,Number(args[2])||10);const timerSec=Number(args[3])||CONFIG.auctionTimerSec;sendCommand(name,[pid,items,startBid,timerSec]);return;}sendCommand(name,args);return;}const result=original[name](...args);if(NET.online&&NET.host&&!NET.executing)sendState();return result;};});
original.declareBankrupt=window.declareBankrupt;window.declareBankrupt=function(pid){if(NET.online&&!NET.host&&!NET.executing){if(pid!==youAre)return;openConfirm('Declare bankruptcy?',`This forfeits all of ${players[pid].name}'s properties and removes them from the game.`,()=>sendCommand('doBankrupt',[pid,null]),'Yes, go bankrupt');return;}const r=original.declareBankrupt(pid);if(NET.online&&NET.host&&!NET.executing)sendState();return r;};
original.doBankrupt=window.doBankrupt;window.doBankrupt=function(...args){if(NET.online&&!NET.host&&!NET.executing){sendCommand('doBankrupt',args);return;}const r=original.doBankrupt(...args);if(NET.online&&NET.host&&!NET.executing)sendState();return r;};
original.sendChat=window.sendChat;window.sendChat=function(){if(NET.online&&!NET.host&&!NET.executing){const i=document.getElementById('chatInput'),t=i.value.trim();if(!t)return;if(NET.isSpectator){
  // Spectators have no seat, so they can't ride the normal 'cmd'->sendChat path
  // (that speaks as youAre, and a spectator has no real youAre) — send a distinct
  // message the host tags and fans out as a clearly-labeled spectator line instead.
  const c=NET.conns.get('host');
  if(c&&c.open){try{c.send({type:'spectatorChat',text:t});i.value='';}catch(e){}}
  clearTimeout(typingDebounceTimer);typingLastState=false;sendTypingSignal(false);
  return;
}if(sendCommand('sendChat',[t]))i.value='';return;}const r=original.sendChat();if(NET.online&&NET.host&&!NET.executing)sendState();return r;};
original.sendTrade=window.sendTrade;window.sendTrade=function(){if(NET.online&&!NET.host&&!NET.executing){const t={a:tradeOffer.a,b:tradeOffer.b,sa:{cash:tradeOffer.sides[tradeOffer.a].cash,props:[...tradeOffer.sides[tradeOffer.a].props],cards:{...tradeOffer.sides[tradeOffer.a].cards}},sb:{cash:tradeOffer.sides[tradeOffer.b].cash,props:[...tradeOffer.sides[tradeOffer.b].props],cards:{...tradeOffer.sides[tradeOffer.b].cards}}};if(sendCommand('sendTrade',[t]))closeTrade();return;}const r=original.sendTrade();if(NET.online&&NET.host&&!NET.executing)sendState();return r;};
original.setYou=window.setYou;window.setYou=function(pid){if(NET.online){youAre=NET.host?NET.ownPid:NET.assignedId||youAre;setOnlineControls();return;}return original.setYou(pid);};
original.startNewGame=window.startNewGame;window.startNewGame=function(){setupHostPeer();};
original.joinWithCode=window.joinWithCode;window.joinWithCode=function(){const f=document.getElementById('joinCodeField'),id=parseRoomCode(f.value);if(!id){f.style.borderColor='var(--pink)';return;}setupGuestPeer(id);};
original.startLocalTest=window.startLocalTest;window.startLocalTest=function(){disconnectNet();resetToMenuState();return original.startLocalTest();};
original.beginGame=window.beginGame;window.beginGame=function(){if(NET.online&&!NET.host)return;if(NET.online)NET.started=true;clearLocalSave();const r=original.beginGame();if(NET.host){order=NET.activeIds.slice();turnIdx=0;sendState();}updateMenuBtnLabel();return r;};
original.showStartOverlay=window.showStartOverlay;window.showStartOverlay=function(){if(NET.online)disconnectNet();resetToMenuState();clearLocalSave();return original.showStartOverlay();};

/* ---- local (single-device) save/resume ----
   A "local" game here means genuinely offline (!NET.online) — an online room's
   authoritative state already lives with the host, so only a solo/hotseat game
   played entirely in this one tab needs its own persistence. Reuses the exact
   same serializeState()/restoreState() pair the online sync path already relies
   on, so resuming is just "replay the same rehydration a freshly-joining guest
   goes through", against a snapshot pulled from localStorage instead of a peer. */
const LOCAL_SAVE_KEY = 'gbLocalSave';
let __localSaveSig = '';
function saveLocalGameIfDue(){
  if(NET.online || gameOver) return;
  const gameRootEl = document.getElementById('gameRoot');
  if(!gameRootEl || gameRootEl.style.display === 'none') return; // no local game actually on screen
  try{
    const st = serializeState(true);
    st.started = true; // a purely local game never flips NET.started (that flag only ever means "an online room is running"), but restoreState() gates the board-vs-lobby branch on this field, so pin it true for anything we're bothering to save here
    const sig = JSON.stringify(st);
    if(sig === __localSaveSig) return; // nothing actually changed since the last tick
    __localSaveSig = sig;
    localStorage.setItem(LOCAL_SAVE_KEY, sig);
  }catch(e){ /* storage full/unavailable — fail silently, same as the rejoin-token save above */ }
}
function clearLocalSave(){
  try{ localStorage.removeItem(LOCAL_SAVE_KEY); }catch(e){}
  __localSaveSig = '';
  const btn = document.getElementById('resumeLocalBtn');
  if(btn) btn.style.display = 'none';
}
function loadLocalSave(){
  try{
    const raw = localStorage.getItem(LOCAL_SAVE_KEY);
    if(!raw) return null;
    const st = JSON.parse(raw);
    if(st && (st.v===2||st.v===3) && st.started) return st;
  }catch(e){}
  return null;
}
function resumeLocalGame(){
  const st = loadLocalSave();
  if(!st) return;
  document.getElementById('resumeLocalBtn').style.display = 'none';
  restoreState(st);
}
window.resumeLocalGame = resumeLocalGame;
// light polling rather than hooking every single action — a local game only
// has one screen watching it, so a couple of seconds of staleness on an
// accidental tab close is an acceptable trade for not having to instrument
// every action call site (which the ACTIONS wrapping above already keeps
// deliberately generic).
setInterval(saveLocalGameIfDue, 2500);
// Offer "Resume last game" on the very first paint if a save from an earlier
// session is sitting there — but only once, before anything else has had a
// chance to touch #resumeLocalBtn or the save file.
(function offerLocalResumeOnLoad(){
  const btn = document.getElementById('resumeLocalBtn');
  if(btn && loadLocalSave()) btn.style.display = '';
})();

ensureNetUI();setNetStatus('Offline',false);
})();
