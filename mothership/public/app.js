/** Progressive status polling updates dashboard summary values without owning page navigation or forms. */

(() => {
  // Marks enhancement availability before enabling the compact mobile menu;
  // without JavaScript the full navigation deliberately remains visible.
  document.documentElement.classList.add("js-enabled");

  const menuToggle = document.querySelector("[data-menu-toggle]");
  const navigation = document.querySelector("#primary-navigation");
  if (menuToggle && navigation) {
    menuToggle.addEventListener("click", () => {
      const isCollapsed = navigation.classList.toggle("is-collapsed");
      menuToggle.setAttribute("aria-expanded", String(!isCollapsed));
    });
  }

  const targets = document.querySelectorAll("[data-summary-key]");

  /** Applies shallow JSON fields to marked nodes while preserving SSR as the initial and fallback state. */
  const refresh = async () => {
    try {
      const response = await fetch("/api/v1/summary", { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (!response.ok) return;
      const payload = await response.json();
      targets.forEach((target) => {
        const key = target.getAttribute("data-summary-key");
        if (key && payload[key] !== undefined && payload[key] !== null) target.textContent = String(payload[key]);
      });
    } catch {
      // The server-rendered values remain visible when polling is unavailable.
    }
  };

  // Forms still need their enhancements on pages without dashboard summary nodes.
  if (targets.length && window.fetch) setInterval(refresh, 30_000);

  // Tagify is optional: this enhancement retains the ordinary comma-separated input for no-JS use.
  const tagInput = document.querySelector("#tagNames");
  if (tagInput && window.Tagify) {
    try {
      const whitelist = JSON.parse(tagInput.getAttribute("data-tag-whitelist") || "[]");
      new window.Tagify(tagInput, { whitelist, enforceWhitelist: false, maxTags: 10, dropdown: { enabled: 1, maxItems: 10 } });
    } catch {
      // Invalid embedded configuration leaves the normal input fully usable.
    }
  }

  // Confirmation remains an enhancement; all actions still submit as ordinary SSR forms.
  document.querySelectorAll("[data-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.getAttribute("data-confirm"))) event.preventDefault();
    });
  });
})();
