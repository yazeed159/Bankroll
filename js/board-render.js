/* ============ BOARD RENDER (theme colors, 3D building models, board/tile
   art, car tokens, center plate) ============

   Split out of game.js: this file builds the visual board itself — the
   theme color table, 3D building models, the tile-drawing/card-render
   engine, car token art and token DOM creation, and the center plate/dice.
   It also declares PLAYER_IDS/PLAYER_DEFAULTS/DEFAULT_COLORS (the seat
   list and default name/color pool), since token creation needs them and
   nothing before this point does — the rest of the game (state, rules,
   network) reads them from here.

   Plain global script, not a module, like every other file here — it
   must load BEFORE game.js in index.html, since game.js's state/rules
   code references the constants and functions declared below. */
/* ============ THEME (Modern / Classic look) ============
   Two visual skins for the same game engine, toggled via a data-theme
   attribute on <html>. CSS handles almost everything (colors, fonts,
   board shape); this small table covers the handful of colors JS
   sets directly (inline styles) rather than through CSS. */
const THEME_JS_COLORS = {
  skyline: { idleDot: '#5a5f78', tokenBase: '#0b0e1a' },
  classic: { idleDot: '#7a8f80', tokenBase: '#0a2015' },
  hearthside: { idleDot: '#8a7a5f', tokenBase: '#201609' }
};
function currentThemeName(){ return document.documentElement.getAttribute('data-theme') || 'skyline'; }

/* ============ 3D BUILDING MODELS ============
   Sample house/tower GLB models (from the modular building kit), loaded from
   assets/models/ so the board's source stays plain text. A country tile shows nothing here
   until the first house is built on it — then swaps through bigger models as more
   houses go up, ending on a small "tower" once a hotel goes up. */
const BUILDING_MODELS = {
  house_a: "assets/models/house_a.glb",
  house_b: "assets/models/house_b.glb",
  house_c: "assets/models/house_c.glb",
  tower_a: "assets/models/tower_a.glb",
  tower_b: "assets/models/tower_b.glb",
  tower_c: "assets/models/tower_c.glb",
  tower_d: "assets/models/tower_d.glb",
};
const CAR_MODELS = {
  sedan: "assets/models/sedan.glb",
  suv: "assets/models/suv.glb",
  hatchback_sports: "assets/models/hatchback_sports.glb",
  sedan_sports: "assets/models/sedan_sports.glb",
  taxi: "assets/models/taxi.glb",
  race: "assets/models/race.glb",
  delivery: "assets/models/delivery.glb",
  police: "assets/models/police.glb",
};
/* selectable 3D car tokens (Kenney car-kit GLBs) — players pick one of these in
   the setup screen; CAR_LIST drives the picker UI and the default cycling
   assignment, CAR_MODELS holds the actual model paths (assets/models/*.glb). */
const CAR_LIST = [
  {key:'sedan', label:'Sedan', color:'#f2f3f5'},
  {key:'suv', label:'SUV', color:'#3fe07a'},
  {key:'hatchback_sports', label:'Hot Hatch', color:'#ff9f5a'},
  {key:'sedan_sports', label:'Sports Sedan', color:'#5a9bff'},
  {key:'taxi', label:'Taxi', color:'#f0d24b'},
  {key:'race', label:'Race Car', color:'#e35b5b'},
  {key:'delivery', label:'Delivery Van', color:'#a8adb8'},
  {key:'police', label:'Police Car', color:'#565b66'},
];
// Color is no longer chosen independently — each car has a fixed color, and a
// player's color is just whatever their currently-selected car's color is.
function colorForCar(car){ return (CAR_LIST.find(c=>c.key===car)||CAR_LIST[0]).color; }

// index 0..3 = house levels as houses are built (1 house = index 0, 2 = index 1, ...),
// index 4 = hotel (reused for houses>=5, with the sparkle overlay marking the hotel)
const BUILDING_LEVELS = [
  BUILDING_MODELS.house_a,
  BUILDING_MODELS.house_b,
  BUILDING_MODELS.house_c,
  BUILDING_MODELS.tower_a,
  BUILDING_MODELS.tower_b,
  BUILDING_MODELS.tower_c
];

// classic-theme flat 2D pieces: plain green house / red hotel, in the style of the
// original board game's wooden playing pieces — used instead of the 3D house/hotel
// models whenever data-theme="classic".
const FLAT_HOUSE_SVG = '<svg viewBox="0 0 24 24"><polygon points="1,12 12,2 23,12 23,13 1,13" fill="#1b5e20" stroke="#0c2f0e" stroke-width="1" stroke-linejoin="round"/><rect x="4" y="12" width="16" height="9" fill="#2e7d32" stroke="#0c2f0e" stroke-width="1"/></svg>';
const FLAT_HOTEL_SVG = '<svg viewBox="0 0 40 30"><polygon points="1,11 20,1 39,11 39,12.5 1,12.5" fill="#7f1010" stroke="#4a0a0a" stroke-width="1" stroke-linejoin="round"/><rect x="4" y="11" width="32" height="17" fill="#c62828" stroke="#4a0a0a" stroke-width="1"/><rect x="8" y="16" width="5" height="5.5" fill="#ffe9b3" opacity=".9"/><rect x="17.5" y="16" width="5" height="5.5" fill="#ffe9b3" opacity=".9"/><rect x="27" y="16" width="5" height="5.5" fill="#ffe9b3" opacity=".9"/></svg>';
// skyline-theme flat pieces: a small glass tower (house) and a taller twin-tower
// skyscraper (hotel), styled in the board's own cyan/violet/gold palette instead
// of the classic board's green/red wooden pieces — used in place of the old
// low-poly 3D house/hotel models on the "Modern" skin. Colors are literal hex
// (not CSS vars) since this markup is duplicated via innerHTML per building.
const MODERN_HOUSE_SVG = '<svg viewBox="0 0 20 26"><rect x="3" y="3" width="14" height="21" rx="1" fill="#141a2e" stroke="#2dd4bf" stroke-width="0.8"/><rect x="3" y="3" width="14" height="3" fill="#e3ce6e"/><rect x="5.4" y="8" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="9.8" y="8" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="5.4" y="12.2" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="9.8" y="12.2" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="5.4" y="16.4" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="9.8" y="16.4" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="9.1" y="0" width="1.8" height="3" fill="#2dd4bf"/><circle cx="10" cy="0.6" r="1" fill="#ff7aa2"/></svg>';
const MODERN_HOTEL_SVG = '<svg viewBox="0 0 44 34"><rect x="4" y="14" width="14" height="20" rx="1" fill="#141a2e" stroke="#8b5cf6" stroke-width="0.8"/><rect x="4" y="14" width="14" height="3" fill="#e3ce6e"/><rect x="22" y="4" width="18" height="30" rx="1" fill="#161b31" stroke="#2dd4bf" stroke-width="0.9"/><rect x="22" y="4" width="18" height="3" fill="#e3ce6e"/><rect x="6.6" y="19" width="2.2" height="2.2" fill="#5eead4" opacity=".8"/><rect x="10.6" y="19" width="2.2" height="2.2" fill="#5eead4" opacity=".55"/><rect x="6.6" y="23.2" width="2.2" height="2.2" fill="#5eead4" opacity=".55"/><rect x="10.6" y="23.2" width="2.2" height="2.2" fill="#5eead4" opacity=".8"/><rect x="6.6" y="27.4" width="2.2" height="2.2" fill="#5eead4" opacity=".8"/><rect x="10.6" y="27.4" width="2.2" height="2.2" fill="#5eead4" opacity=".55"/><rect x="24.8" y="9" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="29.4" y="9" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="34" y="9" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="24.8" y="13.6" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="29.4" y="13.6" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="34" y="13.6" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="24.8" y="18.2" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="29.4" y="18.2" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="34" y="18.2" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="24.8" y="22.8" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="29.4" y="22.8" width="2.4" height="2.4" fill="#5eead4" opacity=".85"/><rect x="34" y="22.8" width="2.4" height="2.4" fill="#5eead4" opacity=".55"/><rect x="30.1" y="0" width="1.8" height="4" fill="#2dd4bf"/><circle cx="31" cy="0.6" r="1.1" fill="#ff7aa2"/></svg>';

const GROUP_COLOR = ["#45e8da","#e3ce6e","#ea6bab","#9b8cf2"]; // cyan, gold, pink, violet per edge
const FLAG_COLORS = {
  india:   ["#FF9933","#FFFFFF","#138808"],
  turkey:  ["#E30A17","#E30A17"],
  canada:  ["#FF0000","#FFFFFF","#FF0000"],
  uk:      ["#00247D","#FFFFFF","#CF142B"],
  italy:   ["#009246","#FFFFFF","#CE2B37"],
  korea:   ["#FFFFFF","#C60C30","#003478"],
  ukraine: ["#0057B7","#FFD700"],
  swiss:   ["#D52B1E","#D52B1E"]
};
// Each country group gets its own vivid, well-spaced accent — used to tint the tile
// face and border so neighboring countries (and countries vs. specials) are readable
// at a glance instead of relying on the small flag icon alone. Picked to stay distinct
// from each other AND from OTHER_ACCENT below (railroads/utilities/tax/etc.), rather
// than reusing each flag's own color (several flags are red, one is mostly white —
// neither makes a usable, distinguishable board accent).
const ACCENT_COLOR = {
  india:   "#F2994A", // saffron orange
  turkey:  "#E8583D", // red-orange
  canada:  "#F2707D", // coral rose
  uk:      "#4E8FF0", // blue
  italy:   "#5FD08A", // green
  korea:   "#3FD1C7", // teal
  ukraine: "#F2D94E", // yellow-gold
  swiss:   "#B24FC2"  // magenta
};
// Non-country tiles (railroads, utilities, tax, chance/gift) each get their own accent
// too, but pulled from a visibly different, cooler/neutral family than ACCENT_COLOR so
// the two tile "kinds" never get mistaken for each other.
const OTHER_ACCENT = { rail:"#6FA8DC", util:"#F5D76E", tax:"#EA6BAB", wheel:"#9B8CF2", gift:"#7FE0C4" };
const ICON_GLYPH   = { rail:"\u{1F686}", util:"\u26A1", tax:"%", wheel:"\u{1F3A1}", gift:"\u{1F381}" };

/* Lucky Wheel / Happy Birthday each run in one of two mutually-exclusive modes (see
   CONFIG.luckyWheelPowerOnly / CONFIG.bdayPowerOnly): "normal" draws cash only, never a
   power card; "power" draws a power card only, never cash. The board tile itself swaps
   name/glyph/accent to match — see updateSpecialTileVisuals() below, which re-applies
   this any time that config changes (game setup, an invite code, or a network sync). */
const POWER_TILE_GLYPH = "\u2728";
const POWER_TILE_ACCENT = "#FFD24C";
const SPECIAL_TILE_NAMES = {
  wheel: { normal:"Lucky Wheel", power:"Power-Up" },
  gift:  { normal:"Happy B'day", power:"Power-Up" }
};

const tiles = [
  {name:"GO", corner:true, icon:"start"},

  {flag:"🇮🇳", name:"Delhi", price:"$60", group:"india", houseCost:50, rent:[2,10,30,90,160,250]},
  {name:"Lucky Wheel", icon:"wheel"},
  {flag:"🇮🇳", name:"Mumbai", price:"$60", group:"india", houseCost:50, rent:[4,20,60,180,320,450]},
  {name:"Income Tax", price:"10%", icon:"tax"},
  {name:"India Railroad", price:"$200", icon:"rail"},
  {flag:"🇹🇷", name:"Izmir", price:"$100", group:"turkey", houseCost:50, rent:[6,30,90,270,400,550]},
  {name:"Happy B'day", icon:"gift"},
  {flag:"🇹🇷", name:"Ankara", price:"$100", group:"turkey", houseCost:50, rent:[6,30,90,270,400,550]},
  {flag:"🇹🇷", name:"Istanbul", price:"$120", group:"turkey", houseCost:50, rent:[8,40,100,300,450,600]},

  {name:"Just Visiting", corner:true, icon:"jail"},

  {flag:"🇨🇦", name:"Vancouver", price:"$140", group:"canada", houseCost:100, rent:[10,50,150,450,625,750]},
  {name:"Solar Co.", price:"$150", icon:"util"},
  {flag:"🇨🇦", name:"Montreal", price:"$140", group:"canada", houseCost:100, rent:[10,50,150,450,625,750]},
  {flag:"🇨🇦", name:"Toronto", price:"$160", group:"canada", houseCost:100, rent:[12,60,180,500,700,900]},
  {name:"Canada Railroad", price:"$200", icon:"rail"},
  {flag:"🇬🇧", name:"Manchester", price:"$180", group:"uk", houseCost:100, rent:[14,70,200,550,750,950]},
  {name:"Lucky Wheel", icon:"wheel"},
  {flag:"🇬🇧", name:"Brighton", price:"$180", group:"uk", houseCost:100, rent:[14,70,200,550,750,950]},
  {flag:"🇬🇧", name:"London", price:"$200", group:"uk", houseCost:100, rent:[16,80,220,600,800,1000]},

  {name:"Bailout", corner:true, icon:"park"},

  {flag:"🇮🇹", name:"Florence", price:"$220", group:"italy", houseCost:150, rent:[18,90,250,700,875,1050]},
  {name:"Happy B'day", icon:"gift"},
  {flag:"🇮🇹", name:"Venice", price:"$220", group:"italy", houseCost:150, rent:[18,90,250,700,875,1050]},
  {flag:"🇮🇹", name:"Rome", price:"$240", group:"italy", houseCost:150, rent:[20,100,300,750,925,1100]},
  {name:"Italy Railroad", price:"$200", icon:"rail"},
  {flag:"🇰🇷", name:"Suwon", price:"$260", group:"korea", houseCost:150, rent:[22,110,330,800,975,1150]},
  {flag:"🇰🇷", name:"Busan", price:"$260", group:"korea", houseCost:150, rent:[22,110,330,800,975,1150]},
  {name:"Electric Co.", price:"$150", icon:"util"},
  {flag:"🇰🇷", name:"Seoul", price:"$280", group:"korea", houseCost:150, rent:[24,120,360,850,1025,1200]},

  {name:"Go To Jail", corner:true, icon:"gojail"},

  {flag:"🇺��", name:"Odessa", price:"$300", group:"ukraine", houseCost:200, rent:[26,130,390,900,1100,1275]},
  {flag:"🇺🇦", name:"Kharkiv", price:"$300", group:"ukraine", houseCost:200, rent:[26,130,390,900,1100,1275]},
  {name:"Lucky Wheel", icon:"wheel"},
  {flag:"🇺🇦", name:"Kyiv", price:"$320", group:"ukraine", houseCost:200, rent:[28,150,450,1000,1200,1400]},
  {name:"Ukraine Railroad", price:"$200", icon:"rail"},
  {name:"Happy B'day", icon:"gift"},
  {flag:"🇨🇭", name:"Geneva", price:"$350", group:"swiss", houseCost:200, rent:[35,175,500,1100,1300,1500]},
  {name:"Luxury Tax", price:"$75", icon:"tax"},
  {flag:"🇨🇭", name:"Zurich", price:"$400", group:"swiss", houseCost:200, rent:[50,200,600,1400,1700,2000]}
];

/* Re-applies each Lucky Wheel / Happy Birthday tile's board name/badge to match its
   current mode (see SPECIAL_TILE_NAMES/POWER_TILE_GLYPH/POWER_TILE_ACCENT above) —
   called whenever CONFIG.luckyWheelPowerOnly/bdayPowerOnly could have just changed
   (game setup saved, an invite code decoded, a network sync landed). No-ops safely
   before the board DOM exists yet. */
function updateSpecialTileVisuals(){
  tiles.forEach((t,i)=>{
    if(t.icon!=='wheel' && t.icon!=='gift') return;
    const powerMode = specialTilePowerMode(t);
    const nameEl = tileNameEls[i], badgeEl = tileBadgeEls[i], barEl = tileAccentBarEls[i], cellEl = tileCellEls[i];
    const accent = powerMode ? POWER_TILE_ACCENT : OTHER_ACCENT[t.icon];
    if(nameEl) nameEl.textContent = SPECIAL_TILE_NAMES[t.icon][powerMode ? 'power' : 'normal'];
    if(badgeEl){
      badgeEl.textContent = powerMode ? POWER_TILE_GLYPH : ICON_GLYPH[t.icon];
      badgeEl.style.border = `1.2px solid ${accent}`;
      badgeEl.style.color = accent;
    }
    if(barEl) barEl.style.background = accent;
    if(cellEl) cellEl.classList.toggle('power-tile', powerMode);
  });
  // the center card-stack decoration (the pile art sitting either side of the dice,
  // separate from the perimeter tiles above) needs the same relabel — it's static
  // markup otherwise and was never touched by the loop above, so it kept showing
  // "LUCKY WHEEL"/"HAPPY B'DAY" even once that tile was switched to power-only.
  const wheelGlyphEl = document.getElementById('centerWheelGlyph'), wheelLblEl = document.getElementById('centerWheelLbl');
  if(wheelGlyphEl) wheelGlyphEl.textContent = CONFIG.luckyWheelPowerOnly ? POWER_TILE_GLYPH : ICON_GLYPH.wheel;
  if(wheelLblEl) wheelLblEl.textContent = CONFIG.luckyWheelPowerOnly ? 'POWER-UP' : 'LUCKY WHEEL';
  const bdayGlyphEl = document.getElementById('centerBdayGlyph'), bdayLblEl = document.getElementById('centerBdayLbl');
  if(bdayGlyphEl) bdayGlyphEl.textContent = CONFIG.bdayPowerOnly ? POWER_TILE_GLYPH : ICON_GLYPH.gift;
  if(bdayLblEl) bdayLblEl.textContent = CONFIG.bdayPowerOnly ? 'POWER-UP' : "HAPPY B'DAY";
}

// index of the "Bailout" corner tile (this build's Free Parking equivalent) — found by
// icon rather than a hardcoded number so reordering the board above can't silently break it
const BAILOUT_IDX = tiles.findIndex(t=>t.icon==='park');
let bailoutPot = 0; // tax + fines collected here, paid out in full to whoever lands on Bailout

function posFor(i){
  if(i<=10) return {r:0,c:i};
  if(i<=20) return {r:i-10,c:10};
  if(i<=30) return {r:10,c:10-(i-20)};
  return {r:10-(i-30),c:0};
}
function edgeIndex(i){
  if(i===0) return 3;
  if(i<=10) return 0;
  if(i===20) return 0;
  if(i<=20) return 1;
  if(i===30) return 1;
  if(i<=30) return 2;
  return 3;
}

/* ============ GB CARD-BOARD RENDER ENGINE ============ */
const COL = [185,140,140,140,140,140,140,140,140,140,185]; // 11 tracks, matches posFor's 0..10 c/r (widened for readability)
const ROW = COL;
function gbPos(c,r){ // c,r are 0-indexed (posFor's coordinate space)
  const left = COL.slice(0,c).reduce((a,b)=>a+b,0);
  const top  = ROW.slice(0,r).reduce((a,b)=>a+b,0);
  return {left, top, w:COL[c], h:ROW[r]};
}
const BOARD_W = COL.reduce((a,b)=>a+b,0), BOARD_H = ROW.reduce((a,b)=>a+b,0);

function shade(hex, amt){
  const n = parseInt(hex.slice(1),16);
  let r=(n>>16)+amt, g=((n>>8)&255)+amt, b=(n&255)+amt;
  r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
  return "rgb("+r+","+g+","+b+")";
}
function mixColor(hexA, hexB, t){
  const a = parseInt(hexA.slice(1),16), b = parseInt(hexB.slice(1),16);
  const ar=(a>>16)&255, ag=(a>>8)&255, ab=a&255;
  const br=(b>>16)&255, bg=(b>>8)&255, bb=b&255;
  const r = Math.round(ar*(1-t)+br*t), g = Math.round(ag*(1-t)+bg*t), bl = Math.round(ab*(1-t)+bb*t);
  return `rgb(${r},${g},${bl})`;
}
function mk(tag, cls, parent){
  const e = document.createElement(tag);
  if(cls) e.className = cls;
  if(parent) parent.appendChild(e);
  return e;
}

/* ============ 3D SVG CAR TOKEN ART ============ */
const SVG_NS = "http://www.w3.org/2000/svg";
function el(tag, attrs){
  const e = document.createElementNS(SVG_NS, tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function pts(arr){ return arr.map(p=>p.x.toFixed(1)+","+p.y.toFixed(1)).join(" "); }
/* a low, wide wedge-shaped supercar (Lambo/Porsche-style silhouette): pointed nose,
   flared rear haunches, a low sloped cabin set back toward the rear axle, a rear
   wing, angular slit headlights and a full-width tail light bar — built the same
   way as before (a coloured top face + darker extruded side faces + wheels with an
   off-centre "spoke" so a CSS spin reads as motion) but reshaped so it reads as a
   real sports car instead of a boxy toy car. */
function carGroup(color){
  const g = el('g',{class:'car-token'});
  const inner = el('g',{transform:'translate(0,-4.6)'});
  g.appendChild(inner);
  const iso = p => ({x:p.x, y:p.y*0.62});

  // pointed nose (6,7) · tapered front shoulders (0,5) · flared wide rear
  // haunches (1,4) · wide rear cap (2,3) — an asymmetric wedge, not a symmetric
  // toy-car octagon.
  const bodyRaw = [
    {x: 7,   y: -3.4},
    {x: -7,  y: -6.3},
    {x: -12, y: -4.5},
    {x: -12, y: 4.5},
    {x: -7,  y: 6.3},
    {x: 7,   y: 3.4},
    {x: 13,  y: 1.1},
    {x: 13,  y: -1.1},
  ];
  const top = bodyRaw.map(iso);
  const depth = 3.6; // lower stance than the old toy-car body

  inner.appendChild(el('ellipse',{cx:0, cy:depth+7.2, rx:17.5, ry:4, fill:"#000", opacity:0.30, class:"car-shadow"}));

  function extrude(chain, d){
    const poly=[]; chain.forEach(p=>poly.push(p));
    for(let i=chain.length-1;i>=0;i--) poly.push({x:chain[i].x, y:chain[i].y+d});
    return poly;
  }

  // wide front track under the shoulders, wider rear track under the flared
  // haunches — bigger wheels read as low-profile performance tires.
  [[5.8,-5.1],[5.8,5.1],[-8.2,-5.9],[-8.2,5.9]].forEach(([wx,wy])=>{
    const wheel = el('g',{class:"car-wheel"});
    const wcy = wy*0.62 + depth + 0.4;
    wheel.appendChild(el('circle',{cx:wx, cy:wcy.toFixed(2), r:2.9, fill:"#101119", stroke:"#000", "stroke-width":0.3}));
    wheel.appendChild(el('circle',{cx:wx, cy:wcy.toFixed(2), r:1.7, fill:"#b7bcd6"}));
    wheel.appendChild(el('circle',{cx:wx, cy:wcy.toFixed(2), r:0.5, fill:"#20232e"}));
    inner.appendChild(wheel);
  });

  inner.appendChild(el('polygon',{points:pts(extrude([top[4],top[5],top[6]],depth)), fill:shade(color,-58)}));
  inner.appendChild(el('polygon',{points:pts(extrude([top[1],top[2],top[3]],depth)), fill:shade(color,-38)}));
  inner.appendChild(el('polygon',{points:pts([top[6],top[7],{x:top[7].x,y:top[7].y+depth},{x:top[6].x,y:top[6].y+depth}]), fill:shade(color,-20)}));
  inner.appendChild(el('polygon',{points:pts([top[2],top[3],{x:top[3].x,y:top[3].y+depth},{x:top[2].x,y:top[2].y+depth}]), fill:shade(color,-70)}));

  // small dark side-intake accent on the visible flank, ahead of the rear haunch
  const scoopA=iso({x:-2,y:5.4}), scoopB=iso({x:-6.4,y:6.1}), scoopC=iso({x:-6.4,y:6.1+depth*0.55}), scoopD=iso({x:-2,y:5.4+depth*0.55});
  inner.appendChild(el('polygon',{points:pts([scoopA,scoopB,scoopC,scoopD]), fill:shade(color,-72), opacity:0.85}));

  inner.appendChild(el('polygon',{points:pts(top), fill:shade(color,10), stroke:shade(color,-30), "stroke-width":0.6}));
  // faint hood crease running from the cabin toward the nose
  const creaseA=iso({x:1,y:0}), creaseB=iso({x:11.5,y:0});
  inner.appendChild(el('line',{x1:creaseA.x,y1:creaseA.y,x2:creaseB.x,y2:creaseB.y, stroke:shade(color,-25), "stroke-width":0.35, opacity:0.6}));

  // low, sloped cabin set back toward the rear axle (mid-engine proportions),
  // tapering forward into a raked windshield.
  const cabRaw = [
    {x: 2,   y: -3.7},
    {x: -6,  y: -3.7},
    {x: -6,  y: 3.7},
    {x: 2,   y: 3.7},
    {x: 5.6, y: 1.7},
    {x: 5.6, y: -1.7},
  ];
  const cab = cabRaw.map(iso);
  const cabDepth = 2.3;
  inner.appendChild(el('polygon',{points:pts(extrude([cab[3],cab[4],cab[5],cab[0]],cabDepth)), fill:shade(color,-50)}));
  inner.appendChild(el('polygon',{points:pts(cab), fill:shade(color,32), stroke:shade(color,-15), "stroke-width":0.5}));
  inner.appendChild(el('polygon',{points:pts([cab[5],cab[0],{x:cab[0].x,y:cab[0].y+cabDepth},{x:cab[5].x,y:cab[5].y+cabDepth}]), fill:"#9fe0ff", opacity:0.7}));
  inner.appendChild(el('polygon',{points:pts([cab[4],cab[3],{x:cab[3].x,y:cab[3].y+cabDepth},{x:cab[4].x,y:cab[4].y+cabDepth}]), fill:"#9fe0ff", opacity:0.55}));

  // rear wing: two struts rising off the deck plus a thin blade above it
  const wingBaseL=iso({x:-10.5,y:-3.2}), wingBaseR=iso({x:-10.5,y:3.2});
  const wingTopL={x:wingBaseL.x-1.1,y:wingBaseL.y-3.4}, wingTopR={x:wingBaseR.x-1.1,y:wingBaseR.y-3.4};
  [[wingBaseL,wingTopL],[wingBaseR,wingTopR]].forEach(([base,top_])=>{
    inner.appendChild(el('line',{x1:base.x,y1:base.y+depth*0.3,x2:top_.x,y2:top_.y, stroke:shade(color,-45), "stroke-width":0.6}));
  });
  inner.appendChild(el('polygon',{points:pts([
    {x:wingTopL.x-1.6,y:wingTopL.y-0.9},{x:wingTopR.x-1.6,y:wingTopR.y-0.9},
    {x:wingTopR.x+1.6,y:wingTopR.y+0.9},{x:wingTopL.x+1.6,y:wingTopL.y+0.9}
  ]), fill:shade(color,-55), stroke:"#000", "stroke-width":0.25}));

  // slim angular headlights and a full-width LED tail bar, sports-car style
  const hl1=iso({x:12.6,y:-1.4}), hl2=iso({x:12.6,y:1.4});
  inner.appendChild(el('polygon',{points:pts([
    {x:hl1.x,y:hl1.y-0.55},{x:hl1.x-1.7,y:hl1.y-0.3},{x:hl1.x-1.7,y:hl1.y+0.3},{x:hl1.x,y:hl1.y+0.55}
  ]), fill:"#fff6c8"}));
  inner.appendChild(el('polygon',{points:pts([
    {x:hl2.x,y:hl2.y-0.55},{x:hl2.x-1.7,y:hl2.y-0.3},{x:hl2.x-1.7,y:hl2.y+0.3},{x:hl2.x,y:hl2.y+0.55}
  ]), fill:"#fff6c8"}));
  const tl1=iso({x:-12,y:-4.1}), tl2=iso({x:-12,y:4.1});
  inner.appendChild(el('rect',{x:tl1.x-0.15, y:tl1.y-0.5, width:1.3, height:1.0, rx:0.25, fill:"#e35b5b"}));
  inner.appendChild(el('rect',{x:tl2.x-1.15, y:tl2.y-0.5, width:1.3, height:1.0, rx:0.25, fill:"#e35b5b"}));
  const tlBarA=iso({x:-12.3,y:-3.7}), tlBarB=iso({x:-12.3,y:3.7});
  inner.appendChild(el('line',{x1:tlBarA.x,y1:tlBarA.y,x2:tlBarB.x,y2:tlBarB.y, stroke:"#e35b5b", "stroke-width":0.5, opacity:0.85}));

  return g;
}

const boardEl = document.getElementById('board');
const boardView = document.getElementById('boardView');
const tokenLayer = document.getElementById('tokenLayer');
const cardDrawLayer = document.getElementById('cardDrawLayer');
boardEl.style.width = BOARD_W+'px';
boardEl.style.height = BOARD_H+'px';

// heading (in degrees) the token should face while sitting on tile i, based on the
// step it's about to take next. Computed from the tiles' actual measured on-screen
// centers (tileEls, filled in by measureTileScreenCenters() once the board is laid
// out) rather than the grid's pre-tilt row/column math — the token now renders in a
// flat, untilted layer, so what matters is the direction the path actually travels
// on screen (which runs at the diamond's angled edges), not the direction it runs
// in the underlying, unrotated grid.
function tileHeadingDeg(i){
  const cur = tileEls[((i%40)+40)%40], next = tileEls[(((i+1)%40)+40)%40];
  if(!cur || !next) return 0;
  return Math.atan2(next.y-cur.y, next.x-cur.x)*180/Math.PI;
}

// the exact slope of the diamond's edges on screen, derived from two adjacent
// top-edge tiles once they're measured (updateEdgeAngle(), called alongside
// measureTileScreenCenters()) — not a guessed constant, so it stays correct if the
// board's proportions or tilt angle are ever retuned.
let EDGE_ANGLE = 36;
function updateEdgeAngle(){
  const a = tileEls[0], b = tileEls[1];
  if(a && b) EDGE_ANGLE = Math.abs(Math.atan2(b.y-a.y, b.x-a.x)*180/Math.PI);
}

function gbFlagMarkup(groupId){
  switch(groupId){
    case 'swiss':   return `<div class="gb-flag gb-flag-ch"></div>`;
    case 'india':   return `<div class="gb-flag gb-flag-in"><div class="ck"></div></div>`;
    case 'turkey':  return `<div class="gb-flag gb-flag-tr"><div class="cres"></div><div class="star"></div></div>`;
    case 'canada':  return `<div class="gb-flag gb-flag-ca"><div class="lf"></div></div>`;
    case 'uk':      return `<div class="gb-flag gb-flag-gb"><div class="d1"></div><div class="d2"></div><div class="cr"></div><div class="crr"></div></div>`;
    case 'italy':   return `<div class="gb-flag gb-flag-it"></div>`;
    case 'korea':   return `<div class="gb-flag gb-flag-kr"><div class="tg"></div></div>`;
    case 'ukraine': return `<div class="gb-flag gb-flag-ua"></div>`;
    default: return '';
  }
}
// Drawn-flag markup for UI spots outside the board (trade list, tile-info popup).
// Emoji flag sequences (e.g. the India flag codepoints) depend on the OS having a
// color-flag font installed — Windows and many Linux setups don't, and silently fall
// back to showing the plain two-letter country code instead of a flag. Reusing the
// board's hand-drawn CSS flags sidesteps that entirely since they render identically
// everywhere. gb-flag's native size is 33x22; scale it to whatever box we need here.
function flagIconHTML(groupId, w){
  const inner = gbFlagMarkup(groupId);
  if(!inner) return '';
  const h = Math.round(w*22/33), scale=(w/33).toFixed(3);
  return `<div style="width:${w}px;height:${h}px;overflow:hidden;position:relative;flex-shrink:0;border-radius:2px;"><div style="transform:scale(${scale});transform-origin:top left;">${inner}</div></div>`;
}

/* ============ DRAW TILES ============ */
// tileEls[i] starts as the pre-tilt board-local {x,y} center (used only to lay out the
// cells below); right after the tiles are in the DOM it gets OVERWRITTEN in-place by
// measureTileScreenCenters() with the tile's actual on-screen center relative to
// #boardView. Tokens live in a separate flat, untilted layer (#tokenLayer, a sibling of
// .gb-tilt) so the car art never gets squashed by the board's rotateZ/rotateX tilt —
// so every token placement always wants that post-tilt screen position, not the
// original pre-tilt one, and tileEls is what all of them read.
const tileEls = [];
let boardCenter = {x:0, y:0}; // filled in by measureTileScreenCenters(); center point for #cardDrawLayer's card
const tileCellEls = []; // per-tile actual .gb-cell DOM node, needed to measure screen centers
const ownFaceEls = {};    // per-tile ownership-tint overlay div
const tilePriceEls = {};  // per-tile price/rent label
const tilePriceBgEls = {};// alias of tilePriceEls (the pill IS its own backdrop in CSS)
const tileHouseEls = {};  // per-tile {el, mv, level, sparkEl} for the flat 3D building overlay
const groupTileIdx = []; // indices of country tiles, filled in while tiles are drawn below
const tileAnchorEls = {}; // per-tile invisible anchor div (the empty gap between name/price)
const buildingAnchorPos = []; // per-tile screen position of that gap, filled in by measureTileScreenCenters()
const tileNameEls = {};  // per-tile .gb-tname div — used by updateSpecialTileVisuals() to relabel wheel/gift tiles
const tileBadgeEls = {}; // per-tile .gb-badge div — used by updateSpecialTileVisuals() to re-skin wheel/gift tiles
const tileAccentBarEls = {}; // per-tile .gb-accent-bar div (wheel/gift only) — recolored by updateSpecialTileVisuals() to match power mode

tiles.forEach((t,i)=>{
  const {r,c} = posFor(i);
  const {left,top,w,h} = gbPos(c,r);
  const isCorner = !!t.corner;
  const eIdx = edgeIndex(i);
  const isOther = !isCorner && !t.group;
  const groupAccent = t.group ? (ACCENT_COLOR[t.group] || GROUP_COLOR[eIdx]) : (OTHER_ACCENT[t.icon] || GROUP_COLOR[eIdx]);
  const accent = isCorner ? "#e3ce6e" : groupAccent;
  const rotClass = isCorner ? 'rot-0' : ['rot-0','rot-90','rot-180','rot-270'][eIdx];

  tileEls[i] = {x: left+w/2, y: top+h/2};

  const cell = document.createElement('div');
  cell.className = 'gb-cell '+rotClass+(isCorner?' corner':'');
  cell.style.left = left+'px'; cell.style.top = top+'px';
  cell.style.width = w+'px'; cell.style.height = h+'px';
  cell.addEventListener('click', ()=>{
    if(dragMoved) return;
    if(teleportPickMode && order[turnIdx]===youAre){ teleportPickMode=false; resolveTeleportTo(i); return; }
    if(sabotagePickMode && order[turnIdx]===youAre){
      // see matching comment in the Property Freeze branch above
      const p = players[youAre];
      if(!(p && p.sabotageCards>0)){ sabotagePickMode=false; refreshUI(); return; }
      if(sabotageTargetValid(tiles[i], youAre)) sabotagePickMode=false;
      else document.getElementById('rollResult').textContent = "Sabotage needs an opposing team's owned property in a color group — tap one, or cancel.";
      resolveSabotageTo(i);
      return;
    }
    if(propertySwapPick && propertySwapPick.pid===youAre){ resolvePropertySwapPick(i); return; }
    showTileInfo(i);
  });
  tileCellEls[i] = cell;

  const card = mk('div','gb-card',cell);
  const abar = mk('div','gb-accent-bar',card); abar.style.background = accent; abar.style.opacity = isCorner?0.9:(t.group?0.9:0.6);
  if(t.icon==='wheel' || t.icon==='gift') tileAccentBarEls[i] = abar;
  const ownFace = mk('div','gb-ownface',cell);
  ownFaceEls[i] = ownFace;

  const inner = mk('div','gb-inner',cell);

  if(isCorner){
    const iconGlyph = ({start:"\u{1F697}",jail:"\u{1F441}\uFE0F",park:"\u{1F17F}\uFE0F",gojail:"\u{1F694}"})[t.icon] || "\u2605";
    mk('div','gb-corner-icon',inner).textContent = iconGlyph;
    mk('div','gb-corner-title',inner).textContent = t.name;
  } else {
    if(t.flag && t.group){
      inner.insertAdjacentHTML('beforeend', gbFlagMarkup(t.group));
    } else if(isOther && t.icon){
      const badge = mk('div','gb-badge',inner);
      badge.style.border = `1.2px solid ${accent}`; badge.style.color = accent;
      badge.textContent = ICON_GLYPH[t.icon] || '?';
      tileBadgeEls[i] = badge;
    }
    tileNameEls[i] = mk('div','gb-tname',inner);
    tileNameEls[i].textContent = t.name;
    if(t.group){
      // invisible spacer marking the empty gap between name and price — the flat
      // 3D building overlay anchors to THIS element's screen position (not the
      // tile's own center), so it lands in that empty gap instead of on top of
      // the name or price text.
      const anchor = mk('div','gb-bldg-anchor',inner);
      tileAnchorEls[i] = anchor;
      groupTileIdx.push(i);
    }
  }

  if(t.price || t.icon==='park'){
    const pr = mk('div','gb-tprice is-rent',inner);
    pr.textContent = t.icon==='park' ? `$${fmt(bailoutPot)}` : t.price;
    tilePriceEls[i] = pr;
    tilePriceBgEls[i] = pr;
  }

  boardEl.appendChild(cell);
});

/* every token position downstream (setTokenPos/moveToken/placeTokenInstant/etc.) reads
   tileEls[i] expecting it to already be the tile's actual on-screen center — measure it
   here, once the cells are in the DOM, and overwrite the pre-tilt values in place. Reads
   relative to #boardView (which has its own transform and so is a positioning containing
   block) since #tokenLayer, a sibling of .gb-tilt, is positioned against that same box —
   this makes tokenLayer inherit #boardView's pan/zoom for free without extra recompute,
   while never inheriting .gb-tilt/#board's rotateX/rotateZ tilt. Re-run on resize since
   the tilt's perspective projection is viewport-size dependent. */
function measureTileScreenCenters(){
  // measure at boardView's own transform reset to identity — #tokenLayer's left/top
  // are interpreted in boardView's untransformed local space, then boardView's pan/zoom
  // transform scales tokenLayer and its tokens along with the tilted board as one rigid
  // unit, so measuring while any pan/zoom is already applied would double-scale things.
  const prevTransform = boardView.style.transform;
  boardView.style.transform = 'translate(0px,0px) scale(1)';
  const bv = boardView.getBoundingClientRect();
  tileCellEls.forEach((cell,i)=>{
    if(!cell) return;
    const r = cell.getBoundingClientRect();
    tileEls[i] = {x: r.left + r.width/2 - bv.left, y: r.top + r.height/2 - bv.top};
    const anchor = tileAnchorEls[i];
    if(anchor){
      const ar = anchor.getBoundingClientRect();
      buildingAnchorPos[i] = {x: ar.left + ar.width/2 - bv.left, y: ar.top + ar.height/2 - bv.top};
    }
  });
  // same measured space as tileEls above — #cardDrawLayer is a 0x0 box positioned
  // against #boardView exactly like #tokenLayer, so the Lucky Wheel/Happy Birthday
  // card (a child of that layer) needs its center as an explicit px point too, not a
  // CSS percentage (which would resolve against the layer's own zero size).
  boardCenter = {x: bv.width/2, y: bv.height/2};
  boardView.style.transform = prevTransform;
}
measureTileScreenCenters();
updateEdgeAngle();

/* ============ 3D BUILDING OVERLAY (flat layer, see .gb-building-layer note) ============ */
const buildingLayer = document.getElementById('buildingLayer');
function makeBldgMv(src, extraClass){
  const mv = document.createElement('model-viewer');
  mv.className = 'gb-bldg-mv ' + extraClass;
  mv.setAttribute('src', src);
  mv.setAttribute('disable-zoom', '');
  mv.setAttribute('interaction-prompt', 'none');
  mv.setAttribute('camera-orbit', '-30deg 68deg auto');
  mv.setAttribute('min-camera-orbit', 'auto 55deg auto');
  mv.setAttribute('max-camera-orbit', 'auto 80deg auto');
  mv.setAttribute('field-of-view', '30deg');
  mv.setAttribute('shadow-intensity', '1.2');
  mv.setAttribute('shadow-softness', '0.6');
  mv.setAttribute('exposure', '1.3');
  mv.setAttribute('environment-image', 'neutral');
  mv.setAttribute('loading', 'eager');
  return mv;
}
groupTileIdx.forEach(i=>{
  const wrap = document.createElement('div');
  wrap.className = 'gb-building';
  wrap.style.display = 'none'; // hidden until the property actually has a house built on it
  buildingLayer.appendChild(wrap);
  // mv:null — deliberately NOT created here. A <model-viewer> spins up its own WebGL
  // context and eagerly decodes a GLB the moment it's inserted into the DOM, even
  // while display:none. Creating one per property (there can be 20+) at board setup
  // means 20+ WebGL contexts and GLB decodes before a single house is ever built —
  // costly on load, and risks exceeding the browser's concurrent-WebGL-context limit
  // (commonly ~16, lower on mobile), which silently evicts older contexts and can
  // leave buildings failing to render later in the game. renderTileHouses() below
  // creates the real <model-viewer> lazily, the first time this tile actually needs
  // one (i.e. the first house going up on a hearthside/skyline board).
  tileHouseEls[i] = {el:wrap, mv:null, level:-1, sparkEl:null}; // level:-1 = nothing built yet, forces the first build to reveal + set the right model
});
function positionBuildings(){
  groupTileIdx.forEach(i=>{
    const g = tileHouseEls[i], pos = buildingAnchorPos[i];
    if(!g || !pos) return;
    g.el.style.left = pos.x+'px';
    g.el.style.top = pos.y+'px';
    // depth-sort against car tokens (see the .gb-building-layer/.gb-token-layer CSS
    // notes): a building further up the board (smaller y, "further back") should sit
    // behind a car token that's further down (larger y, "closer to camera"), and vice
    // versa, instead of every building always painting in front of or behind every car.
    g.el.style.zIndex = Math.round(pos.y);
  });
}
positionBuildings();

/* ============ CENTER PLATE + DICE ============ */
const centerArea = document.createElement('div');
centerArea.className = 'gb-center-area';
centerArea.style.left = '0'; centerArea.style.top = '0';
centerArea.style.right = '0'; centerArea.style.bottom = '0';
centerArea.style.position = 'absolute';
centerArea.innerHTML = `
  <div style="display:flex;align-items:center;gap:110px;">
    <div class="gb-cardstack"><div class="glyph" id="centerWheelGlyph">\u{1F3A1}</div><div class="lbl" id="centerWheelLbl">LUCKY WHEEL</div></div>
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div class="gb-center-logo" id="gbCenterLogo">BANKROLL</div>
      <div class="gb-mascot" id="gbMascot">\u{1F3D9}\u{FE0F}</div>
      <div class="gb-dice-row">
        <div class="gb-die one" id="die1">
          <div class="gb-die-shadow" id="die1shadow"></div>
          <div class="gb-die-jump" id="die1jump"><div class="gb-die-cube" id="die1cube"></div></div>
        </div>
        <div class="gb-die two" id="die2">
          <div class="gb-die-shadow" id="die2shadow"></div>
          <div class="gb-die-jump" id="die2jump"><div class="gb-die-cube" id="die2cube"></div></div>
        </div>
      </div>
    </div>
    <div class="gb-cardstack"><div class="glyph" id="centerBdayGlyph">\u{1F381}</div><div class="lbl" id="centerBdayLbl">HAPPY B'DAY</div></div>
  </div>
`;
boardEl.appendChild(centerArea);

/* dice pip layout per face value, standard 3x3 arrangement */
const DIE_PIPS = {
  1:[[50,50]],
  2:[[26,26],[74,74]],
  3:[[26,26],[50,50],[74,74]],
  4:[[26,26],[74,26],[26,74],[74,74]],
  5:[[26,26],[74,26],[50,50],[26,74],[74,74]],
  6:[[26,26],[74,26],[26,50],[74,50],[26,74],[74,74]]
};
/* each die is a real cube: 6 static faces built once, glued to the standard
   opposite-faces-sum-to-7 layout (1<->6, 2<->5, 3<->4). Rolling never redraws
   pips — it just rotates the cube so the right face ends up pointing at the
   viewer, same as a physical die landing. */
function buildDieFaces(cubeEl){
  cubeEl.innerHTML = '';
  for(let v=1;v<=6;v++){
    const f = mk('div',`gb-die-face f${v}`,cubeEl);
    (DIE_PIPS[v]||DIE_PIPS[1]).forEach(([x,y])=>{
      const p = mk('div','gb-pip',f);
      p.style.left = `calc(${x}% - 8px)`; p.style.top = `calc(${y}% - 8px)`;
    });
  }
}
/* cube rotation (deg) that brings each face value to point at the viewer —
   inverse of that face's own static placement transform above */
const FACE_ROT = {1:{x:0,y:0},2:{x:0,y:-90},3:{x:-90,y:0},4:{x:90,y:0},5:{x:0,y:90},6:{x:0,y:180}};
const dieRot = {die1cube:{x:0,y:0}, die2cube:{x:0,y:0}};
/* always spins forward (never snaps backward) and adds a couple of extra
   full turns per axis so the landing feels like an actual tumble */
function spinDie(cubeKey, value){
  const t = FACE_ROT[value]||FACE_ROT[1];
  const cur = dieRot[cubeKey];
  const spinsX = 1+Math.floor(Math.random()*2);
  const spinsY = 1+Math.floor(Math.random()*2);
  const baseX = Math.floor(cur.x/360)*360 + 360;
  const baseY = Math.floor(cur.y/360)*360 + 360;
  cur.x = baseX + spinsX*360 + t.x;
  cur.y = baseY + spinsY*360 + t.y;
  return cur;
}
function setDieFaceInstant(cubeEl, cubeKey, value){
  const t = FACE_ROT[value]||FACE_ROT[1];
  dieRot[cubeKey] = {x:t.x,y:t.y};
  cubeEl.style.transition = 'none';
  cubeEl.style.transform = `rotateX(${t.x}deg) rotateY(${t.y}deg)`;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ cubeEl.style.transition = ''; }));
}
/* dice roll flourish: tumble each cube to the new face, with a little hop + contact shadow */
function drawDice(a,b){
  const cube1=document.getElementById('die1cube'), cube2=document.getElementById('die2cube');
  const jump1=document.getElementById('die1jump'), jump2=document.getElementById('die2jump');
  const shadow1=document.getElementById('die1shadow'), shadow2=document.getElementById('die2shadow');
  if(!cube1||!cube2)return;
  const r1=spinDie('die1cube',a), r2=spinDie('die2cube',b);
  cube1.style.transform = `rotateX(${r1.x}deg) rotateY(${r1.y}deg)`;
  cube2.style.transform = `rotateX(${r2.x}deg) rotateY(${r2.y}deg)`;
  [jump1,jump2,shadow1,shadow2].forEach(el=>{ if(el)el.classList.remove('rolling'); });
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    [jump1,jump2,shadow1,shadow2].forEach(el=>{ if(el)el.classList.add('rolling'); });
  }));
  setTimeout(()=>{ [jump1,jump2,shadow1,shadow2].forEach(el=>{ if(el)el.classList.remove('rolling'); }); },1500);
}
window.lastRollDice = [4,3];
buildDieFaces(document.getElementById('die1cube'));
buildDieFaces(document.getElementById('die2cube'));
setDieFaceInstant(document.getElementById('die1cube'),'die1cube',4);
setDieFaceInstant(document.getElementById('die2cube'),'die2cube',3);
let __syncedDiceKey = '4,3'; // tracks which dice faces are currently drawn, so restoreState()
                              // only re-triggers the roll animation when the faces actually change

/* ============ TOKENS ============ */
const tokenEls = {};
// camera micro-zoom (see pulseCameraToActivePlayer, defined near the pan/zoom code
// below): tracked separately from the pan/zoom state itself (gbScale/gbPanX/gbPanY)
// because that state isn't declared until later in the script, while checkTurnSound()
// — which drives this — can fire from the very first refreshUI() call, before that
// declaration has run. __cameraSystemReady (set true right after the first
// resetView()) guards against calling into the pan/zoom variables too early.
let __lastCameraPid = null;
let __camPulseTimer = null;
let __cameraSystemReady = false;
const PLAYER_IDS = ['p1','p2','p3','p4','p5','p6','p7','p8'];
// Fun default names, shuffled once per page load and handed out to the 8 seats —
// used any time a player hasn't typed their own name (PLAYER_SETUP name empty).
// Colors are legacy/unused now (each player's real color comes from colorForCar()
// based on their chosen car) but kept in the tuple shape for compatibility.
const RANDOM_NAME_POOL = [
  'Penny','Baron','Rex','Ivy','Duke','Nina','Otto','Wells',
  'Cleo','Max','Zara','Jack','Mona','Leo','Ruby','Hugo',
  'Tess','Cy','Dot','Remy','Gus','Lola','Ezra','Nora'
];
const DEFAULT_COLORS = ['#e3ce6e','#ea6bab','#4fd8e0','#3fe07a','#b98af0','#ff9f5a','#e35b5b','#5a9bff'];
function shuffledDefaultNames(n){
  const pool = RANDOM_NAME_POOL.slice();
  for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  return pool.slice(0, n);
}
const PLAYER_DEFAULTS = shuffledDefaultNames(PLAYER_IDS.length).map((name,i)=>[name, DEFAULT_COLORS[i]||'#ffffff']);

/* each player's token is a real 3D GLB car (see CAR_MODELS/CAR_LIST), rendered the
   same way the house/hotel overlay renders buildings: a small upright <model-viewer>
   standing off the tilted board. A colored ring underneath keeps the player's chosen
   color readable (the model itself isn't tinted). The default car is just cycled by
   player index at startup — the real pick (from PLAYER_SETUP) is applied once the
   setup screen hands off via applyPlayerIdentity()/updateTokenAppearance(). */
function makeCarToken(color, carKey, x, y){
  const wrap = document.createElement('div');
  wrap.className = 'gb-token instant';
  wrap.style.left = x+'px'; wrap.style.top = y+'px';
  wrap.style.zIndex = Math.round(y); // depth-sort against buildings, see setTokenPos
  const facing = document.createElement('div');
  facing.className = 'car-facing';
  const art = document.createElement('div');
  art.className = 'car-token car-token-3d';
  const mv = document.createElement('model-viewer');
  mv.className = 'car-token-mv';
  const key = carKey || CAR_LIST[0].key;
  mv.setAttribute('src', CAR_MODELS[key] || CAR_MODELS[CAR_LIST[0].key]);
  mv.dataset.car = key;
  mv.setAttribute('disable-zoom', '');
  mv.setAttribute('interaction-prompt', 'none');
  const initPolar = carPolarDeg();
  mv.setAttribute('camera-orbit', `-35deg ${initPolar}deg auto`);
  mv.setAttribute('min-camera-orbit', `auto ${initPolar}deg auto`);
  mv.setAttribute('max-camera-orbit', `auto ${initPolar}deg auto`);
  mv.setAttribute('field-of-view', '28deg');
  const isClassicNow = document.documentElement.dataset.theme === 'classic';
  // classic's near-top-down camera flattens the model's silhouette, so it leans on
  // stronger, softer self-shadowing (rather than skyline's punchier 0.9) to carve out
  // the hood/roof/panel edges that give it a sense of depth from directly above.
  mv.setAttribute('shadow-intensity', isClassicNow ? '1.4' : '0.9');
  mv.setAttribute('shadow-softness', isClassicNow ? '0.75' : '0.5');
  mv.setAttribute('exposure', '1.2');
  mv.setAttribute('environment-image', 'neutral');
  mv.setAttribute('loading', 'eager');
  art.appendChild(mv);
  // setTokenPos never removes the 'hop' class it adds after each step (it only
  // re-triggers the animation for the *next* hop) — left in place, the still-matching
  // .car-token.hop rule permanently outranks the plain .car-token-3d idle-bob rule
  // below by specificity, so a token would freeze with no idle animation after its
  // very first move. Drop 'hop' once its one-shot bounce actually finishes so the
  // idle sway can take back over between moves.
  art.addEventListener('animationend', e=>{ if(e.animationName==='carHop') art.classList.remove('hop'); });
  facing.appendChild(art);
  wrap.appendChild(facing);
  wrap.__facing = facing;
  wrap.__art = art;
  wrap.__mv = mv;
  // stagger the idle bob's phase/speed/tilt per token so waiting cars sway out of
  // sync with each other instead of bobbing in unison (which reads as one shared
  // animation rather than several individually "alive" tokens). Set inline so it
  // survives theme switches, which only touch classes/attributes on this element.
  // custom properties, not the animation-delay/-duration longhands directly: this
  // same element also carries the fast .driving bob (see .car-token-3d.driving),
  // and inline longhands would keep overriding that rule's own timing even though
  // its higher-specificity "animation" shorthand wins the animation-name — CSS vars
  // referenced only from the idle rule below stay invisible to .driving instead.
  art.style.setProperty('--idle-delay', (Math.random()*2.6).toFixed(2)+'s');
  art.style.setProperty('--idle-duration', (2.4+Math.random()*0.9).toFixed(2)+'s');
  art.style.setProperty('--idle-tilt', ((Math.random()<0.5?-1:1)*(1+Math.random()*0.8)).toFixed(2)+'deg');
  tokenLayer.appendChild(wrap);
  requestAnimationFrame(()=>wrap.classList.remove('instant'));
  return wrap;
}
// The model's camera-orbit theta is fixed at -35deg for the GO tile's heading —
// that's the baseline every token is created with, and per the user it already
// looks correctly flush with the board there. For every other tile, instead of
// binning into "two diagonals" (which broke on tiles that aren't cleanly one or
// the other), we take the *exact* measured on-screen rotation of that tile's
// heading relative to GO's heading and apply that same delta to the camera's
// azimuth — a real 3D turn that tracks the board's true geometry continuously
// (jail, corners, every tile) instead of a flat, distorting 2D image transform.
// The Ukraine row (tiles 31–39, the left edge) needed an extra +180 on top of
// that — same family of fix as the GO→Jail edge — and the Manchester row
// (11–19, the right edge) turned out to need the same +180 correction too.
// The two corner tiles that sit at the start of those rows (Jail/"Just
// Visiting" at 10, and "Go To Jail" at 30) are pinned to match the first
// tile of the row they open onto �� Vancouver (11) and Odessa (31),
// respectively — rather than using their own corner-derived heading.
const CAR_BASE_THETA = -35;
// The camera's polar angle (the 2nd camera-orbit value) controls how "from-above" vs
// "from-the-side" the car reads. Skyline's board is a tilted diamond viewed somewhat
// from the side, so 72deg (close to eye-level) matches that perspective. Classic is a
// plain flat top-down square, so its cars read the same way — camera looking mostly
// straight down. Pure top-down (closer to 0deg) flattened the model into a shapeless
// square with no visible sides, so this sits a bit higher than dead-overhead: enough
// to keep the top-down read while still showing the hood/roof/side panels that give
// the model its sense of depth.
const SKYLINE_POLAR_DEG = 72;
const CLASSIC_POLAR_DEG = 34;
function carPolarDeg(){
  return document.documentElement.dataset.theme === 'classic' ? CLASSIC_POLAR_DEG : SKYLINE_POLAR_DEG;
}
// classic's own baseline: unlike CAR_BASE_THETA (tuned to sit flush against the
// diamond-tilted skyline board, which is why it's an odd-looking -35deg and not a
// straight cardinal angle), classic's board is a plain flat square, so its baseline is
// a clean cardinal angle too. Combined with classicTileHeadingDeg's clean 0/90/180/270
// deltas below, every classic heading lands on an exact cardinal value (straight
// up/right/down/left) instead of the diagonal, "tilted" look the skyline-tuned -35deg
// offset would otherwise carry over.
// -90 (rather than 0): the top row (heading 0deg) and right row (heading 90deg) were
// coming out with each other's facing — top showed the face-to-camera orientation that
// belongs on the right row's downward leg, and the right row showed the sideways
// orientation that belongs on the top row's rightward leg. The individual orientations
// were each correct, just assigned to the wrong row. Flipping delta's sign (below) and
// shifting the baseline by -90 swaps them back into the right order without disturbing
// the cardinal spacing between the four edges.
const CLASSIC_BASE_THETA = -90;
// reverseFacing flips the "direction of travel" heading 180° (used for the static
// sitting-in-jail placement) BEFORE the row-position correction below is added, not
// after. Adding the row correction and then a separate +180 reverse flip on top of it
// would cancel each other out (180+180=360=0deg), silently dropping the row correction
// for the jail car — it needs both effects to actually combine, not cancel, so the
// jailed car still gets the same row-position adjustment normal gameplay tokens on that
// row get, just facing the opposite way.
// classic's board is flat and un-rotated (no rotateZ diamond, no rotateX tilt — see
// .gb-tilt:transform:none for this theme), so unlike tileHeadingDeg (which reads the
// *measured, on-screen* angle to cope with skyline's 45deg-rotated/tilted projection),
// the heading here can be read straight off the tile grid's own row/column layout —
// always a clean 0/90/180/270, never the in-between angles the diamond board produces.
function classicTileHeadingDeg(i){
  const idx = ((i%40)+40)%40;
  const cur = posFor(idx), next = posFor((idx+1)%40);
  return Math.atan2(next.r-cur.r, next.c-cur.c)*180/Math.PI;
}
function carOrbitTheta(i, reverseFacing){
  const idx = ((i%40)+40)%40;
  if(idx===10) return carOrbitTheta(11, reverseFacing);
  if(idx===30) return carOrbitTheta(31, reverseFacing);
  const isClassic = document.documentElement.dataset.theme === 'classic';
  if(isClassic){
    // no diamond/tilt distortion to correct for here, so skip the skyline-only Ukraine/
    // Manchester-row +180 patches below — those compensate for that specific rotated
    // projection and don't apply to classic's plain square track.
    const delta = classicTileHeadingDeg(idx) - classicTileHeadingDeg(0);
    let theta = CLASSIC_BASE_THETA + delta;
    if(reverseFacing) theta += 180;
    return theta;
  }
  const delta = tileHeadingDeg(idx) - tileHeadingDeg(0);
  let theta = CAR_BASE_THETA - delta;
  if(reverseFacing) theta += 180;
  if(idx>=31 && idx<=39) theta += 180;
  if(idx>=11 && idx<=19) theta += 180;
  return theta;
}
function applyCarFacing(pid, pos, reverse){
  const wrap = tokenEls[pid];
  const mv = wrap && wrap.__mv;
  if(!mv) return;
  const theta = carOrbitTheta(pos, !!reverse);
  const polar = carPolarDeg();
  mv.setAttribute('camera-orbit', `${theta.toFixed(2)}deg ${polar}deg auto`);
  if(typeof mv.jumpCameraToGoal==='function') mv.jumpCameraToGoal();
}
// min/max-camera-orbit lock the polar angle at whatever it was when the token was
// created, so switching themes mid-game (skyline <-> classic) needs to explicitly
// re-set them on every existing token — otherwise a car created under one theme
// keeps that theme's camera angle forever, even after the board underneath it
// changes shape.
function refreshCarPolarForTheme(){
  const polar = carPolarDeg();
  const isClassicNow = document.documentElement.dataset.theme === 'classic';
  PLAYER_IDS.forEach(pid=>{
    const wrap = tokenEls[pid];
    const mv = wrap && wrap.__mv;
    if(!mv) return;
    mv.setAttribute('min-camera-orbit', `auto ${polar}deg auto`);
    mv.setAttribute('max-camera-orbit', `auto ${polar}deg auto`);
    mv.setAttribute('shadow-intensity', isClassicNow ? '1.4' : '0.9');
    mv.setAttribute('shadow-softness', isClassicNow ? '0.75' : '0.5');
    if(typeof players !== 'undefined' && players[pid]){
      applyCarFacing(pid, players[pid].pos||0, !!players[pid].inJail);
    }
  });
}
(function tokensInit(){
  const p0 = tileEls[0];
  PLAYER_IDS.forEach((pid,i)=>{const a=(i/8)*Math.PI*2; const car=CAR_LIST[i%CAR_LIST.length].key; tokenEls[pid]=makeCarToken(colorForCar(car),car,p0.x+Math.cos(a)*12,p0.y-4+Math.sin(a)*5);});
})();
/* move a token, gliding smoothly along the board; pass {instant:true} to teleport
   (jail, reset) with no glide. opts.pos (the tile index) turns the little car's 3D
   camera to face the direction it's about to travel next (see applyCarFacing/
   carOrbitTheta above) so it composes cleanly with the hop/wheel-spin animations
   that play on the inner .car-token art without one clobbering the other. Pass
   opts.reverse to flip that heading 180° — used for the static "sitting in jail"
   placement, whose facing should be the opposite of the normal go-around-the-
   board pass-through-tile-10 direction, not just a continuation of it. */
// where a token should sit on tile `pos`. The other themes' tile content leaves the
// geometric center clear, so tileEls[pos] (with the small -4px lift every call site
// already applied) is fine as-is there. Classic's tname starts right at the tile's
// vertical center (.gb-inner's 38% top padding), so anchoring dead-center like the
// other themes do sits the car right on the name label.
//
// The first attempt at fixing that reused buildingAnchorPos (the DOM-measured gap the
// building overlay lands in), but that gap sits right after the name in the tile's own
// flex flow — its measured screen position shifts by however many lines that tile's
// name happens to wrap to. On the left/right edges the tile is rotated 90deg, so that
// per-tile flex height difference becomes a *sideways* screen shift instead of a
// vertical one: the token visibly hopped left/right tile to tile instead of moving in
// a straight line.
//
// classicTokenAnchor is purely geometric instead (computed straight from the tile's
// own left/top/w/h, so it's identical for every tile on a given edge regardless of
// content) — but rather than parking it out in the accent-bar band (which read as
// "walking along the border"), it nudges a modest, fixed 8% in from dead-center, away
// from the band and toward the tile's middle. On the travel axis (the axis tiles
// change along on that edge) it stays pinned exactly on-center so movement is still a
// straight line; only the cross-axis gets the nudge.
function classicTokenAnchor(idx){
  const t = tiles[idx];
  const {r,c} = posFor(idx);
  const {left,top,w,h} = gbPos(c,r);
  if(t && t.corner) return {x:left+w/2, y:top+h*0.55};
  switch(edgeIndex(idx)){
    case 0: return {x:left+w/2,   y:top+h*0.58}; // rot-0 (top edge):    nudge down, off the top band
    case 1: return {x:left+w*0.42, y:top+h/2};   // rot-90 (right edge): nudge left, off the right band
    case 2: return {x:left+w/2,   y:top+h*0.42}; // rot-180 (bottom edge): nudge up, off the bottom band
    default:return {x:left+w*0.58, y:top+h/2};   // rot-270 (left edge): nudge right, off the left band
  }
}
function tokenAnchorPoint(pos){
  const idx = ((pos%40)+40)%40;
  const c = tileEls[idx] || tileEls[0];
  if(!c) return {x:0,y:0};
  if(document.documentElement.dataset.theme === 'classic'){
    return classicTokenAnchor(idx);
  }
  return {x:c.x, y:c.y-4};
}
function setTokenPos(pid, x, y, opts){
  opts = opts || {};
  const wrap = tokenEls[pid];
  if(!wrap) return;
  if(opts.pos!==undefined){
    applyCarFacing(pid, opts.pos, opts.reverse);
  }
  // depth-sort against buildings on every step of the move (not just on creation) —
  // see the .gb-building-layer/.gb-token-layer CSS notes. Without this the car keeps
  // whatever z-index it was created with for its entire trip around the board, so it
  // either always paints in front of every hotel it passes (looking like it's driving
  // straight over the roof) or always behind, instead of properly tucking behind a
  // house model on a tile further back and popping in front of one further forward.
  wrap.style.zIndex = Math.round(y);
  if(opts.instant){
    wrap.classList.add('instant');
    wrap.style.left = x+'px'; wrap.style.top = y+'px';
    void wrap.offsetWidth;
    requestAnimationFrame(()=>wrap.classList.remove('instant'));
  } else {
    wrap.classList.remove('instant');
    wrap.style.left = x+'px'; wrap.style.top = y+'px';
  }
  if(opts.hop!==false && wrap.__art){
    const art = wrap.__art;
    art.classList.remove('hop');
    void art.getBoundingClientRect();
    requestAnimationFrame(()=>requestAnimationFrame(()=>art.classList.add('hop')));
  }
}
function setTokenDriving(pid, on){
  const wrap = tokenEls[pid];
  if(wrap && wrap.__art) wrap.__art.classList.toggle('driving', !!on);
}

/* ---- remote token animation (for clients replaying state synced from the host) ---- */
const remoteAnimPos = {};
const remoteAnimTimers = {};
function placeTokenInstant(pid, pos, hop, reverse){
  const c = tileEls[pos] || tileEls[0];
  if(!c || !tokenEls[pid]) return;
  const p = tokenAnchorPoint(pos);
  const off = ((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
  setTokenPos(pid, p.x+off, p.y, {instant:true, hop:hop!==false, pos, reverse});
  remoteAnimPos[pid] = pos;
}
function glideTokenRemote(pid, toPos){
  if(!tokenEls[pid]) return;
  if(remoteAnimTimers[pid]){ clearTimeout(remoteAnimTimers[pid]); remoteAnimTimers[pid]=null; }
  const known = remoteAnimPos[pid];
  if(known===undefined){ placeTokenInstant(pid, toPos, false); return; }
  const steps = (toPos-known+40)%40;
  if(steps===0) return;
  if(steps>12){ placeTokenInstant(pid, toPos, true); return; }
  let pos = known, remaining = steps;
  setTokenDriving(pid, true);
  const stepOnce = ()=>{
    if(remaining<=0){ setTokenDriving(pid,false); remoteAnimTimers[pid]=null; return; }
    pos = (pos+1)%40;
    remoteAnimPos[pid] = pos;
    const c = tileEls[pos];
    const off = ((PLAYER_IDS.indexOf(pid)%4)-1.5)*9;
    if(c){ const p = tokenAnchorPoint(pos); setTokenPos(pid, p.x+off, p.y, {pos}); }
    playFootstepSound();
    if(pos===0) playRentSound(); // passing/landing on GO — mirrors the money sound the active roller hears locally
    remaining--;
    remoteAnimTimers[pid] = setTimeout(stepOnce, 280);
  };
  stepOnce();
}
function syncTokenVisibility(){
  PLAYER_IDS.forEach(pid=>{
    const wrap = tokenEls[pid];
    if(!wrap) return;
    wrap.style.display = (players[pid].active && !players[pid].bankrupt) ? '' : 'none';
  });
}
/* updates a token's car model if the player picked a different car. `color` is
   kept as a parameter for backward compatibility with existing call sites but is
   no longer applied to the token itself (the board no longer shows a color ring). */
function updateTokenAppearance(pid, color, car){
  const wrap = tokenEls[pid];
  if(!wrap) return;
  const key = car || (wrap.__mv && wrap.__mv.dataset.car) || CAR_LIST[0].key;
  if(wrap.__mv && wrap.__mv.dataset.car !== key){
    wrap.__mv.setAttribute('src', CAR_MODELS[key] || CAR_MODELS[CAR_LIST[0].key]);
    wrap.__mv.dataset.car = key;
  }
}
// kept as an alias — a couple of call sites below still say "recolorToken"
const recolorToken = updateTokenAppearance;

/* no-op stand-ins: the SVG renderer used to auto-shrink label text to fit; plain HTML
   just wraps/clamps via CSS, so there's nothing left for these to do. Kept as no-ops
   because a few call sites elsewhere still invoke them. */
function fitLabelText(){ return 1; }
function fitPriceBackdrop(){}
function fitAllTileLabels(){}
