/* ============ POWER CARDS + LUCKY WHEEL/BIRTHDAY CARD REVEAL ============

   Split out of game.js: the power-card system (card defs, granting,
   eligibility checks, the Cards tray/hub UI) and the on-board reveal
   popup for a drawn Lucky Wheel or Happy Birthday card. Does NOT include
   the turn engine itself (rollDice/moveToken/resolveTile, which decide
   *when* a card gets drawn) — that's core gameplay and stays in game.js;
   this file only owns what a drawn card IS and how it's shown/spent.

   Plain global script, not a module, like every other file here — it
   must load BEFORE game.js, since game.js's resolveTile() calls into
   grantPowerCard()/showCardDraw() declared below when a player lands on
   a wheel/gift tile. */
/* ============ POWER CARDS ============
   A rarer draw mixed into the Lucky Wheel tile (see CONFIG.luckyWheelPowerOnly) —
   these don't resolve instantly like the cash events above. Each one either
   sets a passive charge that silently modifies a later game event (rentDoubler,
   shield) or adds a card to the player's hand that they choose when to spend
   (jailFree, teleport, propertyFreeze, swap). All six charge counts live directly
   on the player object (rentDoublerCharges/jailFreeCards/shieldCharges/
   teleportCards/propertyFreezeCards/swapCards), so they ride along for free in
   serializeState()/restoreState() like every other player field — no separate
   sync path needed. */
const POWER_CARDS = [
  {type:'rentDoubler', glyph:'\u{1F4B0}', title:'RENT DOUBLER', text:'Doubles the next rent you collect from an opponent.'},
  {type:'jailFree',     glyph:'\u{1F513}', title:'GET OUT OF JAIL FREE', text:'Fires automatically the moment you\u2019d be sent to jail — walks you right past it, no bail needed.'},
  {type:'teleport',     glyph:'\u{1F300}', title:'TELEPORT', text:'Play it on your turn to warp your token to any tile.'},
  {type:'shield',       glyph:'\u{1F6E1}\uFE0F', title:'PROPERTY SHIELD', text:'Blocks the next rent charged to you.'},
  {type:'propertyFreeze', glyph:'\u2744\uFE0F', title:'PROPERTY FREEZE', text:"Play it on your turn to freeze ALL of one opponent's properties — no building, selling, mortgaging, or rent from any of them for their next turn."},
  {type:'swap',         glyph:'\u{1F500}', title:'SWAP', text:'Play it on your turn to swap board positions with another player.'},
  {type:'skipAhead', glyph:'\u23ED\uFE0F', title:'SKIP AHEAD', text:'Instantly jumps your token forward a fixed number of spaces the moment you draw it, with the same GO salary as a normal move if you pass or land on it.'},
  {type:'propertySwap', glyph:'\u{1F504}', title:'PROPERTY SWAP', text:"Play it on your turn to trade one of your unbuilt properties for an unbuilt property of your choice from another player."},
  {type:'bankruptcyInsurance', glyph:'\u{1F4B8}', title:'BANKRUPTCY INSURANCE', text:"The instant you go negative, wipes your debt and brings you back to $0."},
  {type:'doubleSalary', glyph:'\u{1F4B5}', title:'DOUBLE SALARY', text:'Doubles your very next GO payday.'},
  {type:'loanForgiveness', glyph:'\u{1F3E6}', title:'LOAN FORGIVENESS', text:'Sits in your hand until you have an active bank loan, then instantly wipes it out — you don\u2019t choose when.'},
  {type:'extraRoll', glyph:'\u{1F501}', title:'EXTRA ROLL', text:'Instantly rolls the dice again for you.'},
  {type:'fastForward', glyph:'\u23E9', title:'FAST FORWARD', text:"Instantly cancels your next Bailout skip, or breaks you out of jail completely."},
  {type:'stealCard', glyph:'\u{1F3B4}', title:'STEAL A CARD', text:"Instantly steals a held power card from another player of your choice."},
  {type:'sharedShield', glyph:'\u{1F91D}', title:'SHARED SHIELD', text:"Blocks the next rent charged to ANY teammate, not just you. Team mode only.", teamOnly:true},
  {type:'rally', glyph:'\u{1F4E3}', title:'RALLY', text:"Instantly gives every teammate (including you) one extra roll on their next turn. Team mode only.", teamOnly:true},
  {type:'pooledPayday', glyph:'\u{1F4B8}', title:'POOLED PAYDAY', text:"Doubles the whole team's rent income until your next turn comes back around. Team mode only.", teamOnly:true},
  {type:'highRiseHustle', glyph:'\u{1F3D9}\uFE0F', title:'DISCOUNT', text:"Your next house or hotel purchase (any level) is 50% off — applies automatically the moment you build, no need to play it by hand."},
  {type:'sabotage', glyph:'\u{1F5E1}\uFE0F', title:'SABOTAGE', text:"Play it on your turn to freeze an entire opposing team's property group at once — no building, selling, mortgaging, or rent from any tile in it, for their next turn. Team mode only.", teamOnly:true},
  // ---- weaker "filler" cards: deliberately low-impact so the big swings above
  // (Sabotage, Bankruptcy Insurance, Steal a Card, Property Freeze, ...) feel
  // like the jackpot they're supposed to be. Kept common via a higher default
  // draw weight in CONFIG.powerCardWeights rather than by adding any new
  // mechanics — see the comment there.
  {type:'nudge', glyph:'\u{1F449}', title:'NUDGE', text:'Play it on your turn to nudge your token 1–3 spaces forward or backward, then resolve wherever you land.'},
  {type:'tollRefund', glyph:'\u{1F9FE}', title:'TOLL REFUND', text:'Instantly refunds the last rent you paid, if any.'},
  {type:'halfShield', glyph:'\u{1F530}', title:'HALF SHIELD', text:'Blocks half (rounded down) of the next rent charged to you.'},
  {type:'theft', glyph:'\u{1FA99}', title:'THEFT', text:'Instantly steals 10% of the richest other player\u2019s cash.'},
];
/* maps each POWER_CARDS type to the player-object field that holds its count —
   shared by grantPowerCard() below, the power-cards hub, card trading, and
   card auctions, so there's exactly one place that knows the field names.
   Instant-fire cards (extraRoll, skipAhead, stealCard, rally) are intentionally
   left out — they never sit in a player's hand, so they're never "owned" for
   hub/trade/auction purposes. doubleSalary and loanForgiveness used to be instant
   too, but now sit in hand (like Bankruptcy Insurance) until their trigger
   condition happens, so they can be traded like every other held card. */
const CARD_FIELD = {rentDoubler:'rentDoublerCharges', jailFree:'jailFreeCards', teleport:'teleportCards', shield:'shieldCharges', propertyFreeze:'propertyFreezeCards', swap:'swapCards', propertySwap:'propertySwapCards', bankruptcyInsurance:'bankruptcyInsuranceCharges', fastForward:'fastForwardCards', sharedShield:'sharedShieldCharges', pooledPayday:'pooledPaydayCards', highRiseHustle:'highRiseHustleCards', sabotage:'sabotageCards', nudge:'nudgeCards', halfShield:'halfShieldCharges', doubleSalary:'doubleSalaryCards', loanForgiveness:'loanForgivenessCards'};
function grantPowerCard(player, card){
  if(card.type==='rentDoubler') player.rentDoublerCharges = (player.rentDoublerCharges||0) + 1;
  else if(card.type==='jailFree') player.jailFreeCards = (player.jailFreeCards||0) + 1;
  else if(card.type==='teleport') player.teleportCards = (player.teleportCards||0) + 1;
  else if(card.type==='shield') player.shieldCharges = (player.shieldCharges||0) + 1;
  else if(card.type==='propertyFreeze') player.propertyFreezeCards = (player.propertyFreezeCards||0) + 1;
  else if(card.type==='swap') player.swapCards = (player.swapCards||0) + 1;
  else if(card.type==='skipAhead'){
    // instant, like Extra Roll — doesn't set any charge on the player object at
    // all. The draw site (resolveTile's wheel/gift branches) sees
    // card.type==='skipAhead' and jumps the token forward itself, right away.
  }
  else if(card.type==='bankruptcyInsurance') player.bankruptcyInsuranceCharges = (player.bankruptcyInsuranceCharges||0) + 1;
  else if(card.type==='doubleSalary') player.doubleSalaryCards = (player.doubleSalaryCards||0) + 1; // sits in hand — auto-consumed the next time this player passes/lands on GO (see moveToken()), never played by hand, but tradeable like any other held card
  else if(card.type==='fastForward') player.fastForwardCards = (player.fastForwardCards||0) + 1;
  else if(card.type==='sharedShield') player.sharedShieldCharges = (player.sharedShieldCharges||0) + 1;
  else if(card.type==='rally'){
    // instant, team-wide — like Property Swap/Steal a Card it resolves right
    // here with no held card, but unlike either it doesn't need a pick: it
    // just credits every currently active, non-bankrupt teammate (including
    // the drawer) with one banked extra roll apiece, to be cashed in on each
    // of their own next turns (see finishTurnStep(), which spends a credit
    // the same way a rolled double grants another roll). Team mode only, and
    // wasted outright if the drawer isn't actually paired with anyone active
    // right now — a lone player "rallying" nobody is just a plain Extra Roll.
    const mates = teammatesOf(player.id, true).filter(id=>players[id] && players[id].active && !players[id].bankrupt);
    if(teamOf(player.id) && mates.length>1){
      mates.forEach(id=>{ players[id].extraRollCredits = (players[id].extraRollCredits||0) + 1; });
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Rally</b> — every teammate banks an extra roll for their next turn!`);
    } else {
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Rally</b> with no team to rally — wasted.`);
    }
  }
  // extraRoll is instant, like doubleSalary/loanForgiveness — it doesn't set any
  // charge on the player object at all. The draw site (resolveTile's wheel/gift
  // branches) sees card.type==='extraRoll' and triggers the reroll itself.
  else if(card.type==='loanForgiveness'){
    // sits in hand, tradeable, like Bankruptcy Insurance — fires the instant the holder
    // has an active bank loan (right now if they already owe one, otherwise the next
    // time they borrow — see tryAutoFireLoanForgiveness(), called from here, from
    // borrowLoan(), and from finalizeAcceptedTrade() so a traded-in card that lands on
    // an already-indebted player activates immediately too).
    player.loanForgivenessCards = (player.loanForgivenessCards||0) + 1;
    tryAutoFireLoanForgiveness(player);
  }
  else if(card.type==='propertySwap') player.propertySwapCards = (player.propertySwapCards||0) + 1;
  else if(card.type==='stealCard'){
    // instant, like Loan Forgiveness/Double Salary — needs the player to pick a
    // target card before it can resolve, so it hands off to its own pending-pick state
    // (stealCardPick, see resolveStealCardPick()/syncStealCardOverlay()) that
    // pauses the turn until a choice is made. Wasted outright if nobody else
    // is holding any power card at all.
    if(stealCardEligible(player.id)){
      stealCardPick = {pid: player.id};
    } else {
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Steal a Card</b> with nobody holding a card to take — wasted.`);
    }
  }
  else if(card.type==='pooledPayday') player.pooledPaydayCards = (player.pooledPaydayCards||0) + 1;
  else if(card.type==='highRiseHustle') player.highRiseHustleCards = (player.highRiseHustleCards||0) + 1;
  else if(card.type==='sabotage') player.sabotageCards = (player.sabotageCards||0) + 1;
  else if(card.type==='nudge') player.nudgeCards = (player.nudgeCards||0) + 1;
  else if(card.type==='halfShield') player.halfShieldCharges = (player.halfShieldCharges||0) + 1;
  else if(card.type==='tollRefund'){
    // instant, like Loan Forgiveness — resolves right here instead of sitting in hand.
    // player.lastRentPaid is stamped every time this player actually pays rent
    // (see the rent-resolution block in resolveTile) and cleared right back to 0
    // the moment it's refunded, so two Toll Refund draws in a row without paying
    // any rent in between only ever pay out once.
    const owed = player.lastRentPaid||0;
    if(owed>0){
      player.balance += owed;
      player.lastRentPaid = 0;
      log(`<span class="who" style="color:${player.color}">${player.name}</span>'s <b>Toll Refund</b> gives back the $${fmt(owed)} rent they last paid!`);
    } else {
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Toll Refund</b> with no rent paid recently — wasted.`);
    }
  }
  else if(card.type==='theft'){
    // instant — takes 10% (rounded down) of the richest OTHER active,
    // non-bankrupt, non-teammate player's cash. Wasted if there's nobody
    // eligible, or the richest eligible player is flat broke.
    const targets = PLAYER_IDS.filter(id=>id!==player.id && players[id] && players[id].active && !players[id].bankrupt && !sameTeam(player.id,id));
    const richestId = targets.reduce((best,id)=> (!best || players[id].balance>players[best].balance) ? id : best, null);
    if(richestId){
      const victim = players[richestId];
      const amt = Math.max(0, Math.floor(victim.balance*0.1));
      if(amt>0){
        victim.balance -= amt;
        player.balance += amt;
        log(`<span class="who" style="color:${player.color}">${player.name}</span>'s <b>Theft</b> swipes $${fmt(amt)} (10%) from <span class="who" style="color:${victim.color}">${victim.name}</span>, the richest player!`);
      } else {
        log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Theft</b> — the richest player has nothing worth taking — wasted.`);
      }
    } else {
      log(`<span class="who" style="color:${player.color}">${player.name}</span> draws <b>Theft</b> with no one to steal from — wasted.`);
    }
  }
}
/* Fires a held Loan Forgiveness the instant its holder actually has an active bank
   loan — the card never gets a manual "Use" button (see powerCardUsable/POWER_CARD_USE_FN),
   it just waits in hand until this condition is true. Called right after a card is
   granted (in case the drawer already owes a loan), from borrowLoan() (in case they take
   out a new loan while already holding one), and from finalizeAcceptedTrade() (in case a
   traded-in card lands on a player who's already indebted). No-op if the holder has no
   charge or no loan right now — safe to call speculatively from anywhere. */
function tryAutoFireLoanForgiveness(player){
  if(!player || !(player.loanForgivenessCards>0) || !(player.loan>0)) return;
  const owed = player.loan;
  player.loanForgivenessCards--;
  player.loan = 0;
  player.loanTermTurns = 0;
  log(`<span class="who" style="color:${player.color}">${player.name}</span>'s <b>Loan Forgiveness</b> wipes out the $${fmt(owed)} still owed on their bank loan!`);
  showCardDraw({id:++cardDrawSeq, kind:'power', glyph:'\u{1F3E6}', title:'LOAN FORGIVENESS USED', who:player.name, text:`Loan Forgiveness cancelled $${fmt(owed)} of bank loan.`});
  playCardPopupSound();
  if(cardDrawTimer) clearTimeout(cardDrawTimer);
  cardDrawTimer = setTimeout(()=>{ cardDrawTimer = null; hideCardDraw(); }, CARD_DRAW_MS);
  refreshUI();
}
/* Property Swap is only "fair" when both sides of the trade are the same kind of
   property: a country tile (has a .group) can only go for another country tile,
   and a railroad/utility ("other" — no .group) can only go for another railroad/
   utility. Used by propertySwapEligible below and by every stage-'theirs' filter
   in the picker (resolvePropertySwapPick, refreshPropertySwapPanelIfOpen,
   updatePropertySwapBoardHighlights) so all three agree on what's a legal pair. */
function psCategory(t){ return t.group ? 'country' : 'other'; }
/* true only when BOTH sides of a Property Swap actually have something to trade:
   the drawing player owns at least one unbuilt (0-house) tile, and at least one
   other active player owns an unbuilt tile of the SAME category (country vs.
   railroad/utility) as one of the drawing player's own unbuilt tiles — a player
   who only holds countries can't swap for a railroad, and vice versa. */
/* true only when BOTH sides of a Property Swap actually have something to trade:
   the drawing player owns at least one property with no building anywhere in its
   group, and at least one other active player owns a similarly unbuilt tile of the
   SAME category (country vs. railroad/utility) as one of the drawing player's own —
   a player who only holds countries can't swap for a railroad, and vice versa. */
function propertySwapEligible(pid){
  const mine = tiles.filter(t=>ownedByUnit(t,pid) && !groupHasBuilding(t)); // IN TEAMS: a teammate's unbuilt tile counts as "mine" to give up
  if(!mine.length) return false;
  const myCats = new Set(mine.map(psCategory));
  return tiles.some(t=>t.owner && !sameTeam(t.owner,pid) && !groupHasBuilding(t) && myCats.has(psCategory(t)));
}
/* true only when at least one OTHER active, non-bankrupt player is holding at
   least one power card of any held type (see CARD_FIELD) — a Steal a Card
   draw is wasted outright, same as Property Swap with nothing to trade, when
   nobody else has a card to take. */
function stealCardEligible(pid){
  return PLAYER_IDS.some(id=>id!==pid && players[id] && players[id].active && !players[id].bankrupt &&
    Object.values(CARD_FIELD).some(field=>(players[id][field]||0)>0));
}
/* true if pid is currently on an active team (teams mode on, paired with at
   least one other active player) AND no one on that team already has a
   Shared Shield armed — used to gate both drawability-in-hub display and
   the actual "Use" button, so you can never stack two active team shields. */
function sharedShieldUsable(pid){
  if(!CONFIG.teamsEnabled || !teamOf(pid)) return false;
  // .active alone doesn't mean "still in the game" — doBankrupt() never clears it,
  // only a real disconnect does (see finalizeDisconnect/kick/lobby-leave). Every
  // other team-roster check in this file pairs active with !bankrupt for exactly
  // that reason (stealCardEligible, auctionEligible, tradeActiveVoters, doBankrupt's
  // own `unit` calc); this one and its two siblings below were missing it, which let
  // a team keep benefiting from a bankrupt (and thus permanently unconsumed) armed
  // Shared Shield/Pooled Payday forever.
  return !teammatesOf(pid,true).some(id=>players[id] && !players[id].bankrupt && players[id].sharedShieldArmed);
}
/* the teammate (including pid) currently holding an armed Shared Shield, if
   any — null when none is armed or teams are off. Used at rent-resolution
   time to find and consume the charge on whichever teammate actually armed
   it, since arming and paying rent can happen on two different players'
   turns. */
function armedSharedShielder(pid){
  if(!CONFIG.teamsEnabled) return null;
  const id = teammatesOf(pid,true).find(id=>players[id] && !players[id].bankrupt && players[id].sharedShieldArmed);
  return id ? players[id] : null;
}
/* the teammate (including pid) currently holding an armed Pooled Payday, if
   any — null when none is armed or teams are off. Unlike Shared Shield this
   is NOT consumed the moment it does something: like Rent Doubler it keeps
   doubling every rent the team collects until the armer's own next turn
   comes back around (see advanceTurn()), so it's just a lookup, never
   cleared here. */
function armedPooledPaydayForTeam(pid){
  if(!CONFIG.teamsEnabled) return null;
  const id = teammatesOf(pid,true).find(id=>players[id] && !players[id].bankrupt && players[id].pooledPaydayArmed);
  return id ? players[id] : null;
}
/* Picks one power card type, respecting the per-type enable toggles and draw
   weights set in the Cards & Power-ups config section. Falls back to a plain
   uniform pick among whatever's enabled if the weights are all zero/missing,
   and returns null if every power card type has been switched off (the wheel
   landing then just falls through to a normal cash event). */
function pickPowerCard(){
  // teamOnly cards (Shared Shield, currently) can only ever be drawn in an
  // active alliance game — filtered out here regardless of their own
  // enable/weight toggle so a leftover "on" toggle from a past team game
  // can't leak one into a solo/non-team game.
  const enabled = POWER_CARDS.filter(c => CONFIG.powerCardsEnabled?.[c.type] !== false && (!c.teamOnly || CONFIG.teamsEnabled));
  if(!enabled.length) return null;
  const weights = enabled.map(c => Math.max(0, Number(CONFIG.powerCardWeights?.[c.type]) || 0));
  const total = weights.reduce((a,b)=>a+b, 0);
  if(total <= 0) return enabled[Math.floor(Math.random()*enabled.length)];
  let r = Math.random()*total;
  for(let i=0;i<enabled.length;i++){ r -= weights[i]; if(r<=0) return enabled[i]; }
  return enabled[enabled.length-1];
}
/* Title-cases a POWER_CARDS title ("GET OUT OF JAIL FREE" -> "Get Out of
   Jail Free") for use in prose descriptions, keeping small joining words
   lowercase (unless they're the first word). */
const POWER_CARD_SMALL_WORDS = new Set(['a','an','of','the','to','in','on','for']);
function titleCasePowerCardTitle(title){
  return title.toLowerCase().split(' ').map((w,i)=>{
    const cased = (i>0 && POWER_CARD_SMALL_WORDS.has(w)) ? w : w.charAt(0).toUpperCase()+w.slice(1);
    return cased.replace(/-([a-z])/g, (_,c)=>'-'+c.toUpperCase()); // "high-rise" -> "High-Rise"
  }).join(' ');
}
/* Comma-separated, human-readable list of every power card type that could
   actually come out of a power-only Lucky Wheel/Happy Birthday landing right
   now — mirrors pickPowerCard()'s own enabled/team-only filtering exactly, so
   the tile-info popup can never drift out of sync with what's really in the
   draw pool (the old copy hardcoded a fixed 6-card list that undersold how
   many card types — up to 19, more with teams on — can actually be drawn,
   and didn't shrink to match cards a host had disabled). */
function enabledPowerCardList(){
  const enabled = POWER_CARDS.filter(c => CONFIG.powerCardsEnabled?.[c.type] !== false && (!c.teamOnly || CONFIG.teamsEnabled));
  if(!enabled.length) return 'nothing — every power card type is currently disabled';
  const names = enabled.map(c=>titleCasePowerCardTitle(c.title));
  if(names.length===1) return names[0];
  return names.slice(0,-1).join(', ') + ', or ' + names[names.length-1];
}
/* small always-visible badge row on every player's roster card (own AND
   opponents') showing which power cards they're currently holding — lets
   everyone see e.g. that an opponent has a Shield in hand before deciding
   whether to trade with or attack them. Purely cosmetic/read-only; the
   actual "use" buttons only ever appear on the holder's own turn (see
   jailFreeBtn/teleportBtn in refreshUI). */
function renderPowerBadges(pid, p){
  const el = document.getElementById('powerBadges-'+pid);
  if(!el) return;
  const items = [
    p.rentDoublerCharges>0 ? {glyph:'\u{1F4B0}', n:p.rentDoublerCharges, title:'Rent Doubler'} : null,
    p.jailFreeCards>0 ? {glyph:'\u{1F513}', n:p.jailFreeCards, title:'Get Out of Jail Free'} : null,
    p.teleportCards>0 ? {glyph:'\u{1F300}', n:p.teleportCards, title:'Teleport'} : null,
    p.shieldCharges>0 ? {glyph:'\u{1F6E1}\uFE0F', n:p.shieldCharges, title:'Property Shield'} : null,
    p.propertyFreezeCards>0 ? {glyph:'\u2744\uFE0F', n:p.propertyFreezeCards, title:'Property Freeze'} : null,
    p.swapCards>0 ? {glyph:'\u{1F500}', n:p.swapCards, title:'Swap'} : null,
    p.bankruptcyInsuranceCharges>0 ? {glyph:'\u{1F4B8}', n:p.bankruptcyInsuranceCharges, title:'Bankruptcy Insurance'} : null,
    p.fastForwardCards>0 ? {glyph:'\u23E9', n:p.fastForwardCards, title:'Fast Forward'} : null,
    p.sharedShieldCharges>0 ? {glyph:'\u{1F91D}', n:p.sharedShieldCharges, title:'Shared Shield (team mode)'} : null,
    p.extraRollCredits>0 ? {glyph:'\u{1F4E3}', n:p.extraRollCredits, title:'Rally bonus roll(s) banked for their next turn'} : null,
    p.pooledPaydayCards>0 ? {glyph:'\u{1F4B8}', n:p.pooledPaydayCards, title:'Pooled Payday (team mode)'} : null,
    p.highRiseHustleCards>0 ? {glyph:'\u{1F3D9}\uFE0F', n:p.highRiseHustleCards, title:'Discount — next house/hotel purchase 50% off'} : null,
    p.sabotageCards>0 ? {glyph:'\u{1F5E1}\uFE0F', n:p.sabotageCards, title:'Sabotage (team mode)'} : null,
    p.nudgeCards>0 ? {glyph:'\u{1F449}', n:p.nudgeCards, title:'Nudge'} : null,
    p.halfShieldCharges>0 ? {glyph:'\u{1F530}', n:p.halfShieldCharges, title:'Half Shield'} : null,
    p.doubleSalaryCards>0 ? {glyph:'\u{1F4B5}', n:p.doubleSalaryCards, title:'Double Salary — fires on their next GO payday'} : null,
    p.loanForgivenessCards>0 ? {glyph:'\u{1F3E6}', n:p.loanForgivenessCards, title:'Loan Forgiveness — fires the moment they owe a bank loan'} : null,
  ].filter(Boolean);
  el.innerHTML = items.map(it=>
    `<span title="${it.title}" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(255,255,255,.08);border:1px solid var(--line);border-radius:999px;padding:1px 6px;">${it.glyph}${it.n>1?`&times;${it.n}`:''}</span>`
  ).join('') + [
    p.shieldArmed ? `<span title="Property Shield is active for the rest of this turn" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(127,196,255,.16);border:1px solid rgba(127,196,255,.5);border-radius:999px;padding:1px 6px;">\u{1F6E1}\uFE0F armed</span>` : '',
    p.rentDoublerGroup ? `<span title="Rent from ${escapeHtml(doublerGroupLabel(p.id,p.rentDoublerGroup))} is doubled until their next turn" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(255,211,127,.16);border:1px solid rgba(255,211,127,.5);border-radius:999px;padding:1px 6px;">\u{1F4B0} doubled: ${escapeHtml(doublerGroupLabel(p.id,p.rentDoublerGroup))}</span>` : '',
    p.sharedShieldArmed ? `<span title="Shared Shield is up for the whole team, until it blocks a rent payment" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(139,92,246,.16);border:1px solid rgba(139,92,246,.5);border-radius:999px;padding:1px 6px;">\u{1F91D} team armed</span>` : '',
    p.pooledPaydayArmed ? `<span title="Pooled Payday is doubling the whole team's rent until their next turn" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(255,196,64,.16);border:1px solid rgba(255,196,64,.5);border-radius:999px;padding:1px 6px;">\u{1F4B8} team armed</span>` : '',
    p.halfShieldArmed ? `<span title="Half Shield is active for the rest of this turn" style="display:inline-flex;align-items:center;gap:2px;font-size:11px;background:rgba(127,196,255,.16);border:1px solid rgba(127,196,255,.5);border-radius:999px;padding:1px 6px;">\u{1F530} armed</span>` : '',
  ].join('');
}

/* ============ POWER CARDS HUB ============
   A single consolidated place to see every power card type — owned or not,
   with a plain-English description — and to use or auction whichever
   one you're holding, instead of hunting down a scattered per-card button.
   (Offering a card in a trade used to be possible from here too, but that
   path into the trade system was pulled.)
   Uses the same instant-use functions (useShieldCard/useJailFreeCard/etc.)
   that used to live behind their own roll-btn's, so all the existing
   validation, logging, and online host/guest command routing (see ACTIONS)
   keeps working unchanged. */
/* Read-only viewer for another player's held power cards — separate render
   path from renderPowerCardsHub() (which is always about your own turn/cards)
   so viewing an opponent's hand can never accidentally expose a "Use" button
   for a card you don't own. Reuses the same overlay/body elements; closePowerCards()
   clears viewingOpponentPid so the next openPowerCards() call renders your own
   cards again as normal. */
let viewingOpponentPid = null;
function viewOpponentCards(pid){
  if(NET.online && !NET.host && NET.isSpectator) return;
  if(!players[pid]) return;
  if(pid===youAre){ openPowerCards(); return; } // clicking your own badges just opens your normal Cards hub
  viewingOpponentPid = pid;
  renderOpponentCardsReadOnly(pid);
  document.getElementById('powerCardsOverlay').classList.add('show');
}
function renderOpponentCardsReadOnly(pid){
  const body = document.getElementById('powerCardsBody');
  if(!body) return;
  const target = players[pid];
  if(!target){ closePowerCards(); return; }
  const owned = POWER_CARDS.filter(def => (target[CARD_FIELD[def.type]]||0) > 0);
  const hintHTML = `<div class="pc-hint">Read-only — showing what <b style="color:${target.color}">${escapeHtml(target.name)}</b> is currently holding. You can still offer to trade for any of these from the Trade panel.</div>`;
  if(!owned.length){
    body.innerHTML = hintHTML + `<div class="pc-empty-note">${escapeHtml(target.name)} isn't holding any cards right now.</div>`;
    return;
  }
  body.innerHTML = hintHTML + owned.map(def=>{
    const count = target[CARD_FIELD[def.type]]||0;
    return `<div class="pc-card owned">
      <div class="pc-card-head"><span class="pc-glyph">${def.glyph}</span><span class="pc-title">${def.title}</span><span class="pc-count">&times;${count}</span></div>
      <div class="pc-desc">${def.text}</div>
    </div>`;
  }).join('');
}
function openPowerCards(){
  if(NET.online && !NET.host && NET.isSpectator) return;
  viewingOpponentPid = null; // opening your own Cards button always shows your own hand, even if you were mid-viewing someone else's
  powerCardsShowAll = false; // always open back on "cards you own", regardless of how it was left last time
  renderPowerCardsHub();
  document.getElementById('powerCardsOverlay').classList.add('show');
}
function togglePowerCardsShowAll(){
  powerCardsShowAll = !powerCardsShowAll;
  renderPowerCardsHub();
}
function closePowerCards(){
  viewingOpponentPid = null;
  document.getElementById('powerCardsOverlay').classList.remove('show');
}
/* true if the player already has ANY of the tap-a-tile pick modes open
   (Teleport, Property Freeze, Sabotage, Property Swap). Cards that need a
   board tap to resolve must never be allowed to stack — the tile click
   handler only checks them in one fixed priority order, so a second mode
   opened on top of a first just gets stuck active in the background,
   silently eating tile clicks meant for the first mode (or for ordinary
   "show tile info" clicks) until someone notices and cancels it. */
function anyPickModeActive(){
  return teleportPickMode || sabotagePickMode || !!propertySwapPick;
}
/* whether the card the hub is showing can actually be used right now — mirrors
   the same conditions the old individual buttons used to gate on. */
function powerCardUsable(type, player, isYourTurn){
  if(!player || gameOver || !isYourTurn) return false;
  if((player[CARD_FIELD[type]]||0) <= 0) return false;
  if(type==='shield') return !busy && !awaitingEndTurn && !player.shieldArmed;
  if(type==='rentDoubler') return !busy && !player.rentDoublerGroup;
  if(type==='teleport') return !busy && !anyPickModeActive();
  if(type==='propertyFreeze') return !busy; // targets a player from a dropdown, same as Swap — no board pick mode to guard against
  if(type==='swap') return !busy; // playable from jail on purpose — swapping springs you out
  if(type==='sharedShield') return !busy && !awaitingEndTurn && sharedShieldUsable(player.id);
  if(type==='pooledPayday') return !busy && !player.pooledPaydayArmed;
  if(type==='sabotage') return !busy && !anyPickModeActive();
  if(type==='propertySwap') return !busy && !anyPickModeActive() && propertySwapEligible(player.id);
  if(type==='nudge') return !busy;
  if(type==='halfShield') return !busy && !awaitingEndTurn && !player.halfShieldArmed;
  return false; // bankruptcyInsurance/extraRoll/fastForward/skipAhead/tollRefund/theft are never manually played — they fire on their own
}
function updatePowerCardsButton(){
  const el = document.getElementById('powerCardsBtnLabel');
  if(!el) return;
  const p = players[youAre];
  const total = p ? POWER_CARDS.reduce((s,def)=>s+(p[CARD_FIELD[def.type]]||0),0) : 0;
  el.textContent = total>0 ? `Cards (${total})` : 'Cards';
}
function refreshPowerCardsIfOpen(){
  const ov = document.getElementById('powerCardsOverlay');
  if(!ov || !ov.classList.contains('show')) return;
  if(viewingOpponentPid) renderOpponentCardsReadOnly(viewingOpponentPid);
  else renderPowerCardsHub();
}
const POWER_CARD_USE_FN = {rentDoubler:'useRentDoublerCard', teleport:'useTeleportCard', shield:'useShieldCard', propertyFreeze:'useFreezeCard', propertySwap:'usePropertySwapCard', sharedShield:'useSharedShieldCard', pooledPayday:'usePooledPaydayCard', sabotage:'useSabotageCard', halfShield:'useHalfShieldCard'};
function renderPowerCardsHub(){
  const body = document.getElementById('powerCardsBody');
  if(!body) return;
  const pid = youAre, player = players[pid];
  const activeId = order[turnIdx];
  const isYourTurn = !!player && activeId===pid;
  const opponents = PLAYER_IDS.filter(id=>id!==pid && players[id] && players[id].active && !players[id].bankrupt);
  const teammates = CONFIG.teamsEnabled ? opponents.filter(id=>sameTeam(pid,id)) : [];
  // "All enabled" mirrors pickPowerCard()'s own filter — only cards this game's
  // settings can actually draw, not every card type that exists in the app.
  const enabledInGame = POWER_CARDS.filter(c => CONFIG.powerCardsEnabled?.[c.type] !== false && (!c.teamOnly || CONFIG.teamsEnabled));
  const ownedCards = POWER_CARDS.filter(def => player && (player[CARD_FIELD[def.type]]||0) > 0);
  const listCards = powerCardsShowAll ? enabledInGame : ownedCards;
  const toggleBtnHTML = `<button class="action-pill" onclick="togglePowerCardsShowAll()">${powerCardsShowAll ? '&#127183; Show only my cards' : '&#128065;&#65039; Show all cards enabled in this game'}</button>`;
  const hintHTML = powerCardsShowAll
    ? `<div class="pc-hint">Every card this game's settings allow to be drawn — owned cards below show their count, the rest are shown grayed out so you know what to look out for. ${toggleBtnHTML}</div>`
    : `<div class="pc-hint">Cards you're holding can be used, or relayed straight to a teammate (goes through instantly, no approval needed). Auctioning a card is done from the Auction button instead, alongside your properties. ${toggleBtnHTML}</div>`;
  if(!listCards.length){
    body.innerHTML = hintHTML + `<div class="pc-empty-note">${powerCardsShowAll ? "No cards are enabled for this game." : "You're not holding any cards right now."}</div>`;
    return;
  }
  body.innerHTML = hintHTML +
  listCards.map(def=>{
    const count = player ? (player[CARD_FIELD[def.type]]||0) : 0;
    const owned = count>0;
    let actionsHTML = '';
    if(owned){
      const usable = powerCardUsable(def.type, player, isYourTurn);
      if(def.type==='rentDoubler'){
        // targets a property GROUP the owner picks (a color set, all Railroads,
        // or all Utilities) instead of arming every property at once.
        const groups = {};
        tiles.forEach(x=>{
          if(!purchasable(x) || x.owner!==pid) return;
          const key = x.icon==='rail' ? 'RAIL' : x.icon==='util' ? 'UTIL' : x.group;
          if(!key) return;
          (groups[key]=groups[key]||[]).push(x);
        });
        const groupKeys = Object.keys(groups);
        if(groupKeys.length){
          const optHTML = groupKeys.map(k=>{
            const label = k==='RAIL' ? 'Railroads' : k==='UTIL' ? 'Utilities' : groups[k].map(x=>x.name).join(', ');
            return `<option value="${k}">${escapeHtml(label)}</option>`;
          }).join('');
          actionsHTML += `<div class="pc-actions">
            <select class="pc-select" id="pcDoublerTarget">${optHTML}</select>
            <button class="buy-btn yes" ${usable?'':'disabled'} onclick="const __g=document.getElementById('pcDoublerTarget').value;useRentDoublerCard(__g);refreshPowerCardsIfOpen();">Use</button>
          </div>`;
        } else {
          actionsHTML += `<div class="pc-empty-note">You don't own any properties to double rent on yet.</div>`;
        }
      } else if(def.type==='swap'){
        if(opponents.length){
          const optHTML = opponents.map(id=>`<option value="${id}">${escapeHtml(players[id].name)}${players[id].inJail?' (in jail — will be sprung)':''}</option>`).join('');
          actionsHTML += `<div class="pc-actions">
            <select class="pc-select" id="pcSwapTarget">${optHTML}</select>
            <button class="buy-btn yes" ${usable?'':'disabled'} onclick="const __t=document.getElementById('pcSwapTarget').value;useSwapCard(__t);closePowerCards();">Use</button>
          </div>`;
        } else {
          actionsHTML += `<div class="pc-empty-note">No valid opponent to swap with right now.</div>`;
        }
      } else if(def.type==='propertyFreeze'){
        // targets a player, same dropdown pattern as Swap — resolves instantly,
        // no board tap needed, so it can just close the modal right away.
        if(opponents.length){
          const optHTML = opponents.map(id=>`<option value="${id}">${escapeHtml(players[id].name)}</option>`).join('');
          actionsHTML += `<div class="pc-actions">
            <select class="pc-select" id="pcFreezeTarget">${optHTML}</select>
            <button class="buy-btn yes" ${usable?'':'disabled'} onclick="const __t=document.getElementById('pcFreezeTarget').value;useFreezeCard(__t);closePowerCards();">Use</button>
          </div>`;
        } else {
          actionsHTML += `<div class="pc-empty-note">No valid opponent to freeze right now.</div>`;
        }
      } else if(def.type==='nudge'){
        // targets a small +/- space offset the holder picks, same dropdown
        // pattern as Rent Doubler/Swap/Property Freeze above — resolves
        // instantly (no board tap needed), so the modal just closes right away.
        const optHTML = [-3,-2,-1,1,2,3].map(n=>`<option value="${n}" ${n===1?'selected':''}>${n>0?'+':'−'}${Math.abs(n)} space${Math.abs(n)===1?'':'s'} ${n>0?'forward':'back'}</option>`).join('');
        actionsHTML += `<div class="pc-actions">
          <select class="pc-select" id="pcNudgeAmount">${optHTML}</select>
          <button class="buy-btn yes" ${usable?'':'disabled'} onclick="const __n=parseInt(document.getElementById('pcNudgeAmount').value);useNudgeCard(__n);closePowerCards();">Use</button>
        </div>`;
      } else if(POWER_CARD_USE_FN[def.type]){
        const fn = POWER_CARD_USE_FN[def.type];
        const closesModal = (def.type==='teleport'||def.type==='sabotage'||def.type==='propertySwap');
        actionsHTML += `<div class="pc-actions">
          <button class="buy-btn yes" ${usable?'':'disabled'} onclick="${fn}();${closesModal?'closePowerCards();':'refreshPowerCardsIfOpen();'}">Use</button>
        </div>`;
      } else {
        // no manual "Use" — this card fires on its own (Bankruptcy Insurance,
        // Fast Forward); still tradeable while it's held, below.
        actionsHTML += `<div class="pc-empty-note">Fires automatically — nothing to play by hand.</div>`;
      }
      if(teammates.length){
        const relayCtl = `<select class="pc-select" id="pcRelayTarget-${def.type}">${teammates.map(id=>`<option value="${id}">${escapeHtml(players[id].name)}</option>`).join('')}</select><button class="action-pill" onclick="const __t=document.getElementById('pcRelayTarget-${def.type}').value;relayCard('${def.type}',__t);">&#128257; Relay to teammate</button>`;
        actionsHTML += `<div class="pc-actions">${relayCtl}</div>`;
      }
    }
    return `<div class="pc-card ${owned?'owned':'unowned'}">
      <div class="pc-card-head"><span class="pc-glyph">${def.glyph}</span><span class="pc-title">${def.title}</span><span class="pc-count">${owned?`&times;${count}`:'0'}</span></div>
      <div class="pc-desc">${def.text}</div>
      ${actionsHTML}
    </div>`;
  }).join('');
}

/* ============ LUCKY WHEEL / HAPPY BIRTHDAY CARD REVEAL ============
   Landing on either tile flashes the drawn card up on the board (centered, on the
   untilted #cardDrawLayer so it renders the same for every synced client) for a
   few seconds before the turn resumes — mirrors the Chance/Community Chest reveal
   from physical Monopoly instead of just resolving silently in the log. */
const CARD_DRAW_MS = 6000; // how long the card stays up before the turn continues
let cardDrawCleanupTimer = null;

function showCardDraw(payload){
  toastSuppressGen = logCallSeq; // the log() line just written for this same event shouldn't also get a toast
  cardDraw = payload;
  shownCardDrawId = payload.id;
  if(!cardDrawLayer) return;
  if(cardDrawCleanupTimer){ clearTimeout(cardDrawCleanupTimer); cardDrawCleanupTimer = null; }
  const amtHTML = (typeof payload.amt === 'number')
    ? `<div class="cd-amt ${payload.amt>=0?'pos':'neg'}">${payload.amt>=0?'+':'-'}$${fmt(Math.abs(payload.amt))}</div>`
    : '';
  cardDrawLayer.innerHTML = `
    <div class="gb-carddraw kind-${payload.kind}" style="left:${boardCenter.x}px; top:${boardCenter.y - 190}px;">
      <div class="cd-glyph">${payload.glyph}</div>
      <div class="cd-title">${payload.title}</div>
      ${payload.who ? `<div class="cd-who">${payload.who}</div>` : ''}
      <div class="cd-text">${payload.text}</div>
      ${amtHTML}
    </div>`;
  requestAnimationFrame(()=>{
    const el = cardDrawLayer.querySelector('.gb-carddraw');
    if(el) el.classList.add('show');
  });
}

function hideCardDraw(){
  cardDraw = null;
  shownCardDrawId = null;
  if(!cardDrawLayer) return;
  const el = cardDrawLayer.querySelector('.gb-carddraw');
  if(!el) return;
  el.classList.remove('show');
  cardDrawCleanupTimer = setTimeout(()=>{ if(cardDrawLayer) cardDrawLayer.innerHTML = ''; }, 400);
}
