/* ============ GAME STATE ============ */
function purchasable(t){ return !t.corner && t.price && t.price.indexOf('%')===-1; }
tiles.forEach(t=>{ if(purchasable(t)) { t.owner=null; t.houses=0; t.mortgaged=false; t.frozenTurns=0; } });

const players = {};
PLAYER_IDS.forEach((id,i)=>{const car=CAR_LIST[i%CAR_LIST.length].key; players[id]={id,name:PLAYER_DEFAULTS[i][0],balance:1500,pos:0,color:colorForCar(car),car,inJail:false,jailTurns:0,bankrupt:false,active:i===0,doublesCount:0,loan:0,loanTermTurns:0,skipNextTurn:false,reconnecting:false,discDeadline:0,rentDoublerCharges:0,jailFreeCards:0,shieldCharges:0,teleportCards:0,skipAheadCards:0,propertyFreezeCards:0,swapCards:0,propertySwapCards:0,bankruptcyInsuranceCharges:0,fastForwardCards:0,sharedShieldCharges:0,extraRollCredits:0,pooledPaydayCards:0,highRiseHustleCards:0,sabotageCards:0,halfShieldCharges:0,halfShieldArmed:false,lastRentPaid:0,shieldArmed:false,rentDoublerGroup:null,doubleSalaryCards:0,loanForgivenessCards:0,sharedShieldArmed:false,pooledPaydayArmed:false,team:null,ready:false,wantsRematch:false};});
// letters available for alliance/team mode pairings — up to 4 teams of 2 across the 8 seats
const TEAM_LETTERS = ['A','B','C','D'];
// a distinct accent color per team letter, purely cosmetic — used to color-code
// each team's column in the lobby's Teams-tab board (see renderTeamsBoard in
// network.js) and its "is-mine" highlight glow. Not used anywhere in actual
// gameplay logic, just so the four teams read as visually distinct at a glance.
const TEAM_COLORS = {A:'#22d3ee', B:'#f2b84b', C:'#a78bfa', D:'#fb7185'};
syncTokenVisibility(); // only the initial player (p1) has a car until others actually join
let order = PLAYER_IDS.slice();
let turnIdx = 0;
let youAre = 'p1'; // which player this device/browser is controlling
let busy = false;      // true while animating / awaiting a buy decision
let turnRollSeq = 0;    // bumped once per actual dice roll (rollDice()'s real body executing, not the network-relay stub) — lets the turn timer notice "a roll just happened" and give the player a fresh countdown, even though the active player hasn't changed. Rides along in serializeState()/restoreState() like any other top-level game field so every client's timer resets in step.
let awaitingEndTurn = false; // true once a move is fully resolved and only needs the player to click "End turn"
let powerCardsShowAll = false; // false (default): the Cards tray only lists cards this player currently holds. true: it instead lists every card enabled for this game (per the Cards & power-ups settings and Team mode), owned or not — toggled via the button rendered by renderPowerCardsHub(), and reset back to false each time openPowerCards() opens the tray fresh.
let cardDraw = null;    // {id,kind,glyph,title,who,text,amt} while a drawn Lucky Wheel / Happy Birthday card is up on the board
let cardDrawSeq = 0;
let cardDrawTimer = null;
let shownCardDrawId = null; // id of the card currently rendered locally, so a repeated state sync doesn't restart the reveal animation
let pendingBuy = null; // tile index awaiting purchase decision
let pendingBuyout = null; // tile index awaiting a landing buyout decision
let pendingDebt = null; // {pid, creditorId, resume:{type,...}} — set when a payment leaves a player
                         // short but they still have mortgageable/sellable assets to cover it with
let gameOver = false;
let gameWinnerId = null; // set once checkWin() (or a synced state) crowns a winner — drives the end-game summary title/standings
let gameWinnerIds = []; // full winning unit — just [gameWinnerId] solo, or the whole team in alliance mode
let netWorthHistory = []; // one snapshot per turn: {turn, afterPid, p1:worth, p2:worth, ...} — feeds the summary screen's net-worth-over-time chart
let currentRollWasDouble = false; // whether the active player's last roll earns them another turn
window.lastRoll = 7;

/* ============ GAME-END SUPERLATIVES TRACKING ============
   Lightweight per-player/per-tile counters fed from the various action handlers
   below (rent, GO, jail, building, trading, auctions, bankruptcy). Nothing here
   drives gameplay — it's purely fodder for the fun "recap" cards on the
   end-game summary screen (see buildSuperlatives/renderSuperlatives). Reset
   fresh in beginGame() alongside everything else. */
let gameStats = {
  rentPaid: {}, rentCollected: {}, biggestRent: null, // biggestRent: {amt, payerId, ownerId, tileName}
  tileLandings: {}, // idx -> times any player landed there
  doublesRolled: {}, // pid -> count
  jailVisits: {}, // pid -> times sent to jail
  housesBuilt: {}, // pid -> houses+hotels built
  goSalary: {}, // pid -> total collected passing/landing on GO
  tradesCompleted: 0,
  auctionsWon: {}, // pid -> items won at auction
  bankruptciesCaused: {}, // pid (creditor) -> number of players bankrupted
};
function bumpStat(bucketName, key, amt){
  const bucket = gameStats[bucketName];
  bucket[key] = (bucket[key]||0) + (amt===undefined?1:amt);
}

/* ============ RULE CONFIG (adjustable from the start menu) ============ */
let CONFIG = {
  startingCash: 3000,
  salary: 400,
  goLandingBonus: 600,
  bail: 100,
  loansEnabled: true,
  loanLimit: 3000,
  loanInterestPct: 10,

  noRentInJail: true,
  doubleRentFullSet: true,

  auctionOnDecline: true,
  auctionFunMode: false,
  auctionTimerSec: 6,

  requireFullSetToBuild: true,
  evenBuildRule: false,

  buyoutEnabled: true,
  buyoutMultiplier: 4,
  buyoutAnywhere: false,
  buyoutIncludesHouses: false,

  turnTimerEnabled: false,
  turnTimerSec: 45,

  speedX2Enabled: false, // 2x game speed: halves the dice/token-movement/card-reveal pacing delays (see spd() below). Settable here pre-game, or toggled live mid-game from the board's topbar Speed button — but only the host can flip it there (see toggleGameSpeed() in network.js); it then rides along on the normal CONFIG sync like any other rule, same as turnTimerEnabled above.

  teamsEnabled: false, // alliance/team mode — paired players (see players[pid].team) share one bank and win together

  luckyWheelPowerOnly: true, // true (default): Lucky Wheel tile always draws a power card instead, and the tile itself relabels/re-skins on the board (see updateSpecialTileVisuals()). false: it always draws cash instead, never a power card.
  bdayPowerOnly: true, // true (default): Happy Birthday tile always draws a power card, never cash. false: it always draws its cash bonus instead, and the tile itself relabels/re-skins on the board.
  powerCardsEnabled: { shield:true, rentDoubler:true, jailFree:true, teleport:true, skipAhead:true, propertyFreeze:true, swap:true, propertySwap:true, bankruptcyInsurance:true, doubleSalary:true, loanForgiveness:true, extraRoll:true, fastForward:true, stealCard:true, sharedShield:true, rally:true, pooledPayday:true, highRiseHustle:true, sabotage:true, nudge:true, tollRefund:true, halfShield:true, theft:true },
  powerCardWeights:  { shield:25,   rentDoubler:25,   jailFree:25,   teleport:25,   skipAhead:25,   propertyFreeze:25,   swap:25,   propertySwap:25,   bankruptcyInsurance:25,   doubleSalary:25,   loanForgiveness:25,   extraRoll:25,   fastForward:25,   stealCard:25,   sharedShield:25,   rally:25,   pooledPayday:25,   highRiseHustle:25,   sabotage:25,   nudge:25,   tollRefund:25,   halfShield:25,   theft:25 }, // relative draw weight among the enabled cards — sharedShield/rally/pooledPayday/sabotage are additionally gated by CONFIG.teamsEnabled itself (see pickPowerCard); Discount (highRiseHustle) is no longer team-only. Every entry here now has a matching enable-checkbox + weight field in the settings menu (see openConfigMenu/saveConfigMenu and encodeConfig/decodeConfig) — these are just the fallback defaults.
  skipAheadSpaces: 5, // how many spaces forward a drawn Skip Ahead card instantly moves its player — fixed, doesn't wrap into a GO bonus

  sideBetsEnabled: false // lets any non-active player wager cash against the active player's next roll — purely social, never touches properties/rent
};

/* ============ PLAYER IDENTITY (name + color, chosen before the game starts) ============ */
let PLAYER_SETUP = {};
PLAYER_IDS.forEach((id,i)=>{const car=CAR_LIST[i%CAR_LIST.length].key; PLAYER_SETUP[id]={name:'',color:colorForCar(car),car};});

/* ---- rent / monopoly / house helpers ---- */
function groupTiles(groupId){ return tiles.filter(t=>t.group===groupId); }
/* House rule: once ANY property in a color group has a building on it, EVERY property
   in that group is locked out of changing hands — not just the built one. Used to gate
   buyouts, trade offers (both sides), auctions, and every ownership-moving power card
   (Property Swap) so a player can't dodge the "sell the houses first" rule by trading,
   auctioning, or card-swapping a still-bare sibling property out from under a built-up
   group. Railroads/utilities have no .group, so this falls back to the plain per-tile
   houses check for them (they can never actually have houses). */
function groupHasBuilding(t){
  if(!t) return false;
  if(t.group) return groupTiles(t.group).some(x=>(x.houses||0)>0);
  return (t.houses||0)>0;
}
function ownsGroup(pid, groupId){
  const g = groupTiles(groupId);
  // IN TEAMS: a monopoly counts once the whole color group sits with pid or any of
  // their active teammates — the set doesn't have to be piled onto one single deed
  return g.length>0 && g.every(t=>t.owner===pid || (t.owner && sameTeam(t.owner,pid)));
}
function houseCost(t){
  if(typeof t.houseCost==='number') return t.houseCost;
  const price = parseInt(t.price.replace('$',''));
  return Math.max(20, Math.round(price/2/10)*10);
}
/* the price to actually charge pid for buying tile t right now — halved
   (rounded to the nearest $10, same rounding used everywhere else in this
   file) whenever they're holding a Discount card. Doesn't consume anything
   itself — that only happens in buyDecision()/buyPropertyAnywhere() once a
   purchase actually goes through, so this is always safe to call just to
   render a price tag. */
function propertyBuyPrice(t, pid){
  const price = parseInt(t.price.replace('$',''));
  const player = players[pid];
  if(player && player.highRiseHustleCards>0) return Math.max(10, Math.round(price/2/10)*10);
  return price;
}
function mortgageValue(t){
  const price = parseInt(t.price.replace('$',''));
  return Math.round(price/2/10)*10;
}
function unmortgageCost(t){
  return Math.round(mortgageValue(t)*1.1/10)*10;
}
/* ---- end-game summary: net worth tracking ----
   Net worth = cash on hand, plus every owned property (at mortgage value if
   mortgaged, otherwise full price) and anything sunk into houses/hotels on it,
   minus whatever's still owed on a bank loan. Recorded once per turn (see
   advanceTurn) so the summary screen can chart it over the course of the game. */
function computeNetWorth(pid){
  const p = players[pid];
  if(!p) return 0;
  let v = p.balance - (p.loan||0);
  tiles.forEach(t=>{
    if(!ownedByUnit(t,pid)) return; // IN TEAMS: net worth reflects the whole shared pool, not just this player's own deeds
    const price = parseInt(String(t.price||'0').replace('$',''))||0;
    v += t.mortgaged ? mortgageValue(t) : price;
    if(t.houses) v += t.houses * houseCost(t);
  });
  return v;
}
function recordNetWorthSnapshot(afterPid){
  const snap = {turn: netWorthHistory.length+1, afterPid: afterPid||null};
  PLAYER_IDS.forEach(id=>{ if(players[id].active) snap[id] = computeNetWorth(id); });
  netWorthHistory.push(snap);
  // cap so a marathon game doesn't grow this (and every state sync carrying it)
  // without bound — the chart only has room to show so many points anyway.
  if(netWorthHistory.length>300) netWorthHistory.shift();
}
/* Rent Doubler now targets a property GROUP the owner picks when they use the
   card (a color set, or all Railroads, or all Utilities) instead of arming
   the player globally — see useRentDoublerCard(). 'RAIL' and 'UTIL' are
   pseudo-group keys for the two tile types that don't carry a real .group. */
function tileMatchesDoublerGroup(t, key){
  if(!key) return false;
  if(key==='RAIL') return t.icon==='rail';
  if(key==='UTIL') return t.icon==='util';
  return !!t.group && t.group===key;
}
function doublerGroupLabel(pid, key){
  if(!key) return '';
  if(key==='RAIL') return 'Railroads';
  if(key==='UTIL') return 'Utilities';
  const owned = tiles.filter(t=>t.group===key && t.owner===pid);
  return owned.length ? owned.map(t=>t.name).join(', ') : key;
}
function calcRent(t, ownerId){
  if(t.mortgaged) return 0;
  if(t.frozenTurns>0) return 0; // Property Freeze: no rent collected from a frozen property, from anyone
  if(CONFIG.noRentInJail && players[ownerId] && players[ownerId].inJail) return 0;
  const price = parseInt(t.price.replace('$',''));
  let rent;
  if(t.icon==='rail'){
    // IN TEAMS: railroads owned by any teammate count toward the set, same as a monopoly
    const owned = tiles.filter(x=>x.icon==='rail' && x.owner && (x.owner===ownerId || sameTeam(x.owner,ownerId))).length;
    rent = 25 * Math.pow(2, Math.max(0,owned-1));
  } else if(t.icon==='util'){
    const owned = tiles.filter(x=>x.icon==='util' && x.owner && (x.owner===ownerId || sameTeam(x.owner,ownerId))).length;
    const mult = owned>=2 ? 10 : 4;
    rent = mult * (window.lastRoll||7);
  } else {
    const houses = t.houses||0;
    if(Array.isArray(t.rent)){
      if(houses>0) rent = t.rent[houses];
      else{
        const monopoly = t.group && ownsGroup(ownerId, t.group);
        rent = (monopoly && CONFIG.doubleRentFullSet) ? t.rent[0]*2 : t.rent[0];
      }
    } else {
      const base = Math.max(4, Math.round(price*0.15));
      if(houses>0){
        const rentMult = [0,4,8,12,16,20][houses];
        rent = base*rentMult;
      } else {
        const monopoly = t.group && ownsGroup(ownerId, t.group);
        rent = (monopoly && CONFIG.doubleRentFullSet) ? base*2 : base;
      }
    }
  }
  // Rent Doubler: baked in here so the board price label, tile info card, and
  // the actual rent charged in resolveTile all agree on the same doubled
  // number — no more a tile quietly charging 2x while the board still showed
  // the un-doubled price.
  const owner = players[ownerId];
  if(owner && owner.rentDoublerGroup && tileMatchesDoublerGroup(t, owner.rentDoublerGroup)) rent *= 2;
  return rent;
}

/* ---- alliance / team mode ----
   Two (or more) players can be paired into a team that shares one bank and wins
   or loses together. teamOf/teammatesOf are the read-side helpers used all over
   bankruptcy/trade/rent logic; wireTeamBalances is what actually makes the money
   shared — see its comment below for how. */
function teamOf(pid){ const p=players[pid]; return (CONFIG.teamsEnabled && p && p.team) ? p.team : null; }
/* ids of pid's team, including pid itself by default (pass includeSelf:false to
   exclude it) — only counts players still active, so a kicked/disconnected
   teammate's assets don't linger in the shared pool calculations. Returns just
   [pid] (or []) when teams are off or pid has no team, so callers never need a
   separate no-team branch. */
function teammatesOf(pid, includeSelf){
  const t = teamOf(pid);
  if(!t) return includeSelf===false ? [] : [pid];
  const mates = PLAYER_IDS.filter(id=>id!==pid && players[id].active && players[id].team===t);
  return includeSelf===false ? mates : [pid,...mates];
}
/* whether two players are on the same active team — the single check every
   "does this belong to my team" call site below is built on */
function sameTeam(pidA, pidB){
  if(pidA===pidB) return true;
  const t = teamOf(pidA);
  return !!t && t===teamOf(pidB);
}
/* IN TEAMS: is tile t part of pid's shared pool — owned by pid themself or by any
   active teammate? Used everywhere building/mortgaging/auctioning off a property
   needs to work no matter which teammate physically holds the deed. */
function ownedByUnit(t, pid){ return !!t && !!t.owner && (t.owner===pid || sameTeam(t.owner,pid)); }
/* IN TEAMS: a tile bought by either teammate renders in a blended midpoint of the
   whole team's colors instead of just whichever teammate happened to buy it — the
   board reads as "the team owns this", not "player X owns this". Averages every
   active teammate's RGB together; solo players (or teams off) just get their own
   color back unchanged. */
function teamDisplayColor(pid){
  const p = players[pid];
  if(!p) return '#ffffff';
  const mates = teammatesOf(pid, true).filter(id=>players[id] && players[id].active && !players[id].bankrupt);
  if(mates.length<2) return p.color;
  const toRgb=hex=>{
    if(typeof hex==='string' && hex.startsWith('rgb')){ const m=hex.match(/\d+/g).map(Number); return {r:m[0],g:m[1],b:m[2]}; }
    const n=parseInt(String(hex).slice(1),16); return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};
  };
  const sum = mates.reduce((acc,id)=>{ const c=toRgb(players[id].color); acc.r+=c.r; acc.g+=c.g; acc.b+=c.b; return acc; },{r:0,g:0,b:0});
  const n = mates.length;
  return `rgb(${Math.round(sum.r/n)},${Math.round(sum.g/n)},${Math.round(sum.b/n)})`;
}
/* Makes every member of a team read and write the SAME underlying balance —
   instead of rewriting the ~30 call sites that do `player.balance -= x` or
   `+= x` all over the file, each teammate's `balance` property is replaced with
   a getter/setter pair that all point at one shared number. Every existing
   comparison, deduction and credit then "just works" on the pooled total with
   no other code changes, including trades or rent paid between teammates
   (those net out to zero automatically, since both sides read/write the same
   pool). JSON.stringify (used by serializeState) reads through the getter, so
   the value sent over the wire is always the correct pooled figure, and
   restoreState's Object.assign writes through the setter on the receiving end.

   seedFromSum=true pools everyone's CURRENT individual balance together (used
   once, right when a game begins, to combine each teammate's starting cash
   into one shared bank). seedFromSum=false just keeps whatever pooled value is
   already flowing in — used when re-establishing the wiring locally (e.g.
   after a synced state arrives) without ever double-counting an already-shared
   number. */
/* fields pooled across a team: cash plus every power-card count (jailFreeCards,
   shieldCharges, etc.) — computed at call time since CARD_FIELD is declared later
   in the file but this only ever runs once a game actually starts. */
function teamSharedFields(){ return ['balance', ...Object.values(CARD_FIELD)]; }
function unwireTeamBalances(){
  const fields = teamSharedFields();
  PLAYER_IDS.forEach(pid=>{
    const p = players[pid];
    fields.forEach(f=>{
      const desc = Object.getOwnPropertyDescriptor(p,f);
      if(desc && desc.get){
        // un-wire back to a plain number so re-grouping (or teams being turned
        // off, or a fresh game starting) never leaves a stale getter pointing at
        // an old pool
        Object.defineProperty(p,f,{value:desc.get(),writable:true,enumerable:true,configurable:true});
      }
    });
  });
}
function wireTeamBalances(seedFromSum){
  unwireTeamBalances();
  if(!CONFIG.teamsEnabled) return;
  const groups = {};
  PLAYER_IDS.forEach(pid=>{
    const p = players[pid];
    if(p.active && p.team) (groups[p.team]=groups[p.team]||[]).push(pid);
  });
  const fields = teamSharedFields();
  Object.values(groups).forEach(pids=>{
    if(pids.length<2) return; // a lone player left on a team letter just plays solo
    fields.forEach(f=>{
      const pool = {v: seedFromSum ? pids.reduce((s,id)=>s+(players[id][f]||0),0) : (players[pids[0]][f]||0)};
      pids.forEach(pid=>{
        Object.defineProperty(players[pid],f,{
          get(){ return pool.v; },
          set(nv){ pool.v = nv; },
          enumerable:true, configurable:true
        });
      });
    });
  });
}

/* ---- bankruptcy / win ---- */
/* total cash a player could still raise by mortgaging every unmortgaged property
   they own and selling every house/hotel on their improved properties — the pool
   real Monopoly rules require you to draw on before you're forced bankrupt.
   In team mode this also counts a teammate's raisable assets, since the debt is
   really owed by the shared bank, not just the one player who triggered it. */
function totalRaisable(pid){
  const ids = teammatesOf(pid);
  let sum = 0;
  tiles.forEach(t=>{
    if(!ids.includes(t.owner)) return;
    if(!t.mortgaged) sum += mortgageValue(t);
    if(t.houses>0) sum += (Math.round(houseCost(t)/2/10)*10) * t.houses;
  });
  return sum;
}
function isDebtor(pid){ return !!(pendingDebt && pendingDebt.pid===pid); }
// true while pid is the active player currently staring at the buy/skip panel —
// used to let them borrow cash before committing to a purchase decision
function isAwaitingBuy(pid){ return pendingBuy!=null && order[turnIdx]===pid; }

/* checkBankrupt(pid, creditorId, resume) — resume is a plain, serializable descriptor
   ({type:'finish'} | {type:'rent',idx} | {type:'move',steps}) describing what should
   happen once the shortfall is covered; it is never a closure, so it survives being
   broadcast to other players in an online game. */
function checkBankrupt(pid, creditorId, resume){
  if(!pid || !players[pid]) return false; // no seller (bank auction) or unknown id — nothing to check
  const player = players[pid];
  if(player.balance>=0 || player.bankrupt) return false;
  // Bankruptcy Insurance fires the instant a player dips below zero, whatever
  // the reason — it doesn't wait to see whether they could've covered it by
  // selling/mortgaging first. Spend a charge, wipe the debt outright, and let
  // the game carry on as if it had been paid in full. Unlike Property Shield
  // it isn't armed ahead of time — it just fires automatically here.
  if(player.bankruptcyInsuranceCharges>0){
    const owed = -player.balance;
    player.bankruptcyInsuranceCharges--;
    player.balance = 0;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> went negative, but <b>Bankruptcy Insurance</b> wipes the $${fmt(owed)} debt!`);
    showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F4B8}', title:'BANKRUPTCY INSURANCE USED', who:player.name, text:`Bankruptcy Insurance cancelled $${fmt(owed)} in debt.`});
    playCardPopupSound();
    if(cardDrawTimer) clearTimeout(cardDrawTimer);
    cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    refreshUI();
    return false;
  }
  // The game never forces a player into bankruptcy on its own, even if they
  // couldn't cover the shortfall by liquidating everything — it just pauses
  // here and makes them raise the cash (or declare bankruptcy themselves,
  // any time, via their own Bankrupt button) instead of ending the game for
  // them automatically.
  pendingDebt = {pid, creditorId: creditorId||null, resume: resume||{type:'finish'}};
  busy = true;
  awaitingEndTurn = false;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> is <b>$${fmt(-player.balance)}</b> short.`);
  showCardDraw({id:++cardDrawSeq, kind:'debt', glyph:'\u{1F4C9}', title:'IN THE RED', who:player.name, text:'Short on cash — needs to raise funds to keep playing.', amt:player.balance});
  playCardPopupSound();
  playNegativeSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  refreshUI();
  return true;
}

/* Fires a held Bankruptcy Insurance the instant it lands in the hand of a player
   who's already in the red — e.g. traded to them (see finalizeAcceptedTrade()).
   Mirrors the wipe in checkBankrupt() but skips all of pendingDebt/busy handling
   since this only ever runs on a receiving side that isn't already mid-turn. */
function tryAutoFireInsuranceOnReceive(pid){
  const player = players[pid];
  if(!player || player.bankrupt || player.balance>=0 || !(player.bankruptcyInsuranceCharges>0)) return;
  const owed = -player.balance;
  player.bankruptcyInsuranceCharges--;
  player.balance = 0;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> receives a <b>Bankruptcy Insurance</b> card while already in the red — it fires immediately and wipes the $${fmt(owed)} debt!`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F4B8}', title:'BANKRUPTCY INSURANCE USED', who:player.name, text:`Bankruptcy Insurance cancelled $${fmt(owed)} in debt.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  refreshUI();
}

/* called after any action that changes a debtor's balance (mortgaging, selling a
   house, unmortgaging, a bank loan) to see if they've covered their shortfall yet */
function tryResumeAfterDebt(pid){
  if(!isDebtor(pid)) return;
  const player = players[pid];
  if(player.balance<0) return; // still short — stay paused
  const {resume} = pendingDebt;
  pendingDebt = null;
  busy = false;
  if(resume.type==='rent') offerLandingBuyoutOrFinish(pid, resume.idx);
  else if(resume.type==='move') moveToken(pid, resume.steps);
  else if(resume.type==='endTurn') finishOrRepeatTurn(pid);
  else if(resume.type==='newTurn') refreshUI(); // loan installment just cleared at the start of their turn — leave them free to roll
  else if(resume.type==='freeRoll') refreshUI(); // bail just paid — leave them free to roll, don't force end-of-turn
  else finishTurnStep(pid);
}

/* self-service bankruptcy — a player can throw in the towel at any time, not just on their turn,
   but only for themselves: you must be the one currently signed in as that player, and it needs
   an explicit confirmation before it actually happens. */
function declareBankrupt(pid){
  const player = players[pid];
  if(gameOver || player.bankrupt) return;
  if(pid !== youAre) return; // safety net — the button for another player is hidden anyway
  // Bankruptcy Insurance promises to cancel "your next bankruptcy outright" with
  // no carve-out for a self-declared one — so a held charge auto-fires here too,
  // the same way it does inside checkBankrupt(), instead of only covering the
  // forced/can't-pay path.
  if(player.bankruptcyInsuranceCharges>0){
    openConfirm(
      'Declare bankruptcy?',
      `${player.name} is holding a Bankruptcy Insurance card, which will cancel this and keep them in the game instead. Use it now?`,
      ()=>{
        player.bankruptcyInsuranceCharges--;
        const owed = player.balance<0 ? -player.balance : 0;
        if(owed>0) player.balance = 0;
        log(`<span class="who" style="color:${player.color}">${player.name}</span> tries to declare bankruptcy, but <b>Bankruptcy Insurance</b> cancels it${owed>0?` and wipes the $${fmt(owed)} debt`:''}!`);
        showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F4B8}', title:'BANKRUPTCY INSURANCE USED', who:player.name, text:'Bankruptcy Insurance cancelled the bankruptcy.'});
        playCardPopupSound();
        if(cardDrawTimer) clearTimeout(cardDrawTimer);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
      },
      'Yes, go bankrupt'
    );
    return;
  }
  openConfirm(
    'Declare bankruptcy?',
    `This forfeits all of ${player.name}'s properties and removes ${player.name} from the game. This can't be undone.`,
    ()=> doBankrupt(pid, null),
    'Yes, go bankrupt'
  );
}

function doBankrupt(pid, creditorId){
  // in team mode the whole unit shares the bank that just ran dry, so the whole
  // unit goes down together — everyone still standing on pid's team, not just
  // pid, is marked bankrupt and forfeits their properties in this same pass
  const unit = teammatesOf(pid).filter(id=>players[id] && players[id].active && !players[id].bankrupt);
  if(creditorId && !unit.includes(creditorId)) bumpStat('bankruptciesCaused', creditorId);
  if(isDebtor(pid)) pendingDebt = null; // the debt is moot once they're bankrupt
  // figure out who was actually up before we mutate `order`, so we can re-locate
  // them afterward instead of guessing — removing an earlier seat shifts every
  // later index down by one, which used to silently skip or repeat a turn
  const activePidBefore = order[turnIdx];
  const wasActivePlayer = unit.includes(activePidBefore);
  unit.forEach(uid=>{
    const player = players[uid];
    player.bankrupt = true;
    tiles.forEach((t,i)=>{
      if(t.owner===uid){
        t.houses = 0;
        t.frozenTurns = 0; // Property Freeze doesn't survive a bankruptcy transfer — the new owner (or the bank) starts clean
        setFrozenVisual(i, false);
        if(creditorId && !unit.includes(creditorId)){
          t.owner = creditorId;
          markOwnership(i, teamDisplayColor(creditorId));
          pulseTile(i, teamDisplayColor(creditorId));
          setMortgageVisual(i, !!t.mortgaged);
        } else {
          t.owner = null;
          t.mortgaged = false;
          clearOwnershipRing(i);
        }
      }
    });
    // Held power cards are assets too, same as properties — hand them to whoever's
    // collecting the estate (a real player creditor outside this unit), or just
    // clear them out to the bank same as unowned properties when there's no
    // such creditor (a can't-pay-even-liquidating bankruptcy with no one to pay,
    // or a self-declared one).
    const creditor = (creditorId && !unit.includes(creditorId)) ? players[creditorId] : null;
    Object.values(CARD_FIELD).forEach(field=>{
      const held = player[field]||0;
      if(held>0){
        if(creditor) creditor[field] = (creditor[field]||0) + held;
        player[field] = 0;
      }
    });
    const cardEl = document.getElementById('card-'+uid);
    if(cardEl) cardEl.style.opacity = '0.35';
    if(tokenEls[uid]) tokenEls[uid].style.display = 'none';
  });
  // any side bet involving a now-bankrupt player is void — their balance is
  // no longer meaningful collateral, so it's cleared rather than settled
  if(sideBets.length) sideBets = sideBets.filter(sb=>!unit.includes(sb.bettor) && !unit.includes(sb.roller));
  if(unit.length>1){
    const names = unit.map(uid=>`<span class="who" style="color:${players[uid].color}">${players[uid].name}</span>`).join(' & ');
    log(`${names} have gone <b>bankrupt together</b>!`);
  } else if(unit.length){
    log(`<span class="who" style="color:${players[unit[0]].color}">${players[unit[0]].name}</span> has gone <b>bankrupt</b>!`);
  }
  playNegativeSound();
  if(unit.includes(youAre)) vibrate([40,60,40,60,80]); // heavier pattern for the player(s) it actually happened to
  triggerScreenShake(14);
  spawnParticleBurst(tokenEls[pid] ? tokenEls[pid].getBoundingClientRect() : null, ['#e35b5b','#8a8a8a','#c0392b'], 18);

  order = order.filter(id=>!unit.includes(id));
  if(order.length===0){
    turnIdx = 0;
  } else if(wasActivePlayer){
    // the bankrupt player's own slot now holds whoever was next in line — that's
    // correctly who should be up, so just clamp the same index into range
    turnIdx = turnIdx % order.length;
  } else {
    const idx = order.indexOf(activePidBefore);
    turnIdx = idx>=0 ? idx : (turnIdx % order.length);
  }
  // a bankruptcy reshuffles `order`/`turnIdx` directly instead of going through
  // advanceTurn(), which is the only other place that normally checks "does
  // whoever we just landed on owe a sit-out?" (Bailout's skipNextTurn, jail's
  // Fast Forward auto-use, a disconnect's reconnect grace window). Without this
  // call, a bankruptcy that happens to shift turnIdx straight onto a
  // skip-flagged player would silently let them play instead of sitting out.
  applySkipTurns();

  document.getElementById('managePanel').classList.remove('show');
  document.getElementById('auctionPanel').classList.remove('show');
  document.getElementById('loanPanel').classList.remove('show');
  document.getElementById('tradeOverlay').classList.remove('show');
  checkWin();
  // this bankruptcy always happens mid a payment the active player couldn't cover
  // (rent, tax, bail) — that flow never got to unlock rolling for whoever's turn
  // it now is, so do it here instead of leaving `busy` stuck true forever
  if(wasActivePlayer && !gameOver){
    busy = false;
    awaitingEndTurn = false;
  } else {
    busy = busy || gameOver;
  }
  refreshUI();
}

/* ---- "who is playing on this device" toggle ---- */
function setYou(pid){ if(players[pid] && !players[pid].bankrupt){ youAre=pid; refreshUI(); } }

/* ---- generic themed confirm modal ---- */
let confirmCallback = null;
function openConfirm(title, body, onConfirm, yesLabel){
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').textContent = body;
  document.getElementById('confirmYesBtn').textContent = yesLabel || 'Yes';
  confirmCallback = onConfirm;
  document.getElementById('confirmOverlay').classList.add('show');
}
function closeConfirm(){
  document.getElementById('confirmOverlay').classList.remove('show');
  confirmCallback = null;
}
document.getElementById('confirmYesBtn').addEventListener('click', ()=>{
  const cb = confirmCallback;
  closeConfirm();
  if(cb) cb();
});
function checkWin(){
  const alive = Object.keys(players).filter(id=>players[id].active&&!players[id].bankrupt);
  // group survivors into units — teammates collapse into one unit since they rise
  // or fall together, so the game only ends once a single unit remains, not
  // just a single player (two still-standing teammates should keep playing)
  const seen = new Set();
  const units = [];
  alive.forEach(id=>{
    if(seen.has(id)) return;
    const t = teamOf(id);
    const group = t ? alive.filter(x=>teamOf(x)===t) : [id];
    group.forEach(g=>seen.add(g));
    units.push(group);
  });
  if(units.length<=1 && !gameOver){
    gameOver = true;
    const winners = units[0]||[];
    gameWinnerId = winners[0]||null;
    gameWinnerIds = winners.slice();
    recordNetWorthSnapshot(null); // final snapshot so the chart's last point matches the standings
    document.getElementById('rollBtn').disabled = true;
    busy = true;
    if(winners.length){
      const names = winners.map(id=>players[id].name).join(' & ');
      const verb = winners.length>1 ? 'win' : 'wins';
      document.getElementById('rollResult').textContent = `🏆 ${names} ${verb} the game!`;
      log(`<span class="who" style="color:${players[winners[0]].color}">${names}</span> ${verb} the game!`);
      playWinSound();
      spawnConfetti();
    } else {
      // everyone still in the game went bankrupt at once (e.g. the last active player bankrupts) —
      // no survivor to crown, so end the game without one instead of crashing on players[undefined]
      document.getElementById('rollResult').textContent = `Game over — no players remaining.`;
      log(`Game over — no players remaining.`);
    }
    updateGameOverBtn();
    // let the win chime/confetti land first, then bring up the full breakdown
    setTimeout(openGameOverSummary, 1200);
  }
}

/* ============ END-GAME SUMMARY ============
   A themed overlay (reuses the trade-overlay/trade-modal shell so it inherits
   every theme's colors/fonts for free) showing final standings, a hand-rolled
   SVG line chart of net worth per turn, and a breakdown of who ended up owning
   what. Built from netWorthHistory + the live players/tiles state, so it works
   identically whether it's running on the host (right after checkWin) or on a
   guest (once the synced state's gameOver flips true in restoreState). */
function updateGameOverBtn(){
  const btn=document.getElementById('gameOverBtn');
  if(btn) btn.style.display = gameOver ? '' : 'none';
}
function playerWasEverActive(id){
  return players[id].active || netWorthHistory.some(h=>h[id]!==undefined);
}
function renderStandings(){
  const ids = PLAYER_IDS.filter(playerWasEverActive);
  const rows = ids.map(id=>{
    const p=players[id];
    return {id, name:p.name, color:p.color, worth:computeNetWorth(id), bankrupt:p.bankrupt, active:p.active};
  }).sort((a,b)=>b.worth-a.worth);
  return rows.map((r,i)=>{
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    const isWinner = gameWinnerIds.includes(r.id);
    const status = isWinner ? 'Winner' : r.bankrupt ? 'Bankrupt' : !r.active ? 'Disconnected' : '';
    return `<div class="go-standing-row${isWinner?' go-standing-winner':''}">`
      +`<div class="go-standing-rank">${medal}</div>`
      +`<div class="go-standing-name" style="color:${r.color}">${escapeHtml(r.name)}</div>`
      +`<div class="go-standing-status">${status}</div>`
      +`<div class="go-standing-worth">$${fmt(r.worth)}</div>`
      +`</div>`;
  }).join('');
}
function buildNetWorthChartSVG(){
  const ids = PLAYER_IDS.filter(id=>netWorthHistory.some(h=>h[id]!==undefined));
  if(netWorthHistory.length<2 || !ids.length){
    return '<div class="go-empty">Not enough turns played yet to chart net worth.</div>';
  }
  const W=640,H=210,padL=52,padR=14,padT=14,padB=22;
  let min=Infinity,max=-Infinity;
  netWorthHistory.forEach(h=>ids.forEach(id=>{ if(h[id]!==undefined){ if(h[id]<min)min=h[id]; if(h[id]>max)max=h[id]; } }));
  if(!isFinite(min)||!isFinite(max)){ min=0; max=CONFIG.startingCash||1500; }
  if(min===max){ min-=100; max+=100; }
  const pad=(max-min)*0.08 || 50;
  min-=pad; max+=pad;
  const n=netWorthHistory.length;
  const xAt=i=> padL + (n<=1?0:(i/(n-1))*(W-padL-padR));
  const yAt=v=> padT + (1-((v-min)/(max-min)))*(H-padT-padB);
  const grid=[0,0.25,0.5,0.75,1].map(f=>{
    const v=min+(max-min)*f, y=padT+(1-f)*(H-padT-padB);
    return `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" class="go-chart-grid"/><text x="${padL-6}" y="${y+3}" text-anchor="end" class="go-chart-label">$${fmt(Math.round(v))}</text>`;
  }).join('');
  const lines=ids.map(id=>{
    const pts=netWorthHistory.map((h,i)=> h[id]!==undefined ? `${xAt(i).toFixed(1)},${yAt(h[id]).toFixed(1)}` : null).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${players[id].color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const xLabels = `<text x="${padL}" y="${H-6}" class="go-chart-label">Start</text><text x="${W-padR}" y="${H-6}" text-anchor="end" class="go-chart-label">Turn ${n}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="go-chart-svg" preserveAspectRatio="none">${grid}${lines}${xLabels}</svg>`;
}
function renderChartLegend(){
  const ids = PLAYER_IDS.filter(id=>netWorthHistory.some(h=>h[id]!==undefined));
  return ids.map(id=>`<div class="go-legend-item"><span class="go-legend-dot" style="background:${players[id].color}"></span>${escapeHtml(players[id].name)}</div>`).join('');
}
/* ---- fun "recap" superlatives (most rent collected, most doubles, biggest
   single hit, hottest tile, etc.) fed by the gameStats counters bumped
   throughout play — see the GAME-END SUPERLATIVES TRACKING block up top. */
function leaderOf(bucket, ids){
  let bestId=null, bestVal=0;
  ids.forEach(id=>{ const v=bucket[id]||0; if(v>bestVal){ bestVal=v; bestId=id; } });
  return bestId ? {id:bestId, val:bestVal} : null;
}
function trailerOf(bucket, ids){
  let bestId=null, bestVal=Infinity;
  ids.forEach(id=>{ const v=bucket[id]||0; if(v<bestVal){ bestVal=v; bestId=id; } });
  return bestId!==null ? {id:bestId, val:bestVal} : null;
}
function buildSuperlatives(){
  const ids = PLAYER_IDS.filter(playerWasEverActive);
  const cards = [];
  const add = (icon,label,winner,fmtVal)=>{
    if(!winner || !players[winner.id]) return;
    const p = players[winner.id];
    cards.push({icon, label, name:p.name, color:p.color, value:fmtVal(winner.val)});
  };
  add('💰','Biggest Landlord', leaderOf(gameStats.rentCollected, ids), v=>`$${fmt(v)} collected in rent`);
  add('💸','Rent Magnet', leaderOf(gameStats.rentPaid, ids), v=>`$${fmt(v)} paid out in rent`);
  add('🎲','Dice Wizard', leaderOf(gameStats.doublesRolled, ids), v=>`rolled doubles ${v} time${v===1?'':'s'}`);
  add('🚔','Repeat Offender', leaderOf(gameStats.jailVisits, ids), v=>`sent to jail ${v} time${v===1?'':'s'}`);
  add('🏗️','Master Builder', leaderOf(gameStats.housesBuilt, ids), v=>`built ${v} house${v===1?'':'s'}/hotels`);
  add('🔨','Auction Hound', leaderOf(gameStats.auctionsWon, ids), v=>`won ${v} auction${v===1?'':'s'}`);
  add('🏦','Salary Champion', leaderOf(gameStats.goSalary, ids), v=>`$${fmt(v)} collected passing GO`);
  add('🥊','Ruthless', leaderOf(gameStats.bankruptciesCaused, ids), v=>`bankrupted ${v} other player${v===1?'':'s'}`);
  // opposite-extreme awards: only worth showing if the field wasn't all zeros/ties
  const rentPaidTotal = Object.values(gameStats.rentPaid).reduce((a,b)=>a+b,0);
  if(rentPaidTotal>0){
    const safest = trailerOf(gameStats.rentPaid, ids);
    add('🧘','Safest Driver', safest, v=>v===0?"never paid a dime in rent":`kept rent down to just $${fmt(v)}`);
  }
  const jailTotal = Object.values(gameStats.jailVisits).reduce((a,b)=>a+b,0);
  if(jailTotal>0){
    const clean = trailerOf(gameStats.jailVisits, ids);
    if(clean && clean.val===0) add('😇','Clean Record', clean, ()=>'never once saw the inside of a jail cell');
  }
  if(gameStats.biggestRent){
    const {amt,payerId,ownerId,tileName} = gameStats.biggestRent;
    const payer=players[payerId], owner=players[ownerId];
    if(payer && owner){
      cards.push({icon:'💥', label:'Biggest Single Hit', name:`${payer.name} → ${owner.name}`, color:payer.color, value:`$${fmt(amt)} rent on ${tileName}`});
    }
  }
  const tileEntries = Object.entries(gameStats.tileLandings);
  if(tileEntries.length){
    tileEntries.sort((a,b)=>b[1]-a[1]);
    const [idxStr,count] = tileEntries[0];
    const tile = tiles[Number(idxStr)];
    if(tile && count>1) cards.push({icon:'📍', label:'Hottest Address', name:tile.name, color:'var(--text)', value:`landed on ${count} times`});
  }
  if(gameStats.tradesCompleted>0){
    cards.push({icon:'🤝', label:'Dealmaking', name:'This game', color:'var(--text)', value:`${gameStats.tradesCompleted} trade${gameStats.tradesCompleted===1?'':'s'} completed`});
  }
  return cards;
}
function renderSuperlatives(){
  const cards = buildSuperlatives();
  if(!cards.length) return '<div class="go-empty">Not enough happened this game for a highlight reel!</div>';
  return `<div class="go-superlatives">${cards.map(c=>
    `<div class="go-super-card">`
    +`<div class="go-super-icon">${c.icon}</div>`
    +`<div class="go-super-label">${escapeHtml(c.label)}</div>`
    +`<div class="go-super-name" style="color:${c.color}">${escapeHtml(c.name)}</div>`
    +`<div class="go-super-value">${escapeHtml(c.value)}</div>`
    +`</div>`
  ).join('')}</div>`;
}
function renderOwnershipSummary(){
  const owners={};
  tiles.forEach(t=>{ if(t.owner) (owners[t.owner]=owners[t.owner]||[]).push(t); });
  const ids = PLAYER_IDS.filter(id=>owners[id]&&owners[id].length);
  if(!ids.length) return '<div class="go-empty">No properties were purchased.</div>';
  return ids.map(id=>{
    const p=players[id];
    const chips=owners[id].map(t=>{
      const houseTag = t.houses>=5?' 🏨':(t.houses>0?` 🏠×${t.houses}`:'');
      const mort = t.mortgaged?' <span class="go-mort">(mortgaged)</span>':'';
      return `<span class="go-prop-chip">${t.flag?t.flag+' ':''}${escapeHtml(t.name)}${houseTag}${mort}</span>`;
    }).join('');
    return `<div class="go-owner-row"><div class="go-owner-name" style="color:${p.color}">${escapeHtml(p.name)}</div><div class="go-prop-chips">${chips}</div></div>`;
  }).join('');
}
function openGameOverSummary(){
  if(!gameOver) return;
  const title=document.getElementById('gameOverTitle');
  if(title){
    const winners = (gameWinnerIds.length?gameWinnerIds:(gameWinnerId?[gameWinnerId]:[])).filter(id=>players[id]);
    if(winners.length){
      const names = winners.map(id=>`<span style="color:${players[id].color}">${escapeHtml(players[id].name)}</span>`).join(' &amp; ');
      title.innerHTML = `🏆 ${names} ${winners.length>1?'win':'wins'}!`;
    } else {
      title.innerHTML = '🏁 Game over';
    }
  }
  const body=document.getElementById('gameOverBody');
  if(body){
    body.innerHTML =
      `<div class="go-section-title">Final standings</div>`
      +`<div class="go-standings">${renderStandings()}</div>`
      +`<div class="go-section-title">Highlights</div>`
      +renderSuperlatives()
      +`<div class="go-section-title">Net worth over time</div>`
      +`<div class="go-chart">${buildNetWorthChartSVG()}</div>`
      +`<div class="go-legend">${renderChartLegend()}</div>`
      +`<div class="go-section-title">Who owned what</div>`
      +`<div class="go-ownership">${renderOwnershipSummary()}</div>`;
  }
  const playAgainBtn=document.getElementById('gameOverPlayAgainBtn');
  const newGameBtn=document.getElementById('gameOverNewGameBtn');
  if(playAgainBtn && newGameBtn){
    if(NET.online && NET.host){
      // host: offer a real rematch (same room, same players, nobody disconnected) as the
      // primary action, and keep "New game" around as the harder "tear the room down" option
      playAgainBtn.style.display='';
      newGameBtn.textContent='End room';
    } else if(NET.online && !NET.host){
      // guest: can't restart the room themselves, but clicking "Play again" casts a visible
      // vote the host can see (refreshGameOverRematchUI) — they'll still be pulled into the
      // lobby automatically the moment the host actually starts it, whether or not they voted.
      // "New game" stays as their way to leave for good if they don't want to wait.
      playAgainBtn.style.display='';
      newGameBtn.textContent='Leave';
    } else {
      playAgainBtn.style.display='none';
      newGameBtn.textContent='New game';
    }
  }
  document.getElementById('gameOverOverlay').classList.add('show');
  refreshGameOverRematchUI();
}
window.openGameOverSummary=openGameOverSummary;
/* Drives the "Play again" button and the hint line beneath it. Re-run on every
   openGameOverSummary() and after every state sync (see refreshUI) so the host's vote
   count and a guest's own button label stay live as people click around. Does nothing
   if the summary isn't currently open — no point updating hidden UI on every sync. */
function refreshGameOverRematchUI(){
  const overlay=document.getElementById('gameOverOverlay');
  const hint=document.getElementById('gameOverRematchHint');
  const playAgainBtn=document.getElementById('gameOverPlayAgainBtn');
  if(!overlay || !overlay.classList.contains('show') || !hint || !playAgainBtn) return;
  if(!NET.online){ hint.style.display='none'; return; }
  if(NET.host){
    const guestIds = PLAYER_IDS.filter(pid=>pid!=='p1' && players[pid] && players[pid].active);
    const votes = guestIds.filter(pid=>players[pid].wantsRematch).length;
    if(guestIds.length){
      hint.style.display='';
      hint.textContent = `${votes} of ${guestIds.length} other player${guestIds.length===1?'':'s'} want${guestIds.length===1?'s':''} to play again.`;
    } else {
      hint.style.display='none';
    }
  } else {
    const iVoted = !!(players[youAre] && players[youAre].wantsRematch);
    playAgainBtn.textContent = iVoted ? '✓ Want to play again' : 'Play again';
    hint.style.display='';
    hint.textContent = iVoted ? "You're in — waiting for the host to start a new game…" : "Let the host know you'd like another round.";
  }
}
window.refreshGameOverRematchUI=refreshGameOverRematchUI;
/* Single entry point for the "Play again" button's onclick, since what it should
   actually DO depends on whether you're the host (restart the room right now) or a
   guest (just cast/retract your rematch vote — see refreshGameOverRematchUI). */
function gameOverPlayAgainClicked(){
  if(NET.online && !NET.host) toggleWantsRematch();
  else returnToLobbyForAll(); // host, or local/offline (returnToLobbyForAll already handles the offline case itself)
}
window.gameOverPlayAgainClicked=gameOverPlayAgainClicked;
function closeGameOverSummary(){
  document.getElementById('gameOverOverlay').classList.remove('show');
}
window.closeGameOverSummary=closeGameOverSummary;

/* ---- always-available auction panel (start an auction on anything you own — a
   property or a card, mixed together in one go) ---- */
let auctionPanelPicked = { props: new Set(), cards: new Set() }; // selection state for the big picker below; reset fresh every time the panel opens
function toggleAuctionPanel(){
  if(busy&&!isDebtor(youAre)&&!isAwaitingBuy(youAre)) return;
  const panel = document.getElementById('auctionPanel');
  if(panel.classList.contains('show')){ panel.classList.remove('show'); return; }
  document.getElementById('loanPanel').classList.remove('show');
  auctionPanelPicked = { props: new Set(), cards: new Set() };
  renderAuctionPanel(youAre);
  panel.classList.add('show');
}
function toggleAuctionPropPick(idx){
  if(auctionPanelPicked.props.has(idx)) auctionPanelPicked.props.delete(idx); else auctionPanelPicked.props.add(idx);
  renderAuctionPanel(youAre);
}
function toggleAuctionCardPick(type){
  if(auctionPanelPicked.cards.has(type)) auctionPanelPicked.cards.delete(type); else auctionPanelPicked.cards.add(type);
  renderAuctionPanel(youAre);
}
function renderAuctionPanel(pid){
  const body = document.getElementById('auctionPanelBody');
  const player = players[pid];
  const owned = tiles.map((t,i)=>({t,i})).filter(x=>ownedByUnit(x.t,pid)); // IN TEAMS: teammates' deeds are auctionable from the shared pool too
  const auctionableProps = owned.filter(({t})=>!groupHasBuilding(t) && !(t.frozenTurns>0));
  const ownedCardTypes = POWER_CARDS.filter(def => CARD_FIELD[def.type] && player && (player[CARD_FIELD[def.type]]||0) > 0);

  let html = `<div class="pc-hint">Pick anything you own — properties, cards, or both — to put up for auction together. Everyone else gets a chance to bid.</div>`;

  html += `<div class="mgmt-section-label" style="margin-top:0;">Your properties</div>`;
  if(!auctionableProps.length){
    html += `<div class="trade-empty">No eligible properties — must be unfrozen, with no houses anywhere in their group.</div>`;
  } else {
    html += `<div class="trade-prop-list">` + auctionableProps.map(({t,i})=>{
      const flag = t.group ? flagIconHTML(t.group,22) : (t.icon==='rail'?'&#128646;':t.icon==='util'?'&#9889;':'&#127987;');
      const selected = auctionPanelPicked.props.has(i);
      const sub = t.mortgaged ? 'Mortgaged' : t.icon==='rail'?'Railroad':t.icon==='util'?'Utility':'No houses';
      return `<div class="trade-prop-item ${selected?'selected':''}" onclick="toggleAuctionPropPick(${i})">
        <div class="trade-prop-left"><span class="trade-prop-flag">${flag}</span><div><div class="trade-prop-name">${t.name}</div><div class="trade-prop-sub">${sub}</div></div></div>
        <div class="trade-prop-price">${t.price}</div>
      </div>`;
    }).join('') + `</div>`;
  }

  html += `<div class="mgmt-section-label">Your cards</div>`;
  if(!ownedCardTypes.length){
    html += `<div class="trade-empty">You're not holding any cards right now.</div>`;
  } else {
    html += `<div class="trade-prop-list" style="margin-top:8px;">` + ownedCardTypes.map(def=>{
      const count = player[CARD_FIELD[def.type]]||0;
      const selected = auctionPanelPicked.cards.has(def.type);
      return `<div class="trade-prop-item ${selected?'selected':''}" onclick="toggleAuctionCardPick('${def.type}')">
        <div class="trade-prop-left"><span class="trade-prop-flag">${def.glyph}</span><div><div class="trade-prop-name">${def.title}</div><div class="trade-prop-sub">Own ${count}</div></div></div>
      </div>`;
    }).join('') + `</div>`;
  }

  const pickedCount = auctionPanelPicked.props.size + auctionPanelPicked.cards.size;
  html += `<div class="mgmt-row" style="align-items:flex-end;margin-top:12px;">
      <div class="bp-info" style="flex:1;">
        <label style="display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;">Starting bid</label>
        <input type="number" id="ownAuctionStartBid-auc" min="10" step="10" value="50" style="width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px;box-sizing:border-box;">
      </div>
      <div class="bp-info" style="flex:1;">
        <label style="display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;">Timer</label>
        <select id="ownAuctionTimer-auc" style="width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px;">
          <option value="3">3s</option>
          <option value="6" selected>6s</option>
          <option value="9">9s</option>
        </select>
      </div>
    </div>
    <button class="buy-btn yes" style="width:100%;margin-top:8px;" ${pickedCount?'':'disabled'} onclick="startAuctionFromPanel('${pid}')">Start auction${pickedCount?` (${pickedCount})`:''}</button>`;

  body.innerHTML = html;
}
function startAuctionFromPanel(pid){
  const items = [...auctionPanelPicked.props, ...[...auctionPanelPicked.cards].map(t=>'card:'+t)];
  if(items.length===0) return;
  const startBid = Math.max(10, parseInt(document.getElementById('ownAuctionStartBid-auc')?.value)||10);
  const timerSec = parseInt(document.getElementById('ownAuctionTimer-auc')?.value) || CONFIG.auctionTimerSec;
  startCombinedAuction(pid, items, startBid, timerSec);
}
// Mirrors startAuctionFromPanel, but for the (separate) Manage panel's own
// properties-only copy of this UI (see startOwnAuction below) — untouched by the
// combined props+cards picker above.
function startOwnAuctionFromManage(pid){
  const checks = [...document.querySelectorAll('#managePanel .auctionPick:checked')].map(el=>parseInt(el.value)).filter(Number.isInteger);
  if(checks.length===0) return;
  const startBid = Math.max(10, parseInt(document.getElementById('ownAuctionStartBid-mgmt')?.value)||10);
  const timerSec = parseInt(document.getElementById('ownAuctionTimer-mgmt')?.value) || CONFIG.auctionTimerSec;
  startOwnAuction(pid, checks, startBid, timerSec);
}
function refreshAuctionPanelIfOpen(){
  const panel = document.getElementById('auctionPanel');
  if(panel && panel.classList.contains('show')) renderAuctionPanel(youAre);
}

/* ---- always-available loan panel (borrow from / repay the bank) ---- */
function toggleLoanPanel(){
  if(busy&&!isDebtor(youAre)&&!isAwaitingBuy(youAre)) return;
  const panel = document.getElementById('loanPanel');
  if(panel.classList.contains('show')){ panel.classList.remove('show'); return; }
  document.getElementById('auctionPanel').classList.remove('show');
  renderLoanPanel(youAre);
  panel.classList.add('show');
}
// fixed loan tiers a player can pick from, instead of mashing one button to
// pile up debt $200 at a time
const LOAN_STEPS = [100, 200, 500, 1000];
function loanAmountButtonsHTML(pid, room){
  if(room<=0) return `<div class="bp-info" style="margin-top:8px;">No room left to borrow.</div>`;
  const amounts = LOAN_STEPS.filter(a=>a<room);
  amounts.push(room); // always offer "borrow the rest" as the top tier
  return `<div class="loan-amt-row">${amounts.map(a=>
    `<button class="loan-amt-btn" onclick="borrowLoan('${pid}', ${a})">+$${fmt(a)}</button>`
  ).join('')}</div>`;
}
function renderLoanPanel(pid){
  const body = document.getElementById('loanPanelBody');
  if(!CONFIG.loansEnabled){
    body.innerHTML = `<div class="bp-info">Bank loans are turned off in this game's rules.</div>`;
    return;
  }
  const owed = players[pid].loan||0;
  const termTurns = players[pid].loanTermTurns||0;
  const room = owed>0 ? 0 : CONFIG.loanLimit;
  const dueIfRepaid = owed>0 ? Math.round(owed*(1+CONFIG.loanInterestPct/100)) : 0;
  body.innerHTML = `<div class="mgmt-section-label" style="margin-top:0;">Bank loan</div>
    <div class="mgmt-row" style="border-bottom:none;flex-direction:column;align-items:stretch;gap:10px;">
      <div class="bp-info">Owed: <b>$${fmt(owed)}</b>${owed>0?` <span style="color:var(--text-dim);">($${fmt(dueIfRepaid)} incl. interest)</span>`:''}<br>${owed>0?`Repay your loan before borrowing again.<br><span style="color:var(--text-dim);">Auto-repaying over ${termTurns} more turn${termTurns===1?'':'s'}</span>`:`Room to borrow: $${fmt(room)} of $${fmt(CONFIG.loanLimit)}`}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        ${loanAmountButtonsHTML(pid, room)}
        <button class="buy-btn no" ${owed<=0?'disabled':''} onclick="repayLoan('${pid}')">Repay</button>
      </div>
    </div>`;
}
function refreshLoanPanelIfOpen(){
  const panel = document.getElementById('loanPanel');
  if(panel && panel.classList.contains('show')) renderLoanPanel(youAre);
}

/* ---- side bets ----
   A purely social wager between two players on the outcome of the active
   player's next dice roll — never touches properties, rent, or the bank.
   Anyone other than the roller can challenge them for one of three quick
   guesses (doubles, odd/even, over/under 7) at a preset wager amount right
   up until the dice are actually thrown. Win or lose, the cash moves
   directly between the two players involved. */
const SIDE_BET_TYPES = [
  {type:'doubles',   label:'Doubles?',      options:[{guess:'yes',label:'Doubles'},{guess:'no',label:'No doubles'}]},
  {type:'parity',    label:'Odd or even?',  options:[{guess:'odd',label:'Odd'},{guess:'even',label:'Even'}]},
  {type:'overUnder', label:'Over/under 7?', options:[{guess:'over',label:'Over 7'},{guess:'under',label:'Under 7'}]},
];
function describeSideBet(sb){
  const t = SIDE_BET_TYPES.find(x=>x.type===sb.type);
  const opt = t && t.options.find(o=>o.guess===sb.guess);
  return opt ? opt.label.toLowerCase() : sb.type;
}
// current active roller's pending exposure — the most any one roll could cost them
// across every bet already placed against them — used both to render the panel's
// affordability and to keep a new bet from ever being able to push them negative.
function sideBetRollerExposure(rollerPid){
  return sideBets.filter(sb=>sb.roller===rollerPid).reduce((sum,sb)=>sum+sb.amount, 0);
}
function placeSideBet(pid, type, guess, amount){
  // pid must be the acting client's own seat — this also runs on the host from a
  // guest's network command (see executeHostCommand, which swaps youAre to the
  // real sender for the duration of the call), so trusting a bare pid argument
  // would let one player place a wager — and spend money — on another player's
  // behalf. Every other per-player action in this file re-checks pid===youAre
  // for the same reason; this one was missing it.
  if(pid !== youAre) return;
  if(!CONFIG.sideBetsEnabled || gameOver || busy) return;
  const rollerPid = order[turnIdx];
  const roller = players[rollerPid], bettor = players[pid];
  if(!roller || !bettor || pid===rollerPid) return; // can't bet against yourself
  if(!bettor.active || bettor.bankrupt || !roller.active || roller.bankrupt) return;
  if(sideBets.some(sb=>sb.bettor===pid && sb.roller===rollerPid)) return; // one live bet per bettor per roll
  amount = Math.max(0, Math.round(Number(amount))||0);
  if(!SIDE_BET_AMOUNTS.includes(amount)) return;
  if(amount > bettor.balance) return; // bettor must be able to cover a loss
  if(amount > roller.balance - sideBetRollerExposure(rollerPid)) return; // roller can never be pushed negative, even if every pending bet against them lands
  const def = SIDE_BET_TYPES.find(t=>t.type===type);
  if(!def || !def.options.some(o=>o.guess===guess)) return;
  const sb = {id:++sideBetIdSeq, bettor:pid, roller:rollerPid, type, guess, amount};
  sideBets.push(sb);
  log(`<span class="who" style="color:${bettor.color}">${bettor.name}</span> wagers <b>$${fmt(amount)}</b> against <span class="who" style="color:${roller.color}">${roller.name}</span>'s roll — <b>${describeSideBet(sb)}</b>.`);
  refreshUI();
}
function cancelSideBet(pid){
  // same cross-player guard as placeSideBet above — without it, any player could
  // cancel a bet that someone else placed against them.
  if(pid !== youAre) return;
  const before = sideBets.length;
  sideBets = sideBets.filter(sb=>!(sb.bettor===pid && sb.roller===order[turnIdx]));
  if(sideBets.length!==before) refreshUI();
}
/* called from inside rollDice() once a/b are known, before the dice-landing
   animation's setTimeout resolves the tile itself — settles every bet placed
   against this roll, pays out directly between bettor and roller, and clears
   the window so the next roll (a bonus doubles roll, or the next player's
   turn) starts with a clean slate. */
function resolveSideBets(rollerPid, a, b, isDouble){
  const bets = sideBets.filter(sb=>sb.roller===rollerPid);
  sideBets = sideBets.filter(sb=>sb.roller!==rollerPid);
  if(!bets.length) return;
  const roller = players[rollerPid];
  const sum = a+b;
  bets.forEach(sb=>{
    const bettor = players[sb.bettor];
    if(!bettor || !roller) return;
    if(sb.type==='overUnder' && sum===7){
      log(`<span class="who" style="color:${bettor.color}">${bettor.name}</span>'s side bet against <span class="who" style="color:${roller.color}">${roller.name}</span> is a push — rolled exactly 7, $${fmt(sb.amount)} stays put.`);
      return;
    }
    let won;
    if(sb.type==='doubles') won = (sb.guess==='yes') === isDouble;
    else if(sb.type==='parity') won = sb.guess === (sum%2===0 ? 'even' : 'odd');
    else won = sb.guess === (sum>7 ? 'over' : 'under');
    if(won){
      bettor.balance += sb.amount;
      roller.balance -= sb.amount;
      log(`<span class="who" style="color:${bettor.color}">${bettor.name}</span> wins the <b>$${fmt(sb.amount)}</b> side bet off <span class="who" style="color:${roller.color}">${roller.name}</span> (${describeSideBet(sb)})!`);
    } else {
      bettor.balance -= sb.amount;
      roller.balance += sb.amount;
      log(`<span class="who" style="color:${roller.color}">${roller.name}</span> wins <span class="who" style="color:${bettor.color}">${bettor.name}</span>'s <b>$${fmt(sb.amount)}</b> side bet (${describeSideBet(sb)}).`);
    }
  });
  refreshUI();
}
function toggleSideBetPanel(){
  const panel = document.getElementById('sideBetPanel');
  if(!panel) return;
  if(panel.classList.contains('show')){ panel.classList.remove('show'); return; }
  document.getElementById('auctionPanel')?.classList.remove('show');
  document.getElementById('loanPanel')?.classList.remove('show');
  renderSideBetPanel();
  panel.classList.add('show');
}
function renderSideBetPanel(){
  const body = document.getElementById('sideBetPanelBody');
  if(!body) return;
  const rollerPid = order[turnIdx];
  const roller = players[rollerPid];
  if(!CONFIG.sideBetsEnabled || !roller || rollerPid===youAre){
    body.innerHTML = `<div class="bp-info">No bet to make right now.</div>`;
    return;
  }
  const mine = sideBets.find(sb=>sb.bettor===youAre && sb.roller===rollerPid);
  if(mine){
    body.innerHTML = `<div class="mgmt-section-label" style="margin-top:0;">Your side bet on ${roller.name}'s roll</div>
      <div class="bp-info">You wagered <b>$${fmt(mine.amount)}</b> on <b>${describeSideBet(mine)}</b>. Payout settles the instant they roll.</div>
      <button class="buy-btn no" style="width:100%;margin-top:8px;" onclick="cancelSideBet('${youAre}')">Cancel bet</button>`;
    return;
  }
  const me = players[youAre];
  const headroom = roller.balance - sideBetRollerExposure(rollerPid);
  body.innerHTML = `<div class="mgmt-section-label" style="margin-top:0;">Side bet against ${roller.name}'s roll</div>
    <div class="bp-info" style="margin-bottom:8px;">Pick a guess and a wager — win it off them, or pay up if you're wrong. Doesn't touch properties or rent.</div>
    ${SIDE_BET_TYPES.map(t=>`
      <div class="mgmt-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div class="bp-info"><b>${t.label}</b></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${t.options.map(o=>SIDE_BET_AMOUNTS.map(amt=>{
            const disabled = amt>me.balance || amt>headroom;
            return `<button class="loan-amt-btn" ${disabled?'disabled':''} title="${disabled?'Not enough cash to cover this on one or both sides':''}" onclick="placeSideBet('${youAre}','${t.type}','${o.guess}',${amt})">${o.label} $${fmt(amt)}</button>`;
          }).join('')).join('')}
        </div>
      </div>`).join('')}`;
}
function refreshSideBetPanelIfOpen(){
  const panel = document.getElementById('sideBetPanel');
  if(panel && panel.classList.contains('show')) renderSideBetPanel();
}

/* ---- house building panel ---- */
function toggleManage(){
  if(order[turnIdx] !== youAre || (busy&&!isDebtor(youAre)&&!isAwaitingBuy(youAre))) return; // only the active player, and not mid-action (but the buy/skip decision and debt-collection shouldn't block managing properties)
  const panel = document.getElementById('managePanel');
  if(panel.classList.contains('show')){ panel.classList.remove('show'); return; }
  renderManage(order[turnIdx]);
  panel.classList.add('show');
}
function renderManage(pid){
  const panel = document.getElementById('managePanel');
  const owned = tiles.map((t,i)=>({t,i})).filter(x=>ownedByUnit(x.t,pid)); // IN TEAMS: shows the whole team's properties, not just this player's own
  if(owned.length===0){
    panel.innerHTML = `<div class="bp-info">No properties owned yet.</div>`;
    return;
  }

  let html = '';

  if(isDebtor(pid)){
    const shortfall = -players[pid].balance;
    html += `<div class="bp-info" style="background:rgba(234,107,171,.12);border:1px solid var(--pink);border-radius:8px;padding:10px;margin-bottom:10px;color:var(--pink);">
      You're <b>$${fmt(shortfall)}</b> short. Mortgage properties or sell houses (below) to cover it before you can keep playing.
      <button class="buy-btn no" style="margin-top:8px;width:100%;" onclick="declareBankrupt('${pid}')">Declare bankruptcy instead</button>
    </div>`;
  }

  // --- house building ---
  const groups = {};
  tiles.forEach(t=>{ if(t.group && ownedByUnit(t,pid)) (groups[t.group]=groups[t.group]||[]).push(t); });
  const eligibleGroups = CONFIG.requireFullSetToBuild
    ? Object.keys(groups).filter(g=>ownsGroup(pid,g))
    : Object.keys(groups);
  if(eligibleGroups.length>0){
    html += `<div class="mgmt-section-label">Build houses</div>`;
    eligibleGroups.forEach(g=>{
      const groupMin = Math.min(...groups[g].map(x=>x.houses||0));
      groups[g].forEach(t=>{
        const houses = t.houses||0;
        const isFullSet = ownsGroup(pid,g);
        const label = houses>=5 ? 'Hotel built' : (houses===0 ? 'No houses' : houses+' house'+(houses===1?'':'s'));
        const cost = houseCost(t);
        const unevenBlock = CONFIG.evenBuildRule && houses>groupMin;
        const isFrozen = (t.frozenTurns||0)>0;
        const buildDisabled = houses>=5 || t.mortgaged || unevenBlock || isFrozen;
        const canSell = houses>0 && !isFrozen;
        html += `<div class="mgmt-row">
          <div class="bp-info"><b>${t.name}</b>${isFullSet?'<span class="mgmt-tag monopoly">Set</span>':''}${t.mortgaged?'<span class="mgmt-tag mortgaged">Mortgaged</span>':''}${isFrozen?`<span class="mgmt-tag" style="background:rgba(45,212,191,.16);color:var(--cyan);">&#10052;&#65039; Frozen (${t.frozenTurns})</span>`:''}<br>${label}${unevenBlock?' <span style="color:var(--text-dim);font-size:11px;">(build evenly first)</span>':''}${isFrozen?' <span style="color:var(--cyan);font-size:11px;">(frozen — no building/selling)</span>':''}</div>
          <div class="buy-actions">
            <button class="buy-btn no" ${houses>0?(canSell?'':'disabled'):'disabled style="visibility:hidden;"'} onclick="sellHouse('${t.name}')">Sell house (+$${Math.round(houseCost(t)/2/10)*10})</button>
            <button class="buy-btn yes" ${buildDisabled?'disabled':''} onclick="buildHouse('${t.name}')">+ Build ($${cost})</button>
          </div>
        </div>`;
      });
    });
  }

  // --- mortgage / unmortgage, available on any owned property ---
  html += `<div class="mgmt-section-label">Mortgage properties</div>`;
  owned.forEach(({t})=>{
    const isFrozen = (t.frozenTurns||0)>0;
    if(t.mortgaged){
      const cost = unmortgageCost(t);
      html += `<div class="mgmt-row">
        <div class="bp-info"><b>${t.name}</b><span class="mgmt-tag mortgaged">Mortgaged</span>${isFrozen?` <span style="color:var(--cyan);font-size:11px;">(frozen)</span>`:''}</div>
        <div class="buy-actions">
          <button class="buy-btn yes" ${isFrozen?'disabled title="Frozen — mortgage locked for now"':''} onclick="toggleMortgage('${t.name}')">Unmortgage ($${cost})</button>
        </div>
      </div>`;
    } else {
      const value = mortgageValue(t);
      const hasHouses = (t.houses||0)>0;
      const groupHasHouses = !hasHouses && t.group && groupTiles(t.group).some(x=>ownedByUnit(x,pid) && (x.houses||0)>0);
      const mortgageBlocked = hasHouses||groupHasHouses||isFrozen;
      html += `<div class="mgmt-row">
        <div class="bp-info"><b>${t.name}</b>${hasHouses?' <span style="color:var(--text-dim);font-size:11px;">(sell houses first)</span>':groupHasHouses?' <span style="color:var(--text-dim);font-size:11px;">(sell houses in the group first)</span>':''}${isFrozen?' <span style="color:var(--cyan);font-size:11px;">(frozen — mortgage locked)</span>':''}</div>
        <div class="buy-actions">
          <button class="buy-btn yes" ${mortgageBlocked?'disabled':''} onclick="toggleMortgage('${t.name}')">Mortgage (+$${value})</button>
        </div>
      </div>`;
    }
  });

  // --- run your own auction on unimproved properties you own (mortgaged is fine) ---
  const auctionable = owned.filter(({t})=>!groupHasBuilding(t) && !(t.frozenTurns>0));
  html += `<div class="mgmt-section-label">Auction your properties</div>`;
  if(auctionable.length===0){
    html += `<div class="bp-info" style="margin-bottom:8px;">No eligible properties — must be unfrozen, with no houses anywhere in their group.</div>`;
  } else {
    html += `<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px;">`;
    auctionable.forEach(({t,i})=>{
      html += `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text);cursor:pointer;">
        <input type="checkbox" class="auctionPick" value="${i}"> ${t.name}${t.mortgaged?' (mortgaged)':''}
      </label>`;
    });
    html += `</div>
      <div class="mgmt-row" style="align-items:flex-end;">
        <div class="bp-info" style="flex:1;">
          <label style="display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;">Starting bid</label>
          <input type="number" id="ownAuctionStartBid-mgmt" min="10" step="10" value="50" style="width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px;box-sizing:border-box;">
        </div>
        <div class="bp-info" style="flex:1;">
          <label style="display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;">Timer</label>
          <select id="ownAuctionTimer-mgmt" style="width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px;">
            <option value="3">3s</option>
            <option value="6" selected>6s</option>
            <option value="9">9s</option>
          </select>
        </div>
      </div>
      <button class="buy-btn yes" style="width:100%;margin-top:8px;" onclick="startOwnAuctionFromManage('${pid}')">Start auction</button>`;
  }

  // --- buy out the opponent's properties outright, if allowed anywhere ---
  if(CONFIG.buyoutEnabled && CONFIG.buyoutAnywhere){
    // list EVERY active opponent's eligible properties, not just whichever other
    // player happened to come first in PLAYER_IDS — with 3+ players that used to
    // silently hide every other opponent's properties from the buyout list, and it
    // could even pick a player who was never active in this game at all.
    const opponents = new Set(PLAYER_IDS.filter(x=>x!==pid && !sameTeam(x,pid) && players[x].active && !players[x].bankrupt)); // IN TEAMS: a teammate's property isn't an "opponent's" to buy out
    const theirs = tiles.map((t,i)=>({t,i})).filter(x=>opponents.has(x.t.owner) && (CONFIG.buyoutIncludesHouses || !(x.t.houses>0)));
    html += `<div class="mgmt-section-label">Buy out opponents' properties</div>`;
    if(theirs.length===0){
      html += `<div class="bp-info">Nothing eligible to buy out right now.</div>`;
    } else {
      theirs.forEach(({t,i})=>{
        const owner = players[t.owner];
        const price = parseInt(t.price.replace('$',''));
        const cost = price * CONFIG.buyoutMultiplier;
        const afford = players[pid].balance >= cost;
        const houseNote = t.houses>0 ? ` (${t.houses>=5?'hotel':t.houses+' house'+(t.houses===1?'':'s')})` : t.mortgaged ? ' (mortgaged)' : '';
        html += `<div class="mgmt-row">
          <div class="bp-info"><b>${t.name}</b>${houseNote}<br><span style="color:${owner.color};font-size:11px;">${owner.name}</span></div>
          <div class="buy-actions">
            <button class="buy-btn yes" ${afford?'':'disabled'} onclick="buyoutFromManage(${i})">Buy for $${fmt(cost)}</button>
          </div>
        </div>`;
      });
    }
  }

  // --- bank loans, if enabled for this game ---
  if(CONFIG.loansEnabled){
    const owed = players[pid].loan||0;
    const termTurns = players[pid].loanTermTurns||0;
    const room = owed>0 ? 0 : CONFIG.loanLimit;
    const dueIfRepaid = owed>0 ? Math.round(owed*(1+CONFIG.loanInterestPct/100)) : 0;
    html += `<div class="mgmt-section-label">Bank loan</div>
      <div class="mgmt-row" style="flex-direction:column;align-items:stretch;gap:10px;">
        <div class="bp-info">Owed: <b>$${fmt(owed)}</b>${owed>0?` <span style="color:var(--text-dim);">($${fmt(dueIfRepaid)} incl. interest)</span>`:''}<br>${owed>0?`Repay your loan before borrowing again.<br><span style="color:var(--text-dim);">Auto-repaying over ${termTurns} more turn${termTurns===1?'':'s'}</span>`:`Room to borrow: $${fmt(room)} of $${fmt(CONFIG.loanLimit)}`}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          ${loanAmountButtonsHTML(pid, room)}
          <button class="buy-btn no" ${owed<=0?'disabled':''} onclick="repayLoan('${pid}')">Repay</button>
        </div>
      </div>`;
  }

  panel.innerHTML = html;
}
function buyoutFromManage(idx){
  const pid = order[turnIdx];
  if(pid !== youAre || busy) return;
  if(performBuyout(idx, pid)){
    refreshUI();
    renderManage(pid);
  }
}
function borrowLoan(pid, amt){
  if(pid !== youAre || (busy&&!isDebtor(pid)&&!isAwaitingBuy(pid)) || !CONFIG.loansEnabled) return;
  const player = players[pid];
  const owed = player.loan||0;
  const room = owed>0 ? 0 : CONFIG.loanLimit;
  if(room<=0) return;
  const amount = Math.max(0, Math.min(Number(amt)||0, room));
  if(amount<=0) return;
  player.loan = owed + amount;
  // any new borrowing resets the auto-repay countdown — the (now larger) balance
  // owed gets spread evenly over a fresh 10 turns instead of the old schedule
  player.loanTermTurns = 10;
  player.balance += amount;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> borrows $${fmt(amount)} from the bank (now owes $${fmt(player.loan)}, auto-repaid over the next 10 turns).`);
  tryAutoFireLoanForgiveness(player); // held Loan Forgiveness can't be played by hand — it wipes this loan right away if they're holding one
  refreshUI();
  tryResumeAfterDebt(pid);
  renderManage(pid);
  refreshLoanPanelIfOpen();
}
function repayLoan(pid){
  if(pid !== youAre || (busy&&!isDebtor(pid)&&!isAwaitingBuy(pid))) return;
  const player = players[pid];
  const owed = player.loan||0;
  if(owed<=0) return;
  const totalDue = Math.round(owed*(1+CONFIG.loanInterestPct/100));
  const pay = Math.min(totalDue, player.balance);
  if(pay<=0){
    log(`<span class="who" style="color:${player.color}">${player.name}</span> doesn't have enough cash to repay any of their loan right now.`);
    return;
  }
  const principalPaid = pay/(1+CONFIG.loanInterestPct/100);
  player.loan = Math.max(0, Math.round(owed - principalPaid));
  player.balance -= pay;
  if(player.loan<=0){
    player.loan = 0;
    player.loanTermTurns = 0;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> fully repays their bank loan ($${fmt(pay)} incl. interest).`);
  } else {
    log(`<span class="who" style="color:${player.color}">${player.name}</span> repays $${fmt(pay)} toward their bank loan (still owes $${fmt(player.loan)}).`);
  }
  refreshUI();
  renderManage(pid);
}
/* automatic installment repayment — fires once for a player right as their own
   turn begins, for up to 10 turns after a loan (or top-up) is taken. Whatever
   is owed (principal + interest) at that point is spread evenly across the
   remaining turns in the schedule, so it fully clears right on schedule even if
   the player never touches the manual Repay button. Like rent or tax, a payment
   the player can't afford can push them into debt and pause the turn until they
   raise the cash. */
function applyAutoLoanRepayment(pid){
  const player = players[pid];
  if(!player || player.bankrupt || !CONFIG.loansEnabled) return;
  const owed = player.loan||0;
  if(owed<=0 || (player.loanTermTurns||0)<=0){
    player.loan = 0;
    player.loanTermTurns = 0;
    return;
  }
  const totalDue = Math.round(owed*(1+CONFIG.loanInterestPct/100));
  const installment = Math.min(totalDue, Math.ceil(totalDue/player.loanTermTurns));
  player.balance -= installment;
  const principalPaid = installment/(1+CONFIG.loanInterestPct/100);
  player.loan = Math.max(0, Math.round(owed - principalPaid));
  player.loanTermTurns = Math.max(0, player.loanTermTurns - 1);
  if(player.loan<=0){
    player.loan = 0;
    player.loanTermTurns = 0;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> auto-repays $${fmt(installment)} and fully pays off their bank loan.`);
  } else {
    log(`<span class="who" style="color:${player.color}">${player.name}</span> auto-repays $${fmt(installment)} toward their bank loan (still owes $${fmt(player.loan)}, ${player.loanTermTurns} turn${player.loanTermTurns===1?'':'s'} left).`);
  }
  refreshLoanPanelIfOpen();
}
function buildHouse(name){
  const pid = order[turnIdx];
  if(pid !== youAre) return;
  const player = players[pid];
  const t = tiles.find(x=>x.name===name && ownedByUnit(x,pid)); // IN TEAMS: any teammate's deed builds off the shared pool
  if(!t || (busy&&!isAwaitingBuy(pid))) return;
  if(t.mortgaged) return;
  if(t.frozenTurns>0) return; // Property Freeze: can't build here for now
  if(CONFIG.requireFullSetToBuild && !ownsGroup(pid, t.group)) return;
  if(CONFIG.evenBuildRule){
    const groupMin = Math.min(...groupTiles(t.group).filter(x=>ownedByUnit(x,pid)).map(x=>x.houses||0));
    if((t.houses||0) > groupMin) return;
  }
  const houses = t.houses||0;
  if(houses>=5) return;
  const cost = houseCost(t);
  if(player.balance < cost){
    log(`<span class="who" style="color:${player.color}">${player.name}</span> can't afford to build on <b>${t.name}</b>.`);
    return;
  }
  player.balance -= cost;
  t.houses = houses+1;
  bumpStat('housesBuilt', pid);
  log(`<span class="who" style="color:${player.color}">${player.name}</span> builds ${t.houses>=5?'a <b>hotel</b>':'a house'} on <b>${t.name}</b> (-$${cost}).`);
  refreshUI();
  renderManage(pid);
}
function sellHouse(name){
  const pid = order[turnIdx];
  if(pid !== youAre) return;
  const player = players[pid];
  const t = tiles.find(x=>x.name===name && ownedByUnit(x,pid)); // IN TEAMS: any teammate's deed sells off the shared pool
  if(!t || (busy&&!isDebtor(pid)&&!isAwaitingBuy(pid)) || !((t.houses||0)>0)) return;
  if(t.frozenTurns>0) return; // Property Freeze: can't sell houses off it for now
  if(CONFIG.evenBuildRule){
    const groupMax = Math.max(...groupTiles(t.group).filter(x=>ownedByUnit(x,pid)).map(x=>x.houses||0));
    if((t.houses||0) < groupMax) return; // must sell from the most-built property first
  }
  const refund = Math.round(houseCost(t)/2/10)*10;
  t.houses -= 1;
  player.balance += refund;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> sells a house on <b>${t.name}</b> for $${refund}.`);
  refreshUI();
  tryResumeAfterDebt(pid);
  renderManage(pid);
}
function toggleMortgage(name){
  const pid = youAre;
  const player = players[pid];
  const idx = tiles.findIndex(x=>x.name===name && ownedByUnit(x,pid)); // IN TEAMS: any teammate's deed can be (un)mortgaged from the shared pool
  if(idx===-1 || (busy&&!isDebtor(pid)&&!isAwaitingBuy(pid))) return;
  const t = tiles[idx];
  if(t.frozenTurns>0) return; // Property Freeze: mortgage status locked for now
  if(!t.mortgaged){
    // must sell houses before mortgaging — and not just on this tile: the same
    // rule applies group-wide, since a mortgaged property can't collect rent
    // and that would let houses sit safely on its street-mates while this one
    // ducks out of the risk they're supposed to share.
    if((t.houses||0)>0) return;
    if(t.group && groupTiles(t.group).some(x=>ownedByUnit(x,pid) && (x.houses||0)>0)) return;
    t.mortgaged = true;
    player.balance += mortgageValue(t);
    log(`<span class="who" style="color:${player.color}">${player.name}</span> mortgages <b>${t.name}</b> for $${mortgageValue(t)}.`);
  } else {
    const cost = unmortgageCost(t);
    if(player.balance < cost){
      log(`<span class="who" style="color:${player.color}">${player.name}</span> can't afford to lift the mortgage on <b>${t.name}</b> ($${cost}).`);
      return;
    }
    player.balance -= cost;
    t.mortgaged = false;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> pays $${cost} to lift the mortgage on <b>${t.name}</b>.`);
  }
  setMortgageVisual(idx, t.mortgaged);
  refreshUI();
  tryResumeAfterDebt(pid);
  renderManage(pid);
}

/* ---- trade panel ---- */
let tradeOffer = {a:null,b:null, sides:{}};
let activeTrades = [];
let tradeIdSeq = 1;
let expandedTrades = new Set(); // trade ids currently expanded in the Trades tab — collapsed by default
let negotiatingTradeId = null; // set while the compose modal is open as a counter-offer to an existing trade
/* ---- side bets: an optional player-vs-player wager on the ACTIVE player's
   upcoming roll, entirely separate from properties/rent. Anyone other than
   the roller can challenge them before the dice are thrown; see placeSideBet()
   and resolveSideBets() below. Cleared every time the active player's roll
   is resolved (win or lose), so the betting window only ever covers exactly
   one upcoming roll at a time. */
let sideBets = [];
let sideBetIdSeq = 1;
const SIDE_BET_AMOUNTS = [25, 50, 100];
function openTrade(targetPid){
  if(!targetPid || targetPid===youAre || gameOver || !players[targetPid]?.active || !players[youAre]?.active || players[targetPid]?.bankrupt || players[youAre]?.bankrupt) return;
  tradeOffer={a:youAre,b:targetPid,sides:{}}; tradeOffer.sides[youAre]={cash:0,props:new Set(),cards:{}}; tradeOffer.sides[targetPid]={cash:0,props:new Set(),cards:{}};
  renderTrade(); document.getElementById('tradeOverlay').classList.add('show'); playTradeOpenSound();
}
/* opened from the power cards hub's "Offer in trade" control — starts a normal
   trade with the chosen opponent, pre-loaded with one of the given card type
   already selected on your side, so you land straight on a ready-to-tweak offer
   instead of an empty one. */
function openTradeCardPreset(type,targetPid){
  openTrade(targetPid);
  if(tradeOffer.a!==youAre) return; // openTrade bailed (invalid target etc.)
  const owned=(players[youAre][CARD_FIELD[type]]||0);
  if(owned>0){ tradeOffer.sides[youAre].cards[type]=1; renderTrade(); }
}
function closeTrade(){
  document.getElementById('tradeOverlay').classList.remove('show');
  playTradeCloseSound();
  negotiatingTradeId = null;
  const btn=document.getElementById('tradeSendBtn'); if(btn) btn.textContent='Make offer';
  const title=document.getElementById('tradeModalTitle'); if(title) title.innerHTML='&#8646; Propose a trade';
}
/* Opens the compose modal pre-filled with the other side's existing offer, roles
   flipped so the person negotiating is proposing back — lets them nudge the cash,
   add/drop a property, etc. instead of only ever being able to accept-as-is or
   kill the whole thing with Decline. Nothing about the original trade changes
   until they actually send the counter (see submitTradeOffer()) — closing this
   modal without sending leaves the original offer exactly as it was. */
function negotiateTrade(id){
  const tr = activeTrades.find(t=>t.id===id);
  if(!tr) return;
  if(!tradeActiveVoters(tr).includes(youAre)) return; // only whoever the offer is addressed to can counter it
  tradeOffer = {a:youAre, b:tr.a, sides:{}};
  tradeOffer.sides[youAre] = {cash:tr.to.cash, props:new Set(tr.to.props), cards:{...tr.to.cards}};
  tradeOffer.sides[tr.a] = {cash:tr.from.cash, props:new Set(tr.from.props), cards:{...tr.from.cards}};
  negotiatingTradeId = id;
  renderTrade();
  const btn=document.getElementById('tradeSendBtn'); if(btn) btn.textContent='Send counter-offer';
  const title=document.getElementById('tradeModalTitle'); if(title) title.innerHTML=`&#8646; Counter ${players[tr.a].name}'s trade`;
  document.getElementById('tradeOverlay').classList.add('show');
  playTradeOpenSound();
}
/* the compose modal's single send button — behaves like the old plain sendTrade()
   for a brand-new offer, but when it's mid-negotiation also retires the trade
   being countered first so the two don't end up sitting active side by side. */
function submitTradeOffer(){
  if(negotiatingTradeId!=null){
    const id = negotiatingTradeId;
    negotiatingTradeId = null;
    declineTrade(id);
    sendTrade();
  } else {
    sendTrade();
  }
}
function toggleTradeExpand(id){
  if(expandedTrades.has(id)) expandedTrades.delete(id); else expandedTrades.add(id);
  renderTradesList();
}
/* short human status for the collapsed row — who's actually got the ball right now */
function tradeStatusLabel(tr){
  const voters = tradeActiveVoters(tr), votes = tr.votes||{};
  if(voters.length<=1){
    return youAre===voters[0] ? 'Awaiting your response' : `Waiting for ${players[voters[0]].name}`;
  }
  const votedCount = voters.filter(id=>votes[id]==='accept').length;
  if(voters.includes(youAre) && !Object.prototype.hasOwnProperty.call(votes,youAre)) return 'Awaiting your vote';
  return `${votedCount}/${voters.length} teammates voted`;
}
function toggleTradeProp(pid,idx){const t=tiles[idx];if(groupHasBuilding(t))return;if((t.frozenTurns||0)>0)return;const set=tradeOffer.sides[pid].props;if(set.has(idx))set.delete(idx);else set.add(idx);renderTrade();}
function setTradeCash(pid,val){tradeOffer.sides[pid].cash=Math.max(0,Math.min(players[pid].balance,parseInt(val)||0));const el=document.getElementById('tradeCashAmt-'+pid);if(el)el.value=tradeOffer.sides[pid].cash;}
/* how many of a given power-card type pid currently holds — trade quantities
   are capped at this so an offer can never exceed what's actually owned. */
function tradeCardOwned(pid,type){ return (players[pid]&&players[pid][CARD_FIELD[type]])||0; }
function adjustTradeCard(pid,type,delta){
  const owned=tradeCardOwned(pid,type);
  const cur=tradeOffer.sides[pid].cards[type]||0;
  const next=Math.max(0,Math.min(owned,cur+delta));
  if(next===0) delete tradeOffer.sides[pid].cards[type]; else tradeOffer.sides[pid].cards[type]=next;
  renderTrade();
}
function tradePropRow(pid,idx){const t=tiles[idx],selected=tradeOffer.sides[pid].props.has(idx),hasHouses=(t.houses||0)>0,groupBuilt=groupHasBuilding(t),isFrozen=(t.frozenTurns||0)>0,disabled=groupBuilt||isFrozen,sub=t.mortgaged?'Mortgaged':hasHouses?(t.houses>=5?'Hotel built':`${t.houses} house${t.houses===1?'':'s'}`):isFrozen?'Frozen':groupBuilt?'Group has a building':(t.icon==='rail'?'Railroad':t.icon==='util'?'Utility':'No houses'),flag=t.group?flagIconHTML(t.group,22):(t.icon==='rail'?'🚆':t.icon==='util'?'⚡':'🏳️');return `<div class="trade-prop-item ${selected?'selected':''} ${disabled?'disabled':''}" ${isFrozen?'title="Frozen — can\'t be traded for now"':groupBuilt?'title="A property in this group has a building on it — sell every house/hotel in the group back to the bank before trading any of them"':''} onclick="toggleTradeProp('${pid}',${idx})"><div class="trade-prop-left"><span class="trade-prop-flag">${flag}</span><div><div class="trade-prop-name">${t.name}</div><div class="trade-prop-sub">${sub}${groupBuilt?' — sell houses first':isFrozen?' — frozen':''}</div></div></div><div class="trade-prop-price">${t.price}</div></div>`;}
function tradeCardRow(pid,type){
  const def=POWER_CARDS.find(c=>c.type===type);
  const owned=tradeCardOwned(pid,type);
  const sel=tradeOffer.sides[pid].cards[type]||0;
  return `<div class="trade-prop-item ${sel>0?'selected':''}" style="cursor:default;"><div class="trade-prop-left"><span class="trade-prop-flag">${def.glyph}</span><div><div class="trade-prop-name">${def.title}</div><div class="trade-prop-sub">Own ${owned}</div></div></div><div style="display:flex;align-items:center;gap:6px;" onclick="event.stopPropagation();"><button type="button" class="pc-step-btn" onclick="adjustTradeCard('${pid}','${type}',-1)">&minus;</button><span style="min-width:14px;text-align:center;font-weight:700;">${sel}</span><button type="button" class="pc-step-btn" onclick="adjustTradeCard('${pid}','${type}',1)">+</button></div></div>`;
}
function renderTrade(){let html='';[tradeOffer.a,tradeOffer.b].forEach(pid=>{const p=players[pid],side=tradeOffer.sides[pid],owned=tiles.map((t,i)=>({t,i})).filter(x=>ownedByUnit(x.t,pid)),cardTypes=POWER_CARDS.filter(c=>tradeCardOwned(pid,c.type)>0);html+=`<div class="trade-side" style="color:${p.color}"><div class="trade-side-head"><div class="trade-avatar"><model-viewer class="avatar-car-mv" src="${CAR_MODELS[p.car]||CAR_MODELS[CAR_LIST[0].key]}" disable-zoom interaction-prompt="none" camera-orbit="-35deg 72deg auto" field-of-view="14deg" exposure="1.2" environment-image="neutral" loading="eager"></model-viewer></div><div class="trade-side-name">${p.name}</div></div><div class="trade-section-label">Cash</div><div class="trade-cash-row"><span class="trade-cash-sign">$</span><input class="trade-cash-input" id="tradeCashAmt-${pid}" type="number" min="0" max="${p.balance}" step="5" value="${side.cash}" oninput="setTradeCash('${pid}',this.value)"><span class="trade-balance">of $${fmt(p.balance)}</span></div><div class="trade-section-label">Properties</div><div class="trade-prop-list">${owned.length?owned.map(x=>tradePropRow(pid,x.i)).join(''):'<div class="trade-empty">No properties owned.</div>'}</div>${cardTypes.length?`<div class="trade-section-label">Power cards</div><div class="trade-prop-list">${cardTypes.map(c=>tradeCardRow(pid,c.type)).join('')}</div>`:''}</div>`;});document.getElementById('tradeSides').innerHTML=html;}
function sendTrade(){const a=tradeOffer.a,b=tradeOffer.b,sa=tradeOffer.sides[a],sb=tradeOffer.sides[b];const saCards=Object.values(sa.cards||{}).reduce((x,y)=>x+y,0),sbCards=Object.values(sb.cards||{}).reduce((x,y)=>x+y,0);if(!a||!b||(sa.cash===0&&sb.cash===0&&sa.props.size===0&&sb.props.size===0&&saCards===0&&sbCards===0)){closeTrade();return;}/* IN TEAMS: an incoming trade is decided by the whole team, not just the one player it
   was addressed to — every still-active teammate of the recipient (b) has to vote accept
   before it goes through, and any single decline kills it. Solo (or teams disabled) just
   falls back to voters:[b], which behaves exactly like the old one-person accept/decline. */
const voters=(CONFIG.teamsEnabled?teammatesOf(b,true):[b]).filter(id=>players[id]&&players[id].active&&!players[id].bankrupt);
activeTrades.push({id:tradeIdSeq++,a,b,from:{cash:sa.cash,props:[...sa.props],cards:{...sa.cards}},to:{cash:sb.cash,props:[...sb.props],cards:{...sb.cards}},voters:voters.length?voters:[b],votes:{}});log(`<span class="who" style="color:${players[a].color}">${players[a].name}</span> offered a trade to <span class="who" style="color:${players[b].color}">${players[b].name}</span>.`);playTradeSound();updateTradesTabCount();renderTradesList();closeTrade();}
function tradeGiveSummary(side){
  // Plain itemized list — no counts, no "N items" badge. What matters here is
  // WHAT's being given, not a number that invites comparing the two sides like
  // a scoreboard (that's how a fair 1-for-3 trade reads as a "mismatch").
  const items = side.props.map(i=>{
    const t=tiles[i];
    const flag=t.group?flagIconHTML(t.group,18):(t.icon==='rail'?'🚆':t.icon==='util'?'⚡':'🏳️');
    return `<div class="trade-give-item">${flag}<span>${t.name}</span></div>`;
  });
  Object.entries(side.cards||{}).forEach(([type,n])=>{
    if(!(n>0)) return;
    const def=POWER_CARDS.find(c=>c.type===type);
    for(let i=0;i<n;i++) items.push(`<div class="trade-give-item">${def?def.glyph:'🎴'}<span>${def?def.title:type}</span></div>`);
  });
  if(side.cash>0) items.unshift(`<div class="trade-give-item"><span class="trade-give-cash-ic">$</span><span>${fmt(side.cash)} cash</span></div>`);
  if(!items.length) return '<div class="trade-empty" style="padding:0;">Nothing</div>';
  return `<div class="trade-give-list">${items.join('')}</div>`;
}
/* Collapsed by default: a trade card only shows who it's between and its status
   (see tradeStatusLabel) — tap it to expand in place and see what's actually being
   offered, plus Accept / Decline / Negotiate. Nothing here compares side sizes or
   flags a "mismatch"; a trade can be one property for three and that's fine. */
function renderTradesList(){
  const body=document.getElementById('tradesBody');if(!body)return;
  if(!activeTrades.length){body.innerHTML='<div class="trades-empty">No active trades right now.</div>';return;}
  body.innerHTML=activeTrades.map(tr=>{
    const expanded=expandedTrades.has(tr.id);
    const details=expanded?`<div class="trade-card-body"><div class="trade-card-side"><div class="trade-card-label">${players[tr.a].name} offers</div>${tradeGiveSummary(tr.from)}</div><div class="trade-card-side"><div class="trade-card-label">${players[tr.b].name} offers</div>${tradeGiveSummary(tr.to)}</div></div>${tradeVoteHTML(tr)}`:'';
    return `<div class="trade-card ${expanded?'expanded':''}">`+
      `<div class="trade-card-head" onclick="toggleTradeExpand(${tr.id})">`+
        `<div class="trade-card-title"><span style="color:${players[tr.a].color}">${players[tr.a].name}</span><span class="trade-vs">&#8646;</span><span style="color:${players[tr.b].color}">${players[tr.b].name}</span></div>`+
        `<div class="trade-card-status">${tradeStatusLabel(tr)}</div>`+
        `<span class="trade-card-chevron">&#8250;</span>`+
      `</div>${details}</div>`;
  }).join('');
}
function updateTradesTabCount(){const t=document.getElementById('tradesTab');if(t)t.textContent=`Trades (${activeTrades.length})`;}
function switchTab(tab){const tradesTab=document.getElementById('tradesTab'),historyTab=document.getElementById('historyTab'),chatBody=document.getElementById('chatBody'),tradesBody=document.getElementById('tradesBody');if(!tradesTab||!historyTab||!chatBody||!tradesBody)return;const showTrades=tab==='trades';tradesTab.classList.toggle('active',showTrades);historyTab.classList.toggle('active',!showTrades);tradesBody.style.display=showTrades?'flex':'none';chatBody.style.display=showTrades?'none':'';}
/* IN TEAMS: who currently has to weigh in on a trade addressed to tr.b — normally just
   tr.b, but in team mode it's every still-active, non-bankrupt teammate captured in
   tr.voters at offer time. Recomputed live (not just read off tr.voters) so a teammate
   who goes bankrupt or drops mid-vote doesn't hold the rest of the team hostage. */
function tradeActiveVoters(tr){
  const base=(tr.voters&&tr.voters.length)?tr.voters:[tr.b];
  const live=base.filter(id=>players[id]&&players[id].active&&!players[id].bankrupt);
  return live.length?live:[tr.b];
}
/* Renders either the classic single accept/decline (solo recipient, or teams disabled)
   or the team merge-vote UI: a tally of every teammate's vote, plus Accept/Decline
   buttons only for the local player if they still owe a vote. Unanimous accept triggers
   the trade; any single decline kills it for the whole team immediately. */
function tradeVoteHTML(tr){
  const voters=tradeActiveVoters(tr),votes=tr.votes||{};
  // Negotiate is only offered to the person the trade was addressed to (tr.a is
  // the proposer and has nothing to negotiate against on their own open offer).
  const negotiateBtn=youAre===tr.a?'':`<button class="buy-btn negotiate" onclick="negotiateTrade(${tr.id})">Negotiate</button>`;
  if(voters.length<=1){
    if(youAre!==voters[0]) return `<div class="trade-vote-status">Waiting for ${players[voters[0]].name} to respond.</div>`;
    return `<div class="trade-card-actions"><button class="buy-btn yes" onclick="acceptTrade(${tr.id})">Accept</button><button class="buy-btn no" onclick="declineTrade(${tr.id})">Decline</button>${negotiateBtn}</div>`;
  }
  const rows=voters.map(id=>{const v=votes[id],chip=v==='accept'?'<span class="trade-vote-chip yes">&#10003; Accept</span>':v==='decline'?'<span class="trade-vote-chip no">&#10007; Decline</span>':'<span class="trade-vote-chip pending">Voting&hellip;</span>';return `<div class="trade-vote-row"><span style="color:${players[id].color}">${players[id].name}</span>${chip}</div>`;}).join('');
  const iVoted=Object.prototype.hasOwnProperty.call(votes,youAre);
  const actions=(voters.includes(youAre)&&!iVoted)?`<div class="trade-card-actions"><button class="buy-btn yes" onclick="acceptTrade(${tr.id})">Vote accept</button><button class="buy-btn no" onclick="declineTrade(${tr.id})">Vote decline</button>${negotiateBtn}</div>`:'';
  return `<div class="trade-vote-status"><div class="trade-vote-label">Team merge vote &mdash; everyone must accept</div>${rows}</div>${actions}`;
}
function acceptTrade(id){
  const ix=activeTrades.findIndex(t=>t.id===id);
  if(ix<0)return;
  const tr=activeTrades[ix];
  const voters=tradeActiveVoters(tr);
  if(!voters.includes(youAre))return;
  tr.votes=tr.votes||{};
  tr.votes[youAre]='accept';
  if(voters.length>1){
    log(`<span class="who" style="color:${players[youAre].color}">${players[youAre].name}</span> voted to accept the trade from <span class="who" style="color:${players[tr.a].color}">${players[tr.a].name}</span>.`);
    if(!voters.every(vid=>tr.votes[vid]==='accept')){ renderTradesList(); refreshUI(); return; } // still waiting on teammates
  }
  finalizeAcceptedTrade(tr.id);
}
function finalizeAcceptedTrade(id){
  const ix=activeTrades.findIndex(t=>t.id===id);
  if(ix<0)return;
  const tr=activeTrades[ix];
  const a=players[tr.a],b=players[tr.b];
  const invalidate=(reason)=>{activeTrades.splice(ix,1);updateTradesTabCount();renderTradesList();log(`Trade between ${a.name} and ${b.name} fell through — ${reason}.`);refreshUI();};
  // re-validate against the current game state: cash, ownership, and house-free status
  // may all have changed since the offer was made and sitting untouched in the queue
  if(tr.from.cash>a.balance||tr.to.cash>b.balance) return invalidate('one side no longer has the cash');
  if(a.bankrupt||b.bankrupt) return invalidate('a player involved went bankrupt');
  for(const i of tr.from.props){ if(!ownedByUnit(tiles[i],tr.a)||groupHasBuilding(tiles[i])||(tiles[i].frozenTurns||0)>0) return invalidate(`${tiles[i].name} is no longer tradeable`); }
  for(const i of tr.to.props){ if(!ownedByUnit(tiles[i],tr.b)||groupHasBuilding(tiles[i])||(tiles[i].frozenTurns||0)>0) return invalidate(`${tiles[i].name} is no longer tradeable`); }
  // cards can have been spent or auctioned off since the offer was made — re-check
  // both sides still actually hold what they offered before touching any state
  for(const [type,n] of Object.entries(tr.from.cards||{})){ if(n>0 && (a[CARD_FIELD[type]]||0)<n) return invalidate('a power card in the offer is no longer available'); }
  for(const [type,n] of Object.entries(tr.to.cards||{})){ if(n>0 && (b[CARD_FIELD[type]]||0)<n) return invalidate('a power card in the offer is no longer available'); }
  a.balance+=tr.to.cash-tr.from.cash;b.balance+=tr.from.cash-tr.to.cash;
  tr.from.props.forEach(i=>{tiles[i].owner=tr.b;markOwnership(i,teamDisplayColor(tr.b));pulseTile(i,teamDisplayColor(tr.b));});
  tr.to.props.forEach(i=>{tiles[i].owner=tr.a;markOwnership(i,teamDisplayColor(tr.a));pulseTile(i,teamDisplayColor(tr.a));});
  for(const [type,n] of Object.entries(tr.from.cards||{})){ if(n>0){ a[CARD_FIELD[type]]-=n; b[CARD_FIELD[type]]=(b[CARD_FIELD[type]]||0)+n; } }
  for(const [type,n] of Object.entries(tr.to.cards||{})){ if(n>0){ b[CARD_FIELD[type]]-=n; a[CARD_FIELD[type]]=(a[CARD_FIELD[type]]||0)+n; } }
  activeTrades.splice(ix,1);updateTradesTabCount();renderTradesList();
  gameStats.tradesCompleted = (gameStats.tradesCompleted||0)+1;
  log(`${a.name} and ${b.name} completed a trade.`);
  // Bankruptcy Insurance / Loan Forgiveness can't be manually played — if a traded-in
  // copy lands on a side that's already in the situation it fixes, it fires right now
  // instead of waiting for the condition to happen again later.
  tryAutoFireInsuranceOnReceive(tr.a); tryAutoFireInsuranceOnReceive(tr.b);
  tryAutoFireLoanForgiveness(a); tryAutoFireLoanForgiveness(b);
  refreshUI();
}
function declineTrade(id){
  const ix=activeTrades.findIndex(t=>t.id===id);
  if(ix<0)return;
  const tr=activeTrades[ix];
  const voters=tradeActiveVoters(tr);
  if(!voters.includes(youAre))return;
  activeTrades.splice(ix,1);updateTradesTabCount();renderTradesList();
  const note=voters.length>1?` &mdash; ${players[youAre].name} voted no`:'';
  log(`${players[tr.a].name}'s trade to ${players[tr.b].name} was declined${note}.`);
  refreshUI();
}

function fmt(n){ return n.toLocaleString('en-US'); }

/* ---- balance roll-up counter -------------------------------------------
   Player-card cash used to just snap to the new number on every refreshUI()
   call. This counts the displayed digits smoothly from the old value to the
   new one instead, so a rent payment, purchase, or GO bonus reads as a
   number visibly ticking up/down rather than jumping. Keyed per player id
   so each card animates independently; re-triggering mid-count (e.g. two
   quick balance changes) cancels the old frame and restarts from wherever
   the digits currently are, so it never jumps backward or fights itself. */
const balRollState = {};   // pid -> last value we've rendered/animated to
const balRollFrames = {};  // pid -> active requestAnimationFrame id
const balRollDebounce = {}; // pid -> pending setTimeout id waiting to actually kick off an animation
/* Online games call refreshUI() (and therefore this) many times in quick succession
   for a single real change — once right after the action itself, then again on every
   ~300ms host poll while anything in the wider state is still settling (auction
   timers, token animation, etc.). Each of those calls used to restart the count
   animation from wherever the digits currently sat mid-flight, so a single payout
   or bail payment could visibly stutter through 2-3 short animations back to back
   instead of one clean count — reading as the balance "randomly changing" before
   it settled. Debouncing here so a burst of calls within a short window collapses
   into a single animation, from the value that was on screen BEFORE the burst
   started straight to the last (i.e. truly final) value in that burst. */
function rollBalance(pid, el, newVal){
  if(!el) return;
  const prevTarget = balRollState[pid];
  if(prevTarget === undefined){
    // first paint for this card — nothing to count from, just show it
    balRollState[pid] = newVal;
    el.textContent = fmt(newVal);
    return;
  }
  if(prevTarget === newVal) return; // unchanged since last frame — leave any running count alone
  balRollState[pid] = newVal;
  if(balRollDebounce[pid]) clearTimeout(balRollDebounce[pid]);
  balRollDebounce[pid] = setTimeout(()=>{
    balRollDebounce[pid] = null;
    // balRollState[pid] may have moved again while we were waiting — always
    // animate toward whatever the latest target is, never a stale one.
    const finalVal = balRollState[pid];
    if(balRollFrames[pid]) cancelAnimationFrame(balRollFrames[pid]);
    const startVal = parseInt((el.textContent||'0').replace(/[^0-9-]/g,''),10) || 0;
    if(startVal === finalVal){ el.textContent = fmt(finalVal); return; }
    const goingUp = finalVal > startVal;
    el.classList.remove('rolling-up','rolling-down');
    void el.offsetWidth; // restart the CSS pop animation even if the same class was just applied
    el.classList.add(goingUp ? 'rolling-up' : 'rolling-down');
    const duration = spd(Math.min(900, Math.max(300, Math.abs(finalVal-startVal)*1.1)));
    const t0 = performance.now();
    function step(now){
      const t = Math.min(1, (now-t0)/duration);
      const eased = 1-Math.pow(1-t,3); // ease-out cubic — fast start, gentle settle
      const cur = Math.round(startVal + (finalVal-startVal)*eased);
      el.textContent = fmt(cur);
      if(t<1){
        balRollFrames[pid] = requestAnimationFrame(step);
      } else {
        el.textContent = fmt(finalVal);
        balRollFrames[pid] = null;
        el.classList.remove('rolling-up','rolling-down');
      }
    }
    balRollFrames[pid] = requestAnimationFrame(step);
  }, 140);
}

const ROLE_DEFAULT={}; PLAYER_IDS.forEach((id,i)=>ROLE_DEFAULT[id]=i===0?'Host':`Player ${i+1}`);

/* ============ TURN TIMER ============
   A per-turn countdown, shown as a shrinking ring around the active player's
   avatar (CONFIG.turnTimerEnabled / CONFIG.turnTimerSec). When it hits zero the
   turn is ended automatically — rolling for the player if they hadn't rolled
   yet, declining a pending buy, or just clicking End turn for them. The clock
   pauses (ring dims, countdown freezes) whenever the active player is stuck
   negative and legally can't end their turn (isDebtor) — it resumes, with the
   time they had left, once that's resolved. Driven off refreshUI() so it stays
   in sync in both local and online play (guests follow whatever the host's
   state sync says, since CONFIG/turnIdx/busy all travel in serializeState). */
let turnTimerActiveId = null;
let turnTimerWasEnabled = false;
let turnTimerDeadlineAt = 0;
let turnTimerPaused = false;
let turnTimerRemainingMsAtPause = 0;
let turnTimerTimeoutId = null;
let turnTimerBadgeInterval = null;
let turnTimerLastRollSeq = -1; // last turnRollSeq value we already reacted to — see syncTurnTimerToActivePlayer()

function clearTurnTimerTimeout(){ if(turnTimerTimeoutId){ clearTimeout(turnTimerTimeoutId); turnTimerTimeoutId=null; } }

function setAllCardsTimerClasses(liveId, paused){
  PLAYER_IDS.forEach(pid=>{
    const card = document.getElementById('card-'+pid);
    if(!card) return;
    card.classList.toggle('timer-live', pid===liveId);
    card.classList.toggle('timer-paused', pid===liveId && paused);
  });
}

function stopTurnTimerVisual(){
  setAllCardsTimerClasses(null, false);
  const badge = document.getElementById('turnTimerBadge');
  if(badge) badge.classList.remove('show');
}

/* re-attaches the ring's classes/CSS animation to whatever's currently in the
   DOM for turnTimerActiveId, using the *current* remaining time — used when
   the player-card DOM got rebuilt out from under a still-running timer,
   without resetting the actual deadline/enforcement. */
function reapplyTurnTimerRingVisual(){
  if(!turnTimerActiveId || !CONFIG.turnTimerEnabled) return;
  const card = document.getElementById('card-'+turnTimerActiveId);
  if(!card) return;
  card.classList.add('timer-live');
  card.classList.toggle('timer-paused', turnTimerPaused);
  const ring = card.querySelector('.turn-ring-progress');
  if(!ring) return;
  const remainingMs = Math.max(1, turnTimerPaused ? turnTimerRemainingMsAtPause : (turnTimerDeadlineAt - Date.now()));
  ring.style.animation = 'none';
  void ring.getBoundingClientRect(); // force reflow — ring is an SVG <circle>, whose offsetWidth isn't reliable for this
  ring.style.animation = `turnRingShrink ${remainingMs/1000}s linear forwards`;
  ring.style.animationPlayState = turnTimerPaused ? 'paused' : 'running';
}

/* (re)starts the countdown for pid — called whenever the active player changes,
   or whenever the timer setting itself is flipped on/off. Passing pid=null (no
   active player / game over) just tears the timer down. */
function startTurnTimer(pid){
  clearTurnTimerTimeout();
  turnTimerActiveId = pid;
  turnTimerPaused = false;
  turnTimerWasEnabled = CONFIG.turnTimerEnabled;
  if(!pid || !CONFIG.turnTimerEnabled){ stopTurnTimerVisual(); return; }
  const totalMs = Math.max(1000, (CONFIG.turnTimerSec||45)*1000);
  turnTimerDeadlineAt = Date.now() + totalMs;
  setAllCardsTimerClasses(pid, false);
  const ring = document.querySelector('#card-'+pid+' .turn-ring-progress');
  if(ring){
    ring.style.animation = 'none';
    void ring.getBoundingClientRect(); // force reflow — ring is an SVG <circle>, whose offsetWidth isn't reliable for this
    ring.style.animation = `turnRingShrink ${totalMs/1000}s linear forwards`;
    ring.style.animationPlayState = 'running';
  }
  turnTimerTimeoutId = setTimeout(onTurnTimerExpired, totalMs);
}

function pauseTurnTimer(){
  if(turnTimerPaused || !turnTimerActiveId || !CONFIG.turnTimerEnabled) return;
  turnTimerPaused = true;
  turnTimerRemainingMsAtPause = Math.max(0, turnTimerDeadlineAt - Date.now());
  clearTurnTimerTimeout();
  const card = document.getElementById('card-'+turnTimerActiveId);
  if(card) card.classList.add('timer-paused');
  const ring = document.querySelector('#card-'+turnTimerActiveId+' .turn-ring-progress');
  if(ring) ring.style.animationPlayState = 'paused';
}

function resumeTurnTimer(){
  if(!turnTimerPaused || !turnTimerActiveId) return;
  turnTimerPaused = false;
  turnTimerDeadlineAt = Date.now() + turnTimerRemainingMsAtPause;
  const card = document.getElementById('card-'+turnTimerActiveId);
  if(card) card.classList.remove('timer-paused');
  const ring = document.querySelector('#card-'+turnTimerActiveId+' .turn-ring-progress');
  if(ring) ring.style.animationPlayState = 'running';
  if(CONFIG.turnTimerEnabled) turnTimerTimeoutId = setTimeout(onTurnTimerExpired, turnTimerRemainingMsAtPause);
}

/* fires when a player's clock actually runs out. Only the client whose own
   turn it is takes any action — rollDice()/playerEndTurn()/buyDecision() are
   already guarded to no-op for anyone else, and route through the network
   layer for guests exactly like a manual click would. */
function onTurnTimerExpired(){
  turnTimerTimeoutId = null;
  if(!CONFIG.turnTimerEnabled || gameOver) return;
  const activeId = order[turnIdx];
  if(!activeId || activeId !== turnTimerActiveId) return; // stale — turn already moved on
  if(activeId !== youAre) return; // not this client's player to act for
  if(busy && isDebtor(activeId)) return; // should already be paused; bail out defensively
  if(awaitingEndTurn){ playerEndTurn(); }
  else if(pendingBuy!=null){ buyDecision(false); }
  else if(!busy){ rollDice(); }
  else {
    // mid-animation or some other transient busy state (e.g. dice still tumbling) —
    // there's nothing actionable yet, so check back shortly rather than waiting
    // out a whole new turn's worth of time.
    turnTimerTimeoutId = setTimeout(onTurnTimerExpired, 400);
  }
}

/* single choke point, called from the top of refreshUI() on every state
   change: notices when the active player (or the enabled/duration settings)
   changed and restarts the ring, and keeps the pause state in sync with
   whether the active player is currently stuck negative. */
function syncTurnTimerToActivePlayer(){
  // order/turnIdx/gameOver are all initialized as if a game were already running (order
  // defaults to every PLAYER_IDS, turnIdx to 0) so the lobby/setup screen has sane values
  // to read before beginGame() ever runs — but that means without this guard, clicking a
  // player avatar during setup (which calls refreshUI()) would start the countdown before
  // the game has actually begun. #gameRoot is the actual game screen and stays
  // display:none the entire time setup is showing, so it's a reliable "has the game
  // actually started" check.
  const gameRootEl = document.getElementById('gameRoot');
  const gameShowing = gameRootEl && gameRootEl.style.display !== 'none';
  const activeId = (gameShowing && !gameOver && order && order.length) ? order[turnIdx] : null;
  // a fresh roll (even mid-turn, e.g. rolling again on doubles, or a jail roll)
  // earns the active player a brand-new full countdown rather than inheriting
  // whatever was left over from the time they spent deciding to roll — see
  // turnRollSeq, bumped once per real rollDice() execution and synced like any
  // other top-level game field.
  const rolledSinceLastSync = turnRollSeq !== turnTimerLastRollSeq;
  turnTimerLastRollSeq = turnRollSeq;
  if(activeId !== turnTimerActiveId || CONFIG.turnTimerEnabled !== turnTimerWasEnabled || (activeId && rolledSinceLastSync)){
    startTurnTimer(activeId);
  } else if(activeId && CONFIG.turnTimerEnabled){
    // renderPlayerCards() occasionally rebuilds the player-card DOM outright (a
    // player joining/leaving mid-game) — that wipes the ring's classes/inline
    // animation from the fresh nodes even though the actual countdown (the
    // setTimeout driving auto-actions) never stopped. Notice and re-attach the
    // visual without touching the underlying deadline.
    const card = document.getElementById('card-'+activeId);
    if(card && !card.classList.contains('timer-live')) reapplyTurnTimerRingVisual();
  }
  if(!activeId || !CONFIG.turnTimerEnabled) return;
  const stuck = busy && isDebtor(activeId);
  if(stuck) pauseTurnTimer(); else resumeTurnTimer();
}

function turnTimerBadgeTick(){
  const activeId = order[turnIdx];
  const timerOn = !!(CONFIG.turnTimerEnabled && !gameOver && activeId);
  const remainingMs = timerOn ? (turnTimerPaused ? turnTimerRemainingMsAtPause : Math.max(0, turnTimerDeadlineAt - Date.now())) : 0;
  const secs = Math.ceil(remainingMs/1000);
  // Per-card seconds readout on the active player's avatar ring — visible to
  // every player (not just whoever's turn it is), so it's obvious at a glance
  // how much time is left without anyone having to open their own turn.
  PLAYER_IDS.forEach(pid=>{
    const secsEl = document.getElementById('secs-'+pid);
    if(!secsEl) return;
    if(timerOn && pid===activeId){
      secsEl.textContent = turnTimerPaused ? '⏸' : `${secs}s`;
      secsEl.classList.toggle('low', !turnTimerPaused && secs<=10);
    } else {
      secsEl.textContent = '';
      secsEl.classList.remove('low');
    }
  });
  const badge = document.getElementById('turnTimerBadge');
  if(!badge) return;
  if(!timerOn || activeId!==youAre){
    badge.classList.remove('show');
    return;
  }
  badge.classList.add('show');
  badge.classList.toggle('low', !turnTimerPaused && secs<=10);
  badge.classList.toggle('paused', turnTimerPaused);
  badge.textContent = turnTimerPaused ? `⏱ paused — clear your balance first` : `⏱ ${secs}s left`;
}
turnTimerBadgeInterval = setInterval(turnTimerBadgeTick, 250);

function refreshUI(){
  try{ syncTurnTimerToActivePlayer(); }catch(err){ console.error('refreshUI: syncTurnTimerToActivePlayer failed', err); }
  try{ refreshGameOverRematchUI(); }catch(err){ console.error('refreshUI: refreshGameOverRematchUI failed', err); } // keeps the host's live vote count (and a guest's own button label) current while the game-over summary is open and state syncs keep arriving
  // ---- CORE ACTION BUTTONS FIRST -----------------------------------------
  // Roll / Pay bail / End turn / the roll-result line only ever depend on
  // busy/awaitingEndTurn/gameOver/turn-order state — never on board geometry,
  // tile art, or anything theme-related — so they're computed and applied
  // before any of the more elaborate (and more theme-sensitive) rendering
  // below. That way, if something further down this function throws — e.g.
  // a stale measurement left over from a mid-animation theme switch — the
  // controls the player actually needs to keep playing (Roll/Bail/End turn)
  // have already been correctly synced and can't get stuck disabled.
  const activeId=order[turnIdx]||PLAYER_IDS.find(id=>players[id].active&&!players[id].bankrupt), active=players[activeId], isYourTurn=activeId===youAre;
  const debtStuck = busy && isDebtor(youAre); // still locked, but the manage/loan tools stay usable so they can raise cash
  const decidingBuy = busy && isAwaitingBuy(youAre); // staring at the buy/skip panel — loan tools stay usable to raise cash before deciding
  document.getElementById('rollBtn').disabled=busy||awaitingEndTurn||gameOver||!isYourTurn; const m=document.getElementById('manageBtn'); if(m)m.disabled=(busy&&!debtStuck&&!decidingBuy)||gameOver||!isYourTurn; const e=document.getElementById('endTurnBtn'); if(e){e.style.display=awaitingEndTurn&&isYourTurn&&!gameOver?'':'none';e.disabled=busy||gameOver||!isYourTurn;}
  const bb2=document.getElementById('bailBtn'); if(bb2){const canBail=isYourTurn&&!!active&&!!active.inJail&&active.jailTurns>1&&!gameOver; bb2.style.display=canBail?'':'none'; bb2.textContent=`Pay $${fmt(CONFIG.bail)} bail`; bb2.disabled=busy||awaitingEndTurn||!canBail;}
  const shb=document.getElementById('shieldBtn'); if(shb){const hasShield=!!active&&(active.shieldCharges>0||active.shieldArmed); const canArmShield=isYourTurn&&!!active&&!gameOver&&!busy&&!awaitingEndTurn&&(active.shieldCharges>0)&&!active.shieldArmed; shb.style.display=(isYourTurn&&!gameOver&&hasShield)?'':'none'; shb.textContent=active&&active.shieldArmed?`\u{1F6E1}\uFE0F Property Shield armed for this turn`:`\u{1F6E1}\uFE0F Use Property Shield (${active&&active.shieldCharges||0})`; shb.disabled=!canArmShield;}
  const jfb=document.getElementById('jailFreeBtn'); if(jfb){const canUseJf=isYourTurn&&!!active&&!!active.inJail&&!gameOver&&(active.jailFreeCards>0); jfb.style.display=canUseJf?'':'none'; jfb.textContent=`\u{1F513} Use Jail Free card (${active&&active.jailFreeCards||0})`; jfb.disabled=busy||awaitingEndTurn||!canUseJf;}
  const tpb=document.getElementById('teleportBtn'); if(tpb){const canTeleport=isYourTurn&&!!active&&!gameOver&&(active.teleportCards>0)&&!anyPickModeActive(); tpb.style.display=canTeleport?'':'none'; tpb.textContent=`\u{1F300} Use Teleport card (${active&&active.teleportCards||0})`; tpb.disabled=busy||!canTeleport;}
  const tcb=document.getElementById('teleportCancelBtn'); if(tcb){ tcb.style.display=(isYourTurn&&teleportPickMode&&!gameOver)?'':'none'; }
  const scb=document.getElementById('sabotageCancelBtn'); if(scb){ scb.style.display=(isYourTurn&&sabotagePickMode&&!gameOver)?'':'none'; }
  const pscb=document.getElementById('propertySwapCancelBtn'); if(pscb){ pscb.style.display=(isYourTurn&&!!propertySwapPick&&!gameOver)?'':'none'; }
  const iOwnSomething = tiles.some(t=>ownedByUnit(t,youAre)); // IN TEAMS: a teammate owning something is enough to unlock Auction/Loan
  const ab=document.getElementById('auctionBtn'); if(ab){ab.style.display=((iOwnSomething||decidingBuy)&&!gameOver)?'':'none';ab.disabled=(busy&&!debtStuck&&!decidingBuy)||gameOver;}
  const lb=document.getElementById('loanBtn'); if(lb){lb.style.display=((iOwnSomething||decidingBuy)&&!gameOver&&CONFIG.loansEnabled)?'':'none';lb.disabled=(busy&&!debtStuck&&!decidingBuy)||gameOver;}
  // side bets are the mirror image of every other action button here — they're only
  // ever available to whoever ISN'T the active player, since you can't wager against
  // your own roll, and only during the idle window before the dice are actually thrown.
  const sbb=document.getElementById('sideBetBtn'); if(sbb){const meCanBet=!!players[youAre]&&players[youAre].active&&!players[youAre].bankrupt&&!isYourTurn&&!!active&&!active.bankrupt; const show=(CONFIG.sideBetsEnabled&&!gameOver&&meCanBet); sbb.style.display=show?'':'none'; sbb.disabled=busy; if(!show){const sbp=document.getElementById('sideBetPanel'); if(sbp)sbp.classList.remove('show');}}
  if(!gameOver&&active){document.getElementById('rollResult').textContent=isYourTurn&&teleportPickMode?'Teleport ready — tap any tile on the board to warp there.':isYourTurn&&sabotagePickMode?"Sabotage ready — tap any tile in an opposing team's property group to freeze the whole group.":isYourTurn&&propertySwapPick?(propertySwapPick.stage==='mine'?"Property Swap: tap one of your own properties with no houses on it to give up.":"Property Swap: now tap an opponent's property with no houses on it to take."):isYourTurn&&stealCardPick?"Steal a Card: choose a card from the popup to continue.":debtStuck?`You're negative — you can't end your turn until you're back to $0 or above`:!isYourTurn?`Waiting for ${active.name} to play…`:awaitingEndTurn?`${active.name}'s move is done — manage properties, then End turn`:!busy?(active.inJail?(active.jailTurns>1?`${active.name} is in jail — roll for doubles, or pay $${fmt(CONFIG.bail)} bail to get out now`:`${active.name} is in jail — last roll: doubles breaks out free, otherwise bail is paid automatically`):`${active.name}'s turn — roll the dice`):document.getElementById('rollResult').textContent;}
  if(pendingBuy!=null && tiles[pendingBuy]){
    // keep the Buy button's afford-check live so borrowing mid-decision unlocks it immediately
    const t=tiles[pendingBuy], price=parseInt(t.price.replace('$','')), actor=players[order[turnIdx]];
    const yesBtn=document.getElementById('buyYesBtn');
    if(yesBtn){ const canAfford=!!actor&&actor.balance>=price; yesBtn.disabled=!canAfford; yesBtn.title=canAfford?'':'Not enough cash'; }
  }

  // ---- EVERYTHING ELSE, defensively --------------------------------------
  // Tile price labels, player cards, and the tile-info/auction/loan side
  // panels all touch theme-dependent DOM (measured geometry, per-theme
  // building art, THEME_JS_COLORS lookups, etc.) and are cosmetically
  // important but never gameplay-blocking. Any one of them throwing should
  // never be able to take the whole function down with it — that's what
  // silently stranded the action buttons above in the old single-block
  // version of this function, since a throw partway through aborted every
  // statement after it, including the button sync. Each piece now fails on
  // its own, logs so it's actually debuggable, and lets the rest continue.
  try{ applySpeedUI(); }catch(err){ console.error('refreshUI: applySpeedUI failed', err); }
  try{ refreshTilePriceLabels(); }catch(err){ console.error('refreshUI: refreshTilePriceLabels failed', err); }
  try{ checkTurnSound(); }catch(err){ console.error('refreshUI: checkTurnSound failed', err); }
  try{
    PLAYER_IDS.forEach(id=>{const p=players[id]; const card=document.getElementById('card-'+id); if(card){card.classList.toggle('is-me',id===youAre);card.classList.toggle('is-opponent',id!==youAre);} const bal=document.getElementById('bal-'+id); if(bal) rollBalance(id,bal,p.balance); const role=document.getElementById('role-'+id),dot=document.getElementById('dot-'+id); if(role){if(!p.active){role.textContent='Not joined';}else if(p.bankrupt){role.textContent='Bankrupt';}else if(p.inJail){role.textContent=`In Jail (${p.jailTurns})`;}else role.textContent=ROLE_DEFAULT[id]; if(p.active&&!p.bankrupt&&p.loan>0) role.textContent+=` · owes $${fmt(p.loan)}${p.loanTermTurns>0?` (${p.loanTermTurns} left)`:''}`; if(CONFIG.teamsEnabled&&p.team) role.textContent+=` · Team ${p.team}`;} if(dot){const idleClr=(THEME_JS_COLORS[currentThemeName()]||THEME_JS_COLORS.skyline).idleDot;dot.style.background=!p.active?idleClr:p.bankrupt?idleClr:p.inJail?'#e35b5b':'#3fe07a';dot.style.boxShadow=!p.active||p.bankrupt?'none':`0 0 6px ${p.inJail?'#e35b5b':'#3fe07a'}`;} const tb=document.getElementById('tradeBtn-'+id),bb=document.getElementById('bankruptBtn-'+id),sb=document.getElementById('swapBtn-'+id); if(tb){tb.style.display=(id!==youAre&&p.active&&!p.bankrupt)?'':'none';tb.disabled=!players[youAre]?.active||!!players[youAre]?.bankrupt||!p.active||p.bankrupt||gameOver;} if(bb){bb.style.display=id===youAre?'':'none';bb.disabled=p.bankrupt||gameOver;} if(sb){const activeP=players[order[turnIdx]]; const canSwap=order[turnIdx]===youAre&&!!activeP&&(activeP.swapCards>0); sb.style.display=(id!==youAre&&p.active&&!p.bankrupt&&order[turnIdx]===youAre&&!!activeP&&activeP.swapCards>0)?'':'none'; sb.disabled=busy||gameOver||!canSwap||!p.active||p.bankrupt;} const card2=document.getElementById('card-'+id); if(card2) card2.classList.toggle('is-turn',order[turnIdx]===id); const nm=document.getElementById('name-'+id); if(nm) nm.textContent=p.name; renderPowerBadges(id,p);});
  }catch(err){ console.error('refreshUI: player card refresh failed', err); }
  try{ refreshTileInfoIfOpen(); }catch(err){ console.error('refreshUI: refreshTileInfoIfOpen failed', err); }
  try{ refreshAuctionPanelIfOpen(); }catch(err){ console.error('refreshUI: refreshAuctionPanelIfOpen failed', err); }
  try{ refreshLoanPanelIfOpen(); }catch(err){ console.error('refreshUI: refreshLoanPanelIfOpen failed', err); }
  try{ refreshSideBetPanelIfOpen(); }catch(err){ console.error('refreshUI: refreshSideBetPanelIfOpen failed', err); }
  try{ refreshPropertySwapPanelIfOpen(); }catch(err){ console.error('refreshUI: refreshPropertySwapPanelIfOpen failed', err); }
  // trade cards show different buttons (Accept/Decline vs. "waiting for X") depending on
  // who's currently looking (youAre) — without this, switching seats locally (setYou) or
  // any other refreshUI() call left the panel showing stale buttons from whoever's
  // perspective it was last drawn under, so Accept/Decline could silently do nothing.
  try{ renderTradesList(); }catch(err){ console.error('refreshUI: renderTradesList failed', err); }
  try{ updatePowerCardsButton(); }catch(err){ console.error('refreshUI: updatePowerCardsButton failed', err); }
  try{ refreshPowerCardsIfOpen(); }catch(err){ console.error('refreshUI: refreshPowerCardsIfOpen failed', err); }
  try{ syncStealCardOverlay(); }catch(err){ console.error('refreshUI: syncStealCardOverlay failed', err); }
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sendChat(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;
  const me = players[youAre];
  switchTab('history');
  log(`<span class="who" style="color:${me.color}">${me.name}</span> ${escapeHtml(text)}`, '💬');
  input.value = '';
  // message is on its way — stop showing "you are typing" to everyone else right
  // away rather than waiting out the trailing debounce in handleChatInputTyping.
  clearTimeout(typingDebounceTimer); typingLastState = false; sendTypingSignal(false);
}

/* "Someone is typing…" for multiplayer: local input fires this on every keystroke;
   it debounces into a single typing:true/false signal (see sendTypingSignal, which
   is a no-op offline) rather than spamming the wire on every character. */
let typingDebounceTimer = null, typingLastState = false;
function handleChatInputTyping(){
  const input = document.getElementById('chatInput');
  const hasText = !!(input && input.value.trim());
  clearTimeout(typingDebounceTimer);
  if(hasText){
    if(!typingLastState){ typingLastState = true; sendTypingSignal(true); }
    typingDebounceTimer = setTimeout(()=>{ typingLastState = false; sendTypingSignal(false); }, 2000);
  } else if(typingLastState){
    typingLastState = false; sendTypingSignal(false);
  }
}
function sendTypingSignal(isTyping){
  if(typeof window.__netNotifyTyping==='function') window.__netNotifyTyping(isTyping);
}
// Receiving side, called for both host and guests once a typing signal arrives over
// the network (see __netNotifyTyping/broadcastTyping below) — tracks who's currently
// typing and repaints the strip under the chat log. A short per-player timeout acts
// as a safety net in case a "stopped typing" signal is ever lost (e.g. a disconnect
// mid-keystroke), so the indicator can't get stuck on forever.
const typingPlayers = new Map();
function updateTypingIndicator(pid, isTyping){
  if(!pid || pid===youAre) return; // never echo your own typing back at you
  if(typingPlayers.has(pid)){ clearTimeout(typingPlayers.get(pid)); typingPlayers.delete(pid); }
  if(isTyping){
    const timer = setTimeout(()=>{ typingPlayers.delete(pid); renderTypingIndicator(); }, 4000);
    typingPlayers.set(pid, timer);
  }
  renderTypingIndicator();
}
function renderTypingIndicator(){
  const el = document.getElementById('typingIndicator');
  if(!el) return;
  const names = [...typingPlayers.keys()].map(id=>players[id]?.name||'Someone');
  if(!names.length){ el.style.display='none'; el.textContent=''; return; }
  el.textContent = names.length===1 ? `${names[0]} is typing…`
    : names.length===2 ? `${names[0]} and ${names[1]} are typing…`
    : `${names.slice(0,-1).join(', ')}, and ${names[names.length-1]} are typing…`;
  el.style.display = '';
}

/* Ordered keyword rules for picking a per-line icon in the log/chat feed — first
   match wins, so more specific phrases (jail, trades, auctions) are listed ahead
   of generic money language that would otherwise swallow them. Matching is done
   against the plain-text, lowercased version of the line so it's agnostic to
   exactly which tile/player names or markup surround the keywords. */
const LOG_ICON_RULES = [
  [/wins the game/, '🏆'],
  [/game over/, '🏁'],
  [/gone bankrupt/, '💥'],
  [/\$[\d,]+<\/b> short|\$[\d,]+ short\.?$/, '⚠️'],
  [/breaks out of jail|leaves jail|hauled off .*jail|stays in jail|locked up for|bail/, '🚔'],
  [/offered a trade|completed a trade|trade .*declined|trade between .*fell through|buys out/, '🤝'],
  [/wins the auction|no bids on|to auction/, '🏛️'],
  [/builds a house|builds a hotel|sells a house/, '🏠'],
  [/mortgage/, '📜'],
  [/^\s*\S+\s+buys\b.*for \$/, '🏠'],
  [/sits out this turn/, '⏭️'],
  [/rolls? (doubles|again)|rolled \d|moving \d+ space/, '🎲'],
  [/borrows \$|repays|loan/, '🏦'],
  [/rent|pays .*: ?-\$|passes go|lands exactly on go|collects \$/, '💰'],
  [/\(\+?\$-?[\d,]+\)\.?$/, '💰'],
  [/lands on/, '📍'],
];
function classifyLogIcon(html){
  const t = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
  for(const [re,icon] of LOG_ICON_RULES){ if(re.test(t)) return icon; }
  return '';
}

/* ===== small "toast" popups — a second, quieter tier of board notification for
   events that used to only show up if you dug through the history log: trades,
   auctions, building/selling houses, mortgages, buying a property, plain rent,
   loans, jail comings-and-goings, and bankruptcies. The flashy centered
   gb-carddraw popup (cards, tax, going into the red, jail sentencing, power-card
   plays) is left alone — this is deliberately a whitelist, so anything not
   listed here just stays a log line like before, nothing changes for it.
   'toast' = normal small pill, a few seconds. 'tiny' = smaller/faster-fading,
   for the really minor stuff (mortgaging, rent, bail, etc). First match wins. */
const TOAST_RULES = [
  [/offered a trade|completed a trade|trade .*declined|trade between .*fell through/, 'toast', '🤝'],
  [/buys out/, 'toast', '🤝'],
  [/wins the auction/, 'toast', '🏛️'],
  [/no bids on|sends? .* to auction|going straight to auction/, 'tiny', '🏛️'],
  [/builds a hotel|builds a house/, 'toast', '🏠'],
  [/sells a house/, 'tiny', '🏠'],
  [/pays \$?[\d,]+ to lift the mortgage|mortgages/, 'tiny', '📜'],
  [/^\S+\s+buys\b.*for \$/, 'toast', '🏠'],
  [/sits out this turn/, 'tiny', '⏭️'],
  [/borrows \$|repays|auto-repays/, 'tiny', '🏦'],
  [/gone bankrupt/, 'toast', '💥'],
  [/breaks out of jail|stays in jail|runs out of patience/, 'tiny', '🚔'],
  [/passes go and collects|lands exactly on go/, 'tiny', '💰'],
  [/pays \$[\d,]+ rent\b/, 'tiny', '💰'],
  // ---- extra coverage: mostly power-card plays and other small moments that
  // used to only show up if you scrolled the history log. 'tiny' = quick
  // in-and-out flash for the minor stuff; 'toast' = a beat longer for things
  // that actually swing the board (a blocked rent payment, a card taken off
  // another player, a swap of places/properties).
  [/wagers \$[\d,]+ against/, 'tiny', '🎲'],
  [/side bet/, 'toast', '🎲'],
  [/shield blocks the \$[\d,]+ rent/, 'toast', '🛡️'],
  [/raises a property shield|raises a shared shield/, 'tiny', '🛡️'],
  [/uses a rent doubler/, 'tiny', '💹'],
  [/arms pooled payday/, 'tiny', '📣'],
  [/discount card used/, 'toast', '🏗️'],
  [/double salary used/, 'toast', '💵'],
  [/loan forgiveness wipes out/, 'toast', '🏦'],
  [/bankruptcy insurance (wipes|cancels)|receives a bankruptcy insurance card/, 'toast', '💸'],
  [/plays a teleport/, 'toast', '🌀'],
  [/plays a property swap/, 'toast', '🔄'],
  [/plays a swap card/, 'toast', '🔄'],
  [/plays a property freeze/, 'toast', '❄️'],
  [/plays sabotage/, 'toast', '🧨'],
  [/plays fast forward/, 'tiny', '⏩'],
  [/plays a get out of jail free/, 'tiny', '🔑'],
  [/relays a .+ card to teammate/, 'tiny', '📤'],
  [/property freeze has worn off/, 'tiny', '❄️'],
];
function classifyToastTier(html){
  const t = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
  for(const [re,tier,glyph] of TOAST_RULES){ if(re.test(t)) return {tier,glyph}; }
  return null;
}
let toastSeq = 0;
let logCallSeq = 0;
let toastSuppressGen = -1; // see showCardDraw(): set when the big popup already covers this same log line
function queueLogToast(html, myGen){
  if(toastSuppressGen===myGen) return; // a card-draw popup already fired for this exact line
  const hit = classifyToastTier(html);
  if(!hit) return;
  const payload = {id:++toastSeq, html, glyph:hit.glyph, tier:hit.tier};
  showToast(payload);
  if(typeof window.__netBroadcastToast==='function') window.__netBroadcastToast(payload);
}
function log(html, icon){
  const chat = document.getElementById('chatBody');
  const div = document.createElement('div');
  div.className='msg';
  const t = new Date();
  const useIcon = icon!==undefined ? icon : classifyLogIcon(html);
  const iconHtml = useIcon ? `<span class="log-icon">${useIcon}</span>` : '';
  div.innerHTML = `<span class="time">${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}</span><div>${iconHtml}${html}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  if(typeof window.__netBroadcastChatLine==='function') window.__netBroadcastChatLine(div.outerHTML);
  // deferred one tick so showCardDraw() — called synchronously right after log()
  // at every call site that wants the big popup instead — has a chance to mark
  // this exact line as already-covered before the toast would otherwise fire.
  const myGen = ++logCallSeq;
  setTimeout(()=>queueLogToast(html, myGen), 0);
}
/* small stacking pill notifications — a lighter-weight sibling to showCardDraw()
   below. Multiple can be alive at once (they stack in #toastStack), each on its
   own timer, unlike the single-slot synced cardDraw. */
const TOAST_MS = {toast:4200, tiny:2400};
function showToast(payload){
  const stack = document.getElementById('toastStack');
  if(!stack) return;
  const el = document.createElement('div');
  el.className = `toast-pill${payload.tier==='tiny'?' tiny':''}`;
  el.innerHTML = `${payload.glyph?`<span class="toast-icon">${payload.glyph}</span>`:''}<span class="toast-text">${payload.html}</span>`;
  stack.appendChild(el);
  // cap how many can be stacked at once so a burst of events doesn't wall off the board
  while(stack.children.length>4){ const first=stack.firstElementChild; if(first) first.remove(); else break; }
  requestAnimationFrame(()=>{ el.classList.add('show'); });
  const dur = TOAST_MS[payload.tier]||TOAST_MS.toast;
  setTimeout(()=>{
    el.classList.add('leaving');
    el.classList.remove('show');
    setTimeout(()=>{ el.remove(); }, 260);
  }, dur);
}

/* ============ AUTO-PLAY ============
   A "just get through my own turns" toggle for the slow early-game stretch
   where every tile is unowned and you're clicking Roll → Buy → End turn over
   and over. While it's on and it's your own turn, this repeatedly presses
   whichever of your turn buttons is currently clickable — roll, buy, pay
   bail, end turn — on a short human-speed timer so it's still watchable
   instead of instantly resolving the whole game. It never touches anything
   that isn't your own decision (auctions, trades, other players' turns) and
   backs off the instant any overlay/modal is open, so it can't fight you or
   fire an action underneath a dialog you're looking at. */
let autoPlayEnabled = false;
let autoPlayTimer = null;
const AUTO_PLAY_TICK_MS = 650; // pause between auto-clicks — fast, but still readable

function setAutoPlayEnabled(on){
  autoPlayEnabled = on;
  const btn = document.getElementById('autoPlayBtn');
  const label = document.getElementById('autoPlayBtnLabel');
  if(label) label.textContent = on ? 'Auto: on' : 'Auto: off';
  if(btn) btn.classList.toggle('auto-on', on);
  if(on && !autoPlayTimer) autoPlayTick();
  if(!on && autoPlayTimer){ clearTimeout(autoPlayTimer); autoPlayTimer = null; }
}
function toggleAutoPlay(){ setAutoPlayEnabled(!autoPlayEnabled); }

function autoPlayClickable(id){
  const btn = document.getElementById(id);
  if(!btn || btn.disabled) return null;
  if(btn.offsetParent === null) return null; // hidden (display:none or detached)
  return btn;
}
function autoPlayTick(){
  autoPlayTimer = null;
  if(!autoPlayEnabled) return;
  if(gameOver || !players[youAre] || players[youAre].bankrupt || !players[youAre].active){
    setAutoPlayEnabled(false); return;
  }
  // never act underneath an open modal/overlay (trade review, auction,
  // power cards, config, confirm-bankruptcy, etc.) — wait it out instead.
  if(!document.querySelector('.trade-overlay.show, .confirm-overlay.show') && order[turnIdx] === youAre){
    // priority order matters: pay bail immediately rather than trying for
    // doubles first (bail is the fast path, which is the whole point here),
    // then buy anything landed on, then roll, then end the turn once nothing
    // else is left to do.
    const btn = autoPlayClickable('bailBtn') || autoPlayClickable('buyYesBtn') || autoPlayClickable('rollBtn') || autoPlayClickable('endTurnBtn');
    if(btn) btn.click();
  }
  autoPlayTimer = setTimeout(autoPlayTick, spd(AUTO_PLAY_TICK_MS));
}

/* the sidebar's "⌨ Controls" pill has a hover title with the full shortcut
   legend for desktop, but touch devices can't hover — tapping it fires this
   instead, reusing the same toast pill so it fits right in with everything
   else flashing on the board. */
function showKeyHintsToast(){
  showToast({id:++toastSeq, html:'<b>Space</b> roll/buy/end turn &middot; <b>Q</b> buy &middot; <b>A</b> auction/decline &middot; <b>R</b> bail &middot; <b>X</b> cancel &middot; <b>C</b> cards &middot; <b>Z</b> auto-play', glyph:'⌨', tier:'toast'});
}
function markOwnership(i, color){
  const face = ownFaceEls[i];
  if(!face) return;
  face.style.background = mixColor(color, THEME_JS_COLORS[currentThemeName()].tokenBase, 0.32);
  face.style.border = `1.5px solid ${color}`;
  face.style.opacity = 1;
  face.style.borderStyle = 'solid';
}
function clearOwnershipRing(i){
  const face = ownFaceEls[i];
  if(!face) return;
  face.style.background = 'transparent';
  face.style.border = 'none';
  face.style.opacity = 0;
}
function setMortgageVisual(i, mortgaged){
  const face = ownFaceEls[i];
  if(!face || face.style.opacity==='0') return; // unowned — nothing to dim
  face.style.opacity = mortgaged ? 0.4 : 1;
  face.style.borderStyle = mortgaged ? 'dashed' : 'solid';
}
/* Property Freeze's board indicator — an icy glow ring on the ownership face,
   independent of (and layered alongside) the mortgage dimming above, since a
   property can in principle be both at once. */
function setFrozenVisual(i, frozen){
  const face = ownFaceEls[i];
  if(!face) return;
  face.style.boxShadow = frozen ? '0 0 0 2px #7dd3fc, 0 0 14px 2px rgba(125,211,252,.55)' : '';
  face.style.filter = frozen ? 'saturate(.6) brightness(1.08)' : '';
}

/* once a property is bought, its board label should read as what it now costs to land
   on (the rent), not what it cost to buy — so swap the tile text between price and rent
   as ownership/mortgage/house-count change. Called from refreshUI so every code path
   that can affect rent (buy, bankruptcy transfer, trade, mortgage, build/sell house,
   or a synced state on a guest's screen) keeps the board labels correct. */
// redraws the house/hotel glyphs on a street tile from its current house count —
// each house is the same small model duplicated side by side (1 house = one model,
// 4 houses = four side by side), all sitting on the tile's usual anchored spot, then
// the whole row swaps out for a single hotel model once the property reaches 5.
// Nothing is shown at all until the first house goes up.
// renders flat 2D building pieces into g.el, replacing whatever 3D model-viewer
// content might be sitting there. houses 1-4 show that many house icons side by
// side; 5+ shows one hotel icon. classic is the only theme that still uses this —
// skyline now shares hearthside's 3D building models (see renderTileHouses below),
// just at a smaller size so they don't cover the tile's name/price text.
function renderFlatBuilding(g, houses, theme, anchorEl){
  if(g.mv) g.mv.style.display = 'none'; // no-op if this tile has never needed the 3D model-viewer (see lazy creation below)
  // skyline's board is a rotateZ+rotateX 3D perspective diamond; the flat overlay layer
  // (buildingLayer, sibling of the tilted board — see g.el) doesn't share that transform,
  // so a fixed screen-space offset could only ever be tuned right for one edge of the
  // board and drifted off-tile on the others. Rendering skyline's flat pieces straight
  // into the tile's own anchor div instead sidesteps that entirely: as a normal child
  // inside the tile, it inherits the exact same transform as the tile itself, so it
  // lands correctly seated for every row with no per-edge math needed. Classic's board
  // isn't tilted at all, so its flat pieces stay on the original overlay layer.
  const container = (theme === 'skyline' && anchorEl) ? anchorEl : g.el;
  if(!g.flatWrap || g.flatWrapParent !== container){
    if(g.flatWrap) g.flatWrap.remove();
    g.flatWrap = document.createElement('div');
    g.flatWrap.className = 'gb-flat-buildings';
    container.appendChild(g.flatWrap);
    g.flatWrapParent = container;
  }
  g.flatWrap.innerHTML = '';
  const houseSvg = theme === 'skyline' ? MODERN_HOUSE_SVG : FLAT_HOUSE_SVG;
  const hotelSvg = theme === 'skyline' ? MODERN_HOTEL_SVG : FLAT_HOTEL_SVG;
  if(houses >= 5){
    const piece = document.createElement('div');
    piece.className = 'gb-flat-hotel house-pop';
    piece.innerHTML = hotelSvg;
    g.flatWrap.appendChild(piece);
  } else {
    for(let k=0; k<houses; k++){
      const piece = document.createElement('div');
      piece.className = 'gb-flat-house house-pop';
      piece.innerHTML = houseSvg;
      g.flatWrap.appendChild(piece);
    }
  }
}
function renderTileHouses(i){
  const g = tileHouseEls[i];
  if(!g) return;
  const houses = tiles[i].houses||0;
  const theme = currentThemeName();
  if(houses<=0){
    if(g.level !== -1){ g.el.style.display='none'; g.level=-1; }
    if(g.sparkEl){ g.sparkEl.remove(); g.sparkEl=null; }
    if(g.flatWrap){ g.flatWrap.remove(); g.flatWrap=null; g.flatWrapParent=null; }
    if(g.mv) g.mv.style.display='none';
    g.theme = theme;
    return;
  }
  if(theme === 'classic'){
    // flat 2D houses/hotel: classic's own green-house/red-hotel wooden-piece look.
    // skyline used to render its own flat glass-tower pieces here too, but now
    // shares hearthside's 3D building models below instead (just smaller).
    if(houses !== g.level || theme !== g.theme){
      g.el.style.display = '';
      renderFlatBuilding(g, houses, theme, tileAnchorEls[i]);
      g.level = houses;
      g.theme = theme;
    }
    if(g.sparkEl){ g.sparkEl.remove(); g.sparkEl=null; }
    return;
  }
  // hearthside & skyline: a single 3D model-viewer per tile whose model gets bigger/
  // grander as houses are built (1st house = level 0, ... 4th house = level 3), and
  // swaps to the hotel model at 5+ (reuses the last entry in BUILDING_LEVELS).
  // skyline uses the exact same models, just inside a smaller container (see
  // .gb-bldg-house/.gb-bldg-hotel under [data-theme="skyline"]) so the built-up
  // building doesn't obscure the tile's name/price text the way the full
  // hearthside size would.
  if(g.flatWrap){ g.flatWrap.remove(); g.flatWrap=null; }
  if(!g.mv){
    // First time this tile has actually needed the 3D model — create the
    // model-viewer now rather than at board setup (see board-render.js note on
    // tileHouseEls) so we're not paying for a WebGL context + GLB decode on
    // properties nobody ever builds on.
    g.mv = makeBldgMv(BUILDING_LEVELS[0], 'gb-bldg-house');
    g.el.appendChild(g.mv);
  }
  const level = Math.min(houses-1, BUILDING_LEVELS.length-1);
  if(level !== g.level || theme !== g.theme){
    if(g.el.style.display==='none') g.el.style.display='';
    if(g.mv.style.display==='none') g.mv.style.display=''; // the model-viewer itself is hidden
    // (display:none) whenever the classic flat-SVG path was last used on this
    // tile — that path always hides it since classic doesn't need the 3D model.
    // Switching to hearthside/skyline must explicitly re-show it, or the
    // house/hotel model stays invisible even though its wrapper div is visible.
    g.mv.setAttribute('src', BUILDING_LEVELS[level]);
    g.level = level;
    g.theme = theme;
    // container is a fixed size (see .gb-bldg-house), so scale the model up a bit
    // more at each level to make the grow-as-you-build effect actually readable —
    // skyline's container is smaller than hearthside's, so the same scale curve
    // still ends up visibly smaller overall.
    g.mv.style.transform = (theme === 'hearthside' || theme === 'skyline') ? `scale(${1.15 + level*0.12})` : '';
    g.mv.classList.remove('pop'); void g.mv.offsetWidth; g.mv.classList.add('pop');
  }
  const wantSpark = false; // hotel sparkle removed — kept as a no-op branch so the
                            // remove-cleanup below still runs if a stale spark exists
  const hasSpark = !!g.sparkEl;
  if(wantSpark && !hasSpark){
    g.sparkEl = document.createElement('div');
    g.sparkEl.className = 'gb-hotel-spark';
    g.sparkEl.textContent = '\u2728';
    g.el.appendChild(g.sparkEl);
  } else if(!wantSpark && hasSpark){
    g.sparkEl.remove();
    g.sparkEl = null;
  }
}

function updateTilePriceLabel(i){
  renderTileHouses(i);
  const t = tiles[i], labelEl = tilePriceEls[i];
  if(!labelEl || !purchasable(t)) return;
  let str;
  if(!t.owner){
    str = String(t.price);
    labelEl.classList.remove('is-rent');
  } else {
    str = t.mortgaged ? 'Mortgaged' : `$${fmt(calcRent(t, t.owner))}`;
    labelEl.classList.add('is-rent');
  }
  labelEl.textContent = str;
}
function refreshTilePriceLabels(){ tiles.forEach((t,i)=>updateTilePriceLabel(i)); }

/* keeps the $ total shown right on the Bailout tile in sync with bailoutPot — called
   any time tax/fines feed the pot or a player collects it */
function updateBailoutPotLabel(){
  if(BAILOUT_IDX<0) return;
  const labelEl = tilePriceEls[BAILOUT_IDX];
  if(!labelEl) return;
  labelEl.textContent = `$${fmt(bailoutPot)}`;
}
/* adds money paid to the bank (tax, fines, jail bail) into the Bailout pot */
function addToBailoutPot(amt){
  if(!(amt>0)) return;
  bailoutPot += amt;
  updateBailoutPotLabel();
}

const WHEEL_EVENTS = [
  {amt: 40,  text:'spins the wheel and wins $40'},
  {amt: -30, text:'spins the wheel and pays a $30 fine'},
  {amt: 60,  text:'spins the wheel and wins $60'},
  {amt: -20, text:'spins the wheel and loses $20 in fees'},
  {amt: 75,  text:'spins the wheel, hits the jackpot symbol twice, and wins $75'},
  {amt: -45, text:'spins the wheel, it lands on a llama, and pays $45 in "llama damages"'},
  {amt: 25,  text:'spins the wheel, finds a $25 bill taped to the back, and pockets it'},
  {amt: -60, text:'spins the wheel so hard it flies off the table and shatters a $60 vase'},
  {amt: 100, text:'spins the wheel, wins the grand prize, and collects $100'},
  {amt: -15, text:'spins the wheel, gets a papercut doing it, and spends $15 on band-aids'},
  {amt: 50,  text:'spins the wheel, lands on a coupon, and redeems it for $50'},
  {amt: -35, text:'spins the wheel, knocks over the snack table, and pays $35 to replace it'},
  {amt: 80,  text:'spins the wheel, wins the office raffle, and collects $80'},
  {amt: -25, text:'spins the wheel with too much enthusiasm, gets fined $25 for "reckless spinning"'},
  {amt: 65,  text:'spins the wheel and finds a forgotten $65 in an old coat pocket'},
  {amt: -50, text:'spins the wheel, accidentally subscribes to a llama grooming newsletter, and pays $50 to cancel'},
  {amt: 30,  text:'spins the wheel, wins a scratch-off bonus, and collects $30'},
  {amt: -40, text:'spins the wheel, the wheel spins back, and it costs $40 to fix the wheel'},
  {amt: 90,  text:'spins the wheel, lands on double points, and collects $90'},
  {amt: -55, text:'spins the wheel, gets caught in it by the sleeve, and pays $55 for repairs'},
];

const BDAY_EVENTS = [
  {amt: 50, text:'celebrates a birthday and the bank chips in $50 for a cake fund'},
  {amt: 50, text:"blows out the candles and collects a $50 gift from the bank"},
  {amt: 50, text:'opens a birthday card stuffed with $50 from a very generous bank'},
  {amt: 50, text:"finds a mystery envelope on the board — happy birthday, here's $50"},
  {amt: 50, text:'is serenaded off-key by the whole board and handed $50 to make up for it'},
  {amt: 50, text:'trips over the birthday banner but still walks away with $50'},
  {amt: 50, text:'gets a surprise party — mostly surprising the bank, which now owes $50'},
  {amt: 50, text:'wishes for cash while blowing out the candles, and the wish is granted: $50'},
  {amt: 50, text:'receives a birthday card with "$50" written in glitter glue'},
  {amt: 50, text:'is today\'s guest of honor and pockets a $50 birthday bonus'},
  {amt: 50, text:'discovers cake AND cash are both free today, and collects $50'},
  {amt: 50, text:'finds a $50 bill taped to a balloon — happy birthday indeed'},
  {amt: 50, text:'celebrates another trip around the sun and collects $50 in "hush money" from the other players'},
  {amt: 50, text:'gets a slightly-too-small birthday hat and a very right-sized $50 from the bank'},
];
function rollDice(){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return; // only the player whose turn it is may roll
  performRoll(order[turnIdx]);
}
/* the actual dice-rolling logic, factored out of rollDice() so it can also be
   triggered automatically — e.g. by Extra Roll, which fires the instant it's
   drawn and rolls again for the same player without anyone clicking the
   button. Callers other than rollDice() are responsible for confirming it's
   still that player's turn to act; this function itself only checks gameOver. */
function performRoll(pid){
  if(gameOver) return;
  busy = true;
  turnRollSeq++; // a real roll just happened — give the turn timer a fresh window (see syncTurnTimerToActivePlayer)
  currentRollWasDouble = false;
  refreshUI();
  const player = players[pid];

  const a = 1+Math.floor(Math.random()*6);
  const b = 1+Math.floor(Math.random()*6);
  const isDouble = a===b;
  window.lastRoll = a+b;
  window.lastRollDice = [a,b];
  drawDice(a,b);
  playDiceSound(); // plays for whoever's screen actually executes the roll (see the network-sync call site for everyone else)
  vibrate(20); // quick tap, mirrors the dice sound

  // wait for the dice animation to finish landing before showing the result and
  // moving the car — otherwise the result text/number appears while the cubes are
  // still visibly tumbling, which looks like it's spoiling its own animation.
  setTimeout(()=>{
    document.getElementById('rollResult').textContent = `${player.name} rolled ${a} + ${b} = ${a+b}`;
    if(sideBets.length) resolveSideBets(pid, a, b, isDouble);
    finishRoll(pid, player, a, b, isDouble);
  }, spd(1500));
}

function finishRoll(pid, player, a, b, isDouble){
  if(player.inJail){
    if(isDouble){
      player.doublesCount = 0;
      bumpStat('doublesRolled', pid);
      log(`<span class="who" style="color:${player.color}">${player.name}</span> rolls doubles (${a}-${b}) and breaks out of jail!`);
      player.inJail = false;
      player.jailTurns = 0;
      moveToken(pid, a+b);
    } else {
      player.jailTurns--;
      if(player.jailTurns<=0){
        player.balance -= CONFIG.bail;
        addToBailoutPot(CONFIG.bail);
        player.inJail = false;
        log(`<span class="who" style="color:${player.color}">${player.name}</span> runs out of patience, pays <b>$${fmt(CONFIG.bail)}</b> bail, and leaves jail.`);
        if(checkBankrupt(pid, null, {type:'move', steps:a+b})){ return; }
        moveToken(pid, a+b);
      } else {
        log(`<span class="who" style="color:${player.color}">${player.name}</span> stays in jail (${player.jailTurns} turn${player.jailTurns===1?'':'s'} left).`);
        readyForEndTurn(pid);
      }
    }
    return;
  }

  if(isDouble){
    player.doublesCount = (player.doublesCount||0)+1;
    if(player.doublesCount>=3){
      player.doublesCount = 0;
      bumpStat('doublesRolled', pid);
      if(tryAutoJailFree(pid, player)){
        moveToken(pid, a+b);
        return;
      }
      player.inJail = true;
      player.jailTurns = 3;
      bumpStat('jailVisits', pid);
      player.pos = 10;
      const offset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
      const p10 = tokenAnchorPoint(10);
      setTokenPos(pid, p10.x+offset, p10.y, {instant:true, pos:10, reverse:true});
      log(`<span class="who" style="color:${player.color}">${player.name}</span> rolls doubles for the third time in a row — hauled off to jail for speeding!`);
      showCardDraw({id:++cardDrawSeq, kind:'jail', glyph:'\u{1F694}', title:'GO TO JAIL', who:player.name, text:'Three doubles in a row — hauled off to jail for speeding!'});
      playCardPopupSound();
      playJailSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      refreshUI();
      readyForEndTurn(pid);
      return;
    }
    currentRollWasDouble = true;
    bumpStat('doublesRolled', pid);
    log(`<span class="who" style="color:${player.color}">${player.name}</span> rolled doubles (${a}-${b}) — moving ${a+b} spaces and going again.`);
  } else {
    player.doublesCount = 0;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> rolled ${a} and ${b} — moving ${a+b} spaces.`);
  }
  moveToken(pid, a+b);
}

/* ---- 2x game speed ----------------------------------------------------------
   Wrap any ms delay that's purely "watching the game play out" (dice landing,
   the token hopping tile-by-tile, a drawn card sitting on screen) in spd(ms) so
   it halves under CONFIG.speedX2Enabled — never a delay that's actually someone's
   decision time (the turn timer, an auction countdown), which stays real
   regardless of this setting. Safe to call from board-render.js/cards.js too
   (both load before this file, but only ever call spd() from inside a callback
   that fires later, once every script has finished loading) — same forward-
   reference pattern the rest of this codebase already relies on for CONFIG/NET. */
function spd(ms){ return CONFIG.speedX2Enabled ? Math.round(ms/2) : ms; }
/* Keeps the topbar's Speed button — and the body class the "2x game speed" CSS
   block in styles.css keys off of, for the dice/token CSS transitions spd()
   itself can't reach — in sync with CONFIG.speedX2Enabled, however it changed
   (a local host toggle, or a synced CONFIG arriving from the host). Called from
   refreshUI() so it stays current for guests too, not just the host who set it. */
function applySpeedUI(){
  document.body.classList.toggle('speed-x2', !!CONFIG.speedX2Enabled);
  const btn = document.getElementById('speedBtn');
  if(!btn) return;
  const lbl = document.getElementById('speedBtnLabel');
  if(lbl) lbl.textContent = 'Speed: ' + (CONFIG.speedX2Enabled ? '2x' : '1x');
  const canToggle = !(typeof NET !== 'undefined' && NET.online && !NET.host);
  btn.disabled = !canToggle;
  btn.title = canToggle ? 'Toggle 2x game speed' : 'Only the host can change game speed';
}
/* Doubles the playbackRate of every finite CSS animation/transition as it starts
   while 2x is on — the dice cube tumble/hop/shadow, token glide and hop, balance
   pops, popup fades, camera pulse, and anything added later — so their durations
   stay in step with the spd()-halved JS delays around them. (The old approach —
   per-property duration overrides in styles.css — never matched: data-theme lives
   on <html>, so `body.speed-x2 [data-theme=...] .x` could not hit anything.)
   Infinite ambient loops (idle bob, wheel spin, driving wobble) are left alone.
   Animations already running when the setting flips just finish at their old
   pace; the next one picks up the new rate. */
function speedUpAnimations(e){
  if(!CONFIG.speedX2Enabled) return;
  const el = e.target;
  if(!el || typeof el.getAnimations !== 'function') return;
  for(const a of el.getAnimations()){
    if(a.playbackRate !== 1) continue;
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    if(!t || t.iterations === Infinity) continue;
    a.playbackRate = 2;
  }
}
function initAnimationSpeed(){
  // capture phase: these events bubble, but capturing on document also covers
  // elements that stop propagation. 'transitionrun' fires when a transition is created.
  document.addEventListener('animationstart', speedUpAnimations, true);
  document.addEventListener('transitionrun', speedUpAnimations, true);
}
initAnimationSpeed();

function moveToken(pid, steps){
  const player = players[pid];
  let remaining = steps;
  setTokenDriving(pid, true);
  const stepOnce = ()=>{
    if(remaining<=0){
      setTokenDriving(pid, false);
      resolveTile(pid, player.pos);
      return;
    }
    player.pos = (player.pos+1)%40;
    const offset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
    const p = tokenAnchorPoint(player.pos);
    setTokenPos(pid, p.x+offset, p.y, {pos:player.pos});
    playFootstepSound();
    if(player.pos===0){
      const landedOnGo = remaining===1; // this is the final step of the move — they stopped exactly on GO
      let amt = landedOnGo ? CONFIG.goLandingBonus : CONFIG.salary;
      const doubled = (player.doubleSalaryCards||0) > 0;
      if(doubled){
        amt *= 2;
        player.doubleSalaryCards--;
      }
      player.balance += amt;
      bumpStat('goSalary', pid, amt);
      log(`<span class="who" style="color:${player.color}">${player.name}</span> ${landedOnGo ? 'lands exactly on GO and collects' : 'passes GO and collects'} <b>$${fmt(amt)}</b>${doubled ? ' (Double Salary used!)' : ''}.`);
      if(doubled){
        showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F4B5}', title:'DOUBLE SALARY USED', who:player.name, text:`Double Salary paid out $${fmt(amt)} at GO.`});
        playCardPopupSound();
        if(cardDrawTimer) clearTimeout(cardDrawTimer);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      }
      playRentSound();
      refreshUI();
    }
    remaining--;
    setTimeout(stepOnce, spd(280));
  };
  stepOnce();
}
/* Setback's backward-only counterpart to moveToken() above — steps the token
   BACKWARD one tile at a time instead of forward. Deliberately does not pay
   any GO salary/bonus even if it steps back across GO: Setback only ever
   fires from a Lucky Wheel/Happy Birthday tile in roughly the back half of
   the board, so a 3-space hop backward can occasionally cross GO, and the
   normal rule that you only get paid for *reaching* GO, never for merely
   sailing past it, applies the same going backward as forward — no line of
   this game's design ever pays out for retreating over the start line. */
function moveTokenBack(pid, steps){
  const player = players[pid];
  let remaining = steps;
  setTokenDriving(pid, true);
  const stepOnce = ()=>{
    if(remaining<=0){
      setTokenDriving(pid, false);
      resolveTile(pid, player.pos);
      return;
    }
    player.pos = (player.pos-1+40)%40;
    const offset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
    const p = tokenAnchorPoint(player.pos);
    setTokenPos(pid, p.x+offset, p.y, {pos:player.pos, reverse:true});
    playFootstepSound();
    remaining--;
    setTimeout(stepOnce, spd(280));
  };
  stepOnce();
}

function resolveTile(pid, idx){
  const player = players[pid];
  const t = tiles[idx];
  bumpStat('tileLandings', idx);
  refreshUI();

  if(t.corner){
    if(t.icon==='gojail'){
      if(tryAutoJailFree(pid, player)){
        readyForEndTurn(pid);
        return;
      }
      player.pos = 10;
      player.inJail = true;
      player.jailTurns = 3;
      bumpStat('jailVisits', pid);
      log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>Go To Jail</b> and is locked up for up to 3 turns (roll doubles or pay $${fmt(CONFIG.bail)} to get out).`);
      showCardDraw({id:++cardDrawSeq, kind:'jail', glyph:'\u{1F694}', title:'GO TO JAIL', who:player.name, text:'Sent straight to jail — no passing GO.'});
      playCardPopupSound();
      playJailSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      const offset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
      const p10 = tokenAnchorPoint(10);
      setTokenPos(pid, p10.x+offset, p10.y, {instant:true, pos:10, reverse:true});
      readyForEndTurn(pid);
      return;
    }
    if(t.icon==='park'){
      const won = bailoutPot;
      bailoutPot = 0;
      updateBailoutPotLabel();
      player.balance += won;
      player.skipNextTurn = true;
      log(won>0
        ? `<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>Bailout</b> and pockets the pot: <b>$${fmt(won)}</b> — but sits out their next turn.`
        : `<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>Bailout</b> — the pot is empty, but they still sit out their next turn.`);
      finishTurnStep(pid);
      return;
    }
    if(t.icon==='start'){
      // GO itself — landing here was already logged with the dollar amount back in
      // moveToken()'s step loop (see "lands exactly on GO and collects $...") the
      // moment the token reached it, so there's nothing left to log here — just
      // don't fall through to the generic amount-less "lands on GO." below.
      finishTurnStep(pid);
      return;
    }
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b>.`);
    finishTurnStep(pid);
    return;
  }

  if(t.icon==='tax'){
    let amt;
    if(t.price.indexOf('%')!==-1){
      amt = Math.round(player.balance * (parseInt(t.price)/100));
    } else {
      amt = parseInt(t.price.replace('$',''));
    }
    player.balance -= amt;
    addToBailoutPot(amt);
    log(`<span class="who" style="color:${player.color}">${player.name}</span> pays <b>${t.name}</b>: -$${fmt(amt)}.`);
    showCardDraw({id:++cardDrawSeq, kind:'tax', glyph:'\u{1F9FE}', title:t.name.toUpperCase(), who:player.name, text:`Paid ${t.name.toLowerCase()} to the bank.`, amt:-amt});
    playCardPopupSound();
    if(cardDrawTimer) clearTimeout(cardDrawTimer);
    cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    if(checkBankrupt(pid, null, {type:'finish'})) return;
    finishTurnStep(pid);
    return;
  }

  if(t.icon==='wheel'){
    // in power-only mode this tile always hands out a power card instead of a cash
    // swing — power cards never touch balance/bankruptcy, so they can resolve
    // immediately without the "would this leave them negative" check the cash
    // branch below needs. Which card (if any) is picked from pickPowerCard(), which
    // honors the per-card enable/weight settings from the config's Cards & Power-ups
    // section; if every power card type is switched off it returns null, and this
    // falls back to the normal cash draw below so the tile is never a dead landing.
    const card = CONFIG.luckyWheelPowerOnly ? pickPowerCard() : null;
    if(card){
      grantPowerCard(player, card);
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws a <b>${card.title}</b> power card!`);
      showCardDraw({id:++cardDrawSeq, kind:'power', glyph:card.glyph, title:card.title, who:player.name, text:card.text});
      playCardPopupSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      if(card.type==='extraRoll'){
        // fires the instant it's drawn — no holding it, no button to press, and
        // no need to wait for the popup to clear before rolling again; the popup
        // just fades out on its own timer below while the reroll happens right away.
        log(`<span class="who" style="color:${player.color}">${player.name}</span> rolls again — <b>Extra Roll</b>!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        performRoll(pid);
        return;
      }
      if(card.type==='skipAhead'){
        // fires the instant it's drawn, same treatment as Extra Roll above —
        // now animates the token forward space-by-space via moveToken() (same
        // stepwise glide + footstep sounds as a normal dice move) instead of
        // silently teleporting, and pays out the usual GO salary/bonus if the
        // jump passes over or lands squarely on GO — moveToken() already
        // handles that the same way a rolled move does. Beat before the jump:
        // hold the token on the wheel/gift tile for a moment with the card
        // popup up so it's clear the SKIP AHEAD draw is what sent it flying,
        // rather than it looking like an ordinary extra move.
        const spaces = Math.min(39, Math.max(1, Number(CONFIG.skipAheadSpaces) || 5));
        log(`<span class="who" style="color:${player.color}">${player.name}</span> jumps ${spaces} spaces ahead!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        setTimeout(()=>{ moveToken(pid, spaces); }, spd(1000));
        return;
      }
      if(card.type==='nudge'){
        // fires the instant it's drawn, always exactly 3 spaces backward — no
        // hand, no direction/amount picker, no waiting for the player's turn
        // to play it. Same beat-before-it-moves treatment as Skip Ahead above,
        // just via moveTokenBack() instead (no GO salary going backward).
        log(`<span class="who" style="color:${player.color}">${player.name}</span> hops 3 spaces back!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        setTimeout(()=>{ moveTokenBack(pid, 3); }, spd(1000));
        return;
      }
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      refreshUI();
      if(stealCardPick){ return; } // Steal a Card paused the turn to wait on the player's pick — resolveStealCardPick() calls finishTurnStep() itself once that's done
      finishTurnStep(pid);
      return;
    }
    const ev = WHEEL_EVENTS[Math.floor(Math.random()*WHEEL_EVENTS.length)];
    player.balance += ev.amt;
    if(ev.amt<0) addToBailoutPot(-ev.amt);
    log(`<span class="who" style="color:${player.color}">${player.name}</span> ${ev.text} (${ev.amt>0?'+':''}$${ev.amt}).`);
    // skip the cosmetic card popup entirely if it would leave the player negative —
    // going into debt should just drop them straight into the inline "you're short"
    // panel below, never compete with a flair overlay for attention.
    if(player.balance>=0){
      showCardDraw({id:++cardDrawSeq, kind:'wheel', glyph:'\u{1F3A1}', title:'LUCKY WHEEL', who:player.name, text:ev.text.charAt(0).toUpperCase()+ev.text.slice(1)+'.', amt:ev.amt});playCardPopupSound();
      // card is purely cosmetic now — it fades itself out on its own timer below and
      // no longer holds up the turn, so resolve the tile immediately.
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    } else if(shownCardDrawId!==null){
      hideCardDraw();
    }
    if(checkBankrupt(pid, null, {type:'finish'})) return;
    finishTurnStep(pid);
    return;
  }

  if(t.icon==='gift'){
    // when the power-only setting is on, Happy Birthday skips its usual cash
    // payout entirely and always hands out a power card instead — pickPowerCard()
    // already honors the per-card enable/weight settings, and if every power card
    // type happens to be switched off it returns null, in which case this falls
    // back to the normal cash draw below so the tile is never a dead landing.
    const powerOnly = CONFIG.bdayPowerOnly ? pickPowerCard() : null;
    if(powerOnly){
      grantPowerCard(player, powerOnly);
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws a <b>${powerOnly.title}</b> power card!`);
      showCardDraw({id:++cardDrawSeq, kind:'power', glyph:powerOnly.glyph, title:powerOnly.title, who:player.name, text:powerOnly.text});
      playCardPopupSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      if(powerOnly.type==='extraRoll'){
        // see matching comment in the Lucky Wheel branch above
        log(`<span class="who" style="color:${player.color}">${player.name}</span> rolls again — <b>Extra Roll</b>!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        performRoll(pid);
        return;
      }
      if(powerOnly.type==='skipAhead'){
        // see matching comment in the Lucky Wheel branch above — pause on the
        // gift tile for a beat before the jump so the draw is clearly what moved it.
        const spaces = Math.min(39, Math.max(1, Number(CONFIG.skipAheadSpaces) || 5));
        log(`<span class="who" style="color:${player.color}">${player.name}</span> jumps ${spaces} spaces ahead!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        setTimeout(()=>{ moveToken(pid, spaces); }, spd(1000));
        return;
      }
      if(powerOnly.type==='nudge'){
        // see matching comment in the Lucky Wheel branch above
        log(`<span class="who" style="color:${player.color}">${player.name}</span> hops 3 spaces back!`);
        cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
        refreshUI();
        setTimeout(()=>{ moveTokenBack(pid, 3); }, spd(1000));
        return;
      }
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      refreshUI();
      if(stealCardPick){ return; } // see matching comment in the Lucky Wheel branch above
      finishTurnStep(pid);
      return;
    }
    const ev = BDAY_EVENTS[Math.floor(Math.random()*BDAY_EVENTS.length)];
    player.balance += ev.amt;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> ${ev.text} (+$${ev.amt}).`);
    showCardDraw({id:++cardDrawSeq, kind:'gift', glyph:'\u{1F381}', title:"HAPPY B'DAY", who:player.name, text:ev.text.charAt(0).toUpperCase()+ev.text.slice(1)+'.', amt:ev.amt});playCardPopupSound();
    // same as above: cosmetic only, no longer blocks the turn from continuing.
    if(cardDrawTimer) clearTimeout(cardDrawTimer);
    cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    finishTurnStep(pid);
    return;
  }

  // purchasable property / railroad / utility
  if(t.owner == null){
    const price = parseInt(t.price.replace('$',''));
    if(CONFIG.auctionFunMode){
      log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b> (${t.price}) — unowned, going straight to auction.`);
      startAuction([idx], { seller:null, startBid:10, timerSec:CONFIG.auctionTimerSec, onComplete:()=>finishTurnStep(pid) });
      return;
    }
    const buyPrice = propertyBuyPrice(t, pid); // Discount card halves this — see propertyBuyPrice()
    const discounted = buyPrice !== price;
    const canAfford = player.balance >= buyPrice;
    pendingBuy = idx;
    if(pid===youAre && !window.__netImpersonating){ // only show the buy/auction panel on the screen of the player it's actually for.
      // The __netImpersonating check matters here specifically: while the host is replaying
      // a GUEST's action (see executeHostCommand), youAre is temporarily swapped to that
      // guest's id, so a bare pid===youAre check would fire true on the HOST's own screen
      // too and pop the buy prompt for a property the host never landed on (e.g. whenever
      // a guest teleports onto — or simply rolls onto — an unowned tile). Skipping the DOM
      // update during impersonation leaves it correctly hidden on the host; syncPendingPanels()
      // (already gated on myTurnNow) re-derives the right panel for every real viewer once
      // the broadcasted state lands on their own client.
      document.getElementById('bpName').textContent = t.name;
      document.getElementById('bpPrice').textContent = discounted ? `$${fmt(buyPrice)} (Discount, was ${t.price})` : t.price;
      document.getElementById('buyPanel').classList.add('show');
      const yesBtn = document.getElementById('buyYesBtn');
      yesBtn.disabled = !canAfford;
      yesBtn.title = canAfford ? '' : "Not enough cash";
    }
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b> (${discounted?`$${fmt(buyPrice)}, Discount card`:t.price}) — unowned${canAfford?'':' — not enough cash to buy'}.`);
    refreshUI(); // recompute Loan/Auction button state now that pendingBuy is set — otherwise
                 // they're stuck showing whatever they were before this decision started
    return; // wait for buy/skip
  }
  if(t.owner === pid || sameTeam(t.owner, pid)){ // IN TEAMS: landing on a teammate's tile is a no-op, same as your own
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on ${t.owner===pid?'their own':"their team's"} property, <b>${t.name}</b>.`);
    finishTurnStep(pid);
    return;
  }
  // pay rent to owner
  const owner = players[t.owner];
  let rent = calcRent(t, t.owner);
  if(rent===0){
    const reason = t.mortgaged ? "it's mortgaged" : (t.frozenTurns>0 ? "it's frozen" : `${owner.name} is in jail`);
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b>, owned by <span class="who" style="color:${owner.color}">${owner.name}</span> — ${reason}, no rent due.`);
    offerLandingBuyoutOrFinish(pid, idx);
    return;
  }
  // Property Shield: blocks rent for every landing during the armed turn, not
  // just the first — it only ever clears at end of turn (endTurn()), whether
  // it blocked one payment, several (e.g. a doubles-roll chain), or none.
  if(player.shieldArmed){
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b>, owned by <span class="who" style="color:${owner.color}">${owner.name}</span> — a <b>Property Shield</b> blocks the $${fmt(rent)} rent!`);
    showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F6E1}\uFE0F', title:'SHIELD USED', who:player.name, text:`Property Shield absorbed $${fmt(rent)} in rent.`});
    playCardPopupSound();
    if(cardDrawTimer) clearTimeout(cardDrawTimer);
    cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    refreshUI();
    offerLandingBuyoutOrFinish(pid, idx);
    return;
  }
  // Shared Shield: team mode only — whichever teammate armed it, it blocks the
  // very next rent charged to ANY teammate (not just the armer), even if that
  // lands on a different teammate's turn than the one who raised it. Unlike
  // Property Shield it's consumed the instant it actually blocks a payment,
  // not at end of turn — see useSharedShieldCard()'s comment for why.
  const sharedShielder = armedSharedShielder(pid);
  if(sharedShielder){
    sharedShielder.sharedShieldArmed = false;
    const sameName = sharedShielder.id===pid;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b>, owned by <span class="who" style="color:${owner.color}">${owner.name}</span> — ${sameName?'their':`<span class="who" style="color:${sharedShielder.color}">${sharedShielder.name}</span>'s`} <b>Shared Shield</b> blocks the $${fmt(rent)} rent!`);
    showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F91D}', title:'SHARED SHIELD USED', who:sharedShielder.name, text:`Shared Shield absorbed $${fmt(rent)} in rent for ${player.name}.`});
    playCardPopupSound();
    if(cardDrawTimer) clearTimeout(cardDrawTimer);
    cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
    refreshUI();
    offerLandingBuyoutOrFinish(pid, idx);
    return;
  }
  // Rent Doubler: already baked into `rent` by calcRent() above (it targets the
  // group the owner picked when they used the card — see useRentDoublerCard);
  // this just detects whether it applied here for the log/popup text. It keeps
  // doubling every rent collected from that group, not just the first, until
  // the owner's own next turn comes back around (see advanceTurn()).
  let doublerUsed = !!(owner.rentDoublerGroup && tileMatchesDoublerGroup(t, owner.rentDoublerGroup));
  // Pooled Payday: team mode — if the owner or any of their teammates has an
  // armed Pooled Payday, this rent is doubled too (stacks with a personal
  // Rent Doubler, since they're tracked independently). Not consumed here —
  // it keeps doubling every rent the team collects until the armer's own
  // next turn comes back around (see advanceTurn()).
  let pooledPaydayUsed = false;
  if(armedPooledPaydayForTeam(t.owner)){
    rent *= 2;
    pooledPaydayUsed = true;
  }
  // Half Shield: a weaker cousin of Property Shield — knocks off half (rounded
  // down) of the final rent instead of blocking it outright, and unlike the
  // full Shield doesn't cancel the payment entirely, so the turn just carries
  // on normally below rather than returning early. Applied after Rent Doubler/
  // Pooled Payday so it's halving whatever actually would have been charged.
  let halfShieldUsed = false;
  if(player.halfShieldArmed){
    rent = Math.floor(rent/2);
    player.halfShieldArmed = false;
    halfShieldUsed = true;
  }
  player.balance -= rent;
  owner.balance += rent;
  player.lastRentPaid = rent; // stamped for a later Toll Refund draw to key off (see grantPowerCard)
  bumpStat('rentPaid', pid, rent);
  bumpStat('rentCollected', t.owner, rent);
  if(!gameStats.biggestRent || rent>gameStats.biggestRent.amt){
    gameStats.biggestRent = {amt:rent, payerId:pid, ownerId:t.owner, tileName:t.name};
  }
  const houseNote = t.houses>0 ? (t.houses>=5?' (hotel)':` (${t.houses} house${t.houses===1?'':'s'})`) : '';
  const rentNotes = [doublerUsed?'Rent Doubler doubled it!':'', pooledPaydayUsed?'Pooled Payday doubled it!':'', halfShieldUsed?'Half Shield cut it in half!':''].filter(Boolean).join(', ');
  log(`<span class="who" style="color:${player.color}">${player.name}</span> lands on <b>${t.name}</b>${houseNote}, owned by <span class="who" style="color:${owner.color}">${owner.name}</span> — pays $${fmt(rent)} rent${rentNotes?` (${rentNotes})`:''}.`);
  playRentSound();
  if(pid===youAre || sameTeam(t.owner,youAre)) vibrate(30); // felt by whichever side of the payment is actually you (or their teammate)
  {
    const payerRect = tokenEls[pid] ? tokenEls[pid].getBoundingClientRect() : null;
    const payeeEl = document.getElementById('bal-'+t.owner);
    const payeeRect = payeeEl ? payeeEl.getBoundingClientRect() : null;
    spawnCoinFly(payerRect, payeeRect, Math.min(6, 2+Math.floor(rent/50)));
    if(rent>=100){
      triggerScreenShake(rent>=200 ? 11 : 6);
      spawnParticleBurst(payerRect, [owner.color, '#ffd54f'], rent>=200 ? 16 : 10);
    }
  }
  if(checkBankrupt(pid, t.owner, {type:'rent', idx})) return;
  offerLandingBuyoutOrFinish(pid, idx);
}

/* after resolving rent (or a rent-free landing), used to pop up a yes/no "buy it out?" panel
   automatically. That's gone now — a landing buyout is available the same way an anytime
   buyout always was: tap the tile you're standing on and use the "Buy it out for $X" button
   in its info card (see buyoutFromInfo below), on your own schedule instead of being asked
   the instant you land. So this just moves the turn along; the tile-info panel's own
   `myTurn && me.pos===idx` check is what still lets the buyout happen for the rest of the turn. */
function offerLandingBuyoutOrFinish(pid, idx){
  finishTurnStep(pid);
}
function buyoutDecision(yes){
  const pid = order[turnIdx];
  if(pid !== youAre) return; // only the active player may decide — same guard buyDecision() uses; this also runs on the host from a guest's network command
  const idx = pendingBuyout;
  pendingBuyout = null;
  document.getElementById('buyoutPanel').classList.remove('show');
  if(idx==null){ finishTurnStep(pid); return; }
  if(yes) performBuyout(idx, pid);
  finishTurnStep(pid);
}
/* ============ CLICK-TO-INSPECT TILE INFO CARD ============ */
/* true if this wheel/gift tile is currently in its power-card-only mode — the
   single source of truth used everywhere the tile's displayed name/glyph needs
   to match its actual behavior (board tile itself via updateSpecialTileVisuals,
   and the tap-to-inspect info card via showTileInfo below). Non-wheel/gift
   tiles always read as false. */
function specialTilePowerMode(t){
  if(t.icon==='wheel') return !!CONFIG.luckyWheelPowerOnly;
  if(t.icon==='gift') return !!CONFIG.bdayPowerOnly;
  return false;
}
function tileTypeIcon(t){
  if(t.icon==='rail') return '&#128646;';
  if(t.icon==='util') return '&#9889;';
  if(t.icon==='wheel' || t.icon==='gift') return specialTilePowerMode(t) ? POWER_TILE_GLYPH : ICON_GLYPH[t.icon];
  return t.group ? flagIconHTML(t.group,40) : '&#127987;';
}
function isPropertyTile(t){ return !t.corner && !!(t.flag || t.icon==='rail' || t.icon==='util'); }
function tiRentRow(label, amtText){
  return `<div class="ti-rent-row"><span>${label}</span><span class="ti-rent-amt">${amtText}</span></div>`;
}
let openTileInfoIdx = null; // tracks which tile's info card is open so actions taken from
                             // inside it (build/mortgage/auction/loan) can refresh it in place
function closeTileInfo(){ openTileInfoIdx = null; document.getElementById('tileInfoOverlay').classList.remove('show'); }
function refreshTileInfoIfOpen(){
  if(openTileInfoIdx!=null && document.getElementById('tileInfoOverlay').classList.contains('show')) showTileInfo(openTileInfoIdx);
}
function showTileInfo(idx){
  openTileInfoIdx = idx;
  const t = tiles[idx];
  const me = players[youAre];
  document.getElementById('tiFlag').innerHTML = tileTypeIcon(t);
  document.getElementById('tiName').textContent = (t.icon==='wheel' || t.icon==='gift')
    ? SPECIAL_TILE_NAMES[t.icon][specialTilePowerMode(t) ? 'power' : 'normal']
    : t.name;
  document.getElementById('tiCash').textContent = '$'+fmt(me.balance);
  const ownerRow = document.getElementById('tiOwnerRow');
  const statsEl = document.getElementById('tiStats');
  const rentEl = document.getElementById('tiRentList');
  const actionsEl = document.getElementById('tiActions');

  if(!isPropertyTile(t)){
    // corners & special tiles (GO, jail, tax, wheel, gift…) — description only, no owner/buy UI
    ownerRow.style.display = 'none';
    statsEl.innerHTML = '';
    actionsEl.innerHTML = '';
    let desc = '';
    if(t.corner){
      desc = ({
        start:"Every player collects a salary from the bank each time they pass or land on GO.",
        jail:"Just visiting — nothing happens here unless you've been sent to jail.",
        park:"A free resting spot to catch your breath before the next lap.",
        gojail:"Landing here sends a player straight to jail — no passing GO, no salary."
      })[t.icon] || '';
    } else if(t.icon==='tax'){
      desc = `Landing here costs ${t.price}, paid straight to the bank.`;
    } else if(t.icon==='wheel'){
      desc = specialTilePowerMode(t)
        ? `Landing here always draws a power card: ${enabledPowerCardList()}.`
        : "Landing here draws a random Lucky Wheel event — it can help or hurt.";
    } else if(t.icon==='gift'){
      desc = specialTilePowerMode(t)
        ? `Landing here always draws a power card: ${enabledPowerCardList()}.`
        : "Landing here is a Happy Birthday bonus — collect a cash gift from the bank.";
    }
    rentEl.innerHTML = `<div class="ti-desc">${desc}</div>`;
    document.getElementById('tileInfoOverlay').classList.add('show');
    return;
  }

  ownerRow.style.display = 'flex';
  const price = parseInt(t.price.replace('$',''));
  const ownerIcon = document.getElementById('tiOwnerIcon');
  const ownerName = document.getElementById('tiOwnerName');
  const ownerSub = document.getElementById('tiOwnerSub');
  if(t.owner==null){
    ownerIcon.textContent = '\u{1F3E6}';
    ownerIcon.style.background = '';
    ownerName.textContent = 'Bank';
    ownerName.style.color = '';
    ownerSub.textContent = 'Unowned — available to buy';
  } else {
    const owner = players[t.owner];
    ownerIcon.textContent = owner.name.charAt(0).toUpperCase();
    ownerIcon.style.background = owner.color;
    ownerName.textContent = owner.name;
    ownerName.style.color = owner.color;
    ownerSub.textContent = t.mortgaged ? 'Mortgaged — no rent due' : (t.frozenTurns>0) ? `Frozen for ${t.frozenTurns} more turn${t.frozenTurns===1?'':'s'} — no rent due` : 'Current property owner';
  }

  // ---- stat boxes: price + (for streets) house/hotel build cost ----
  if(t.flag){
    const hc = houseCost(t);
    statsEl.innerHTML = `
      <div class="ti-stat"><div class="ti-stat-label">Price</div><div class="ti-stat-val">${t.price}</div></div>
      <div class="ti-stat"><div class="ti-stat-label">&#127968; House</div><div class="ti-stat-val">$${fmt(hc)}</div></div>
      <div class="ti-stat"><div class="ti-stat-label">&#127976; Hotel</div><div class="ti-stat-val">$${fmt(hc)}</div></div>`;
  } else {
    statsEl.innerHTML = `<div class="ti-stat" style="grid-column:1/-1;"><div class="ti-stat-label">Price</div><div class="ti-stat-val">${t.price}</div></div>`;
  }

  // ---- rent table ----
  let rentHtml = '';
  if(t.icon==='rail'){
    [25,50,100,200].forEach((amt,i)=> rentHtml += tiRentRow(`With ${i+1} railroad${i?'s':''} owned`, '$'+fmt(amt)));
  } else if(t.icon==='util'){
    rentHtml += tiRentRow('With 1 utility owned', '4&times; dice roll');
    rentHtml += tiRentRow('With 2 utilities owned', '10&times; dice roll');
  } else if(Array.isArray(t.rent)){
    const [r0,r1,r2,r3,r4,r5] = t.rent;
    // only advertise the full-set double-rent row when that house rule is actually
    // on — calcRent() itself already gates the ×2 behind CONFIG.doubleRentFullSet,
    // so showing it unconditionally here used to promise rent players would never
    // actually be charged.
    if(CONFIG.doubleRentFullSet) rentHtml += tiRentRow('Rent with full color set', '$'+fmt(r0*2));
    rentHtml += tiRentRow('with no house', '$'+fmt(r0));
    rentHtml += tiRentRow('with 1 house', '$'+fmt(r1));
    rentHtml += tiRentRow('with 2 houses', '$'+fmt(r2));
    rentHtml += tiRentRow('with 3 houses', '$'+fmt(r3));
    rentHtml += tiRentRow('with 4 houses', '$'+fmt(r4));
    rentHtml += tiRentRow('with hotel', '$'+fmt(r5));
  } else {
    const base = Math.max(4, Math.round(price*0.15));
    if(CONFIG.doubleRentFullSet) rentHtml += tiRentRow('Rent with full color set', '$'+fmt(base*2));
    rentHtml += tiRentRow('with no house', '$'+fmt(base));
    rentHtml += tiRentRow('with 1 house', '$'+fmt(base*4));
    rentHtml += tiRentRow('with 2 houses', '$'+fmt(base*8));
    rentHtml += tiRentRow('with 3 houses', '$'+fmt(base*12));
    rentHtml += tiRentRow('with 4 houses', '$'+fmt(base*16));
    rentHtml += tiRentRow('with hotel', '$'+fmt(base*20));
  }
  rentEl.innerHTML = rentHtml;

  // ---- actions: buy (if landed & pending), buy-out from an opponent, or propose a trade ----
  let actionsHtml = '';
  const myTurn = order[turnIdx]===youAre;
  if(t.owner==null){
    const buyPrice = propertyBuyPrice(t, youAre); // Discount card halves this — see propertyBuyPrice()
    const discounted = buyPrice !== price;
    const buyLabel = discounted ? `Buy for $${fmt(buyPrice)} (Discount, was $${fmt(price)})` : `Buy for ${t.price}`;
    if(pendingBuy===idx && myTurn){
      actionsHtml = `<button class="buy-btn yes" onclick="buyDecision(true);closeTileInfo();">${buyLabel}</button>
        <button class="buy-btn no" onclick="buyDecision(false);closeTileInfo();">&#128176; Send to auction</button>`;
    } else if(!NET.online){
      // Local test only: let whichever player you're currently viewing buy this tile
      // straight from the bank, regardless of whose turn it is or where any token
      // sits — a shortcut for setting up test scenarios. Never shown in an online room.
      const afford = me.balance >= buyPrice;
      actionsHtml = `<button class="buy-btn yes" ${afford?'':'disabled'} onclick="buyPropertyAnywhere(${idx});closeTileInfo();">${buyLabel}</button>
        <div class="ti-hint">&#9889; Local test: buy directly from the bank, no need to land on it.</div>`;
    } else {
      actionsHtml = `<div class="ti-hint">Land on this tile on your turn to buy it from the bank.</div>`;
    }
  } else if(ownedByUnit(t,youAre)){ // IN TEAMS: shows the manage actions for a teammate's tile too
    const myTurnNow = order[turnIdx]===youAre;
    // --- build/sell houses (street properties only) ---
    if(t.group){
      const houses = t.houses||0;
      const isFullSet = ownsGroup(youAre, t.group);
      const groupMin = Math.min(...groupTiles(t.group).filter(x=>ownedByUnit(x,youAre)).map(x=>x.houses||0));
      const unevenBlock = CONFIG.evenBuildRule && houses>groupMin;
      const notEligibleSet = CONFIG.requireFullSetToBuild && !isFullSet;
      const isFrozen = (t.frozenTurns||0)>0;
      const buildDisabled = !myTurnNow || notEligibleSet || houses>=5 || t.mortgaged || unevenBlock || isFrozen;
      const cost = houseCost(t);
      actionsHtml += `<button class="buy-btn no" ${(houses>0&&myTurnNow&&!isFrozen)?'':'disabled'} ${houses>0?'':'style="visibility:hidden;"'} onclick="sellHouse('${t.name}')">Sell house (+$${Math.round(cost/2/10)*10})</button>`;
      actionsHtml += `<button class="buy-btn yes" ${buildDisabled?'disabled':''} onclick="buildHouse('${t.name}')">${houses>=4?'&#127976; Build hotel':'&#127968; Build house'} ($${cost})</button>`;
      if(isFrozen) actionsHtml += `<div class="ti-hint">&#10052;&#65039; Frozen for ${t.frozenTurns} more turn${t.frozenTurns===1?'':'s'} — no building, selling, mortgaging, or rent.</div>`;
    }
    // --- mortgage / unmortgage (allowed any time, not just on your turn) ---
    if(t.mortgaged){
      const cost = unmortgageCost(t);
      const afford = me.balance >= cost;
      actionsHtml += `<button class="buy-btn yes" ${(afford&&!(t.frozenTurns>0))?'':'disabled'} onclick="toggleMortgage('${t.name}')">Unmortgage ($${cost})</button>`;
    } else {
      const value = mortgageValue(t);
      const hasHouses = (t.houses||0)>0;
      const groupHasHouses = !hasHouses && t.group && groupTiles(t.group).some(x=>ownedByUnit(x,youAre) && (x.houses||0)>0);
      actionsHtml += `<button class="buy-btn yes" ${(hasHouses||groupHasHouses||t.frozenTurns>0)?'disabled':''} onclick="toggleMortgage('${t.name}')">Mortgage (+$${value})</button>`;
    }
  } else {
    const owner = players[t.owner];
    const siblingBuilt = t.group && groupTiles(t.group).some(x=>x!==t && (x.houses||0)>0); // a DIFFERENT property in the same group has a building — always blocks buyout, independent of buyoutIncludesHouses (which only ever governed houses on THIS tile)
    const builtOn = siblingBuilt || (!CONFIG.buyoutIncludesHouses && (t.houses||0)>0);
    const isFrozen = (t.frozenTurns||0)>0;
    // Buyout price is quoted here unconditionally (whenever buyouts are enabled at
    // all) so every owned property card tells you what it'd cost to buy out from
    // its owner, whether or not you're currently standing on it / it's your turn —
    // only the actual buy button stays gated behind those conditions below.
    const cost = price * CONFIG.buyoutMultiplier;
    if(CONFIG.buyoutEnabled){
      actionsHtml = `<div class="ti-hint">Buyout price: <b>$${fmt(cost)}</b> (${CONFIG.buyoutMultiplier}&times; price)</div>`;
    }
    if(myTurn && me.pos===idx && CONFIG.buyoutEnabled && !builtOn && !isFrozen){
      const afford = me.balance >= cost;
      actionsHtml += `<button class="buy-btn yes" ${afford?'':'disabled'} onclick="buyoutFromInfo(${idx})">Buy it out for $${fmt(cost)}</button>`;
    } else if(!CONFIG.buyoutEnabled){
      actionsHtml += `<div class="ti-hint">Buyouts are off in this game's rules — propose a trade instead, or turn buyouts on from Rules &amp; setup.</div>`;
    } else if(myTurn && me.pos===idx && isFrozen){
      actionsHtml += `<div class="ti-hint">&#10052;&#65039; ${owner.name}'s property is frozen for ${t.frozenTurns} more turn${t.frozenTurns===1?'':'s'} — it can't be bought out until that wears off.</div>`;
    } else if(myTurn && me.pos===idx && siblingBuilt){
      actionsHtml += `<div class="ti-hint">${owner.name} has built on another property in this group — none of the group can be bought out until every house/hotel in it is sold back.</div>`;
    } else if(myTurn && me.pos===idx && builtOn){
      actionsHtml += `<div class="ti-hint">${owner.name} has built on this property — it can't be bought out until the houses are gone.</div>`;
    } else if(!(myTurn && me.pos===idx)){
      actionsHtml += `<div class="ti-hint">Land on this tile on your turn to buy it out from ${owner.name}.</div>`;
    }
    actionsHtml += `<button class="buy-btn no" onclick="closeTileInfo();openTrade('${t.owner}');">&#8646; Propose a trade</button>`;
  }
  actionsEl.innerHTML = actionsHtml;

  document.getElementById('tileInfoOverlay').classList.add('show');
}
function buyoutFromInfo(idx){
  const pid = order[turnIdx];
  if(pid !== youAre || busy) return;
  if(performBuyout(idx, pid)){
    closeTileInfo();
    refreshUI();
  }
}

/* re-derive the buy/buyout panel contents and visibility from pendingBuy/pendingBuyout after a
   state sync (e.g. on a client that just joined or just received a host state push) */
function syncPendingPanels(){
  const myTurnNow = order[turnIdx]===youAre; // buy/auction and buyout decisions only ever belong to the active player
  const buyPanel = document.getElementById('buyPanel');
  if(pendingBuy!=null && tiles[pendingBuy] && myTurnNow){
    const t = tiles[pendingBuy];
    const price = parseInt(t.price.replace('$',''));
    const actor = players[order[turnIdx]];
    const buyPrice = propertyBuyPrice(t, order[turnIdx]); // Discount card halves this — see propertyBuyPrice()
    const discounted = buyPrice !== price;
    const canAfford = !!actor && actor.balance >= buyPrice;
    document.getElementById('bpName').textContent = t.name;
    document.getElementById('bpPrice').textContent = discounted ? `$${fmt(buyPrice)} (Discount, was ${t.price})` : t.price;
    const yesBtn = document.getElementById('buyYesBtn');
    yesBtn.disabled = !canAfford;
    yesBtn.title = canAfford ? '' : "Not enough cash";
    if(buyPanel) buyPanel.classList.add('show');
  } else if(buyPanel){
    buyPanel.classList.remove('show');
  }
  const buyoutPanel = document.getElementById('buyoutPanel');
  if(pendingBuyout!=null && tiles[pendingBuyout] && myTurnNow){
    const t = tiles[pendingBuyout];
    const owner = players[t.owner];
    const price = parseInt(t.price.replace('$',''));
    document.getElementById('buyoutName').textContent = t.name;
    document.getElementById('buyoutOwner').textContent = owner ? owner.name : '';
    document.getElementById('buyoutPrice').textContent = '$'+fmt(price*CONFIG.buyoutMultiplier);
    if(buyoutPanel) buyoutPanel.classList.add('show');
  } else if(buyoutPanel){
    buyoutPanel.classList.remove('show');
  }
}
/* transfer an owned property from its owner to buyerPid at CONFIG.buyoutMultiplier x price —
   allowed whether or not it's mortgaged, same as a player-run auction; the mortgage
   is cleared as part of the sale rather than being something the buyer has to
   separately pay off, matching how winning an auctioned property already works. */
function performBuyout(idx, buyerPid){
  const t = tiles[idx];
  const sellerPid = t.owner;
  if(!sellerPid || sellerPid===buyerPid || sameTeam(sellerPid,buyerPid) || t.frozenTurns>0) return false; // IN TEAMS: buying out your own teammate is a no-op, not a real trade
  if(!CONFIG.buyoutIncludesHouses && (t.houses||0)>0) return false; // can't buy out a property that's been built on
  if(t.group && groupTiles(t.group).some(x=>x!==t && (x.houses||0)>0)) return false; // a DIFFERENT property in the same group has a building — blocks the whole group, independent of buyoutIncludesHouses
  const price = parseInt(t.price.replace('$',''));
  const cost = price * CONFIG.buyoutMultiplier;
  const buyer = players[buyerPid];
  const seller = players[sellerPid];
  if(buyer.balance < cost) return false;
  buyer.balance -= cost;
  seller.balance += cost;
  t.owner = buyerPid;
  t.mortgaged = false;
  markOwnership(idx, teamDisplayColor(buyerPid)); // IN TEAMS: tile reads as the team's blended color, not just this buyer's own
  pulseTile(idx, teamDisplayColor(buyerPid));
  setMortgageVisual(idx, false);
  log(`<span class="who" style="color:${buyer.color}">${buyer.name}</span> buys out <b>${t.name}</b> from <span class="who" style="color:${seller.color}">${seller.name}</span> for $${fmt(cost)} (${CONFIG.buyoutMultiplier}&times; price).`);
  checkBankrupt(sellerPid, null);
  return true;
}

/* Local-test-only shortcut: buy an unowned property straight from the bank for
   whichever player is currently being viewed (youAre), with no requirement to have
   landed on it, be mid-turn, or have your token anywhere near it. Wired up from the
   tile info panel's "buy from anywhere" button, which only ever renders when
   !NET.online — this function re-checks that itself as a safety net so it can never
   fire in an online room even if called some other way. */
function buyPropertyAnywhere(idx){
  if(NET.online) return false;
  const t = tiles[idx];
  if(!t || !isPropertyTile(t) || t.owner!=null) return false;
  const pid = youAre;
  const player = players[pid];
  if(!player || player.bankrupt) return false;
  const price = propertyBuyPrice(t, pid); // Discount card halves this — see propertyBuyPrice()
  const discountUsed = player.highRiseHustleCards>0;
  if(player.balance < price) return false;
  player.balance -= price;
  t.owner = pid;
  if(discountUsed) player.highRiseHustleCards--; // Discount card burns on the very next property purchase
  markOwnership(idx, teamDisplayColor(pid)); // IN TEAMS: tile reads as the team's blended color, not just this buyer's own
  pulseTile(idx, teamDisplayColor(pid));
  playBuySound();
  log(`<span class="who" style="color:${player.color}">${player.name}</span> buys <b>${t.name}</b> for $${fmt(price)}${discountUsed?' — Discount card used!':''} (local test — bought from anywhere).`);
  refreshUI();
  return true;
}
window.buyPropertyAnywhere = buyPropertyAnywhere;

function buyDecision(yes){
  if(pendingBuy==null) return;
  const pid = order[turnIdx];
  if(pid !== youAre) return; // only the active player can decide
  const player = players[pid];
  const idx = pendingBuy;
  const t = tiles[idx];
  const price = propertyBuyPrice(t, pid); // Discount card halves this — see propertyBuyPrice()
  const discountUsed = player.highRiseHustleCards>0;

  if(yes && player.balance < price){
    // guard rail in case the disabled state was bypassed
    log(`<span class="who" style="color:${player.color}">${player.name}</span> can't afford <b>${t.name}</b>.`);
    yes = false;
  }

  document.getElementById('buyPanel').classList.remove('show');
  pendingBuy = null;

  if(yes){
    player.balance -= price;
    t.owner = pid;
    if(discountUsed) player.highRiseHustleCards--; // Discount card burns on the very next property purchase
    markOwnership(idx, teamDisplayColor(pid)); // IN TEAMS: tile reads as the team's blended color, not just this buyer's own
    pulseTile(idx, teamDisplayColor(pid));
    playBuySound(); // plays for whoever's screen actually executes the buy (see the network-sync call site for everyone else)
    log(`<span class="who" style="color:${player.color}">${player.name}</span> buys <b>${t.name}</b> for $${fmt(price)}${discountUsed?' — Discount card used!':''}.`);
    finishTurnStep(pid);
  } else {
    log(`<span class="who" style="color:${player.color}">${player.name}</span> sends <b>${t.name}</b> to auction.`);
    if(CONFIG.auctionOnDecline){
      startAuction([idx], { seller:null, startBid:10, timerSec:CONFIG.auctionTimerSec, onComplete:()=>finishTurnStep(pid) });
    } else {
      finishTurnStep(pid);
    }
  }
}

/* called after a tile is fully resolved on a live turn — either the same
   player rolls again (they rolled doubles) or their move is done and they
   must explicitly click "End turn" to pass play along */
function finishTurnStep(pid){
  if(gameOver) return;
  const player = players[pid];
  if(!player || player.bankrupt) { endTurn(); return; }
  if(currentRollWasDouble){
    currentRollWasDouble = false;
    busy = false;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> rolls again.`);
    refreshUI();
  } else if(player.extraRollCredits>0){
    // a banked Rally credit — cashed in exactly like a rolled double earns
    // another go, just from a different source. Spent one at a time, so a
    // player who's banked several Rallies gets that many extra rolls in a
    // row before finally moving on to readyForEndTurn().
    player.extraRollCredits--;
    busy = false;
    log(`<span class="who" style="color:${player.color}">${player.name}</span> cashes in a <b>Rally</b> bonus roll!`);
    refreshUI();
  } else {
    readyForEndTurn(pid);
  }
}

/* move is fully resolved — unlock property management/trading but keep rolling
   locked until the active player explicitly clicks "End turn" */
function readyForEndTurn(pid){
  if(gameOver) return;
  busy = false;
  awaitingEndTurn = true;
  refreshUI();
}

/* voluntary "buy your way out" — lets the jailed player pay bail instead of
   rolling for doubles. Paying clears the jailed status; the current turn
   still ends without a roll (same as before), but the player rejoins the
   normal roll rotation immediately on their very next turn — paying bail
   is no longer also penalized with an extra skipped turn on top of that. */
function payBail(){
  if(busy || awaitingEndTurn || gameOver) return;
  if(order[turnIdx] !== youAre) return; // only the active player may pay their own bail
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !player.inJail) return;
  player.balance -= CONFIG.bail;
  addToBailoutPot(CONFIG.bail);
  player.inJail = false;
  player.jailTurns = 0;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> pays <b>$${fmt(CONFIG.bail)}</b> bail and walks free.`);
  // endTurn() itself runs the bankruptcy check (in case bail emptied their
  // balance below zero) and advances turnIdx — same path a normal turn
  // takes, so nothing here duplicates it. (Any bank loan installment is now
  // charged separately, at the start of the next player's own turn.)
  endTurn();
}

/* Get Out of Jail Free now fires the instant it would apply, instead of
   sitting in jail waiting for the holder to click a "Use" button: the moment
   a player would actually be sent to jail (three doubles in a row, or
   landing on Go To Jail), a held card is auto-spent to cancel the trip
   entirely. Returns true if a card fired, so the caller can skip jailing
   the player and carry on as normal. */
function tryAutoJailFree(pid, player){
  if(!player || !(player.jailFreeCards>0)) return false;
  player.jailFreeCards--;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Get Out of Jail Free</b> card and avoids jail entirely.`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F513}', title:'GET OUT OF JAIL FREE', who:player.name, text:`${player.name} avoids jail — no bail needed.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  return true;
}
/* kept for network/action-routing compatibility, but no longer reachable from
   the UI now that Get Out of Jail Free auto-fires via tryAutoJailFree() above
   instead of being played by hand. */
function useJailFreeCard(){
  if(busy || awaitingEndTurn || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !player.inJail || !(player.jailFreeCards>0)) return;
  player.jailFreeCards--;
  player.inJail = false;
  player.jailTurns = 0;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Get Out of Jail Free</b> card and walks.`);
  refreshUI();
}

/* Arms a held Property Shield for this turn only. Must be pressed before rolling
   (the button is hidden the moment busy/awaitingEndTurn flips true) — the charge
   is spent right here, not per rent blocked, so it protects every rent charged to
   you for the rest of the turn (including a doubles-roll chain), not just one hit.
   Cleared automatically at end of turn in endTurn(), used or not. */
function useShieldCard(){
  if(busy || awaitingEndTurn || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || player.shieldArmed || !(player.shieldCharges>0)) return;
  player.shieldCharges--;
  player.shieldArmed = true;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> raises a <b>Property Shield</b> for this turn.`);
  refreshUI();
}

/* Weaker cousin of useShieldCard — arms a held Half Shield for this turn only,
   same "spend now, protects until endTurn()" shape as Property Shield above
   (see the matching clear in endTurn()), just knocks the rent down instead of
   blocking it outright (see the Half Shield check in resolveTile's rent block). */
function useHalfShieldCard(){
  if(busy || awaitingEndTurn || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || player.halfShieldArmed || !(player.halfShieldCharges>0)) return;
  player.halfShieldCharges--;
  player.halfShieldArmed = true;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> raises a <b>Half Shield</b> for this turn.`);
  refreshUI();
}

/* Arms a held Shared Shield — team mode only. Unlike Property Shield, this does
   NOT clear at the armer's own endTurn(): it has to keep protecting the team
   even after the armer's turn ends, since the rent it blocks may well land on
   a teammate's turn instead of this one. It stays armed until it actually
   blocks one rent payment for whichever teammate gets charged next (see the
   armedSharedShielder() check in resolveTile), whoever that turns out to be —
   or forever, if nobody on the team gets charged rent again this game. Can't
   be armed while the team already has one armed (sharedShieldUsable()). */
function useSharedShieldCard(){
  if(busy || awaitingEndTurn || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.sharedShieldCharges>0) || !sharedShieldUsable(pid)) return;
  player.sharedShieldCharges--;
  player.sharedShieldArmed = true;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> raises a <b>Shared Shield</b> over their whole team.`);
  refreshUI();
}

/* Arms a held Rent Doubler on ONE property group the owner picks (a color set,
   all Railroads, or all Utilities) — doubling every rent collected from a tile
   in that group from this moment until the player's own next turn comes back
   around (see advanceTurn(), which expires an unused/still-active arm right as
   their turn starts again), not just the next single payment. The charge is
   spent the instant it's armed, same as the shield above. */
function useRentDoublerCard(groupKey){
  if(gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || player.rentDoublerGroup || !(player.rentDoublerCharges>0)) return;
  const owned = tiles.filter(t=>purchasable(t) && t.owner===pid && tileMatchesDoublerGroup(t, groupKey));
  if(!owned.length) return; // invalid or stale group selection
  player.rentDoublerCharges--;
  player.rentDoublerGroup = groupKey;
  const label = doublerGroupLabel(pid, groupKey);
  log(`<span class="who" style="color:${player.color}">${player.name}</span> uses a <b>Rent Doubler</b> on <b>${label}</b> — rent from ${owned.length>1?'those properties is':'that property is'} doubled until their next turn.`);
  refreshUI();
}

/* Arms a held Pooled Payday — team mode only. Like Rent Doubler, the charge is
   spent the instant it's armed and the window runs until the armer's own next
   turn comes back around (see advanceTurn(), which clears pooledPaydayArmed
   the same way it clears rentDoublerGroup). Unlike Rent Doubler, the doubling
   isn't limited to rent the armer personally collects — every teammate's rent
   income is doubled for the whole window (see armedPooledPaydayForTeam() and
   the resolveTile rent branch that calls it). */
function usePooledPaydayCard(){
  if(gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || player.pooledPaydayArmed || !(player.pooledPaydayCards>0)) return;
  player.pooledPaydayCards--;
  player.pooledPaydayArmed = true;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> arms <b>Pooled Payday</b> — the whole team's rent doubles until their next turn.`);
  refreshUI();
}

/* Discount (formerly High-Rise Hustle) is now an auto-fire card, like Bankruptcy
   Insurance — it just sits in hand until the holder actually buys a property, at
   which point propertyBuyPrice()/buyDecision()/buyPropertyAnywhere() apply the
   50% discount and burn one copy automatically. No manual "Use" button (see
   POWER_CARD_USE_FN/powerCardUsable). */

/* spends a held Teleport power card — enters "pick a tile" mode; the next tile
   the player clicks (see tile click handler) becomes their new position instead
   of opening that tile's info card. Only usable on your own turn, and only
   once you're not mid-move (busy) since moveToken() already owns player.pos then. */
let teleportPickMode = false;
function useTeleportCard(){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.teleportCards>0)) return;
  if(anyPickModeActive()) return; // don't stack on top of another open pick mode
  teleportPickMode = true;
  document.getElementById('rollResult').textContent = 'Teleport ready — tap any tile on the board to warp there.';
  refreshUI();
}
function cancelTeleportPick(){
  if(!teleportPickMode) return;
  teleportPickMode = false;
  refreshUI();
}
function resolveTeleportTo(idx){
  const pid = order[turnIdx];
  // The teleport card belongs to whoever's turn it actually is — not just whoever
  // happens to call this. This runs on the host from a guest's network command too
  // (see executeHostCommand, which sets youAre to the real sender for the call),
  // so without this check any connected player could warp the ACTIVE player's
  // token and spend THEIR teleport card, without the active player ever asking
  // for it. Every other card-resolution action in this file that isn't gated by
  // a per-pick object (propertySwapPick/stealCardPick — see those below) needs
  // this same sender check.
  if(pid !== youAre) return;
  teleportPickMode = false;
  const player = players[pid];
  if(!player || !(player.teleportCards>0)){ refreshUI(); return; }
  player.teleportCards--;
  player.pos = idx;
  const t = tiles[idx];
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Teleport</b> card and warps to <b>${t.name}</b>.`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F300}', title:'TELEPORT', who:player.name, text:`Warped straight to ${t.name}.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  const offset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
  const p = tokenAnchorPoint(idx);
  setTokenPos(pid, p.x+offset, p.y, {instant:true, pos:idx});
  resolveTile(pid, idx);
}

/* held pending-pick state for Property Swap — {pid, stage:'mine'|'theirs', myIdx}
   — set when the holder chooses to play a held Property Swap card (see
   usePropertySwapCard() below) and cleared once both taps are resolved (see
   resolvePropertySwapPick() and the tile click handler), or if they cancel out
   partway through (see cancelPropertySwapPick()).
   BUGFIX: unlike teleportPickMode/sabotagePickMode (which are
   fine to stay purely local, since their resolve* functions re-derive who's
   acting from the host-synced order[turnIdx]), resolvePropertySwapPick's own
   two-stage bookkeeping (myIdx, stage) lives ON this object, so this object
   itself has to be authoritative on the host. usePropertySwapCard/
   cancelPropertySwapPick are therefore both in ACTIONS (see the online-mode
   IIFE) so a guest's "Use"/"Cancel" tap sets/clears the real host-side
   propertySwapPick and rides back down through the normal state sync —
   exactly like resolvePropertySwapPick already did. Previously only
   resolvePropertySwapPick was wrapped, so a guest's tile taps were sent to a
   host whose propertySwapPick was still null and silently did nothing. */
let propertySwapPick = null;
/* spends a held Property Swap power card — enters "pick one of my own tiles,
   then an opponent's tile" mode, same two-stage pattern as before, but now
   started by the player whenever they choose (like Property Freeze/Teleport)
   instead of firing the instant it's drawn. Checks eligibility up front so a
   card with nothing to trade doesn't even enter pick mode; the card itself
   isn't spent until the swap actually completes (see resolvePropertySwapPick),
   so canceling out costs nothing.
   UX: this used to be "tap a tile on the board, read a one-line hint under the
   board, tap another tile" with zero feedback about which tiles were even
   valid — easy to lose track of which stage you were on and end up mashing the
   same tile. It now opens propertySwapOverlay (a proper step-by-step picker
   with a live list of eligible properties, so tapping is optional rather than
   the only way in) and glows the eligible tiles right on the board. Both the
   board tap and the list click resolve through the same resolvePropertySwapPick,
   so they always agree on state. */
function usePropertySwapCard(){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.propertySwapCards>0)) return;
  if(propertySwapPick) return;
  if(teleportPickMode || sabotagePickMode) return; // don't stack on top of another open pick mode
  if(!propertySwapEligible(pid)){
    document.getElementById('rollResult').textContent = "Property Swap needs an unbuilt property of your own and an unbuilt property owned by someone else — nothing eligible right now.";
    return;
  }
  propertySwapPick = {pid, stage:'mine', myIdx:null};
  document.getElementById('rollResult').textContent = "Property Swap: tap one of your own properties with no houses on it to give up.";
  refreshUI();
}
function cancelPropertySwapPick(){
  if(!propertySwapPick) return;
  if(propertySwapPick.pid !== youAre) return; // only the player who opened the pick may cancel it — now that this runs through ACTIONS/executeHostCommand for guests too, guard it the same way playerEndTurn guards ending someone else's turn
  propertySwapPick = null;
  refreshUI();
}
/* lets the player undo their "give up" pick and choose a different one instead
   of the only prior escape hatch (Cancel, which threw away the whole card use
   and made them re-open it from the power cards hub). Doesn't touch the card
   count — nothing was spent yet at this stage. */
function propertySwapBack(){
  if(!propertySwapPick || propertySwapPick.pid!==youAre || propertySwapPick.stage!=='theirs') return;
  propertySwapPick.stage = 'mine';
  propertySwapPick.myIdx = null;
  document.getElementById('rollResult').textContent = "Property Swap: tap one of your own properties with no houses on it to give up.";
  refreshUI();
}
/* resolves each half of a Property Swap pick (see propertySwapPick/
   usePropertySwapCard above). First tap must be one of their own tiles with no
   houses on it (stage 'mine'); once that's locked in, the second tap must be an
   opponent's tile with no houses on it (stage 'theirs'), which performs the
   actual ownership swap and spends the card. An out-of-scope tap at either
   stage is just ignored with a nudge — it doesn't burn the pick or advance the
   stage. idx arrives the same way whether it came from tapping the board or
   clicking a row in propertySwapOverlay. */
function resolvePropertySwapPick(idx){
  if(!propertySwapPick) return;
  if(propertySwapPick.pid !== youAre) return; // same cross-player guard as resolveTeleportTo — a pending pick belongs to whoever opened it, not whoever calls this
  const pid = propertySwapPick.pid;
  const player = players[pid];
  const t = tiles[idx];
  if(!player || !t) return;
  if(propertySwapPick.stage==='mine'){
    if(!ownedByUnit(t,pid) || groupHasBuilding(t)){ // IN TEAMS: a teammate's unbuilt tile is fair game to give up too
      document.getElementById('rollResult').textContent = "Property Swap: tap one of your own properties with no houses anywhere in its group.";
      return;
    }
    propertySwapPick.myIdx = idx;
    propertySwapPick.stage = 'theirs';
    document.getElementById('rollResult').textContent = `Property Swap: giving up ${t.name} — now tap an opponent's property with no houses in its group to take.`;
    refreshUI();
    return;
  }
  // stage === 'theirs'
  if(!t.owner || t.owner===pid || sameTeam(t.owner,pid) || groupHasBuilding(t)){ // IN TEAMS: can't force-swap a teammate's property — it's already yours
    document.getElementById('rollResult').textContent = "Property Swap: tap an opponent's property with no houses anywhere in its group.";
    return;
  }
  const mine = tiles[propertySwapPick.myIdx];
  if(psCategory(t) !== psCategory(mine)){ // fairness rule: countries only swap for countries, railroads/utilities only for railroads/utilities
    document.getElementById('rollResult').textContent = `Property Swap: ${mine.name} is a ${psCategory(mine)==='country'?'country':'railroad/utility'} — you can only take another ${psCategory(mine)==='country'?'country':'railroad/utility'} for it.`;
    return;
  }
  const otherPid = t.owner;
  const otherPlayer = players[otherPid];
  const myIdx = propertySwapPick.myIdx;
  player.propertySwapCards--;
  mine.owner = otherPid;
  t.owner = pid;
  markOwnership(myIdx, teamDisplayColor(otherPid)); pulseTile(myIdx, teamDisplayColor(otherPid));
  markOwnership(idx, teamDisplayColor(pid)); pulseTile(idx, teamDisplayColor(pid));
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Property Swap</b> card — hands over <b>${mine.name}</b> and takes <span class="who" style="color:${otherPlayer.color}">${otherPlayer.name}</span>'s <b>${t.name}</b> in exchange.`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F504}', title:'PROPERTY SWAP', who:player.name, text:`Traded ${mine.name} for ${t.name}.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  propertySwapPick = null;
  refreshUI();
  renderManage(pid);

}

/* highlights, right on the board, exactly which tiles are legal to tap for the
   current stage of an open Property Swap pick — a violet pulse for "you can pick
   this" and a solid cyan ring on the tile already locked in as the give-up side.
   This is the main fix for players getting lost mid-pick: previously the only
   feedback was a one-line hint below the board, so an ineligible tap (a tile
   with houses, or one that isn't actually theirs) looked identical to a tap that
   just hadn't registered yet, and people would mash the same tile over and over. */
function updatePropertySwapBoardHighlights(){
  tileCellEls.forEach(cell=>{ if(cell) cell.classList.remove('ps-eligible','ps-selected'); });
  if(!propertySwapPick || propertySwapPick.pid!==youAre) return;
  const pid = propertySwapPick.pid;
  if(propertySwapPick.stage==='mine'){
    tiles.forEach((t,i)=>{ if(ownedByUnit(t,pid) && !groupHasBuilding(t) && tileCellEls[i]) tileCellEls[i].classList.add('ps-eligible'); });
  } else {
    if(tileCellEls[propertySwapPick.myIdx]) tileCellEls[propertySwapPick.myIdx].classList.add('ps-selected');
    const mineCat = psCategory(tiles[propertySwapPick.myIdx]);
    tiles.forEach((t,i)=>{ if(t.owner && !sameTeam(t.owner,pid) && !groupHasBuilding(t) && psCategory(t)===mineCat && tileCellEls[i]) tileCellEls[i].classList.add('ps-eligible'); });
  }
}
/* one row in the Property Swap picker — reuses the exact same trade-prop-item
   look as the trade compose modal so it reads as "pick a property" everywhere
   in the game, not a one-off widget. locked=true renders the give-up pick once
   it's already chosen (stage 'theirs'): shown for context, not clickable. */
function propertySwapRow(idx, locked){
  const t = tiles[idx];
  const flag = t.group?flagIconHTML(t.group,22):(t.icon==='rail'?'🚆':t.icon==='util'?'⚡':'🏳️');
  const sub = t.icon==='rail'?'Railroad':t.icon==='util'?'Utility':'No houses';
  if(locked){
    return `<div class="trade-prop-item ps-locked"><div class="trade-prop-left"><span class="trade-prop-flag">${flag}</span><div><div class="trade-prop-name">${t.name}</div><div class="trade-prop-sub">${sub}</div></div></div><div class="ps-locked-note">&#10003; Giving up</div></div>`;
  }
  return `<div class="trade-prop-item" onclick="resolvePropertySwapPick(${idx})"><div class="trade-prop-left"><span class="trade-prop-flag">${flag}</span><div><div class="trade-prop-name">${t.name}</div><div class="trade-prop-sub">${sub}</div></div></div><div class="trade-prop-price">${t.price}</div></div>`;
}
/* drives propertySwapOverlay: step pills, instruction line, and the live list of
   eligible properties for whichever stage the local player (youAre) is on. Also
   re-syncs the board glow every call so board taps and list clicks never drift
   out of sync with each other. Safe to call whenever — no-ops (and hides the
   overlay) if there's no pick open for youAre specifically, e.g. a teammate/
   opponent is the one mid-pick in a local pass-and-play seat. */
function refreshPropertySwapPanelIfOpen(){
  const overlay=document.getElementById('propertySwapOverlay');
  if(!overlay) return;
  updatePropertySwapBoardHighlights();
  const showIt = !!propertySwapPick && propertySwapPick.pid===youAre;
  overlay.classList.toggle('show', showIt);
  if(!showIt) return;
  const step1=document.getElementById('propertySwapStep1'), step2=document.getElementById('propertySwapStep2');
  const title=document.getElementById('propertySwapTitle'), backBtn=document.getElementById('propertySwapBackBtn');
  const body=document.getElementById('propertySwapBody');
  if(!body) return;
  if(propertySwapPick.stage==='mine'){
    if(step1){step1.classList.add('active');step1.classList.remove('done');}
    if(step2){step2.classList.remove('active');step2.classList.remove('done');}
    if(title) title.textContent='Tap one of your properties to give up (no houses anywhere in its group).';
    if(backBtn) backBtn.style.display='none';
    const mine = tiles.map((t,i)=>({t,i})).filter(x=>ownedByUnit(x.t,youAre) && !groupHasBuilding(x.t));
    body.innerHTML = mine.length ? `<div class="trade-prop-list">${mine.map(x=>propertySwapRow(x.i,false)).join('')}</div>` : '<div class="trade-empty">Nothing eligible right now — every property you own either has a building somewhere in its group or is mortgaged.</div>';
  } else {
    if(step1){step1.classList.remove('active');step1.classList.add('done');}
    if(step2){step2.classList.add('active');step2.classList.remove('done');}
    const mineCat = psCategory(tiles[propertySwapPick.myIdx]);
    if(title) title.textContent=`Now pick a property to take — any opponent's ${mineCat==='country'?'country':'railroad/utility'} property, no houses anywhere in its group.`;
    if(backBtn) backBtn.style.display='';
    const theirs = tiles.map((t,i)=>({t,i})).filter(x=>x.t.owner && !sameTeam(x.t.owner,youAre) && !groupHasBuilding(x.t) && psCategory(x.t)===mineCat);
    let html = `<div class="trade-prop-list" style="margin-bottom:6px;">${propertySwapRow(propertySwapPick.myIdx,true)}</div>`;
    if(!theirs.length){
      html += '<div class="trade-empty">Nobody else has an eligible property right now — go Back and try a different give-up, or Cancel.</div>';
    } else {
      const byOwner = {};
      theirs.forEach(x=>{ (byOwner[x.t.owner]=byOwner[x.t.owner]||[]).push(x); });
      html += Object.entries(byOwner).map(([oid,list])=>`<div class="trade-section-label" style="color:${players[oid].color}">${players[oid].name}</div><div class="trade-prop-list" style="margin-bottom:8px;">${list.map(x=>propertySwapRow(x.i,false)).join('')}</div>`).join('');
    }
    body.innerHTML = html;
  }
}

/* held pending-pick state for Steal a Card — {pid} — set the instant the
   card is drawn (see grantPowerCard/stealCardEligible above) and cleared once
   the drawing player chooses a target card via the overlay (see
   resolveStealCardPick()/syncStealCardOverlay() below). Unlike Property Swap
   this isn't resolved by tapping the board — the overlay lists every other
   player's held cards directly, since the target is a card, not a tile. */
let stealCardPick = null;
/* resolves a Steal a Card pick: moves one card of the chosen type out of the
   target player's hand and into the drawing player's. No cancel — the card
   already fired the instant it was drawn, so a choice is required to let the
   turn continue. An out-of-range target/type (stale click, card already
   spent elsewhere) is just ignored. */
function resolveStealCardPick(targetPid, cardType){
  if(!stealCardPick) return;
  if(stealCardPick.pid !== youAre) return; // same cross-player guard as resolveTeleportTo — only the player the pick actually belongs to may resolve it
  const pid = stealCardPick.pid;
  const player = players[pid];
  const target = players[targetPid];
  const field = CARD_FIELD[cardType];
  if(!player || !target || !field || targetPid===pid) return;
  if(!(target[field]>0)) return;
  target[field]--;
  player[field] = (player[field]||0) + 1;
  const def = POWER_CARDS.find(c=>c.type===cardType);
  const cardTitle = def ? def.title : cardType;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays <b>Steal a Card</b> and takes a <b>${cardTitle}</b> card from <span class="who" style="color:${target.color}">${target.name}</span>!`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F3B4}', title:'STEAL A CARD', who:player.name, text:`Took a ${cardTitle} card from ${target.name}.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  stealCardPick = null;
  refreshUI();
  finishTurnStep(pid);
}
/* Relay — moves one copy of a held power card straight from youAre's hand
   into a teammate's, no draw and no trade negotiation required (unlike the
   Offer in trade control above, there's no accept/decline: it's team mode's
   answer to Steal a Card, letting a team freely reshuffle its own cards onto
   whoever needs them most). Callable any time you're holding the card and
   have an active, non-bankrupt teammate — not gated to your own turn, same
   as offering a trade isn't. */
function relayCard(cardType, targetPid){
  if(gameOver) return;
  const pid = youAre;
  const player = players[pid];
  const target = players[targetPid];
  const field = CARD_FIELD[cardType];
  if(!player || !target || !field || targetPid===pid) return;
  if(!CONFIG.teamsEnabled || !sameTeam(pid, targetPid)) return;
  if(!(player[field]>0)) return;
  player[field]--;
  target[field] = (target[field]||0) + 1;
  const def = POWER_CARDS.find(c=>c.type===cardType);
  const cardTitle = def ? def.title : cardType;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> relays a <b>${cardTitle}</b> card to teammate <span class="who" style="color:${target.color}">${target.name}</span>.`);
  refreshUI();
  refreshPowerCardsIfOpen();
}
/* shows/hides the Steal a Card overlay to match stealCardPick — only the
   drawing player ever sees the picker; on every other client the pause is
   invisible (their turn just isn't active), same as Property Swap's board-tap
   pause. Called from refreshUI() every refresh so it tracks the pick state
   whether it arrived locally or over the network. */
function syncStealCardOverlay(){
  const ov = document.getElementById('stealCardOverlay');
  if(!ov) return;
  const showIt = !!stealCardPick && stealCardPick.pid===youAre;
  if(showIt) renderStealCardOverlay();
  ov.classList.toggle('show', showIt);
}
/* builds the list of every other active, non-bankrupt player who's holding at
   least one power card, each shown with its own tappable card chips — tapping
   one calls resolveStealCardPick() with that player/card pair. */
function renderStealCardOverlay(){
  const body = document.getElementById('stealCardBody');
  if(!body || !stealCardPick) return;
  const pid = stealCardPick.pid;
  const targets = PLAYER_IDS.filter(id=>id!==pid && players[id] && players[id].active && !players[id].bankrupt);
  let html = '';
  targets.forEach(id=>{
    const p = players[id];
    const held = POWER_CARDS.filter(def=>CARD_FIELD[def.type] && (p[CARD_FIELD[def.type]]||0)>0);
    if(!held.length) return;
    html += `<div class="sc-player"><div class="sc-player-name" style="color:${p.color}">${escapeHtml(p.name)}</div><div class="sc-card-row">` +
      held.map(def=>`<button class="sc-card-btn" onclick="resolveStealCardPick('${id}','${def.type}')"><span class="pc-glyph">${def.glyph}</span><span class="pc-title">${def.title}</span><span class="pc-count">&times;${p[CARD_FIELD[def.type]]}</span></button>`).join('') +
      `</div></div>`;
  });
  body.innerHTML = html || `<div class="pc-empty-note">Nobody else is holding a card right now.</div>`;
}

/* spends a held Property Freeze power card — unlike the old tap-a-tile version,
   this targets a PLAYER (same pattern as Swap): pick an opponent from the
   dropdown in the Power Cards hub and every purchasable tile that opponent
   currently owns gets frozen at once. Only that one opponent is affected —
   never every player on the board, and never the caster's own properties,
   since a same-team or self target is rejected outright below. */
function freezeTargetValid(targetPid, pid){
  const target = players[targetPid];
  return !!(target && targetPid!==pid && target.active && !target.bankrupt && !sameTeam(targetPid,pid));
}
function useFreezeCard(targetPid){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.propertyFreezeCards>0)) return;
  if(!freezeTargetValid(targetPid, pid)) return;
  const target = players[targetPid];
  const targets = tiles.map((x,i)=>({x,i})).filter(({x})=>purchasable(x) && x.owner===targetPid);
  player.propertyFreezeCards--;
  targets.forEach(({x,i})=>{ x.frozenTurns = 1; setFrozenVisual(i, true); });
  if(targets.length){
    const groupLabel = targets.map(({x})=>x.name).join(', ');
    log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Property Freeze</b> card on <span class="who" style="color:${target.color}">${target.name}</span> — <b>${groupLabel}</b> can't be built on, sold, mortgaged, or collect rent for their next turn.`);
  } else {
    log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Property Freeze</b> card on <span class="who" style="color:${target.color}">${target.name}</span>, who owns no properties right now — the card is spent with no effect.`);
  }
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u2744\uFE0F', title:'PROPERTY FREEZE', who:player.name, text: targets.length ? `${target.name}'s ${targets.length} propert${targets.length===1?'y is':'ies are'} frozen for their next turn.` : `${target.name} owns no properties to freeze.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  refreshUI();
  renderManage(pid);
}

/* spends a held Sabotage power card — team mode's group-wide answer to
   Property Freeze. Enters the same "pick a tile" mode, but a valid target
   here is any tile that (a) sits in a color group and (b) is owned by a
   whole opposing TEAM rather than just an opposing player — clicking it
   freezes every tile that team owns in that same group at once, not just
   the one tapped. Each frozen tile still counts down on its own owner's
   turns exactly like a regular Property Freeze (see advanceTurn()), same
   1-turn duration, but hits every property in the group — and every
   teammate who owns a piece of it — in one shot instead of just one
   opponent's whole holdings. Railroads/utilities have no .group, so they can
   never be a valid target. */
let sabotagePickMode = false;
function sabotageTargetValid(t, pid){
  return !!(t && purchasable(t) && t.group && t.owner && !sameTeam(t.owner,pid));
}
function useSabotageCard(){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.sabotageCards>0)) return;
  if(anyPickModeActive()) return; // don't stack on top of another open pick mode
  sabotagePickMode = true;
  document.getElementById('rollResult').textContent = "Sabotage ready — tap any tile in an opposing team's property group to freeze the whole group.";
  refreshUI();
}
function cancelSabotagePick(){
  if(!sabotagePickMode) return;
  sabotagePickMode = false;
  refreshUI();
}
function resolveSabotageTo(idx){
  const pid = order[turnIdx];
  if(pid !== youAre) return; // same cross-player guard as resolveTeleportTo above
  const player = players[pid];
  if(!player || !(player.sabotageCards>0)){ sabotagePickMode=false; refreshUI(); return; }
  const t = tiles[idx];
  if(!sabotageTargetValid(t, pid)){
    // not a valid target — stay in pick mode, don't spend the card
    document.getElementById('rollResult').textContent = "Sabotage needs an opposing team's owned property in a color group — tap one, or cancel.";
    return;
  }
  sabotagePickMode = false;
  player.sabotageCards--;
  const targetOwnerId = t.owner;
  const owner = players[targetOwnerId];
  const targets = tiles.map((x,i)=>({x,i})).filter(({x})=>x.group===t.group && x.owner && sameTeam(x.owner, targetOwnerId));
  targets.forEach(({x,i})=>{ x.frozenTurns = Math.max(x.frozenTurns||0, 1); setFrozenVisual(i, true); });
  const groupLabel = targets.map(({x})=>x.name).join(', ');
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays <b>Sabotage</b> on <span class="who" style="color:${owner.color}">${owner.name}</span>'s whole group — <b>${groupLabel}</b> can't be built on, sold, mortgaged, or collect rent for their next turn.`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F5E1}\uFE0F', title:'SABOTAGE', who:player.name, text:`${targets.length} propert${targets.length===1?'y is':'ies are'} frozen for ${owner.name}'s next turn.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  refreshUI();
  renderManage(pid);
}

/* spends a held Swap power card — unlike teleport/freeze this doesn't need a
   "pick mode" against the board, since its target is a player, not a tile: it's
   fired directly from the Swap button on an opponent's roster card (see
   swapBtn-<pid> in renderPlayerCards/refreshUI). Simply exchanges the two
   players' .pos values and glides both tokens to their new spots. Only the
   acting player's new tile triggers the usual landing effects (rent/buy/draw) —
   the target didn't take a turn, so their new tile stays inert for them until
   their own next move. The acting player still can't play this while THEY'RE
   in jail (their own pos is the jail tile, not a real spot to trade away) —
   but a jailed TARGET can be swapped: swapping pulls them out of jail onto the
   acting player's old tile, since they now occupy a real board spot instead of
   the jail tile. */
function useSwapCard(targetPid){
  if(busy || gameOver) return;
  if(order[turnIdx] !== youAre) return;
  const pid = order[turnIdx];
  const player = players[pid];
  if(!player || !(player.swapCards>0)) return;
  if(!targetPid || targetPid===pid) return;
  const target = players[targetPid];
  if(!target || !target.active || target.bankrupt) return;
  player.swapCards--;
  const myPos = player.pos, theirPos = target.pos;
  // Swap card can now be played from jail: whichever side was jailed hands that
  // status to the other side along with their board position, instead of the
  // card simply being blocked for a jailed player. If neither side was jailed
  // this is a no-op, same as before.
  const playerWasJailed = !!player.inJail;
  const targetWasJailed = !!target.inJail;
  const playerJailTurns = player.jailTurns;
  const targetJailTurns = target.jailTurns;
  player.inJail = targetWasJailed;
  player.jailTurns = targetWasJailed ? targetJailTurns : 0;
  target.inJail = playerWasJailed;
  target.jailTurns = playerWasJailed ? playerJailTurns : 0;
  player.pos = theirPos;
  target.pos = myPos;
  const myTile = tiles[theirPos];
  let jailNote = '';
  if(targetWasJailed && !playerWasJailed) jailNote = `, springing ${target.name} from jail`;
  else if(playerWasJailed && !targetWasJailed) jailNote = `, sending ${player.name} to jail in ${target.name}'s place`;
  log(`<span class="who" style="color:${player.color}">${player.name}</span> plays a <b>Position Swap</b> card on <span class="who" style="color:${target.color}">${target.name}</span> — they trade places on the board${jailNote}.`);
  let jailCardText = '';
  if(targetWasJailed && !playerWasJailed) jailCardText = ` ${target.name} is sprung free from jail!`;
  else if(playerWasJailed && !targetWasJailed) jailCardText = ` ${player.name} is now the one in jail!`;
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F500}', title:'POSITION SWAP', who:player.name, text:`Swapped places with ${target.name}: now on ${myTile.name}.${jailCardText}`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
  const myOffset=((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
  const theirOffset=((PLAYER_IDS.indexOf(targetPid)%4)-1.5)*9;
  const myPoint = tokenAnchorPoint(theirPos);
  const theirPoint = tokenAnchorPoint(myPos);
  setTokenPos(pid, myPoint.x+myOffset, myPoint.y, {instant:true, pos:theirPos});
  setTokenPos(targetPid, theirPoint.x+theirOffset, theirPoint.y, {instant:true, pos:myPos});
  resolveTile(pid, theirPos);
}

/* the active player clicks this when they're done managing/trading */
function playerEndTurn(){
  if(!awaitingEndTurn || gameOver) return;
  const pid = order[turnIdx];
  if(pid !== youAre) return; // only the active player may end their own turn
  awaitingEndTurn = false;
  endTurn();
}

// a player who landed on Bailout sits out the turn that would otherwise be next —
// burn their flag and keep advancing past them (guarded so an all-skip edge case
// can't spin forever). Shared by endTurn() and by anything else that moves
// turnIdx directly (e.g. the disconnect handler), so a skip flag can never be
// silently stranded on a turnIdx change that didn't go through endTurn().
function applySkipTurns(){
  if(!order.length) return;
  for(let guard=0; guard<order.length; guard++){
    const upId = order[turnIdx];
    const up = players[upId];
    if(up && up.skipNextTurn && up.fastForwardCards>0){
      // Fast Forward auto-fires the instant it would otherwise cost them this
      // turn — burn the card, clear the penalty, and let them keep their turn
      // instead of hopping turnIdx past them.
      up.fastForwardCards--;
      up.skipNextTurn = false;
      log(`<span class="who" style="color:${up.color}">${up.name}</span> plays <b>Fast Forward</b> to skip their Bailout penalty and keep their turn!`);
      showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u23E9', title:'FAST FORWARD', who:up.name, text:`${up.name}'s sit-out turn is cancelled.`});
      playCardPopupSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      break;
    } else if(up && up.skipNextTurn){
      up.skipNextTurn = false;
      log(`<span class="who" style="color:${up.color}">${up.name}</span> sits out this turn (Bailout).`);
      turnIdx = (turnIdx+1)%order.length;
    } else if(up && up.inJail && up.fastForwardCards>0){
      // Same auto-fire, against jail time instead of a Bailout skip — clears
      // them out entirely regardless of how many jail turns they had left
      // (unlike rolling doubles or paying bail, which only end it one way).
      up.fastForwardCards--;
      const hadTurns = up.jailTurns;
      up.inJail = false;
      up.jailTurns = 0;
      log(`<span class="who" style="color:${up.color}">${up.name}</span> plays <b>Fast Forward</b> to break out of jail instantly${hadTurns>1?` (skipping all ${hadTurns} remaining turns)`:''}!`);
      showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u23E9', title:'FAST FORWARD', who:up.name, text:`${up.name} walks free from jail, no bail needed.`});
      playCardPopupSound();
      if(cardDrawTimer) clearTimeout(cardDrawTimer);
      cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, spd(CARD_DRAW_MS));
      break;
    } else if(up && up.reconnecting){
      // their seat is being held open during the disconnect grace window (see
      // conn.on('close') in setupHostPeer) — keep hopping over them without
      // touching skipNextTurn, so the moment they reconnect they fall right
      // back into the normal rotation on their next natural turn
      turnIdx = (turnIdx+1)%order.length;
    } else break;
  }
}
function endTurn(){
  document.getElementById('managePanel').classList.remove('show');
  document.getElementById('auctionPanel').classList.remove('show');
  document.getElementById('loanPanel').classList.remove('show');
  currentRollWasDouble = false;
  awaitingEndTurn = false;
  if(gameOver || order.length===0) return;
  const pid = order[turnIdx];
  // Property Shield only ever covers "before you roll until you end your turn" —
  // whether or not it actually blocked a rent payment, it doesn't carry over.
  if(players[pid]){ players[pid].shieldArmed = false; players[pid].halfShieldArmed = false; }
  // catches anything that left the ending player short on the way in here
  // (e.g. paying bail) — pause and make them raise the cash before the turn
  // actually ends. Loan installments are no longer checked here — see
  // advanceTurn(), which now charges those at the START of a turn instead.
  if(checkBankrupt(pid, null, {type:'endTurn'})) return;
  finishOrRepeatTurn(pid);
}
/* shared by endTurn() and the debt-resume path — advances to the next player.
   (Extra Roll used to be checked here, but it now fires instantly the moment
   it's drawn — see the resolveTile wheel/gift branches — so by the time a
   turn actually ends there's nothing left to intercept.) */
function finishOrRepeatTurn(pid){
  advanceTurn();
}
function advanceTurn(){
  recordNetWorthSnapshot(order[turnIdx]);
  turnIdx = (turnIdx+1)%order.length;
  applySkipTurns();
  // Rent Doubler's window runs "until their next turn" — once it comes back
  // around to them, any unused arm quietly expires (the charge was already
  // spent when they armed it).
  const upId = order[turnIdx];
  if(upId && players[upId]) players[upId].rentDoublerGroup = null;
  // Pooled Payday's window runs "until their next turn" too, same as Rent
  // Doubler — it clears here regardless of whether it ever doubled a payment.
  if(upId && players[upId]) players[upId].pooledPaydayArmed = false;
  // Property Freeze counts down in units of the FROZEN OWNER's own turns —
  // so a tile's frozenTurns only ticks down the moment it becomes that
  // owner's turn again, not on every turn that passes for anyone.
  if(upId){
    tiles.forEach((t,i)=>{
      if(t.owner===upId && t.frozenTurns>0){
        t.frozenTurns--;
        if(t.frozenTurns<=0){
          t.frozenTurns = 0;
          setFrozenVisual(i, false);
          log(`<b>${t.name}</b>'s Property Freeze has worn off — <span class="who" style="color:${players[upId].color}">${players[upId].name}</span> can build, sell, mortgage, and collect rent there again.`);
        }
      }
    });
  }
  // Loan installments are charged right as the new player's turn actually
  // starts, not when the previous player clicks End Turn — so it always
  // comes out of the borrower's own turn instead of whoever's turn just
  // finished. If it leaves them short, pause here (same "raise the cash"
  // flow as rent/tax) before letting them roll.
  if(upId){
    applyAutoLoanRepayment(upId);
    if(checkBankrupt(upId, null, {type:'newTurn'})){ return; }
  }
  busy = false;
  refreshUI();
}

/* ============ AUCTIONS ============
   Handles three cases with one engine: a bank auction after a declined buy,
   a "fun mode" bank auction on every unowned landing, and a player-run auction
   of their own property/properties with a custom starting bid + timer.
   All selected items go up for bid simultaneously — one shared countdown for the
   whole session (any bid on any item resets it), each item tracks its own current
   bid/bidder/passes, and an item can settle early once only its leader hasn't
   passed; the whole panel closes once every item is settled or time runs out. */
/* ============ TURN SOUND ============
   Plays a short chime whenever it becomes the local player's (youAre's) turn.
   Uses the Web Audio API so no external sound file is needed. */
let turnSoundEnabled = true;
let turnSoundVolume = 1; // 0..1 master volume; independent of the mute toggle above
let __lastNonZeroVolume = 1; // remembered so unmuting restores the slider position rather than jumping to 100%
let __turnAudioCtx = null;
let __masterGainNode = null; // single GainNode all Web-Audio sounds route through, so the volume slider affects everything at once
let __lastTurnSoundPid = null;
const SOUND_STORAGE_KEY = 'gbSoundSettings';

/* Lazily creates (or returns) the shared master GainNode for this AudioContext,
   connected straight to the destination. Every oscillator/buffer-source sound
   function below connects into this instead of ctx.destination directly, so a
   single gain.value update from the volume slider scales every sound at once
   without having to touch each sound function individually. */
function getMasterGain(ctx){
  if(!__masterGainNode || __masterGainNode.context !== ctx){
    __masterGainNode = ctx.createGain();
    __masterGainNode.gain.value = turnSoundEnabled ? turnSoundVolume : 0;
    __masterGainNode.connect(ctx.destination);
  }
  return __masterGainNode;
}

function saveSoundSettings(){
  try{ localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify({enabled:turnSoundEnabled, volume:turnSoundVolume})); }catch(e){}
}
function loadSoundSettings(){
  try{
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if(!raw) return;
    const s = JSON.parse(raw);
    if(typeof s.enabled === 'boolean') turnSoundEnabled = s.enabled;
    if(typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1) turnSoundVolume = s.volume;
    if(turnSoundVolume > 0) __lastNonZeroVolume = turnSoundVolume;
  }catch(e){}
}
function refreshSoundUI(){
  const slider = document.getElementById('soundVolumeSlider');
  const label = document.getElementById('soundVolumeLabel');
  const icon = document.getElementById('soundMuteIcon');
  const pct = Math.round(turnSoundVolume*100);
  if(slider) slider.value = pct;
  if(label) label.textContent = pct + '%';
  if(icon) icon.innerHTML = (!turnSoundEnabled || turnSoundVolume === 0) ? '&#128263;' : '&#128266;';
  if(__masterGainNode) __masterGainNode.gain.value = turnSoundEnabled ? turnSoundVolume : 0;
}
function toggleTurnSound(){
  turnSoundEnabled = !turnSoundEnabled;
  if(turnSoundEnabled && turnSoundVolume === 0) turnSoundVolume = __lastNonZeroVolume || 1;
  refreshSoundUI();
  saveSoundSettings();
  if(turnSoundEnabled) playTurnChime(); // quick confirmation beep
}
function setTurnSoundVolume(pct){
  turnSoundVolume = Math.max(0, Math.min(100, Number(pct)))/100;
  if(turnSoundVolume > 0){ __lastNonZeroVolume = turnSoundVolume; turnSoundEnabled = true; }
  else turnSoundEnabled = false;
  refreshSoundUI();
  saveSoundSettings();
}
loadSoundSettings();
refreshSoundUI();

/* Camera micro-zoom toward the active player (see pulseCameraToActivePlayer, defined
   with the rest of the pan/zoom code below) — off by default so the camera never
   moves on its own unless a player opts in here. */
let cameraPulseEnabled = false;
function toggleCameraPulse(){
  cameraPulseEnabled = !cameraPulseEnabled;
  const lbl = document.getElementById('camZoomBtnLabel');
  if(lbl) lbl.textContent = 'Turn zoom: ' + (cameraPulseEnabled ? 'on' : 'off');
}

function playTurnChime(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [523.25, 659.25].forEach((freq, i) => { // a friendly little two-note "ding-ding"
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.28, t+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.35);
      osc.start(t); osc.stop(t+0.4);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Short clattering-dice sound, built from a handful of quick filtered-noise
   taps (no external audio file needed) rather than a musical chime, so it
   reads as physical rather than as another "ding". Fired once per genuinely
   new roll — see the two call sites below — so every player at the table
   hears it, not just whoever's turn it is. Shares the same on/off toggle
   and AudioContext as the turn chime. */
/* Trade-offer notification: a soft two-note "pop" — distinct in timbre from
   the dice knock and the turn chime so it reads as "something needs your
   attention" rather than "it's your turn" or "the dice landed". Fires once
   per newly-created trade — see sendTrade() and the sync-side count check
   below — so everyone at the table hears an offer arrive, not just the
   player who made it. */
function playTradeSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [440, 660].forEach((freq, i) => { // a soft rising "pop-pop", warmer/rounder than the turn chime's ding
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t+0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.22);
      osc.start(t); osc.stop(t+0.25);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Lobby presence chimes — a soft two-note "pop up" when someone joins the waiting
   room and a short "pop down" when someone leaves it, so people setting up a game
   notice comings and goings without having to stare at the lobby list. Deliberately
   quieter/gentler than playTradeSound so it doesn't compete with actual game events;
   only ever fires pre-game (see call sites in the networking IIFE and restoreState). */
function playLobbyJoinSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [520, 780].forEach((freq,i)=>{
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.07;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.14, t+0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.18);
      osc.start(t); osc.stop(t+0.2);
    });
  }catch(e){ /* audio not available — fail silently */ }
}
function playLobbyLeaveSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(560, t);
    osc.frequency.exponentialRampToValueAtTime(340, t+0.22); // single downward slide, gentler than playNegativeSound's buzz
    osc.connect(gain); gain.connect(getMasterGain(ctx));
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.13, t+0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.26);
    osc.start(t); osc.stop(t+0.28);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Auction-opened notification: three quick, slightly urgent beeps — meant to
   stand out from the trade "pop" since an auction is time-boxed and everyone
   at the table needs to look up and bid, not just review something at their
   own pace. Fires once when an auction newly opens — see startAuction() and
   the sync-side "was it already open" check below. */
function playAuctionSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [0,1,2].forEach(i => { // three short even beeps, a step up in pitch each time
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = 587.33 + i*98;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.14, t+0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.11);
      osc.start(t); osc.stop(t+0.13);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Buy-property notification: a tiny, understated "cha-ching" — two quick
   bright overlapping notes. Kept deliberately small/quiet since buying a
   property happens constantly during a game and shouldn't compete with the
   trade/auction sounds, which are rarer and meant to grab attention. Plays
   for whoever's screen actually executes the purchase (see buyDecision())
   and, for everyone else, via the network-sync detection further down. */
function playBuySound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [1046.5, 1318.5].forEach((freq, i) => { // a quick, bright, very short two-note "tink"
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.035;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.1, t+0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.09);
      osc.start(t); osc.stop(t+0.1);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Card-popup notification: a quick bright upward "flip/whoosh" — a single
   short pitch sweep, timed to land right as the Chance/Community Chest card
   animates onto the board. Distinct in shape (a sweep, not discrete notes)
   from the buy/trade/auction sounds so it reads as "something appeared"
   rather than "something completed". */
function playCardPopupSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(880, t+0.1); // rising sweep = card sliding/flipping into view
    osc.connect(gain); gain.connect(getMasterGain(ctx));
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.16);
    osc.start(t); osc.stop(t+0.18);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Footstep/hop tap: fired once per single-tile hop as a token travels around
   the board (see moveToken()'s stepOnce and glideTokenRemote()'s stepOnce —
   both step every ~280ms, so this plays in lockstep with the visual hop).
   A short filtered noise "tock" rather than a tone, kept deliberately quiet
   since it repeats up to ~12 times in a row for a long roll. */
function playFootstepSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const bufSize = Math.floor(ctx.sampleRate*0.05);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for(let i=0;i<bufSize;i++) data[i] = (Math.random()*2-1) * (1 - i/bufSize); // decaying noise burst
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.05);
    src.connect(filt); filt.connect(gain); gain.connect(getMasterGain(ctx));
    src.start(t); src.stop(t+0.06);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Rent-collected "cha-ching": a bright three-note register bell, distinct from
   the quieter two-note buy "tink" — rent happens constantly too, but paying
   money to another player (rather than the bank) is meant to land a bit more
   than a purchase. Plays for whoever's screen resolves the rent (see the rent
   branch in resolveTile()). */
function playRentSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [1046.5, 1318.5, 1046.5].forEach((freq,i) => { // ding-DING-ding, register-bell shape
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq;
      const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=2200;
      osc.connect(filt); filt.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.07;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t+0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.13);
      osc.start(t); osc.stop(t+0.14);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Negative-balance buzzer: a short descending "buzz" — fired when a player
   dips into the red (rent/tax/bail they can't fully cover) and again, more
   heavily, when they actually go bankrupt. See checkBankrupt()'s debt-pause
   branch and doBankrupt(). */
/* Haptic buzz for key moments, mirroring the sound toggle so a muted player also
   gets a quieter experience. navigator.vibrate is mobile-only and silently absent
   elsewhere (desktop browsers, iOS Safari), so this is always safe to call. */
function vibrate(pattern){
  if(!turnSoundEnabled) return;
  try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){ /* not available — fail silently */ }
}
function playNegativeSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(110, t+0.35); // downward buzz = bad news
    const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=900;
    osc.connect(filt); filt.connect(gain); gain.connect(getMasterGain(ctx));
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.4);
    osc.start(t); osc.stop(t+0.42);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Jail door clang: filtered noise "clank" plus a low thud right behind it —
   fired whenever a player is actually sent to jail (the "Go To Jail" tile,
   or three doubles in a row), alongside the existing card-popup sound. */
function playJailSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    // metallic clang: bandpass-filtered noise burst
    const bufSize = Math.floor(ctx.sampleRate*0.18);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for(let i=0;i<bufSize;i++) data[i] = (Math.random()*2-1) * Math.pow(1 - i/bufSize, 1.5);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1400; bp.Q.value=6;
    const gain1 = ctx.createGain();
    gain1.gain.setValueAtTime(0.22, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t+0.18);
    src.connect(bp); bp.connect(gain1); gain1.connect(getMasterGain(ctx));
    src.start(t); src.stop(t+0.2);
    // low thud right behind it
    const osc = ctx.createOscillator(), gain2 = ctx.createGain();
    osc.type='sine'; osc.frequency.setValueAtTime(160, t+0.05); osc.frequency.exponentialRampToValueAtTime(60, t+0.25);
    osc.connect(gain2); gain2.connect(getMasterGain(ctx));
    gain2.gain.setValueAtTime(0, t+0.05);
    gain2.gain.linearRampToValueAtTime(0.2, t+0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, t+0.3);
    osc.start(t+0.05); osc.stop(t+0.32);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Victory fanfare: a short rising four-note flourish, fired once from
   checkWin() when a winner is crowned. */
function playWinSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq,i) => { // C5-E5-G5-C6
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq;
      osc.connect(gain); gain.connect(getMasterGain(ctx));
      const t = now + i*0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.26, t+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t+0.5);
      osc.start(t); osc.stop(t+0.55);
    });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Trade-window whooshes: a rising sweep when the trade panel opens, a falling
   sweep when it closes — distinct from playTradeSound() (which fires for
   everyone when an offer is actually sent) since these are purely local UI
   feedback for whoever is opening/closing their own trade window. */
function playTradeOpenSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(700, t+0.14);
    osc.connect(gain); gain.connect(getMasterGain(ctx));
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t+0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.16);
    osc.start(t); osc.stop(t+0.18);
  }catch(e){ /* audio not available — fail silently */ }
}
function playTradeCloseSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(650, t);
    osc.frequency.exponentialRampToValueAtTime(260, t+0.14);
    osc.connect(gain); gain.connect(getMasterGain(ctx));
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.1, t+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t+0.16);
    osc.start(t); osc.stop(t+0.18);
  }catch(e){ /* audio not available — fail silently */ }
}

/* Auction countdown tick: a short beep once per second while an auction is
   running, pitching up and getting snappier once time is running low (see
   the "urgent" flag already used for the visual timer in renderAuction()). */
function playAuctionTickSound(urgent){
  if(!turnSoundEnabled) return;
  try{
    if(!__turnAudioCtx) __turnAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = __turnAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = urgent ? 1100 : 750;
    osc.connect(gain); gain.connect(getMasterGain(ctx));
    const dur = urgent ? 0.07 : 0.05;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(urgent ? 0.12 : 0.07, t+0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, t+dur);
    osc.start(t); osc.stop(t+dur+0.01);
  }catch(e){ /* audio not available — fail silently */ }
}

/* ============ VISUAL JUICE (screen shake, particles, tile pulse, confetti) ============
   All of this renders into a single full-viewport fixed overlay (#fxLayer, lazily
   created) using the Web Animations API directly on throwaway elements — no new CSS
   keyframes needed per theme, so it works identically across all three board skins.
   Screen coordinates are read via getBoundingClientRect(), which already accounts for
   the board's pan/zoom/tilt transforms, so source/destination points line up correctly
   without having to reason about the tilted board's local coordinate space. */
let __fxLayer = null;
function ensureFxLayer(){
  if(__fxLayer && document.body.contains(__fxLayer)) return __fxLayer;
  const layer = document.createElement('div');
  layer.id = 'fxLayer';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:100001;overflow:visible;';
  document.body.appendChild(layer);
  __fxLayer = layer;
  return layer;
}
function __fxSpawn(styleText){
  const layer = ensureFxLayer();
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;pointer-events:none;'+styleText;
  layer.appendChild(el);
  return el;
}

/* Brief camera-style shake on the board's stage wrapper. stageWrap has no other
   transform applied to it (unlike #boardView, which pan/zoom actively manage), so
   animating its transform here is safe. */
function triggerScreenShake(strength){
  strength = strength || 8;
  try{
    const el = document.getElementById('stageWrap');
    if(!el) return;
    const frames = [];
    const steps = 6;
    for(let i=0;i<=steps;i++){
      const decay = 1 - i/steps;
      const dx = (Math.random()*2-1) * strength * decay;
      const dy = (Math.random()*2-1) * strength * decay;
      frames.push({ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` });
    }
    frames.push({ transform: 'translate(0px,0px)' });
    el.animate(frames, { duration: 380, easing: 'ease-out' });
  }catch(e){ /* animation not available — fail silently */ }
}

/* Small colored dots bursting outward and fading from a screen point — used for a
   high-rent hit or a bankruptcy. `rect` is a getBoundingClientRect()-style box (the
   burst originates from its center); `colors` is an array cycled across particles. */
function spawnParticleBurst(rect, colors, count){
  if(!rect) return;
  try{
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    count = count || 10;
    for(let i=0;i<count;i++){
      const angle = (Math.PI*2*i/count) + (Math.random()*0.6-0.3);
      const dist = 34 + Math.random()*46;
      const size = 5 + Math.random()*5;
      const color = colors[i % colors.length];
      const el = __fxSpawn(`left:${cx-size/2}px;top:${cy-size/2}px;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 4px ${color};`);
      const dx = Math.cos(angle)*dist, dy = Math.sin(angle)*dist - 10;
      el.animate([
        { transform:'translate(0,0) scale(1)', opacity:1 },
        { transform:`translate(${dx}px, ${dy}px) scale(0.4)`, opacity:0 }
      ], { duration: 560+Math.random()*180, easing:'cubic-bezier(.2,.7,.3,1)' })
        .onfinish = ()=> el.remove();
    }
  }catch(e){ /* animation not available — fail silently */ }
}

/* Reaction emoji "thrown" onto the board — floats up from the sending player's
   token (or the board's center if their token isn't visible), wobbles slightly,
   and fades on its own; nothing needs to clean it up beyond the animation's own
   onfinish. See sendReaction()/REACTION_EMOJIS below for the sending side, and
   the reaction relay in the networking IIFE for how remote reactions arrive here. */
function spawnReactionPopup(pid, emoji){
  try{
    const tokenVisible = tokenEls[pid] && tokenEls[pid].style.display!=='none';
    const rect = tokenVisible ? tokenEls[pid].getBoundingClientRect()
      : (typeof stageWrap!=='undefined' && stageWrap ? stageWrap.getBoundingClientRect() : null);
    if(!rect) return;
    const jx = Math.random()*30-15, jy = Math.random()*14-7;
    const cx = rect.left+rect.width/2+jx, cy = rect.top+rect.height/2+jy;
    const el = __fxSpawn(`left:${cx-22}px;top:${cy-22}px;width:44px;height:44px;font-size:32px;line-height:44px;text-align:center;filter:drop-shadow(0 2px 5px rgba(0,0,0,.4));`);
    el.textContent = emoji;
    const drift = Math.random()*24-12; // slight side-to-side wobble as it rises
    el.animate([
      { transform:'translate(0,0) scale(0.4)', opacity:0 },
      { transform:`translate(${drift*0.3}px,-18px) scale(1.2)`, opacity:1, offset:0.2 },
      { transform:`translate(${drift*0.7}px,-58px) scale(1)`, opacity:1, offset:0.7 },
      { transform:`translate(${drift}px,-92px) scale(0.85)`, opacity:0 }
    ], { duration: 1500, easing:'cubic-bezier(.2,.7,.3,1)' }).onfinish = ()=> el.remove();
  }catch(e){ /* animation not available — fail silently */ }
}
const REACTION_EMOJIS = ['👍','😂','😮','😡','❤️','🎉'];
let __lastReactionAt = 0;
function sendReaction(emoji){
  if(!REACTION_EMOJIS.includes(emoji)) return;
  const now = Date.now();
  if(now-__lastReactionAt < 350) return; // light debounce so a double-click can't spam the board/network
  __lastReactionAt = now;
  spawnReactionPopup(youAre, emoji);
  if(typeof window.__netSendReaction==='function') window.__netSendReaction(emoji);
}

/* Coin/cash glyphs flying from a payer's screen position to a payee's, on a slight
   upward arc. Used for rent payments — `fromRect`/`toRect` are DOMRect-like boxes
   (typically a token's or a sidebar balance element's getBoundingClientRect()). */
function spawnCoinFly(fromRect, toRect, count){
  if(!fromRect || !toRect) return;
  try{
    const fx = fromRect.left+fromRect.width/2, fy = fromRect.top+fromRect.height/2;
    const tx = toRect.left+toRect.width/2, ty = toRect.top+toRect.height/2;
    count = Math.max(1, Math.min(8, count||3));
    for(let i=0;i<count;i++){
      const jx = (Math.random()*24-12), jy = (Math.random()*16-8);
      const midX = (fx+tx)/2 + jx, midY = Math.min(fy,ty) - 40 - Math.random()*20; // arc peak above both points
      const el = __fxSpawn(`left:${fx-10}px;top:${fy-10}px;width:20px;height:20px;font-size:18px;line-height:20px;text-align:center;`);
      el.textContent = i%2===0 ? '💵' : '🪙';
      const delay = i*70;
      el.animate([
        { offset:0, transform:'translate(0,0) scale(0.6) rotate(0deg)', opacity:0 },
        { offset:0.15, transform:'translate(0,0) scale(1) rotate(0deg)', opacity:1 },
        { offset:0.55, transform:`translate(${midX-fx}px, ${midY-fy}px) scale(1) rotate(120deg)`, opacity:1 },
        { offset:1, transform:`translate(${tx-fx+jx}px, ${ty-fy+jy}px) scale(0.5) rotate(260deg)`, opacity:0 }
      ], { duration: 620, delay, easing:'ease-in-out' })
        .onfinish = ()=> el.remove();
    }
  }catch(e){ /* animation not available — fail silently */ }
}

/* Brief glow/scale pulse on a tile when it changes owner — operates directly on the
   tile's actual .gb-cell DOM node (tileCellEls[idx]) so it renders correctly under
   the board's tilt regardless of theme. */
function pulseTile(idx, color){
  try{
    const el = tileCellEls[idx];
    if(!el) return;
    color = color || '#ffd54f';
    el.animate([
      { boxShadow:`0 0 0px 0px ${color}`, filter:'brightness(1)' },
      { boxShadow:`0 0 22px 6px ${color}`, filter:'brightness(1.35)', offset:0.35 },
      { boxShadow:`0 0 0px 0px ${color}`, filter:'brightness(1)' }
    ], { duration: 650, easing:'ease-out' });
  }catch(e){ /* animation not available — fail silently */ }
}

/* Full-viewport confetti burst — fired once on checkWin(). Pieces fall from just
   above the top of the screen with random horizontal drift, color, and spin. */
function spawnConfetti(){
  try{
    const colors = ['#e35b5b','#3fe07a','#5ba8e3','#ffd54f','#c58af0','#ff9f5b'];
    const W = window.innerWidth;
    const count = 90;
    for(let i=0;i<count;i++){
      const x = Math.random()*W;
      const size = 6 + Math.random()*6;
      const color = colors[i % colors.length];
      const el = __fxSpawn(`left:${x}px;top:-20px;width:${size}px;height:${size*0.6}px;background:${color};border-radius:1px;`);
      const fall = window.innerHeight + 60;
      const drift = (Math.random()*160-80);
      const spin = 360 + Math.random()*720;
      const delay = Math.random()*300;
      el.animate([
        { transform:'translate(0,0) rotate(0deg)', opacity:1 },
        { transform:`translate(${drift*0.5}px, ${fall*0.6}px) rotate(${spin*0.6}deg)`, opacity:1, offset:0.7 },
        { transform:`translate(${drift}px, ${fall}px) rotate(${spin}deg)`, opacity:0.9 }
      ], { duration: 2200+Math.random()*900, delay, easing:'cubic-bezier(.2,.6,.4,1)' })
        .onfinish = ()=> el.remove();
    }
  }catch(e){ /* animation not available — fail silently */ }
}

const __diceSoundDataUri = "assets/sfx/dice-roll.mp3";
let __diceAudioEl = null;
function playDiceSound(){
  if(!turnSoundEnabled) return;
  try{
    if(!__diceAudioEl) __diceAudioEl = new Audio(__diceSoundDataUri);
    const el = __diceAudioEl.cloneNode(true); // clone so overlapping rolls don't cut each other off
    el.volume = 0.35 * (turnSoundEnabled ? turnSoundVolume : 0);
    el.playbackRate = CONFIG.speedX2Enabled ? 2 : 1; // the roll lands in half the time at 2x — the clip should too
    el.play().catch(()=>{ /* autoplay may be blocked until user interacts — fail silently */ });
  }catch(e){ /* audio not available — fail silently */ }
}

/* Call whenever the active player may have changed; only fires once per
   actual turn change, and only when it's now the local (youAre) player's turn. */
function checkTurnSound(){
  // While the host is executing a remote player's command, `youAre` is
  // temporarily swapped to that player's id (see executeHostCommand). If we
  // evaluated the chime during that window, the host would hear a bogus
  // "your turn" ding every time *any* other player took an action, and it
  // would also mark the turn as "already chimed" so the real chime never
  // played once it genuinely became the host's turn. Skip entirely during
  // that window; the refreshUI() call that runs right after identity is
  // restored will re-evaluate this correctly.
  if(window.__netImpersonating) return;
  const activeId = order[turnIdx];
  if(!activeId) return;
  // camera nudge runs for whoever's turn it is (every player watching should see
  // the board settle on the active token), independent of the sound gate below,
  // which only ever fires for the local (youAre) player.
  if(activeId !== __lastCameraPid){
    __lastCameraPid = activeId;
    if(!gameOver) pulseCameraToActivePlayer(activeId);
  }
  if(activeId === __lastTurnSoundPid) return;
  __lastTurnSoundPid = activeId;
  if(!gameOver && activeId === youAre) playTurnChime();
}

let auction = null;

function startAuction(items, opts){
  busy = true;
  const bids = {};
  items.forEach(idx=>{ bids[idx] = {currentBid:0, currentBidder:null, passed:{}}; });
  auction = {
    items: items.slice(),
    bids,
    seller: opts.seller || null,
    startBid: Math.max(10, opts.startBid||10),
    timerSec: opts.timerSec || CONFIG.auctionTimerSec,
    timeLeft: 0,
    onComplete: opts.onComplete || null,
    interval: null
  };
  document.getElementById('auctionOverlay').classList.add('show');
  playAuctionSound();
  beginAuctionRound();
}
function beginAuctionRound(){
  auction.timeLeft = auction.timerSec;
  renderAuction();
  clearInterval(auction.interval);
  auction.interval = setInterval(auctionTick, 1000);
}
function auctionTick(){
  if(!auction) return;
  auction.timeLeft--;
  if(auction.timeLeft<=0) resolveAuction();
  else{
    renderAuction();
    playAuctionTickSound(auction.timeLeft<=3);
    // final 3 seconds: an extra half-beat tick between the whole-second ticks,
    // so the countdown audibly speeds up as time runs out
    if(auction.timeLeft>0 && auction.timeLeft<=3){
      setTimeout(()=>{ if(auction && auction.timeLeft>0 && auction.timeLeft<=3) playAuctionTickSound(true); }, 500);
    }
  }
}
function auctionEligible(){
  return PLAYER_IDS.filter(p=>players[p].active && p!==auction.seller && !players[p].bankrupt);
}
function itemActiveBidders(idx){
  const st = auction.bids[idx];
  return auctionEligible().filter(p=>!st.passed[p]);
}
function isItemClosed(idx){
  const st = auction.bids[idx];
  const active = itemActiveBidders(idx);
  return active.length===0 || (active.length===1 && active[0]===st.currentBidder);
}
/* In a combined auction (multiple properties/cards up at once), a player can be
   the leading bidder on several items simultaneously — nothing gets deducted from
   their balance until resolveAuction() settles the whole auction at the end. That
   means "can they afford this bid" has to check balance minus whatever they're
   ALREADY leading elsewhere in this same auction, not just their raw balance —
   otherwise a $100 player could lead $90 on item A and, separately, $90 on item B
   (each check reads the same untouched $100), then get hit for $180 at resolution
   with no way to actually cover it. */
function auctionCommittedElsewhere(pid, excludeIdx){
  let sum = 0;
  auction.items.forEach(idx=>{
    if(idx===excludeIdx) return;
    const st = auction.bids[idx];
    if(st.currentBidder===pid) sum += st.currentBid;
  });
  return sum;
}
function auctionAvailableBalance(pid, excludeIdx){
  return players[pid].balance - auctionCommittedElsewhere(pid, excludeIdx);
}
function auctionBid(pid, idx, amt){
  if(auction?.remote) return;
  if(!auction || pid!==youAre || pid===auction.seller) return;
  const st = auction.bids[idx];
  if(!st || st.passed[pid] || isItemClosed(idx)) return;
  const base = st.currentBid>0 ? st.currentBid : auction.startBid;
  const nextBid = base + Math.max(0, Number(amt)||0);
  if(auctionAvailableBalance(pid, idx) < nextBid) return;
  st.currentBid = nextBid;
  st.currentBidder = pid;
  auction.timeLeft = auction.timerSec; // any bid, on any item, resets the shared countdown
  renderAuction();
}
function auctionPass(pid, idx){
  if(auction?.remote) return;
  if(!auction || pid!==youAre || pid===auction.seller) return;
  const st = auction.bids[idx];
  if(!st || pid===st.currentBidder) return;
  st.passed[pid] = true;
  if(auction.items.every(isItemClosed)){
    resolveAuction();
  } else {
    renderAuction();
  }
}
/* auction.items historically were always numeric tile indices; card auctions
   (see startCardAuction) add string items shaped "card:<type>" into the same
   list. This is the one place both branches meet, so the rest of the auction
   machinery (bidding, passing, timers, network sync) never has to know the
   difference — it just keys off auction.items/auction.bids either way. */
function auctionItemMeta(idx){
  if(typeof idx==='string' && idx.indexOf('card:')===0){
    const type = idx.slice(5);
    const def = POWER_CARDS.find(c=>c.type===type);
    return {isCard:true, cardType:type, name: def ? `${def.glyph} ${def.title}` : 'Power Card'};
  }
  const t = tiles[idx];
  return {isCard:false, name: t ? t.name : ''};
}
function resolveAuction(){
  clearInterval(auction.interval);
  const winners = new Set(); // buyers who actually won at least one item — re-checked for bankruptcy below
  auction.items.forEach(idx=>{
    const meta = auctionItemMeta(idx);
    const st = auction.bids[idx];
    if(meta.isCard){
      const field = CARD_FIELD[meta.cardType];
      if(st.currentBid>0 && st.currentBidder){
        const buyer = players[st.currentBidder];
        buyer.balance -= st.currentBid;
        winners.add(st.currentBidder);
        bumpStat('auctionsWon', st.currentBidder);
        buyer[field] = (buyer[field]||0) + 1;
        if(auction.seller){ players[auction.seller].balance += st.currentBid; }
        log(`<span class="who" style="color:${buyer.color}">${buyer.name}</span> wins the auction for <b>${meta.name}</b> at $${fmt(st.currentBid)}${auction.seller?` (bought from <span class="who" style="color:${players[auction.seller].color}">${players[auction.seller].name}</span>)`:''}.`);
      } else if(auction.seller && field){
        // no bids — the card was reserved off the seller's hand when the auction
        // started (see startCardAuction), so hand it back rather than losing it.
        players[auction.seller][field] = (players[auction.seller][field]||0) + 1;
        log(`No bids on <b>${meta.name}</b> — it stays with its owner.`);
      }
      return;
    }
    const t = tiles[idx];
    if(st.currentBid>0 && st.currentBidder){
      const buyer = players[st.currentBidder];
      buyer.balance -= st.currentBid;
      winners.add(st.currentBidder);
      bumpStat('auctionsWon', st.currentBidder);
      t.owner = st.currentBidder;
      t.mortgaged = false;
      if(auction.seller){
        players[auction.seller].balance += st.currentBid;
      }
      markOwnership(idx, teamDisplayColor(st.currentBidder)); // IN TEAMS: tile reads as the team's blended color, not just this buyer's own
      pulseTile(idx, teamDisplayColor(st.currentBidder));
      setMortgageVisual(idx, false);
      log(`<span class="who" style="color:${buyer.color}">${buyer.name}</span> wins the auction for <b>${t.name}</b> at $${fmt(st.currentBid)}${auction.seller?` (bought from <span class="who" style="color:${players[auction.seller].color}">${players[auction.seller].name}</span>)`:''}.`);
    } else {
      log(`No bids on <b>${t.name}</b> — it ${auction.seller?'stays with its owner':'remains unowned'}.`);
    }
  });
  refreshUI();
  if(auction.seller) checkBankrupt(auction.seller, null);
  // Belt-and-suspenders: the per-bid affordability check above (see auctionBid/
  // auctionAvailableBalance) should already keep every winner solvent, but a buyer
  // can win several items in one combined auction, so re-check each of them here
  // too rather than only ever checking the seller (who only ever gains cash from
  // a sale and could never actually go negative from one).
  winners.forEach(pid=>{ if(pid!==auction.seller) checkBankrupt(pid, null); });
  document.getElementById('auctionOverlay').classList.remove('show');
  const cb = auction.onComplete;
  auction = null;
  if(cb) cb();
}
function renderAuction(){
  if(!auction) return;
  const seller = auction.seller ? players[auction.seller] : null;
  const BID_STEPS = [2,10,50,100,200];
  const urgent = auction.timeLeft<=3;
  const allCards = auction.items.every(idx=>auctionItemMeta(idx).isCard);
  let html = `<div class="auction-head">
    <div>
      <div class="auction-head-title">${auction.items.length>1?`${auction.items.length} ${allCards?'cards':'properties'} — up for bid`:'Up for bid'}</div>
      ${seller?`<div class="auction-head-sub">Offered by <span style="color:${seller.color}">${seller.name}</span></div>`:`<div class="auction-head-sub">Unowned — going to the highest bidder</div>`}
    </div>
    <div class="auction-timer${urgent?' urgent':''}">${auction.timeLeft}s</div>
  </div>`;
  auction.items.forEach(idx=>{
    const meta = auctionItemMeta(idx);
    const st = auction.bids[idx];
    const base = st.currentBid>0 ? st.currentBid : auction.startBid;
    const closed = isItemClosed(idx);
    html += `<div class="auction-item${closed?' settled':''}">
      <div class="auction-item-head">
        <div class="auction-item-name">${meta.name}${closed?' <span class="auction-settled-tag">Settled</span>':''}</div>
        <div class="auction-item-bid">$${fmt(st.currentBid || auction.startBid)}${st.currentBidder?` <span style="color:${players[st.currentBidder].color}">— ${players[st.currentBidder].name}</span>`:st.currentBid>0?'':' <span style="color:var(--text-dim);font-weight:500;">(opening)</span>'}</div>
      </div>`;
    if(!closed){
      auctionEligible().forEach(pid=>{
        const p = players[pid];
        const passed = st.passed[pid];
        const leading = st.currentBidder===pid;
        const isMe = pid===youAre;
        if(passed){
          html += `<div class="auction-player-row passed"><b style="color:${p.color}">${p.name}</b> passed</div>`;
        } else if(!isMe){
          // Read-only row for everyone but the acting client. Bid/Pass buttons used
          // to render here too, for every player, on every client — they LOOKED
          // clickable (only ever disabled by affordability) but auctionBid/auctionPass
          // silently do nothing for any pid other than your own youAre, so clicking a
          // teammate's or opponent's row here was a dead click: nothing happened and
          // nothing explained why. Worse, in a local pass-and-play game the click
          // wasn't even fully inert — it's easy to fat-finger the wrong row mid-auction.
          // Everyone still needs to see everyone else's cash/leading status live, just
          // without controls that only work when they happen to belong to you.
          html += `<div class="auction-player-row">
            <div class="auction-player-line" style="color:${p.color};"><b>${p.name}</b><span class="auction-cash">$${fmt(p.balance)} cash</span>${leading?'<span class="auction-leading-tag">Leading</span>':''}</div>
          </div>`;
        } else {
          const stepBtns = BID_STEPS.map(step=>{
            const amt = base + step;
            const afford = auctionAvailableBalance(pid, idx) >= amt;
            // idx is JSON.stringify'd (not just dropped in raw) because auction
            // items aren't always tile numbers — a power-card item is the string
            // "card:<type>" (see auctionItemMeta above). Interpolating that bare
            // into the onclick attribute produced invalid JS like
            // onclick="auctionBid('p1',card:shield,10)" (an unquoted, unescaped
            // bareword), which is a syntax error the browser silently swallows —
            // so every bid/pass button on a card auction was a dead click: no
            // request ever reached the host, the price never moved, and the
            // auction just sat there looking broken. JSON.stringify quotes and
            // escapes strings while leaving plain tile-index numbers untouched,
            // so both item types produce valid, working onclick handlers.
            return `<button class="auction-bid-btn" ${afford?'':'disabled'} onclick="auctionBid('${pid}',${JSON.stringify(idx)},${step})">+$${fmt(step)}<span>$${fmt(amt)}</span></button>`;
          }).join('');
          html += `<div class="auction-player-row">
            <div class="auction-player-line" style="color:${p.color};"><b>${p.name}</b><span class="auction-cash">$${fmt(p.balance)} cash</span>${leading?'<span class="auction-leading-tag">Leading</span>':''}</div>
            <div class="auction-bid-grid">${stepBtns}</div>
            ${leading?'':`<button class="buy-btn no" style="align-self:flex-start;margin-top:2px;" onclick="auctionPass('${pid}',${JSON.stringify(idx)})">Pass</button>`}
          </div>`;
        }
      });
    }
    html += `</div>`;
  });
  document.getElementById('auctionBody').innerHTML = html;
}
function startOwnAuction(pid, checksArg, startBidArg, timerSecArg){
  // same exception toggleAuctionPanel/toggleManagePanel already make: busy is true
  // while the buy/skip decision or a pending debt is showing, but those screens
  // deliberately still let you open this panel and pick properties — so the actual
  // "start" action can't bail out on busy alone or it silently no-ops.
  if(pid !== youAre || (busy && !isDebtor(pid) && !isAwaitingBuy(pid))) return;
  // Re-validate every tile server-side-style (ownership, mortgage, houses, frozen)
  // rather than trusting the picker's own filtering, since this also runs on the
  // host from a guest's network command — see startCombinedAuction's version of
  // this same check for why trusting the raw indices isn't safe.
  const checks = (Array.isArray(checksArg) ? checksArg.map(Number).filter(Number.isInteger) : [...document.querySelectorAll('.auctionPick:checked')].map(el=>parseInt(el.value))).filter(idx=>tiles[idx] && ownedByUnit(tiles[idx],pid) && !tiles[idx].mortgaged && !groupHasBuilding(tiles[idx]) && !(tiles[idx].frozenTurns>0));
  if(checks.length===0) return;
  const startBidField = document.getElementById('ownAuctionStartBid-mgmt')||document.getElementById('ownAuctionStartBid-auc');
  const timerField = document.getElementById('ownAuctionTimer-mgmt')||document.getElementById('ownAuctionTimer-auc');
  const startBid = Math.max(10, Number.isFinite(Number(startBidArg)) ? Number(startBidArg) : (parseInt(startBidField?.value)||10));
  const timerSec = Number.isFinite(Number(timerSecArg)) ? Number(timerSecArg) : (parseInt(timerField?.value) || CONFIG.auctionTimerSec);
  document.getElementById('managePanel').classList.remove('show');
  document.getElementById('auctionPanel').classList.remove('show');
  startAuction(checks, {
    seller: pid,
    startBid,
    timerSec,
    // this side-auction can be started while a buy/skip decision (or a debt) is
    // still pending on a different property, so don't unconditionally clear busy
    // afterward — that would silently unlock Roll/End turn while the original
    // decision is still unresolved. Only clear it if nothing else is still pending.
    onComplete: ()=>{ busy = isDebtor(pid) || isAwaitingBuy(pid); refreshUI(); }
  });
}
/* auctions off a single power card the seller is holding — same seller/eligible-
   bidder/timer machinery as startOwnAuction() above, just with one card item
   instead of a list of tile indices. The card is deducted from the seller's hand
   the moment the auction opens (so it can't also be used mid-auction) and is
   either handed to the winning bidder or given back if nobody bids, both in
   resolveAuction(). Reachable from the power cards hub, any time it's your turn. */
function startCardAuction(pid, cardType, startBidArg, timerSecArg){
  if(pid !== youAre || (busy && !isDebtor(pid) && !isAwaitingBuy(pid))) return;
  const player = players[pid], field = CARD_FIELD[cardType];
  if(!player || !field || !(player[field]>0)) return;
  const startBid = Math.max(10, Number(startBidArg)||10);
  const timerSec = Number(timerSecArg)||CONFIG.auctionTimerSec;
  player[field]--;
  closePowerCards();
  startAuction(['card:'+cardType], {
    seller: pid,
    startBid,
    timerSec,
    onComplete: ()=>{ busy = isDebtor(pid) || isAwaitingBuy(pid); refreshUI(); }
  });
}
/* auctions off any mix of properties and cards the seller owns in one go — the
   picker in #auctionPanel (see toggleAuctionPanel/renderAuctionPanel above) builds
   the combined items list and hands it here. Re-validates every item server-side-
   style (ownership, eligibility) rather than trusting the picker's own filtering,
   since this also runs on the host from a guest's network command. Cards are pulled
   from the seller's hand immediately, same as startCardAuction; properties stay put
   until resolveAuction() actually transfers them. */
function startCombinedAuction(pid, itemsArg, startBidArg, timerSecArg){
  if(pid !== youAre || (busy && !isDebtor(pid) && !isAwaitingBuy(pid))) return;
  const player = players[pid];
  const items = (Array.isArray(itemsArg) ? itemsArg : []).filter(v=>{
    if(typeof v==='string' && v.indexOf('card:')===0){
      const field = CARD_FIELD[v.slice(5)];
      return !!field && !!player && (player[field]||0) > 0;
    }
    const idx = Number(v);
    return Number.isInteger(idx) && tiles[idx] && ownedByUnit(tiles[idx],pid) && !tiles[idx].mortgaged && !groupHasBuilding(tiles[idx]) && !(tiles[idx].frozenTurns>0);
  }).map(v => typeof v==='string' ? v : Number(v));
  if(items.length===0) return;
  const startBid = Math.max(10, Number(startBidArg)||10);
  const timerSec = Number(timerSecArg)||CONFIG.auctionTimerSec;
  items.forEach(v=>{
    if(typeof v==='string' && v.indexOf('card:')===0) player[CARD_FIELD[v.slice(5)]]--;
  });
  document.getElementById('managePanel')?.classList.remove('show');
  document.getElementById('auctionPanel')?.classList.remove('show');
  startAuction(items, {
    seller: pid,
    startBid,
    timerSec,
    onComplete: ()=>{ busy = isDebtor(pid) || isAwaitingBuy(pid); refreshUI(); }
  });
}

refreshUI();

/* pan/zoom for the tilted card board: translate+scale the .gb-view layer inside
   the fixed-size stage viewport, instead of the old SVG viewBox camera */
let gbScale=1, gbPanX=0, gbPanY=0, dragging=false, lastX=0, lastY=0;
const stageWrap = document.getElementById('stageWrap');
const boardHint = document.getElementById('boardHint');
function gbApplyTransform(){
  boardView.style.transform = `translate(${gbPanX}px, ${gbPanY}px) scale(${gbScale})`;
}
function gbFitScale(){
  boardView.style.transform = 'translate(0px,0px) scale(1)';
  const rect = boardView.getBoundingClientRect();
  const stageRect = stageWrap.getBoundingClientRect();
  if(rect.width<1 || rect.height<1) return 1;
  const fitW = (stageRect.width*0.92)/rect.width;
  const fitH = (stageRect.height*0.92)/rect.height;
  return Math.max(0.15, Math.min(fitW, fitH));
}
function resetView(){
  // cancel any in-flight camera pulse — its pending revert holds a stale pre-reset
  // pan/scale that would otherwise clobber the fresh values this sets below.
  clearTimeout(__camPulseTimer); if(boardView) boardView.style.transition='';
  // Full map, but with a touch more zoom than the bare fit so it doesn't look tiny —
  // except in classic mode, whose flat top-down board should always show the
  // complete board edge-to-edge rather than being cropped in tighter.
  const zoomBoost = currentThemeName()==='classic' ? 1 : 1.35;
  gbScale = gbFitScale() * zoomBoost;
  gbPanX = 0; gbPanY = 0;
  gbApplyTransform();
  measureTileScreenCenters();
  updateEdgeAngle();
  positionBuildings();
  PLAYER_IDS.forEach(pid=>{
    if(!tokenEls[pid] || !players[pid]) return;
    // A guest client can still have a glideTokenRemote() animation chain running
    // (setTimeout-based, replaying a host move step by step) when the board gets
    // rebuilt — by a theme switch mid-move, most notably. Without cancelling it
    // here, that old chain keeps firing afterward and overwrites the instant snap
    // below on its next tick, so the token visibly jumps back and fights the
    // reset instead of landing cleanly on the tile the authoritative state says
    // it should be on.
    if(remoteAnimTimers[pid]){ clearTimeout(remoteAnimTimers[pid]); remoteAnimTimers[pid]=null; }
    remoteAnimPos[pid] = players[pid].pos;
    placeTokenInstant(pid, players[pid].pos, false, players[pid].inJail);
  });
}
resetView();
window.addEventListener('resize', resetView);
__cameraSystemReady = true; // gbScale/gbPanX/gbPanY/boardView/stageWrap are all live past this point

/* Camera micro-zoom toward whoever's turn just started (see checkTurnSound above),
   so the board settles its attention on the active token instead of staying static
   between turns. Nudges the existing pan/zoom state a little rather than fighting
   it — a full re-center would undo anywhere the player had manually panned/zoomed
   to — and always eases back to exactly where the camera was beforehand. */
function pulseCameraToActivePlayer(pid){
  if(!cameraPulseEnabled || !__cameraSystemReady || dragging) return;
  const wrap = tokenEls[pid];
  if(!wrap || wrap.style.display==='none') return;
  const tokenRect = wrap.getBoundingClientRect();
  const stageRect = stageWrap.getBoundingClientRect();
  if(!tokenRect.width && !tokenRect.height) return; // not laid out yet
  const dx = (stageRect.left+stageRect.width/2) - (tokenRect.left+tokenRect.width/2);
  const dy = (stageRect.top+stageRect.height/2) - (tokenRect.top+tokenRect.height/2);
  const baseScale = gbScale, basePanX = gbPanX, basePanY = gbPanY;
  const nudge = 0.14; // how far (as a fraction of the token's offset from center) to lean in
  clearTimeout(__camPulseTimer);
  boardView.style.transition = 'transform .5s cubic-bezier(.22,.7,.3,1)';
  gbScale = baseScale*1.05; gbPanX = basePanX+dx*nudge; gbPanY = basePanY+dy*nudge;
  gbApplyTransform();
  __camPulseTimer = setTimeout(()=>{
    gbScale = baseScale; gbPanX = basePanX; gbPanY = basePanY;
    gbApplyTransform();
    __camPulseTimer = setTimeout(()=>{ boardView.style.transition=''; }, spd(550));
  }, spd(850));
}

let dragMoved = false; // true once a pointerdown turns into an actual drag — tells tile
                        // click handlers to ignore the click that fires on pointerup after a pan
let activePointerId = null;
let dragStartX = 0, dragStartY = 0; // pointerdown origin, used to measure TOTAL distance
                                     // moved so far (not just the last move event's delta) —
                                     // checking only the incremental per-event delta let slow/
                                     // smooth mouse movement rack up a large real pan across many
                                     // sub-threshold steps without ever tripping dragMoved, so the
                                     // pointerup after a real drag still fired as a tile-opening click

/* Two-finger pinch-to-zoom (touch only — a mouse never sends two simultaneous
   pointerdowns). Tracks every currently-down pointer by id so a second finger
   landing mid-drag can hand off from "single-finger pan" to "pinch zoom + pan"
   without losing track of where the gesture started. Mirrors the wheel-zoom
   bounds/behavior above so pinching and scrolling feel consistent. */
const activeTouchPoints = new Map(); // pointerId -> {x,y}, touch pointers only
let pinchActive = false;
let pinchStartDist = 0, pinchStartScale = 1;
let pinchStartMidX = 0, pinchStartMidY = 0, pinchStartPanX = 0, pinchStartPanY = 0;
function touchPointDist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function touchPointMid(a,b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }
function beginPinch(){
  const pts = [...activeTouchPoints.values()];
  if(pts.length<2) return;
  clearTimeout(__camPulseTimer); boardView.style.transition='';
  pinchActive = true; dragMoved = true; // a second finger landing is never a tap, even if it lands before the drag threshold trips
  if(boardHint) boardHint.style.opacity='0';
  pinchStartDist = touchPointDist(pts[0], pts[1]) || 1;
  pinchStartScale = gbScale;
  const mid = touchPointMid(pts[0], pts[1]);
  pinchStartMidX = mid.x; pinchStartMidY = mid.y;
  pinchStartPanX = gbPanX; pinchStartPanY = gbPanY;
}
stageWrap.addEventListener('pointerdown', e=>{
  // a real user gesture always wins over an in-flight camera pulse — cancel its
  // pending revert so it can't later snap gbScale/gbPanX/gbPanY back over wherever
  // the user just dragged/zoomed to.
  clearTimeout(__camPulseTimer); boardView.style.transition='';
  if(e.pointerType==='touch') activeTouchPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(activeTouchPoints.size>=2){ beginPinch(); return; } // don't also start a single-finger drag underneath the pinch
  dragging=true; dragMoved=false; lastX=e.clientX; lastY=e.clientY;
  dragStartX=e.clientX; dragStartY=e.clientY;
  activePointerId = e.pointerId;
  stageWrap.classList.add('dragging');
  // NOTE: pointer capture is intentionally NOT taken here. Capturing immediately would
  // redirect the click event that follows a plain tap (pointerdown+pointerup with no
  // movement) to stageWrap instead of the tile cell underneath the finger/cursor, which
  // silently broke tapping tiles to open their info popup. Capture is deferred to
  // pointermove, and only once the gesture has actually moved past the drag threshold —
  // by then it's a real pan, not a tap, so redirecting further events is what we want.
});
stageWrap.addEventListener('pointermove', e=>{
  if(e.pointerType==='touch' && activeTouchPoints.has(e.pointerId)) activeTouchPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinchActive){
    const pts = [...activeTouchPoints.values()];
    if(pts.length<2) return; // one finger lifted mid-pinch; pointerup below handles the transition
    const dist = touchPointDist(pts[0], pts[1]) || 1;
    const mid = touchPointMid(pts[0], pts[1]);
    gbScale = Math.max(0.2, Math.min(2.6, pinchStartScale * (dist/pinchStartDist)));
    // keep the midpoint between the two fingers visually anchored (standard pinch
    // behavior) while also letting the pair drag-pan together, same as one finger does.
    gbPanX = pinchStartPanX + (mid.x - pinchStartMidX);
    gbPanY = pinchStartPanY + (mid.y - pinchStartMidY);
    gbApplyTransform();
    return;
  }
  if(!dragging) return;
  const dx=e.clientX-lastX, dy=e.clientY-lastY;
  lastX=e.clientX; lastY=e.clientY; // always advance, even below threshold, so the eventual
                                     // real pan (once dragMoved trips) starts from a correct
                                     // incremental delta instead of jumping by the whole
                                     // pre-threshold distance in one frame
  if(!dragMoved){
    const totalDx=e.clientX-dragStartX, totalDy=e.clientY-dragStartY;
    // 4px was too tight — ordinary mouse jitter during a plain click (especially on
    // trackpads) easily exceeded it, which flagged the gesture as a pan and swallowed
    // the click that should have opened the tile/country info panel. A larger, more
    // standard click-vs-drag tolerance fixes that while still panning readily once a
    // real drag starts.
    if(Math.abs(totalDx)>10 || Math.abs(totalDy)>10){
      dragMoved=true;
      if(activePointerId!=null) stageWrap.setPointerCapture(activePointerId);
    } else {
      // BUGFIX: this used to fall through and apply dx/dy to gbPanX/gbPanY on every
      // move event regardless of whether the threshold above had tripped — so a plain
      // tap (which almost always produces a few sub-pixel pointermove events from
      // sensor/trackpad noise) nudged the board's CSS transform by a pixel or two on
      // every one of those events. That's enough to slide the tile out from under the
      // finger between pointerdown and pointerup, so the browser's hit-test at release
      // lands on a neighboring tile — or the gap between two — and the tap silently
      // does nothing. Returning here means a tap that never crosses the drag threshold
      // never moves the board at all, so the tile stays exactly where the finger is.
      return;
    }
  }
  gbPanX+=dx; gbPanY+=dy;
  gbApplyTransform();
  if(dragMoved && boardHint) boardHint.style.opacity='0';
});
function gbEndDrag(e){
  if(e && e.pointerType==='touch') activeTouchPoints.delete(e.pointerId);
  if(pinchActive && activeTouchPoints.size<2){
    pinchActive = false;
    const remaining = [...activeTouchPoints.values()];
    if(remaining.length===1){
      // one finger still down after a pinch — hand off smoothly into an ordinary
      // single-finger pan instead of dropping the gesture and forcing a re-grab.
      dragging = true; dragMoved = true;
      lastX = remaining[0].x; lastY = remaining[0].y;
    }
  }
  if(activeTouchPoints.size===0){ dragging=false; activePointerId=null; stageWrap.classList.remove('dragging'); }
}
stageWrap.addEventListener('pointerup', gbEndDrag);
stageWrap.addEventListener('pointerleave', gbEndDrag);
stageWrap.addEventListener('pointercancel', gbEndDrag);
stageWrap.addEventListener('wheel', e=>{
  e.preventDefault();
  clearTimeout(__camPulseTimer); boardView.style.transition=''; // see pointerdown above
  const factor = e.deltaY < 0 ? 1.08 : 0.92;
  gbScale = Math.max(0.2, Math.min(2.6, gbScale*factor));
  gbApplyTransform();
  if(boardHint) boardHint.style.opacity='0';
},{passive:false});

function getFsElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}
function syncFullscreenLabel(){
  const label = document.getElementById('fullscreenBtnLabel');
  if(!label) return;
  const active = !!getFsElement() || document.body.classList.contains('pseudo-fullscreen');
  label.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
}
function toggleFullscreen(){
  // fallback mode already active — just turn it off
  if(document.body.classList.contains('pseudo-fullscreen')){
    document.body.classList.remove('pseudo-fullscreen');
    syncFullscreenLabel();
    return;
  }
  const fsEl = getFsElement();
  if(fsEl){
    const exitFn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    try{ const r = exitFn && exitFn.call(document); if(r && r.catch) r.catch(()=>{}); }catch(e){}
    return;
  }
  const el = document.documentElement;
  // iOS Safari has no requestFullscreen for arbitrary elements at all, and some
  // in-app/webview browsers only expose an old vendor-prefixed version (or none) —
  // try every known form before giving up on the native API.
  const reqFn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  let result = null;
  if(reqFn){
    try{ result = reqFn.call(el); }catch(e){ result = null; }
  }
  const fallBack = ()=>{ document.body.classList.add('pseudo-fullscreen'); syncFullscreenLabel(); };
  if(result && typeof result.catch === 'function'){
    result.catch(fallBack);
  } else if(!reqFn){
    fallBack();
  }
  // some older mobile webviews call requestFullscreen synchronously with no promise
  // and no error — verify shortly after that it actually took effect, or fall back
  setTimeout(()=>{ if(!getFsElement() && !document.body.classList.contains('pseudo-fullscreen')) fallBack(); }, 300);
}
['fullscreenchange','webkitfullscreenchange','mozfullscreenchange','MSFullscreenChange'].forEach(evt=>
  document.addEventListener(evt, syncFullscreenLabel)
);
document.addEventListener('keydown', e=>{
  if(e.key==='Escape' && document.body.classList.contains('pseudo-fullscreen')){
    document.body.classList.remove('pseudo-fullscreen');
    syncFullscreenLabel();
  }
});
// mobile browsers resize the visible viewport as the address bar shows/hides,
// which breaks plain 100vh — keep a live custom property as a fallback for
// browsers that don't yet support 100dvh
function setMobileVhVar(){
  document.documentElement.style.setProperty('--vh100', (window.innerHeight*0.01)+'px');
}
setMobileVhVar();
window.addEventListener('resize', setMobileVhVar);
window.addEventListener('orientationchange', setMobileVhVar);

document.getElementById('msgTime').textContent =
  new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'}) + ' ' +
  new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

// Remembers which player cards (and in what order) were last painted, so
// renderPlayerCards() can skip rebuilding the DOM when nothing about the
// active-player set actually changed. Declared here (before renderPlayerCards()
// is invoked below), since that call reads this variable — declaring it later
// with `let` left it in the temporal dead zone at that call time.
let __lastRenderedCardIds=null;

renderPlayerCards();

/* ============ START MENU / RULE CONFIG / SHARE CODE ============
   Name and car are no longer chosen on this pre-room screen — #setupPlayers
   stays empty. Both are picked live inside the lobby instead (see
   renderLobbyPlayers/changeNameLobby/changeCarLobby below), which now every
   flow passes through, including local test (see startLocalTest). */
/* lets a player change their own car while sitting in the online lobby — added so
   everyone can actually SEE which cars are taken and pick a free one themselves,
   instead of only being told after the fact (via the colorWasTaken note above)
   that their original pick got silently reassigned. Registered in ACTIONS, so for
   a guest this automatically routes through sendCommand to the host, runs there,
   and comes back down via the normal state sync — no extra networking code needed. */
function changeCarLobby(pid, car){
  if(NET.started) return; // lobby only — once the game is actually running, cars are locked in
  if(pid !== youAre) return; // only the acting player may change their own car
  const player = players[pid];
  if(!player || !player.active) return;
  if(player.ready) return; // locked while marked ready — press "Not ready" to change cars again
  if(!CAR_LIST.some(c=>c.key===car)) return;
  const takenByOther = PLAYER_IDS.some(x=>x!==pid && players[x] && players[x].active && players[x].car===car);
  if(takenByOther) return; // someone else already has it — the picker UI keeps this disabled, this is just the authoritative re-check
  player.car = car;
  player.color = colorForCar(car);
  PLAYER_SETUP[pid] = PLAYER_SETUP[pid] || {};
  PLAYER_SETUP[pid].car = car;
  PLAYER_SETUP[pid].color = player.color; // keep in sync so applyPlayerIdentity() (re-run on every join/reconnect) doesn't stomp this with a stale value, same as changeNameLobby does for name
  if(tokenEls[pid]) updateTokenAppearance(pid, player.color, car);
  renderLobbyPlayers();
  refreshPlayerVisuals();
}
/* lets a player type their own display name while still sitting in the online
   lobby, instead of only being able to set it once on the pre-room setup screen.
   Registered in ACTIONS (like changeCarLobby above) so a guest's edits route
   through sendCommand to the host automatically. Deliberately does NOT fall back
   to a default name here — an in-progress empty field is normal while typing;
   applyPlayerIdentity() (run at beginGame) is what fills in the default if the
   field was left blank. */
function changeNameLobby(pid, name){
  if(NET.started) return; // lobby only — names lock in once the game is running
  if(pid !== youAre) return; // only the acting player may change their own name
  const player = players[pid];
  if(!player || !player.active) return;
  if(player.ready) return; // locked while marked ready — press "Not ready" to edit again
  const clean = sanitizeName(name);
  player.name = clean;
  PLAYER_SETUP[pid] = PLAYER_SETUP[pid] || {};
  PLAYER_SETUP[pid].name = clean; // keep in sync so beginGame's applyPlayerIdentity() doesn't stomp this with a stale value
  renderLobbyPlayers();
}
/* host-authoritative ready toggle for the lobby's "everyone ready" gate — same
   ACTIONS-routed pattern as changeCarLobby/changeNameLobby. Once marked ready,
   the player's own name/car pickers lock (see changeNameLobby/changeCarLobby's
   guards and renderLobbyPlayers' disabled state below) so nobody can silently
   change their identity after signaling they're set. */
function setReadyLobby(pid, ready){
  if(NET.started) return;
  if(pid !== youAre) return;
  const player = players[pid];
  if(!player || !player.active) return;
  player.ready = !!ready;
  renderLobbyPlayers();
}
function renderPlayerCards(force){
  const root=document.getElementById('playerCards'); if(!root)return;
  // only players who have actually joined (p1 is always active locally; p2+ become
  // active only once a real peer connects) get a card — offline/unjoined slots are
  // never shown, instead of rendering all 8 and just graying the empty ones out
  const activeIds=PLAYER_IDS.filter(pid=>players[pid].active);
  const sig=activeIds.join(',');
  // Online games call this on every network state sync (which fires after nearly
  // every action, many times a minute) — rebuilding the innerHTML each time tears
  // down and recreates every opponent's 3D car <model-viewer>, and browsers only
  // allow a limited number of live WebGL contexts at once. Recreating them this
  // often exhausts that limit and the car models silently stop rendering, which is
  // why opponents' icons could disappear in multiplayer. Only rebuild when the set
  // of joined players (or their order) actually changed; per-player detail updates
  // (name/color/car/etc.) are handled in place by applyPlayerIdentity() and
  // refreshPlayerVisuals() without touching the DOM nodes.
  if(!force && sig===__lastRenderedCardIds) return;
  __lastRenderedCardIds=sig;
  root.innerHTML=activeIds.map(pid=>{
    const i=PLAYER_IDS.indexOf(pid);
    const car=players[pid].car||CAR_LIST[i%CAR_LIST.length].key;
    return `<div class="player-card ${i?'other':'active'}" id="card-${pid}" onclick="setYou('${pid}')"><div class="balance-block"><div class="pin-icon">◎</div><div class="balance-amt"><span class="cur">$</span><span class="bal-num" id="bal-${pid}">1,500</span></div><div class="action-row"><button class="action-pill" id="tradeBtn-${pid}" onclick="openTrade('${pid}')">Trade</button><button class="action-pill danger" id="bankruptBtn-${pid}" onclick="declareBankrupt('${pid}')">Bankrupt</button></div></div><div class="avatar-hex"><svg class="turn-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="turn-ring-track" cx="50" cy="50" r="46"></circle><circle class="turn-ring-progress" cx="50" cy="50" r="46"></circle></svg><div class="turn-ring-secs" id="secs-${pid}"></div><model-viewer class="avatar-car-mv" data-car="${car}" src="${CAR_MODELS[car]}" disable-zoom interaction-prompt="none" camera-orbit="-35deg 72deg auto" field-of-view="14deg" exposure="1.2" environment-image="neutral" loading="eager"></model-viewer></div><div class="player-info"><div class="player-info-main"><div class="player-name"><span class="player-name-text" id="name-${pid}">Player ${i+1}</span><span class="turn-flag" title="Their turn"></span></div><div class="player-role"><span class="dot" id="dot-${pid}"></span><span id="role-${pid}">Player ${i+1}</span></div><div class="disc-badge-row"><div class="disc-badge" id="discBadge-${pid}"></div><button type="button" class="disc-kick-btn" id="discKick-${pid}" onclick="confirmKickPlayer('${pid}')">Kick</button></div><div class="power-badges" id="powerBadges-${pid}" title="Click to see this player's cards" style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;cursor:pointer;" onclick="event.stopPropagation();viewOpponentCards('${pid}')"></div></div></div></div>`;
  }).join('');
}

// Strips characters that would let a typed/remote name break out of the HTML it
// gets dropped into — several spots (chat log, trade cards) insert player names via
// innerHTML rather than textContent, so an unsanitized name (especially one coming
// from another player over the network) could inject markup into everyone's screen.
function sanitizeName(s){ return String(s||'').replace(/[<>]/g,'').trim().slice(0,16); }
function applyPlayerIdentity(){
  renderPlayerCards(); // re-derive which cards exist before styling them — the active set may have just changed (a player joined/left)
  PLAYER_IDS.forEach((pid,i)=>{const p=players[pid]; p.name=sanitizeName(PLAYER_SETUP[pid]?.name)||PLAYER_DEFAULTS[i][0]; p.car=PLAYER_SETUP[pid]?.car||CAR_LIST[i%CAR_LIST.length].key; p.color=colorForCar(p.car); const nm=document.getElementById('name-'+pid); if(nm)nm.textContent=p.name; const card=document.getElementById('card-'+pid); if(card){card.style.borderColor=p.color;card.style.color=p.color;const mv=card.querySelector('.avatar-car-mv');if(mv&&mv.dataset.car!==p.car){mv.setAttribute('src',CAR_MODELS[p.car]||CAR_MODELS[CAR_LIST[0].key]);mv.dataset.car=p.car;}} if(tokenEls[pid])updateTokenAppearance(pid,p.color,p.car);});
  const yn=document.getElementById('youAreName'); if(yn)yn.textContent=players[youAre]?.name||'Player';
}

function refreshPlayerVisuals(){PLAYER_IDS.forEach(pid=>{const p=players[pid],nm=document.getElementById('name-'+pid),card=document.getElementById('card-'+pid);if(nm)nm.textContent=p.name;if(card){card.style.borderColor=p.color;card.style.color=p.color;const mv=card.querySelector('.avatar-car-mv');if(mv&&mv.dataset.car!==p.car){mv.setAttribute('src',CAR_MODELS[p.car]||CAR_MODELS[CAR_LIST[0].key]);mv.dataset.car=p.car;}}if(tokenEls[pid])updateTokenAppearance(pid,p.color,p.car);});const yn=document.getElementById('youAreName');if(yn)yn.textContent=players[youAre]?.name||'Player';}

function encodeConfig(cfg){
  const payload = {
    v:2, sc:cfg.startingCash, sal:cfg.salary, gb:cfg.goLandingBonus, bail:cfg.bail,
    le:cfg.loansEnabled?1:0, ll:cfg.loanLimit, li:cfg.loanInterestPct,
    nj:cfg.noRentInJail?1:0, dr:cfg.doubleRentFullSet?1:0,
    ad:cfg.auctionOnDecline?1:0, af:cfg.auctionFunMode?1:0, at:cfg.auctionTimerSec,
    fs:cfg.requireFullSetToBuild?1:0, eb:cfg.evenBuildRule?1:0,
    bo:cfg.buyoutEnabled?1:0, bm:cfg.buyoutMultiplier, ba:cfg.buyoutAnywhere?1:0, bh:cfg.buyoutIncludesHouses?1:0,
    tt:cfg.turnTimerEnabled?1:0, tts:cfg.turnTimerSec,
    lwp:cfg.luckyWheelPowerOnly?1:0, bdp:cfg.bdayPowerOnly?1:0,
    se:cfg.powerCardsEnabled.shield?1:0, sw:cfg.powerCardWeights.shield,
    rde:cfg.powerCardsEnabled.rentDoubler?1:0, rdw:cfg.powerCardWeights.rentDoubler,
    jfe:cfg.powerCardsEnabled.jailFree?1:0, jfw:cfg.powerCardWeights.jailFree,
    tpe:cfg.powerCardsEnabled.teleport?1:0, tpw:cfg.powerCardWeights.teleport,
    sae:cfg.powerCardsEnabled.skipAhead?1:0, saw:cfg.powerCardWeights.skipAhead, sas:cfg.skipAheadSpaces,
    pfe:cfg.powerCardsEnabled.propertyFreeze?1:0, pfw:cfg.powerCardWeights.propertyFreeze,
    swe:cfg.powerCardsEnabled.swap?1:0, sww:cfg.powerCardWeights.swap,
    pse:cfg.powerCardsEnabled.propertySwap?1:0, psw:cfg.powerCardWeights.propertySwap,
    bie:cfg.powerCardsEnabled.bankruptcyInsurance?1:0, biw:cfg.powerCardWeights.bankruptcyInsurance,
    dse:cfg.powerCardsEnabled.doubleSalary?1:0, dsw:cfg.powerCardWeights.doubleSalary,
    lfe:cfg.powerCardsEnabled.loanForgiveness?1:0, lfw:cfg.powerCardWeights.loanForgiveness,
    ere:cfg.powerCardsEnabled.extraRoll?1:0, erw:cfg.powerCardWeights.extraRoll,
    ffe:cfg.powerCardsEnabled.fastForward?1:0, ffw:cfg.powerCardWeights.fastForward,
    sce:cfg.powerCardsEnabled.stealCard?1:0, scw:cfg.powerCardWeights.stealCard,
    sse:cfg.powerCardsEnabled.sharedShield?1:0, ssw:cfg.powerCardWeights.sharedShield,
    rle:cfg.powerCardsEnabled.rally?1:0, rlw:cfg.powerCardWeights.rally,
    ppe:cfg.powerCardsEnabled.pooledPayday?1:0, ppw:cfg.powerCardWeights.pooledPayday,
    hhe:cfg.powerCardsEnabled.highRiseHustle?1:0, hhw:cfg.powerCardWeights.highRiseHustle,
    sab:cfg.powerCardsEnabled.sabotage?1:0, sabw:cfg.powerCardWeights.sabotage,
    nde:cfg.powerCardsEnabled.nudge?1:0, ndw:cfg.powerCardWeights.nudge,
    tre:cfg.powerCardsEnabled.tollRefund?1:0, trw:cfg.powerCardWeights.tollRefund,
    hse:cfg.powerCardsEnabled.halfShield?1:0, hsw:cfg.powerCardWeights.halfShield,
    the:cfg.powerCardsEnabled.theft?1:0, thw:cfg.powerCardWeights.theft,
    sbe:cfg.sideBetsEnabled?1:0,
    sp2:cfg.speedX2Enabled?1:0
  };
  try{ return 'WE-' + btoa(JSON.stringify(payload)).replace(/=+$/,''); }
  catch(e){ return ''; }
}
function decodeConfig(code){
  try{
    const raw = code.trim().replace(/^WE-/,'');
    const payload = JSON.parse(atob(raw));
    return {
      startingCash: Math.max(0, Number(payload.sc)) || 1500,
      salary: Math.max(0, Number(payload.sal)) || 200,
      goLandingBonus: Math.max(0, Number(payload.gb)) || 600,
      bail: Math.max(0, Number(payload.bail)) || 100,
      loansEnabled: !!payload.le,
      loanLimit: Math.max(0, Number(payload.ll)) || 0,
      loanInterestPct: Math.max(0, Number(payload.li)) || 0,
      noRentInJail: !!payload.nj,
      doubleRentFullSet: payload.dr===undefined ? true : !!payload.dr,
      auctionOnDecline: payload.ad===undefined ? true : !!payload.ad,
      auctionFunMode: !!payload.af,
      auctionTimerSec: [3,6,9].includes(Number(payload.at)) ? Number(payload.at) : 6,
      requireFullSetToBuild: payload.fs===undefined ? true : !!payload.fs,
      evenBuildRule: !!payload.eb,
      buyoutEnabled: !!payload.bo,
      buyoutMultiplier: Math.min(6, Math.max(2, Number(payload.bm)||3)),
      buyoutAnywhere: !!payload.ba,
      buyoutIncludesHouses: !!payload.bh,
      turnTimerEnabled: !!payload.tt,
      turnTimerSec: [15,30,45,60,90,120].includes(Number(payload.tts)) ? Number(payload.tts) : 45,
      luckyWheelPowerOnly: payload.lwp===undefined ? false : !!payload.lwp,
      bdayPowerOnly: payload.bdp===undefined ? true : !!payload.bdp,
      powerCardsEnabled: {
        shield: payload.se===undefined ? true : !!payload.se,
        rentDoubler: payload.rde===undefined ? true : !!payload.rde,
        jailFree: payload.jfe===undefined ? true : !!payload.jfe,
        teleport: payload.tpe===undefined ? true : !!payload.tpe,
        skipAhead: payload.sae===undefined ? true : !!payload.sae,
        propertyFreeze: payload.pfe===undefined ? true : !!payload.pfe,
        swap: payload.swe===undefined ? true : !!payload.swe,
        propertySwap: payload.pse===undefined ? true : !!payload.pse,
        bankruptcyInsurance: payload.bie===undefined ? true : !!payload.bie,
        doubleSalary: payload.dse===undefined ? true : !!payload.dse,
        loanForgiveness: payload.lfe===undefined ? true : !!payload.lfe,
        extraRoll: payload.ere===undefined ? true : !!payload.ere,
        fastForward: payload.ffe===undefined ? true : !!payload.ffe,
        stealCard: payload.sce===undefined ? true : !!payload.sce,
        sharedShield: payload.sse===undefined ? true : !!payload.sse,
        rally: payload.rle===undefined ? true : !!payload.rle,
        pooledPayday: payload.ppe===undefined ? true : !!payload.ppe,
        highRiseHustle: payload.hhe===undefined ? true : !!payload.hhe,
        sabotage: payload.sab===undefined ? true : !!payload.sab,
        nudge: payload.nde===undefined ? true : !!payload.nde,
        tollRefund: payload.tre===undefined ? true : !!payload.tre,
        halfShield: payload.hse===undefined ? true : !!payload.hse,
        theft: payload.the===undefined ? true : !!payload.the
      },
      powerCardWeights: {
        shield: Number.isFinite(Number(payload.sw)) ? Math.max(0, Number(payload.sw)) : 25,
        rentDoubler: Number.isFinite(Number(payload.rdw)) ? Math.max(0, Number(payload.rdw)) : 25,
        jailFree: Number.isFinite(Number(payload.jfw)) ? Math.max(0, Number(payload.jfw)) : 25,
        teleport: Number.isFinite(Number(payload.tpw)) ? Math.max(0, Number(payload.tpw)) : 25,
        skipAhead: Number.isFinite(Number(payload.saw)) ? Math.max(0, Number(payload.saw)) : 25,
        propertyFreeze: Number.isFinite(Number(payload.pfw)) ? Math.max(0, Number(payload.pfw)) : 25,
        swap: Number.isFinite(Number(payload.sww)) ? Math.max(0, Number(payload.sww)) : 25,
        propertySwap: Number.isFinite(Number(payload.psw)) ? Math.max(0, Number(payload.psw)) : 25,
        bankruptcyInsurance: Number.isFinite(Number(payload.biw)) ? Math.max(0, Number(payload.biw)) : 25,
        doubleSalary: Number.isFinite(Number(payload.dsw)) ? Math.max(0, Number(payload.dsw)) : 25,
        loanForgiveness: Number.isFinite(Number(payload.lfw)) ? Math.max(0, Number(payload.lfw)) : 25,
        extraRoll: Number.isFinite(Number(payload.erw)) ? Math.max(0, Number(payload.erw)) : 25,
        fastForward: Number.isFinite(Number(payload.ffw)) ? Math.max(0, Number(payload.ffw)) : 25,
        stealCard: Number.isFinite(Number(payload.scw)) ? Math.max(0, Number(payload.scw)) : 25,
        sharedShield: Number.isFinite(Number(payload.ssw)) ? Math.max(0, Number(payload.ssw)) : 25,
        rally: Number.isFinite(Number(payload.rlw)) ? Math.max(0, Number(payload.rlw)) : 25,
        pooledPayday: Number.isFinite(Number(payload.ppw)) ? Math.max(0, Number(payload.ppw)) : 25,
        highRiseHustle: Number.isFinite(Number(payload.hhw)) ? Math.max(0, Number(payload.hhw)) : 25,
        sabotage: Number.isFinite(Number(payload.sabw)) ? Math.max(0, Number(payload.sabw)) : 25,
        nudge: Number.isFinite(Number(payload.ndw)) ? Math.max(0, Number(payload.ndw)) : 25,
        tollRefund: Number.isFinite(Number(payload.trw)) ? Math.max(0, Number(payload.trw)) : 25,
        halfShield: Number.isFinite(Number(payload.hsw)) ? Math.max(0, Number(payload.hsw)) : 25,
        theft: Number.isFinite(Number(payload.thw)) ? Math.max(0, Number(payload.thw)) : 25
      },
      sideBetsEnabled: payload.sbe===undefined ? false : !!payload.sbe,
      speedX2Enabled: !!payload.sp2,
      skipAheadSpaces: Math.min(39, Math.max(1, Number(payload.sas)||5))
    };
  }catch(e){ return null; }
}

function startNewGame(){
  document.getElementById('startCodeField').value = encodeConfig(CONFIG);
  document.getElementById('startCodeOut').style.display = 'block';
}
function copyStartCode(){
  const field = document.getElementById('startCodeField');
  field.select();
  field.setSelectionRange(0, 99999);
  if(navigator.clipboard) navigator.clipboard.writeText(field.value).catch(()=>{});
  else document.execCommand('copy');
}
function startLocalTest(){
  // local test now goes through the same lobby as an online room (just
  // offline, host-only, solo) instead of jumping straight onto the board —
  // that's the only place name/car are editable, so it needs one too.
  NET.online=false; NET.host=true; NET.activeIds=['p1'];
  PLAYER_SETUP.p1.name='test';
  applyPlayerIdentity();
  enterLobbyUI();
}
function joinWithCode(){
  const codeField = document.getElementById('joinCodeField');
  const decoded = decodeConfig(codeField.value);
  if(!decoded){
    codeField.style.borderColor = 'var(--pink)';
    codeField.placeholder = "That code doesn't look right — try again";
    return;
  }
  CONFIG = decoded;
  beginGame();
}

function openConfigMenu(){
  document.getElementById('cfgStartingCash').value = CONFIG.startingCash;
  document.getElementById('cfgSalary').value = CONFIG.salary;
  document.getElementById('cfgGoLandingBonus').value = CONFIG.goLandingBonus;
  document.getElementById('cfgBail').value = CONFIG.bail;
  document.getElementById('cfgLoansEnabled').checked = CONFIG.loansEnabled;
  document.getElementById('cfgLoanLimit').value = CONFIG.loanLimit;
  document.getElementById('cfgLoanInterest').value = CONFIG.loanInterestPct;
  toggleLoanFieldsUI();

  document.getElementById('cfgTeamsEnabled').checked = CONFIG.teamsEnabled;
  toggleTeamOnlyCardsUI();

  document.getElementById('cfgNoRentInJail').checked = CONFIG.noRentInJail;
  document.getElementById('cfgDoubleRentFullSet').checked = CONFIG.doubleRentFullSet;

  document.getElementById('cfgTurnTimerEnabled').checked = CONFIG.turnTimerEnabled;
  document.getElementById('cfgTurnTimerSec').value = String(CONFIG.turnTimerSec);
  toggleTurnTimerFieldsUI();

  document.getElementById('cfgAuctionOnDecline').checked = CONFIG.auctionOnDecline;
  document.getElementById('cfgAuctionFunMode').checked = CONFIG.auctionFunMode;
  document.getElementById('cfgAuctionTimer').value = String(CONFIG.auctionTimerSec);
  toggleFunModeUI();

  document.getElementById('cfgRequireFullSet').checked = CONFIG.requireFullSetToBuild;
  document.getElementById('cfgEvenBuild').checked = CONFIG.evenBuildRule;

  document.getElementById('cfgBuyoutEnabled').checked = CONFIG.buyoutEnabled;
  document.getElementById('cfgBuyoutMultiplier').value = String(CONFIG.buyoutMultiplier);
  document.getElementById('cfgBuyoutAnywhere').checked = CONFIG.buyoutAnywhere;
  document.getElementById('cfgBuyoutIncludesHouses').checked = CONFIG.buyoutIncludesHouses;
  toggleBuyoutFieldsUI();

  document.getElementById('cfgLuckyWheelCashEnabled').checked = !CONFIG.luckyWheelPowerOnly;
  document.getElementById('cfgBdayCashEnabled').checked = !CONFIG.bdayPowerOnly;
  document.getElementById('cfgPowerShieldEnabled').checked = CONFIG.powerCardsEnabled.shield;
  document.getElementById('cfgPowerShieldWeight').value = CONFIG.powerCardWeights.shield;
  document.getElementById('cfgPowerRentDoublerEnabled').checked = CONFIG.powerCardsEnabled.rentDoubler;
  document.getElementById('cfgPowerRentDoublerWeight').value = CONFIG.powerCardWeights.rentDoubler;
  document.getElementById('cfgPowerJailFreeEnabled').checked = CONFIG.powerCardsEnabled.jailFree;
  document.getElementById('cfgPowerJailFreeWeight').value = CONFIG.powerCardWeights.jailFree;
  document.getElementById('cfgPowerTeleportEnabled').checked = CONFIG.powerCardsEnabled.teleport;
  document.getElementById('cfgPowerTeleportWeight').value = CONFIG.powerCardWeights.teleport;
  document.getElementById('cfgPowerSkipAheadEnabled').checked = CONFIG.powerCardsEnabled.skipAhead;
  document.getElementById('cfgPowerSkipAheadWeight').value = CONFIG.powerCardWeights.skipAhead;
  document.getElementById('cfgSkipAheadSpaces').value = CONFIG.skipAheadSpaces;
  document.getElementById('cfgPowerFreezeEnabled').checked = CONFIG.powerCardsEnabled.propertyFreeze;
  document.getElementById('cfgPowerFreezeWeight').value = CONFIG.powerCardWeights.propertyFreeze;
  document.getElementById('cfgPowerSwapEnabled').checked = CONFIG.powerCardsEnabled.swap;
  document.getElementById('cfgPowerSwapWeight').value = CONFIG.powerCardWeights.swap;
  document.getElementById('cfgPowerPropertySwapEnabled').checked = CONFIG.powerCardsEnabled.propertySwap;
  document.getElementById('cfgPowerPropertySwapWeight').value = CONFIG.powerCardWeights.propertySwap;
  document.getElementById('cfgPowerBankruptcyInsuranceEnabled').checked = CONFIG.powerCardsEnabled.bankruptcyInsurance;
  document.getElementById('cfgPowerBankruptcyInsuranceWeight').value = CONFIG.powerCardWeights.bankruptcyInsurance;
  document.getElementById('cfgPowerDoubleSalaryEnabled').checked = CONFIG.powerCardsEnabled.doubleSalary;
  document.getElementById('cfgPowerDoubleSalaryWeight').value = CONFIG.powerCardWeights.doubleSalary;
  document.getElementById('cfgPowerLoanForgivenessEnabled').checked = CONFIG.powerCardsEnabled.loanForgiveness;
  document.getElementById('cfgPowerLoanForgivenessWeight').value = CONFIG.powerCardWeights.loanForgiveness;
  document.getElementById('cfgPowerExtraRollEnabled').checked = CONFIG.powerCardsEnabled.extraRoll;
  document.getElementById('cfgPowerExtraRollWeight').value = CONFIG.powerCardWeights.extraRoll;
  document.getElementById('cfgPowerFastForwardEnabled').checked = CONFIG.powerCardsEnabled.fastForward;
  document.getElementById('cfgPowerFastForwardWeight').value = CONFIG.powerCardWeights.fastForward;
  document.getElementById('cfgPowerStealCardEnabled').checked = CONFIG.powerCardsEnabled.stealCard;
  document.getElementById('cfgPowerStealCardWeight').value = CONFIG.powerCardWeights.stealCard;
  document.getElementById('cfgPowerSharedShieldEnabled').checked = CONFIG.powerCardsEnabled.sharedShield;
  document.getElementById('cfgPowerSharedShieldWeight').value = CONFIG.powerCardWeights.sharedShield;
  document.getElementById('cfgPowerRallyEnabled').checked = CONFIG.powerCardsEnabled.rally;
  document.getElementById('cfgPowerRallyWeight').value = CONFIG.powerCardWeights.rally;
  document.getElementById('cfgPowerPooledPaydayEnabled').checked = CONFIG.powerCardsEnabled.pooledPayday;
  document.getElementById('cfgPowerPooledPaydayWeight').value = CONFIG.powerCardWeights.pooledPayday;
  document.getElementById('cfgPowerHighRiseHustleEnabled').checked = CONFIG.powerCardsEnabled.highRiseHustle;
  document.getElementById('cfgPowerHighRiseHustleWeight').value = CONFIG.powerCardWeights.highRiseHustle;
  document.getElementById('cfgPowerSabotageEnabled').checked = CONFIG.powerCardsEnabled.sabotage;
  document.getElementById('cfgPowerSabotageWeight').value = CONFIG.powerCardWeights.sabotage;
  document.getElementById('cfgPowerNudgeEnabled').checked = CONFIG.powerCardsEnabled.nudge;
  document.getElementById('cfgPowerNudgeWeight').value = CONFIG.powerCardWeights.nudge;
  document.getElementById('cfgPowerTollRefundEnabled').checked = CONFIG.powerCardsEnabled.tollRefund;
  document.getElementById('cfgPowerTollRefundWeight').value = CONFIG.powerCardWeights.tollRefund;
  document.getElementById('cfgPowerHalfShieldEnabled').checked = CONFIG.powerCardsEnabled.halfShield;
  document.getElementById('cfgPowerHalfShieldWeight').value = CONFIG.powerCardWeights.halfShield;
  document.getElementById('cfgPowerTheftEnabled').checked = CONFIG.powerCardsEnabled.theft;
  document.getElementById('cfgPowerTheftWeight').value = CONFIG.powerCardWeights.theft;

  document.getElementById('cfgSideBetsEnabled').checked = CONFIG.sideBetsEnabled;

  document.getElementById('cfgSpeedX2Enabled').checked = CONFIG.speedX2Enabled;

  switchConfigTab('general');
  document.getElementById('configOverlay').classList.add('show');
}
function closeConfigMenu(){
  document.getElementById('configOverlay').classList.remove('show');
}
// live-apply: every field in the settings menu takes effect the moment it changes —
// no separate Save button — so closing the menu (the × button, or clicking outside)
// never discards anything; it's already been applied to CONFIG by the time you close.
// One delegated listener on the whole settings body instead of an onchange on each of
// the ~70 individual fields — any existing onchange on a field (e.g. toggleLoanFieldsUI)
// still fires too; this just runs saveConfigMenu() on top of it.
document.getElementById('cfgBody').addEventListener('change', (e)=>{
  if(e.target.matches('input,select')) saveConfigMenu();
});
function switchConfigTab(tab){
  const tabs = ['general','auctions','cards'];
  tabs.forEach(t=>{
    const panel = document.getElementById('cfgTabPanel-'+t);
    const btn = document.getElementById('cfgTabBtn-'+t);
    const active = t === tab;
    if(panel) panel.classList.toggle('active', active);
    if(btn){
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  });
  const body = document.querySelector('#configOverlay .cfg-body');
  if(body) body.scrollTop = 0;
}
function toggleLoanFieldsUI(){
  const enabled = document.getElementById('cfgLoansEnabled').checked;
  document.getElementById('cfgLoanFields').classList.toggle('disabled', !enabled);
}
function toggleTurnTimerFieldsUI(){
  const enabled = document.getElementById('cfgTurnTimerEnabled').checked;
  document.getElementById('cfgTurnTimerField').classList.toggle('disabled', !enabled);
}
function toggleFunModeUI(){
  // auction-only mode makes "auction on decline" moot — there is no decline anymore
  const fun = document.getElementById('cfgAuctionFunMode').checked;
  document.getElementById('cfgAuctionOnDecline').disabled = fun;
}
function toggleBuyoutFieldsUI(){
  const enabled = document.getElementById('cfgBuyoutEnabled').checked;
  document.getElementById('cfgBuyoutFields').classList.toggle('disabled', !enabled);
  document.getElementById('cfgBuyoutHousesField').classList.toggle('disabled', !enabled);
}
/* Dims every .cfg-team-only-row (currently just Shared Shield) and disables its
   checkbox/weight input the instant Team mode is switched off in the settings
   panel, so a team-only card can never sit "enabled" for a mode that isn't on.
   Purely a settings-menu display convenience — pickPowerCard() enforces the
   actual teamOnly gate at draw time regardless of what's checked here. Reusable
   as-is for any future team-only card: just add the .cfg-team-only-row class to
   its row and it's picked up by the querySelectorAll below automatically. */
function toggleTeamOnlyCardsUI(){
  const teamsOn = document.getElementById('cfgTeamsEnabled').checked;
  document.querySelectorAll('.cfg-team-only-row').forEach(row=>{
    row.classList.toggle('cfg-team-only-inactive', !teamsOn);
    row.querySelectorAll('input').forEach(inp=>{ inp.disabled = !teamsOn; });
  });
}
function saveConfigMenu(){
  CONFIG.startingCash = Math.max(0, parseInt(document.getElementById('cfgStartingCash').value)) || 0;
  CONFIG.salary = Math.max(0, parseInt(document.getElementById('cfgSalary').value)) || 0;
  CONFIG.goLandingBonus = Math.max(0, parseInt(document.getElementById('cfgGoLandingBonus').value)) || 0;
  CONFIG.bail = Math.max(0, parseInt(document.getElementById('cfgBail').value)) || 0;
  CONFIG.loansEnabled = document.getElementById('cfgLoansEnabled').checked;
  CONFIG.loanLimit = Math.max(0, parseInt(document.getElementById('cfgLoanLimit').value)) || 0;
  CONFIG.loanInterestPct = Math.max(0, parseInt(document.getElementById('cfgLoanInterest').value)) || 0;

  CONFIG.teamsEnabled = document.getElementById('cfgTeamsEnabled').checked;

  CONFIG.noRentInJail = document.getElementById('cfgNoRentInJail').checked;
  CONFIG.doubleRentFullSet = document.getElementById('cfgDoubleRentFullSet').checked;

  CONFIG.turnTimerEnabled = document.getElementById('cfgTurnTimerEnabled').checked;
  CONFIG.turnTimerSec = parseInt(document.getElementById('cfgTurnTimerSec').value) || 45;

  CONFIG.auctionOnDecline = document.getElementById('cfgAuctionOnDecline').checked;
  CONFIG.auctionFunMode = document.getElementById('cfgAuctionFunMode').checked;
  CONFIG.auctionTimerSec = parseInt(document.getElementById('cfgAuctionTimer').value) || 6;

  CONFIG.requireFullSetToBuild = document.getElementById('cfgRequireFullSet').checked;
  CONFIG.evenBuildRule = document.getElementById('cfgEvenBuild').checked;

  CONFIG.buyoutEnabled = document.getElementById('cfgBuyoutEnabled').checked;
  CONFIG.buyoutMultiplier = Math.min(6, Math.max(2, parseInt(document.getElementById('cfgBuyoutMultiplier').value) || 3));
  CONFIG.buyoutAnywhere = document.getElementById('cfgBuyoutAnywhere').checked;
  CONFIG.buyoutIncludesHouses = document.getElementById('cfgBuyoutIncludesHouses').checked;

  CONFIG.luckyWheelPowerOnly = !document.getElementById('cfgLuckyWheelCashEnabled').checked;
  CONFIG.bdayPowerOnly = !document.getElementById('cfgBdayCashEnabled').checked;
  CONFIG.powerCardsEnabled = {
    shield: document.getElementById('cfgPowerShieldEnabled').checked,
    rentDoubler: document.getElementById('cfgPowerRentDoublerEnabled').checked,
    jailFree: document.getElementById('cfgPowerJailFreeEnabled').checked,
    teleport: document.getElementById('cfgPowerTeleportEnabled').checked,
    skipAhead: document.getElementById('cfgPowerSkipAheadEnabled').checked,
    propertyFreeze: document.getElementById('cfgPowerFreezeEnabled').checked,
    swap: document.getElementById('cfgPowerSwapEnabled').checked,
    propertySwap: document.getElementById('cfgPowerPropertySwapEnabled').checked,
    bankruptcyInsurance: document.getElementById('cfgPowerBankruptcyInsuranceEnabled').checked,
    doubleSalary: document.getElementById('cfgPowerDoubleSalaryEnabled').checked,
    loanForgiveness: document.getElementById('cfgPowerLoanForgivenessEnabled').checked,
    extraRoll: document.getElementById('cfgPowerExtraRollEnabled').checked,
    fastForward: document.getElementById('cfgPowerFastForwardEnabled').checked,
    stealCard: document.getElementById('cfgPowerStealCardEnabled').checked,
    sharedShield: document.getElementById('cfgPowerSharedShieldEnabled').checked,
    rally: document.getElementById('cfgPowerRallyEnabled').checked,
    pooledPayday: document.getElementById('cfgPowerPooledPaydayEnabled').checked,
    highRiseHustle: document.getElementById('cfgPowerHighRiseHustleEnabled').checked,
    sabotage: document.getElementById('cfgPowerSabotageEnabled').checked,
    nudge: document.getElementById('cfgPowerNudgeEnabled').checked,
    tollRefund: document.getElementById('cfgPowerTollRefundEnabled').checked,
    halfShield: document.getElementById('cfgPowerHalfShieldEnabled').checked,
    theft: document.getElementById('cfgPowerTheftEnabled').checked
  };
  const wOf = id => { const v = Math.max(0, parseInt(document.getElementById(id).value)); return Number.isFinite(v) ? v : 0; };
  CONFIG.powerCardWeights = {
    shield: wOf('cfgPowerShieldWeight'),
    rentDoubler: wOf('cfgPowerRentDoublerWeight'),
    jailFree: wOf('cfgPowerJailFreeWeight'),
    teleport: wOf('cfgPowerTeleportWeight'),
    skipAhead: wOf('cfgPowerSkipAheadWeight'),
    propertyFreeze: wOf('cfgPowerFreezeWeight'),
    swap: wOf('cfgPowerSwapWeight'),
    propertySwap: wOf('cfgPowerPropertySwapWeight'),
    bankruptcyInsurance: wOf('cfgPowerBankruptcyInsuranceWeight'),
    doubleSalary: wOf('cfgPowerDoubleSalaryWeight'),
    loanForgiveness: wOf('cfgPowerLoanForgivenessWeight'),
    extraRoll: wOf('cfgPowerExtraRollWeight'),
    fastForward: wOf('cfgPowerFastForwardWeight'),
    stealCard: wOf('cfgPowerStealCardWeight'),
    sharedShield: wOf('cfgPowerSharedShieldWeight'),
    rally: wOf('cfgPowerRallyWeight'),
    pooledPayday: wOf('cfgPowerPooledPaydayWeight'),
    highRiseHustle: wOf('cfgPowerHighRiseHustleWeight'),
    sabotage: wOf('cfgPowerSabotageWeight'),
    nudge: wOf('cfgPowerNudgeWeight'),
    tollRefund: wOf('cfgPowerTollRefundWeight'),
    halfShield: wOf('cfgPowerHalfShieldWeight'),
    theft: wOf('cfgPowerTheftWeight')
  };
  CONFIG.skipAheadSpaces = Math.min(39, Math.max(1, parseInt(document.getElementById('cfgSkipAheadSpaces').value) || 5));

  CONFIG.sideBetsEnabled = document.getElementById('cfgSideBetsEnabled').checked;

  CONFIG.speedX2Enabled = document.getElementById('cfgSpeedX2Enabled').checked;
  applySpeedUI();

  updateSpecialTileVisuals();
  // if a share code is already on screen, keep it in sync with the edited rules
  if(document.getElementById('startCodeOut').style.display !== 'none'){
    document.getElementById('startCodeField').value = encodeConfig(CONFIG);
  }
  // team mode may have just been switched on/off — reflect that in the lobby's
  // per-player team pickers right away instead of waiting on the next sync
  if(document.getElementById('lobbySection').style.display !== 'none') renderLobbyPlayers();
}

/* apply CONFIG, reset all game state, and reveal the board */
function beginGame(){
  if(NET.online){
    // belt-and-suspenders: the Start button is already disabled/hidden until this
    // is true (see updateLobbyStartBtnState/enterLobbyUI), but guard the function
    // itself too in case it's ever invoked another way.
    const activeIds=PLAYER_IDS.filter(pid=>players[pid].active);
    if(!activeIds.length || activeIds.some(pid=>!players[pid].ready)) return;
  }
  applyPlayerIdentity();
  unwireTeamBalances(); // in case a previous game this session left shared-balance getters in place
  PLAYER_IDS.filter(pid=>players[pid].active).forEach(pid=>{
    const p = players[pid];
    p.balance = CONFIG.startingCash;
    p.loan = 0;
    p.loanTermTurns = 0;
    p.pos = 0;
    p.inJail = false;
    p.jailTurns = 0;
    p.bankrupt = false;
    p.doublesCount = 0;
    p.skipNextTurn = false;
    p.rentDoublerCharges = 0;
    p.wantsRematch = false;
    p.jailFreeCards = 0;
    p.shieldCharges = 0;
    p.teleportCards = 0;
    p.skipAheadCards = 0;
    p.propertyFreezeCards = 0;
    p.swapCards = 0;
    p.propertySwapCards = 0;
    p.bankruptcyInsuranceCharges = 0;
    p.fastForwardCards = 0;
    p.sharedShieldCharges = 0;
    p.extraRollCredits = 0;
    p.pooledPaydayCards = 0;
    p.highRiseHustleCards = 0;
    p.loanForgivenessCards = 0;
    p.sabotageCards = 0;
    p.halfShieldCharges = 0;
    p.halfShieldArmed = false;
    p.lastRentPaid = 0;
    p.shieldArmed = false;
    p.rentDoublerGroup = null;
    p.doubleSalaryCards = 0;
    p.sharedShieldArmed = false;
    p.pooledPaydayArmed = false;
    const cardEl = document.getElementById('card-'+pid);
    if(cardEl) cardEl.style.opacity = '';
  });
  bailoutPot = 0;
  turnRollSeq = 0;
  updateBailoutPotLabel();
  syncTokenVisibility();
  updateSpecialTileVisuals(); // reflect this game's Lucky Wheel/Happy Birthday mode (e.g. from a joined invite code)
  tiles.forEach((t,i)=>{
    if(purchasable(t)){
      t.owner = null;
      t.houses = 0;
      t.mortgaged = false;
      t.frozenTurns = 0;
      clearOwnershipRing(i);
      setFrozenVisual(i, false);
    }
  });
  order = PLAYER_IDS.filter(pid=>players[pid].active&&!players[pid].bankrupt);
  turnIdx = 0;
  recordNetWorthSnapshot(null); // starting balances, before anyone's taken a turn
  updateGameOverBtn();
  __lastTurnSoundPid = null; // fresh game — let the first turn chime too
  __lastCameraPid = null; // ...and let the first camera pulse fire too
  busy = false;
  awaitingEndTurn = false;
  gameOver = false;
  gameWinnerId = null;
  netWorthHistory = [];
  gameStats = {
    rentPaid: {}, rentCollected: {}, biggestRent: null,
    tileLandings: {}, doublesRolled: {}, jailVisits: {}, housesBuilt: {},
    goSalary: {}, tradesCompleted: 0, auctionsWon: {}, bankruptciesCaused: {},
  };
  currentRollWasDouble = false;
  pendingBuy = null;
  pendingBuyout = null;
  pendingDebt = null;
  teleportPickMode = false;
  sabotagePickMode = false;
  propertySwapPick = null;
  stealCardPick = null;
  if(auction && auction.interval) clearInterval(auction.interval);
  auction = null;
  activeTrades = [];
  updateTradesTabCount();
  sideBets = [];

  const p0 = tileEls[0];
  order.forEach((pid,i)=>{const c=tileEls[0],a=(i/Math.max(1,order.length))*Math.PI*2;setTokenPos(pid,c.x+Math.cos(a)*12,c.y-4+Math.sin(a)*5,{instant:true,hop:false});});

  document.getElementById('rollBtn').disabled = false;
  document.getElementById('buyPanel').classList.remove('show');
  document.getElementById('buyoutPanel').classList.remove('show');
  document.getElementById('managePanel').classList.remove('show');
  document.getElementById('auctionPanel').classList.remove('show');
  document.getElementById('loanPanel').classList.remove('show');
  document.getElementById('auctionOverlay').classList.remove('show');
  switchTab('history');

  document.getElementById('startOverlay').classList.add('hide');
  document.getElementById('gameRoot').style.display = '';
  // the board's text was first measured while #gameRoot was still display:none, so every
  // getComputedTextLength() call returned 0 and the fit/wrap/shrink logic never actually
  // engaged — that's what let long names spill past their tile onto the next one. Now
  // that the board is actually laid out and visible, redo that pass with real widths.
  fitAllTileLabels();
  // same problem hits measureTileScreenCenters(): its very first run (at script load)
  // also happened while #gameRoot was display:none, so every tile measured as 0x0 and
  // every token collapsed onto the same {x:0,y:0} point. Redo it now that the board has
  // real layout, and re-seat each token on its actual tile.
  resetView();

  const ruleNotes = [];
  if(CONFIG.auctionFunMode) ruleNotes.push('auction-only mode');
  else if(CONFIG.auctionOnDecline) ruleNotes.push('declined buys go to auction');
  if(CONFIG.noRentInJail) ruleNotes.push('no rent while owner is jailed');
  if(!CONFIG.doubleRentFullSet) ruleNotes.push('no double rent on full sets');
  if(!CONFIG.requireFullSetToBuild) ruleNotes.push('building without full sets allowed');
  if(CONFIG.evenBuildRule) ruleNotes.push('even building enforced');
  if(CONFIG.buyoutEnabled) ruleNotes.push(`buyouts at ${CONFIG.buyoutMultiplier}&times; price${CONFIG.buyoutAnywhere?' (anytime)':''}`);

  log(`New game — starting cash $${fmt(CONFIG.startingCash)}, GO salary $${fmt(CONFIG.salary)}, jail bail $${fmt(CONFIG.bail)}${CONFIG.loansEnabled ? `, bank loans up to $${fmt(CONFIG.loanLimit)} at ${CONFIG.loanInterestPct}% interest` : ' — bank loans off'}.`, '🆕');
  if(ruleNotes.length) log(`House rules in play: ${ruleNotes.join(', ')}.`, '📋');
  refreshUI();
}
function showStartOverlay(){
  setAutoPlayEnabled(false); // don't carry "auto" into the next game/lobby unannounced
  clearTurnTimerTimeout();
  turnTimerActiveId = null;
  turnTimerPaused = false;
  stopTurnTimerVisual();
  document.getElementById('gameRoot').style.display = 'none';
  document.getElementById('startOverlay').classList.remove('hide');
  document.getElementById('startCodeOut').style.display = 'none';
  document.getElementById('startCodeField').value = '';
  document.getElementById('joinCodeField').value = '';
}

