// layout.js - shared topbar, sidebar state, merchant profile
(function(){
  window.__sharedLayoutBindings = true;
  const SIDEBAR_KEY = 'di_sidebar_collapsed';
  function isSidebarCollapsed(){ return localStorage.getItem(SIDEBAR_KEY) === '1'; }
  function applySidebarState(){
    const sidebar = document.querySelector('.sidebar');
    if(!sidebar) return;
    // Desktop collapsed state
    if(isSidebarCollapsed()) sidebar.classList.add('collapsed'); else sidebar.classList.remove('collapsed');
    // Ensure mobile-specific class is removed on load
    sidebar.classList.remove('mobile-open');
    // remove any overlay if present
    const overlay = document.getElementById('sidebarMobileOverlay');
    if(overlay) overlay.remove();
  }

  function createMobileOverlay(){
    let overlay = document.getElementById('sidebarMobileOverlay');
    if(!overlay){
      overlay = document.createElement('div');
      overlay.id = 'sidebarMobileOverlay';
      overlay.className = 'sidebar-mobile-overlay';
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function syncSidebarMode(){
    const sidebar = document.querySelector('.sidebar');
    if(!sidebar) return;

    if(window.innerWidth > 640){
      sidebar.classList.remove('mobile-open');
      const overlay = document.getElementById('sidebarMobileOverlay');
      if(overlay){
        overlay.classList.remove('visible');
      }
      const toggle = document.getElementById('sidebarToggle');
      if(toggle){
        toggle.setAttribute('aria-pressed', 'false');
      }
    }
  }

  function setupSidebarToggle(){
    const toggle = document.getElementById('sidebarToggle');
    if(!toggle) return;
    toggle.addEventListener('click', ()=>{
      const sidebar = document.querySelector('.sidebar'); if(!sidebar) return;
      const isMobile = window.innerWidth <= 640;
      if(isMobile){
        const open = sidebar.classList.toggle('mobile-open');
        const overlay = createMobileOverlay();
        if(open){
          overlay.classList.add('visible');
          overlay.onclick = ()=>{
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('visible');
            toggle.setAttribute('aria-pressed','false');
          };
          toggle.setAttribute('aria-pressed','true');
        } else {
          overlay.classList.remove('visible');
          toggle.setAttribute('aria-pressed','false');
        }
        return;
      }

      syncSidebarMode();
      const collapsed = sidebar.classList.toggle('collapsed');
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      // announce for screen readers
      toggle.setAttribute('aria-pressed', String(collapsed));
    });

    // close mobile sidebar with escape key
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape'){
        const sidebar = document.querySelector('.sidebar');
        if(sidebar && sidebar.classList.contains('mobile-open')){
          sidebar.classList.remove('mobile-open');
          const overlay = document.getElementById('sidebarMobileOverlay');
          if(overlay) overlay.classList.remove('visible');
          toggle.setAttribute('aria-pressed','false');
        }
      }
    });
  }
  function renderMerchantProfile(){
    try{
      const raw = localStorage.getItem('merchantData'); if(!raw) return;
      const md = JSON.parse(raw);
      const nameEl = document.getElementById('merchantName');
      const avatarEl = document.getElementById('merchantAvatar');
      if(nameEl && md.businessName) nameEl.textContent = md.businessName;
      if(avatarEl){
        if(md.logoDataUrl){ avatarEl.innerHTML = `<img src="${md.logoDataUrl}" alt="Logo" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`; }
        else if(md.businessName){ const initials = md.businessName.split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase(); avatarEl.textContent = initials; }
      }
    }catch(e){/* silent */}
  }
  function setupMerchantMenu(){
    const merchantBtn = document.getElementById('merchantBtn');
    const merchantMenu = document.getElementById('merchantMenu');
    if(!merchantBtn) return;
    merchantBtn.addEventListener('click', ()=>{
      const expanded = merchantBtn.getAttribute('aria-expanded') === 'true';
      merchantBtn.setAttribute('aria-expanded', String(!expanded));
      if(merchantMenu) merchantMenu.classList.toggle('hidden');
    });
    // keyboard support for merchant button
    merchantBtn.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        merchantBtn.click();
      }
    });
    window.addEventListener('click', (ev)=>{
      if(!merchantBtn.contains(ev.target) && merchantMenu && !merchantMenu.contains(ev.target)){
        merchantMenu.classList.add('hidden');
        merchantBtn.setAttribute('aria-expanded','false');
      }
    });
    // logout small
    const logoutSmall = document.getElementById('logoutBtnSmall');
    if(logoutSmall){ logoutSmall.addEventListener('click', ()=>{ localStorage.removeItem('merchantToken'); localStorage.removeItem('merchantData'); window.location.href = '/index.html'; }); }
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    applySidebarState(); setupSidebarToggle(); renderMerchantProfile(); setupMerchantMenu();
    syncSidebarMode();
    window.addEventListener('resize', syncSidebarMode);
  });
})();