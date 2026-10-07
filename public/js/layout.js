// layout.js - shared topbar, sidebar state, merchant profile
(function(){
  window.__sharedLayoutBindings = true;
  const SIDEBAR_KEY = 'di_sidebar_collapsed';
  const MOBILE_LAYOUT_QUERY = "(max-width: 900px), (max-width: 1024px) and (max-height: 500px) and (orientation: landscape)";
  const mobileLayoutQueryList = window.matchMedia(MOBILE_LAYOUT_QUERY);
  const SIDEBAR_ITEMS = [
    { key: "overview", href: "./dashboard.html", icon: "🏠", label: "Overview" },
    { key: "products", href: "./dashboard.html#products", icon: "🧴", label: "Products" },
    { key: "recommendations", href: "./dashboard.html#recommendations", icon: "💡", label: "Recommendations" },
    { key: "customers", href: "./dashboard.html#customers", icon: "👥", label: "Customers" },
    { key: "segments", href: "./segment.html", icon: "📊", label: "Segments" },
    { key: "imports", href: "./imports.html", icon: "📥", label: "CSV Imports" }
  ];

  function bindMobileSidebarLinks(){
    const sidebar = getSidebar();
    if(!sidebar) return;

    sidebar.querySelectorAll('a.nav-link').forEach((link) => {
      if(link.dataset.mobileNavBound === 'true') return;
      link.dataset.mobileNavBound = 'true';
      link.addEventListener('click', () => {
        if(!isMobileViewport()) return;
        closeMobileDrawer({ restoreFocus: false });
      });
    });
  }

  function renderSharedSidebar(){
    const sidebar = document.querySelector("aside.sidebar[data-di-sidebar]");
    if(!sidebar || sidebar.dataset.diSidebarRendered === "1") return;

    const activeKey = document.body?.dataset?.diActiveNav || "";
    const navHtml = SIDEBAR_ITEMS.map((item) => {
      const isActive = item.key === activeKey;
      return `<a href="${item.href}" class="nav-link${isActive ? " active" : ""}" title="${item.label}"${isActive ? ' aria-current="page"' : ""}><span class="nav-icon">${item.icon}</span><span class="label">${item.label}</span></a>`;
    }).join("");

    sidebar.innerHTML = `
      <div class="sidebar-brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" role="img" focusable="false">
            <path d="M6.5 8.5c0-1.1.9-2 2-2h7c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2h-7c-1.1 0-2-.9-2-2v-7Z" stroke="currentColor" stroke-width="1.8"/>
            <path d="M9 10.25h6M9 13.75h4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </div>
        <div>
          <h2>Derma Insight</h2>
          <p>Merchant dashboard</p>
        </div>
      </div>
      <nav class="sidebar-nav" aria-label="Dashboard navigation">
        ${navHtml}
      </nav>
      <button class="btn btn-logout" id="logoutBtn" type="button">Logout</button>
    `;

    sidebar.dataset.diSidebarRendered = "1";
    bindMobileSidebarLinks();
  }

  function isSidebarCollapsed(){ return localStorage.getItem(SIDEBAR_KEY) === '1'; }
  function isMobileViewport(){ return mobileLayoutQueryList.matches; }
  function getSidebar(){ return document.querySelector('.sidebar'); }
  function syncDesktopSidebarPreference(sidebar, mobile){
    if(!sidebar) return;
    sidebar.classList.toggle('collapsed', !mobile && isSidebarCollapsed());
  }
  function setBodyScrollLock(locked){
    document.body.classList.toggle('sidebar-drawer-open', locked);
  }
  function closeMobileDrawer(options = {}){
    const { restoreFocus = false } = options;
    const sidebar = getSidebar();
    const overlay = document.getElementById('sidebarMobileOverlay');
    const toggle = document.getElementById('sidebarToggle');
    if(sidebar) sidebar.classList.remove('mobile-open');
    if(overlay) overlay.classList.remove('visible');
    if(toggle) toggle.setAttribute('aria-expanded', 'false');
    setBodyScrollLock(false);
    if(restoreFocus && toggle) toggle.focus();
  }
  function openMobileDrawer(){
    const sidebar = getSidebar();
    const toggle = document.getElementById('sidebarToggle');
    const merchantMenu = document.getElementById('merchantMenu');
    const merchantBtn = document.getElementById('merchantBtn');
    if(!sidebar) return;
    sidebar.classList.add('mobile-open');
    const overlay = createMobileOverlay();
    overlay.classList.add('visible');
    if(merchantMenu) merchantMenu.classList.add('hidden');
    if(merchantBtn) merchantBtn.setAttribute('aria-expanded', 'false');
    if(toggle) toggle.setAttribute('aria-expanded', 'true');
    setBodyScrollLock(true);
  }
  function applySidebarState(){
    const sidebar = getSidebar();
    if(!sidebar) return;
    syncDesktopSidebarPreference(sidebar, isMobileViewport());
    closeMobileDrawer();
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
    const sidebar = getSidebar();
    if(!sidebar) return;
    const toggle = document.getElementById('sidebarToggle');
    const mobile = isMobileViewport();

    if(!mobile){
      syncDesktopSidebarPreference(sidebar, mobile);
      closeMobileDrawer();
      if(toggle) toggle.setAttribute('aria-pressed', String(sidebar.classList.contains('collapsed')));
      return;
    }

    syncDesktopSidebarPreference(sidebar, mobile);

    if(sidebar.classList.contains('mobile-open')){
      if(toggle) toggle.setAttribute('aria-expanded', 'true');
      setBodyScrollLock(true);
      return;
    }

    if(toggle) toggle.setAttribute('aria-expanded', 'false');
    setBodyScrollLock(false);
  }

  function setupSidebarToggle(){
    const toggle = document.getElementById('sidebarToggle');
    if(!toggle || toggle.dataset.diSidebarToggleBound === '1') return;
    toggle.dataset.diSidebarToggleBound = '1';
    toggle.addEventListener('click', ()=>{
      const sidebar = getSidebar(); if(!sidebar) return;
      const isMobile = isMobileViewport();
      if(isMobile){
        const open = !sidebar.classList.contains('mobile-open');
        if(open) openMobileDrawer(); else closeMobileDrawer();
        return;
      }

      syncSidebarMode();
      const collapsed = sidebar.classList.toggle('collapsed');
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      // announce for screen readers
      toggle.setAttribute('aria-pressed', String(collapsed));
    });

    const overlay = createMobileOverlay();
    if(overlay.dataset.diOverlayBound !== '1'){
      overlay.onclick = ()=>{ closeMobileDrawer({ restoreFocus: true }); };
      overlay.dataset.diOverlayBound = '1';
    }

    bindMobileSidebarLinks();

    const handleViewportChange = ()=>{
      closeMobileDrawer();
      syncSidebarMode();
    };

    // close mobile sidebar with escape key
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape'){
        const sidebar = getSidebar();
        if(sidebar && sidebar.classList.contains('mobile-open')) closeMobileDrawer({ restoreFocus: true });
      }
    });

    if(typeof mobileLayoutQueryList.addEventListener === 'function'){
      mobileLayoutQueryList.addEventListener('change', handleViewportChange);
    }else if(typeof mobileLayoutQueryList.addListener === 'function'){
      mobileLayoutQueryList.addListener(handleViewportChange);
    }

    window.addEventListener('orientationchange', handleViewportChange);
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
    if(!merchantBtn || merchantBtn.dataset.diMerchantMenuBound === '1') return;
    merchantBtn.dataset.diMerchantMenuBound = '1';
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
    document.addEventListener('keydown', (e)=>{
      if(e.key !== 'Escape' || !merchantMenu || merchantMenu.classList.contains('hidden')) return;
      merchantMenu.classList.add('hidden');
      merchantBtn.setAttribute('aria-expanded', 'false');
      merchantBtn.focus();
    });
    // logout small
    const logoutSmall = document.getElementById('logoutBtnSmall');
    if(logoutSmall){ logoutSmall.addEventListener('click', ()=>{ localStorage.removeItem('merchantToken'); localStorage.removeItem('merchantData'); window.location.href = '/index.html'; }); }
  }

  function setupSidebarLogout(){
    const logoutBtn = document.getElementById('logoutBtn');
    if(!logoutBtn || logoutBtn.dataset.diLogoutBound === '1') return;
    if(typeof logoutMerchant !== 'function') return;

    logoutBtn.addEventListener('click', ()=>{ logoutMerchant(); });
    logoutBtn.dataset.diLogoutBound = '1';
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    renderSharedSidebar();
    setupSidebarLogout();
    applySidebarState(); setupSidebarToggle(); renderMerchantProfile(); setupMerchantMenu();
    syncSidebarMode();
  });
})();