/* ============ ACCESSIBILITY: modal semantics, focus management, ============
   ============ live-region announcements, keyboard shortcuts   ============

   Everything here is additive and generic — it works off the existing
   .trade-overlay/.confirm-overlay/.start-overlay + "show"/"hide" class
   convention already used throughout index.html, so it doesn't require
   touching every individual open/close call site in game.js. */

(function(){

  /* ---------- 1) aria-live region for toast notifications ----------
     showToast() (game.js) already funnels every rent/card/bankruptcy/etc.
     event through #toastStack — turning that into a live region means
     screen readers announce those events automatically, with no changes
     needed anywhere events are fired. */
  function setupToastLiveRegion(){
    const stack = document.getElementById('toastStack');
    if(!stack) return;
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    stack.setAttribute('role', 'status');
  }

  /* ---------- 2) modal dialog semantics ----------
     Every overlay in this game follows one of two markup shapes:
       <div class="trade-overlay" id="...">
         <div class="trade-modal" ...> ... <div class="confirm-title|cfg-title">Title</div> ... </div>
       </div>
     or the start screen's .start-overlay > .start-modal, or the confirm
     dialog's .confirm-overlay > .confirm-modal. Tag each modal box with
     role="dialog" + aria-modal="true", and point aria-labelledby at
     whichever title element it contains (giving that title an id if it
     doesn't already have one). */
  function setupDialogRoles(){
    const modalSelectors = ['.trade-modal', '.confirm-modal', '.start-modal'];
    document.querySelectorAll(modalSelectors.join(',')).forEach(modal=>{
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      if(!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
      const titleEl = modal.querySelector('.confirm-title, .cfg-title');
      if(titleEl){
        if(!titleEl.id) titleEl.id = 'a11y-title-' + Math.random().toString(36).slice(2, 9);
        modal.setAttribute('aria-labelledby', titleEl.id);
      }
    });
  }

  /* ---------- 3) focus management on open/close ----------
     Watches every overlay for the class change that shows/hides it, and:
       - on open: remembers what had focus, moves focus into the modal,
         and traps Tab/Shift+Tab inside it
       - on close: restores focus to whatever triggered the modal
     #startOverlay is visible by default and hidden by adding "hide";
     every other overlay is hidden by default and shown by adding "show" —
     both conventions are handled below. */
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const openStack = []; // ids of currently-open overlays, most recent last
  const lastFocused = {}; // overlayId -> element to restore focus to

  function isVisible(overlay){
    if(overlay.id === 'startOverlay') return !overlay.classList.contains('hide');
    return overlay.classList.contains('show');
  }

  function onOverlayOpened(overlay){
    if(openStack.includes(overlay.id)) return;
    openStack.push(overlay.id);
    lastFocused[overlay.id] = document.activeElement;
    const modal = overlay.querySelector('.trade-modal, .confirm-modal, .start-modal');
    if(!modal) return;
    const focusables = modal.querySelectorAll(FOCUSABLE);
    // small delay so display/opacity transitions don't fight the focus call in some browsers
    setTimeout(()=>{
      (focusables[0] || modal).focus();
    }, 30);
  }

  function onOverlayClosed(overlay){
    const idx = openStack.indexOf(overlay.id);
    if(idx !== -1) openStack.splice(idx, 1);
    const toRestore = lastFocused[overlay.id];
    delete lastFocused[overlay.id];
    if(toRestore && document.contains(toRestore) && typeof toRestore.focus === 'function'){
      toRestore.focus();
    }
  }

  function observeOverlays(){
    document.querySelectorAll('.trade-overlay, .confirm-overlay, .start-overlay').forEach(overlay=>{
      let wasVisible = isVisible(overlay);
      const mo = new MutationObserver(()=>{
        const nowVisible = isVisible(overlay);
        if(nowVisible && !wasVisible) onOverlayOpened(overlay);
        else if(!nowVisible && wasVisible) onOverlayClosed(overlay);
        wasVisible = nowVisible;
      });
      mo.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // Tab-trap + Escape-to-close for whichever overlay is topmost on the stack.
  document.addEventListener('keydown', e=>{
    if(openStack.length === 0) return;
    const topId = openStack[openStack.length - 1];
    const overlay = document.getElementById(topId);
    if(!overlay) return;
    const modal = overlay.querySelector('.trade-modal, .confirm-modal, .start-modal');
    if(!modal) return;

    if(e.key === 'Tab'){
      const focusables = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el=>el.offsetParent !== null);
      if(focusables.length === 0) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if(e.shiftKey && document.activeElement === first){
        e.preventDefault(); last.focus();
      }else if(!e.shiftKey && document.activeElement === last){
        e.preventDefault(); first.focus();
      }
    }else if(e.key === 'Escape'){
      // Prefer an explicit close (×) button; fall back to a "Cancel"/"No" button
      // (the confirm dialog uses .buy-btn.no instead of .trade-close).
      const closeBtn = modal.querySelector('.trade-close') || modal.querySelector('.buy-btn.no');
      if(closeBtn){ e.preventDefault(); closeBtn.click(); }
    }
  });

  /* ---------- 4) keyboard shortcuts — left hand only ----------
     Every shortcut lives in the QWERASDFZXC cluster plus Space, all reachable
     from a hand resting near the home row without stretching to Enter, the
     arrow keys, or anywhere on the right side of the board — so the other
     hand (mouse, controller, whatever) never has to touch the keyboard.
       Space - roll / buy / end turn   Q - buy / buy it out
       R     - pay bail                A - send to auction / decline
                                    X - cancel a pending pick (teleport etc.)
       C     - open/close power cards
     Only fires during active gameplay — never while a modal is open or while
     typing in any text field (chat, trade amounts, room code, etc.). */
  function isTypingTarget(el){
    if(!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function clickIfActionable(btn){
    if(!btn || btn.disabled) return false;
    if(btn.offsetParent === null) return false; // hidden (display:none or detached)
    btn.click();
    return true;
  }

  document.addEventListener('keydown', e=>{
    if(openStack.length > 0) return; // a modal is open — let it handle its own keys
    if(isTypingTarget(e.target)) return;
    if(e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if(key === ' ' || e.code === 'Space'){
      // whichever action is actually available right now — roll while a roll
      // is pending, then buy/buy-out if a purchase prompt is up, then end
      // turn once neither is — never more than one at once, same fallthrough
      // pattern as Q (buy/buy-out) below
      if(clickIfActionable(document.getElementById('rollBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('buyYesBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('buyoutYesBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('endTurnBtn'))) e.preventDefault();
    }else if(key === 'q'){
      // whichever "yes" action is currently on screen — buying a fresh
      // property or buying out an opponent's — never both at once
      if(clickIfActionable(document.getElementById('buyYesBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('buyoutYesBtn'))) e.preventDefault();
    }else if(key === 'a'){
      if(clickIfActionable(document.getElementById('buyNoBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('buyoutNoBtn'))) e.preventDefault();
    }else if(key === 'r'){
      if(clickIfActionable(document.getElementById('bailBtn'))) e.preventDefault();
    }else if(key === 'x'){
      if(clickIfActionable(document.getElementById('teleportCancelBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('sabotageCancelBtn'))) e.preventDefault();
      else if(clickIfActionable(document.getElementById('propertySwapCancelBtn'))) e.preventDefault();
    }else if(key === 'c'){
      if(clickIfActionable(document.getElementById('powerCardsBtn'))) e.preventDefault();
    }else if(key === 'z'){
      if(clickIfActionable(document.getElementById('autoPlayBtn'))) e.preventDefault();
    }
  });

  function init(){
    setupToastLiveRegion();
    setupDialogRoles();
    observeOverlays();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  }else{
    init();
  }

})();
