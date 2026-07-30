/**
 * config.js — Cargador y Gestor de Configuración Whitelabel para el Frontend
 */
(function () {
  window.APP_CONFIG = {
    appName: "SEGUCar",
    brandNameHtml: "SEGU<em>Car</em>",
    producerName: "Productor Asesor de Seguros",
    logoSvg: `<svg class="brand-logo-icon" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" stroke-width="6" stroke-dasharray="210 50" stroke-linecap="round" transform="rotate(-40 50 50)"/>
      <path d="M 30 52 L 34 40 C 35 37 38 35 42 35 L 58 35 C 62 35 65 37 66 40 L 70 52 C 73 53 75 55 75 59 L 75 66 C 75 68 73 70 71 70 L 69 70 C 67 70 65 68 65 66 L 65 64 L 35 64 L 35 66 C 35 68 33 70 31 70 L 29 70 C 27 70 25 68 25 66 L 25 59 C 25 55 27 53 30 52 Z M 37 43 L 63 43 L 60 48 L 40 48 Z M 34 57 C 36.2 57 38 55.2 38 53 C 38 50.8 36.2 49 34 49 C 31.8 49 30 50.8 30 53 C 30 55.2 31.8 57 34 57 Z M 66 57 C 68.2 57 70 55.2 70 53 C 70 50.8 68.2 49 66 49 C 63.8 49 62 50.8 62 53 C 62 55.2 63.8 57 66 57 Z" fill="currentColor"/>
    </svg>`
  };

  async function applyConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data.appName) window.APP_CONFIG.appName = data.appName;
        if (data.brandNameHtml) window.APP_CONFIG.brandNameHtml = data.brandNameHtml;
        if (data.producerName) window.APP_CONFIG.producerName = data.producerName;
        if (data.logoSvg) window.APP_CONFIG.logoSvg = data.logoSvg;
      }
    } catch (e) {
      console.log('Usando configuración local de marca por defecto.');
    }

    renderBranding();
  }

  function renderBranding() {
    const brandElements = document.querySelectorAll('.brand');
    brandElements.forEach(brandEl => {
      brandEl.innerHTML = `${window.APP_CONFIG.logoSvg}<span class="brand-text">${window.APP_CONFIG.brandNameHtml}</span>`;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyConfig);
  } else {
    applyConfig();
  }
})();
