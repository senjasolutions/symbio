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

  /** No-op placeholder — the /api/v1/summary endpoint no longer exists. SSR values remain without polling. */
  var refresh = function(){};

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

// Log viewer auto-refresh toggle
(function() {
  var toggle = document.getElementById('logAutoRefresh');
  var output = document.getElementById('logOutput');
  if (!toggle || !output) return;
  var key = 'symbio-log-auto-refresh';
  var saved = localStorage.getItem(key) === 'true';
  toggle.checked = saved;
  var timer = null;
  var doRefresh = function() {
    if (!toggle.checked) return;
    var url = output.getAttribute('data-refresh-url');
    if (!url) return;
    fetch(url).then(function(r) { return r.text(); }).then(function(html) {
      output.innerHTML = html;
    }).catch(function(){});
  };
  toggle.addEventListener('change', function() {
    localStorage.setItem(key, toggle.checked);
    if (toggle.checked) { timer = setInterval(doRefresh, 10000); }
    else { if (timer) clearInterval(timer); timer = null; }
  });
  if (saved) timer = setInterval(doRefresh, 10000);
})();
