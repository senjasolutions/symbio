/**
 * Minimal progressive enhancement for the file manager. Navigation uses full
 * page reloads via href query parameters — SSR handles rendering, zero AJAX.
 * Only the tree toggle and show-hidden are enhanced via JavaScript.
 */
(function () {
  "use strict";

  const pathInput = document.getElementById("fm-path-input");
  const fileRows = document.getElementById("fm-file-rows");
  const treeEl = document.getElementById("fm-tree");
  const treeBody = document.getElementById("fm-tree-body");
  const treeCard = document.getElementById("fm-tree-card");
  const treeLoading = document.getElementById("fm-tree-loading");
  const listLoading = document.getElementById("fm-list-loading");
  const treeCol = document.getElementById("fm-tree-col");
  const listCol = document.getElementById("fm-list-col");
  const toggleHeader = document.getElementById("fm-toggle-tree-header");
  const toggleToolbar = document.getElementById("fm-toggle-tree-toolbar");
  const showHiddenCb = document.getElementById("fm-show-hidden");
  const goBtn = document.getElementById("fm-go-btn");

  if (!pathInput || !fileRows) return;

  // ---- Tree panel collapse (responsive) ----
  const treeVisibleKey = "symbio-fm-tree-visible";
  const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

  const applyTreeVisibility = (visible) => {
    if (visible) {
      treeCol.classList.remove("d-none");
      treeCol.classList.add("col-md-3");
      listCol.classList.remove("col-md-12");
      listCol.classList.add("col-md-9");
      if (treeBody) treeBody.classList.remove("d-none");
      if (treeCard) treeCard.classList.remove("fm-tree-collapsed");
    } else {
      if (isMobile()) {
        if (treeBody) treeBody.classList.add("d-none");
        if (treeCard) treeCard.classList.add("fm-tree-collapsed");
        treeCol.classList.remove("d-none");
      } else {
        treeCol.classList.add("d-none");
        treeCol.classList.remove("col-md-3");
        listCol.classList.add("col-md-12");
        listCol.classList.remove("col-md-9");
      }
    }
  };

  let treeVisible = true;
  try { treeVisible = localStorage.getItem(treeVisibleKey) !== "0"; } catch (e) { /* ignore */ }
  applyTreeVisibility(treeVisible);

  const toggleTree = () => {
    treeVisible = !treeVisible;
    applyTreeVisibility(treeVisible);
    try { localStorage.setItem(treeVisibleKey, treeVisible ? "1" : "0"); } catch (e) { /* ignore */ }
  };

  if (toggleHeader) toggleHeader.addEventListener("click", toggleTree);
  if (toggleToolbar) toggleToolbar.addEventListener("click", toggleTree);
  window.addEventListener("resize", () => applyTreeVisibility(treeVisible));

  // ---- Lazy tree children via AJAX (only tree, not file listing) ----
  const serverId = location.pathname.match(/^\/servers\/(\d+)/)?.[1] || "1";
  const apiBase = `/servers/${serverId}/file-manager`;

  const loadTreeChildren = async (path, container) => {
    if (treeLoading) treeLoading.classList.remove("d-none");
    try {
      const res = await fetch(`${apiBase}/tree?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      renderTreeChildren(data.children, container);
    } catch (err) {
      container.innerHTML = `<div class="text-danger small ps-4">${err.message}</div>`;
    } finally {
      if (treeLoading) treeLoading.classList.add("d-none");
    }
  };

  const renderTreeChildren = (children, container) => {
    if (!children || !children.length) {
      container.innerHTML = '<div class="text-muted small ps-4">Empty</div>';
      return;
    }
    container.innerHTML = children.map((child) =>
      `<div class="file-tree-node" role="treeitem" data-path="${escapeAttr(child.path)}" aria-expanded="false">
        <span class="file-tree-toggle" data-path="${escapeAttr(child.path)}"><i class="fa-solid fa-caret-right" aria-hidden="true"></i></span>
        <span class="file-tree-icon"><i class="fa-solid fa-folder" aria-hidden="true"></i></span>
        <a class="file-tree-link" href="?path=${escapeAttr(child.path)}">${escapeHtml(child.name)}</a>
        <div class="file-tree-children" data-path="${escapeAttr(child.path)}"></div>
      </div>`
    ).join("");
  };

  // ---- Tree toggle (expand/collapse) via delegation ----
  if (treeEl) {
    treeEl.addEventListener("click", (e) => {
      const toggle = e.target.closest(".file-tree-toggle");
      if (!toggle) return;
      e.preventDefault();
      const path = toggle.getAttribute("data-path");
      if (!path) return;
      const node = toggle.closest(".file-tree-node");
      const children = node && node.querySelector(".file-tree-children");
      if (!children) return;
      if (node.getAttribute("aria-expanded") === "true") {
        node.setAttribute("aria-expanded", "false");
        const icon = toggle.querySelector("i");
        if (icon) icon.className = "fa-solid fa-caret-right";
        children.innerHTML = "";
      } else {
        node.setAttribute("aria-expanded", "true");
        const icon = toggle.querySelector("i");
        if (icon) icon.className = "fa-solid fa-caret-down";
        loadTreeChildren(path, children);
      }
    });
  }

  // ---- Toolbar: Go button navigates via query param (full page reload) ----
  const navigate = (dirPath) => {
    const url = new URL(location.href);
    url.searchParams.set("path", dirPath);
    location.href = url.toString();
  };

  if (goBtn) {
    goBtn.addEventListener("click", () => {
      const val = (pathInput.value || "").trim();
      if (val && val.startsWith("/")) navigate(val);
    });
  }
  if (pathInput) {
    pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && goBtn) goBtn.click();
    });
  }

  // Home/Up/Reload buttons all navigate via query param
  const homeBtn = document.getElementById("fm-home-btn");
  const upBtn = document.getElementById("fm-up-btn");
  const reloadBtn = document.getElementById("fm-reload-btn");
  if (homeBtn) homeBtn.addEventListener("click", () => navigate("/home"));

  if (upBtn) {
    upBtn.addEventListener("click", () => {
      const currentPath = new URLSearchParams(location.search).get("path") || "/home";
      const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
      navigate(parent);
    });
  }
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      location.reload();
    });
  }

  // Show hidden checkbox reloads the page with the flag
  if (showHiddenCb) {
    showHiddenCb.addEventListener("change", () => {
      const url = new URL(location.href);
      url.searchParams.set("path", new URLSearchParams(location.search).get("path") || "/home");
      if (showHiddenCb.checked) {
        url.searchParams.set("showHidden", "1");
      } else {
        url.searchParams.delete("showHidden");
      }
      location.href = url.toString();
    });
  }

  // ---- Utilities ----
  const escapeHtml = (str) => {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  };
  const escapeAttr = (str) => String(str || "").replace(/"/g, "&quot;").replace(/&/g, "&amp;");
})();
