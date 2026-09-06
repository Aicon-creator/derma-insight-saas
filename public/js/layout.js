// layout.js - shared topbar, sidebar state, merchant profile
(function(){
  window.__sharedLayoutBindings = true;
  const SIDEBAR_KEY = 'di_sidebar_collapsed';
  const SIDEBAR_ITEMS = [
    { key: "overview", href: "./dashboard.html", icon: "🏠", label: "Overview" },
    { key: "products", href: "./dashboard.html#products", icon: "🧴", label: "Products" },
    { key: "recommendations", href: "./dashboard.html#recommendations", icon: "💡", label: "Recommendations" },
    { key: "customers", href: "./dashboard.html#customers", icon: "👥", label: "Customers" },
    { key: "segments", href: "./segment.html", icon: "📊", label: "Segments" },
    { key: "imports", href: "./imports.html", icon: "📥", label: "CSV Imports" }
  ];

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
  }

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
    renderSharedSidebar();
    applySidebarState(); setupSidebarToggle(); renderMerchantProfile(); setupMerchantMenu();
    syncSidebarMode();
    window.addEventListener('resize', syncSidebarMode);
  });
})();