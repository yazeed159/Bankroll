/* ============ THEME SWITCHER (Modern / Classic look) ============
   One game, one name/brand throughout — only the visual skin changes.
   Everything visual is handled by the [data-theme="..."]-scoped CSS above;
   this just tracks which skin is active, updates the picker/label UI,
   remembers the choice, and — since switching is allowed at any point,
   including mid-game — live-refreshes the handful of things JS colors
   directly instead of through CSS. */
const THEMES = {
  skyline: { label: 'Modern',  shortLabel: 'Modern'  },
  hearthside: { label: 'Golden', shortLabel: 'Golden' },
  classic: { label: 'Classic', shortLabel: 'Classic' }
};
const THEME_ORDER = ['skyline', 'hearthside', 'classic'];
const THEME_STORAGE_KEY = 'propertyTraderTheme';

function applyTheme(name){
  if(!THEMES[name]) name = 'skyline';
  const t = THEMES[name];
  document.documentElement.setAttribute('data-theme', name);
  const setText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
  setText('topbarThemeLabel', `Theme: ${t.shortLabel}`);
  document.querySelectorAll('.theme-pick-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.themePick === name);
  });
  try{ localStorage.setItem(THEME_STORAGE_KEY, name); }catch(e){}
  // live-refresh the handful of things JS colors directly (everything else
  // is plain CSS and updates itself the instant data-theme changes) — this
  // is what makes switching safe to do at any point mid-game, not just
  // from the start screen.
  // Each of these is independently try/caught (not swallowed silently —
  // logged, so a real problem is actually debuggable instead of invisible)
  // so a failure in one can never block the others: e.g. a stale-geometry
  // hiccup in resetView() shouldn't be able to stop refreshCarPolarForTheme()
  // from running, and vice versa.
  if(typeof refreshUI === 'function'){ try{ refreshUI(); }catch(e){ console.error('applyTheme: refreshUI failed', e); } }
  if(typeof tiles !== 'undefined' && typeof markOwnership === 'function' && typeof players !== 'undefined'){
    try{ tiles.forEach((tl,i)=>{ if(tl.owner && players[tl.owner]) markOwnership(i, teamDisplayColor(tl.owner)); }); }catch(e){ console.error('applyTheme: markOwnership refresh failed', e); }
  }
  // the two skins use very different board geometry (tilted diamond vs. flat
  // square), so the camera needs to re-fit itself the instant the theme
  // changes rather than keeping whatever pan/zoom was set for the old shape
  if(typeof resetView === 'function'){ try{ resetView(); }catch(e){ console.error('applyTheme: resetView failed', e); } }
  // and the cars' own camera angle (top-down for classic, eye-level for
  // skyline) needs the same live refresh — see refreshCarPolarForTheme.
  if(typeof refreshCarPolarForTheme === 'function'){ try{ refreshCarPolarForTheme(); }catch(e){ console.error('applyTheme: refreshCarPolarForTheme failed', e); } }
}
function setGameTheme(name){ applyTheme(name); }
function cycleGameTheme(){
  const cur = currentThemeName();
  const idx = THEME_ORDER.indexOf(cur);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  applyTheme(next);
}
(function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem(THEME_STORAGE_KEY); }catch(e){}
  applyTheme(saved && THEMES[saved] ? saved : 'skyline');
})();
