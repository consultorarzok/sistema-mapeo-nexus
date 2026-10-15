(function () {
  "use strict";
  const KEY = "nexus-theme";
  const root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
  }

  function current() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  applyTheme(current());

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");

    btn.addEventListener("click", (e) => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const size = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) * 1.05;

      const persist = () => {
        try {
          localStorage.setItem(KEY, next);
        } catch (err) {}
      };

      if (!document.startViewTransition) {
        applyTheme(next);
        persist();
        return;
      }

      const transition = document.startViewTransition(() => {
        applyTheme(next);
      });

      transition.ready
        .then(() => {
          document.documentElement.animate(
            {
              clipPath: [
                `inset(${y}px ${innerWidth - x}px ${innerHeight - y}px ${x}px)`,
                `inset(${y - size}px ${innerWidth - x - size}px ${innerHeight - y - size}px ${x - size}px)`,
              ],
            },
            {
              duration: 550,
              easing: "ease-in-out",
              pseudoElement: "::view-transition-new(root)",
            }
          );
        })
        .catch(() => {});

      persist();
    });
  });
})();
