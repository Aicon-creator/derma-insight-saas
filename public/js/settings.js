// Settings page - load/save business name and logo to localStorage
(function(){
  const form = document.getElementById('settingsForm');
  const businessNameInput = document.getElementById('businessName');
  const logoInput = document.getElementById('logoInput');
  const logoPreview = document.getElementById('logoPreview');
  const saveBtn = document.getElementById('saveSettings');
  const cancelBtn = document.getElementById('cancelSettings');

  function loadMerchantData(){
    try{
      const raw = localStorage.getItem('merchantData');
      if(!raw) return {};
      return JSON.parse(raw);
    }catch(e){return {}};
  }

  function renderPreview(dataUrl){
    if(!dataUrl){ logoPreview.innerHTML = '' ; return; }
    logoPreview.innerHTML = `<img src="${dataUrl}" alt="Logo preview" style="max-width:160px;max-height:80px;border-radius:8px;border:1px solid rgba(0,0,0,0.06)"/>`;
  }

  const data = loadMerchantData();
  businessNameInput.value = data.businessName || data.merchant?.businessName || '';
  if(data.logoDataUrl) renderPreview(data.logoDataUrl);

  logoInput.addEventListener('change', async (e)=>{
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      const dataUrl = reader.result;
      renderPreview(dataUrl);
      // stash temporarily on form element
      form.dataset.logo = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  saveBtn.addEventListener('click', (ev)=>{
    ev.preventDefault();
    const name = businessNameInput.value.trim();
    if(!name){ alert('Please enter a business name'); return; }
    const md = loadMerchantData();
    md.businessName = name;
    if(form.dataset.logo) md.logoDataUrl = form.dataset.logo;
    localStorage.setItem('merchantData', JSON.stringify(md));
    // show toast
    const t = document.createElement('div'); t.className='toast'; t.textContent='Settings saved locally'; document.body.appendChild(t);
    setTimeout(()=>t.remove(),2500);
  });

  cancelBtn.addEventListener('click', ()=>{
    window.location.href='./dashboard.html';
  });
})();