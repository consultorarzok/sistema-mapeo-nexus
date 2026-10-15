(function () {
  "use strict";
  const KEY = "nexus-theme";
  const root = document.documentElement;

  function apply(theme) {
    root.setAttribute("data-theme", theme);
  }

  function current() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  apply(current());

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
    });
  });
})();
