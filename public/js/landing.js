// Landing page: menu no celular e ano no rodapé.
(function () {
  "use strict";
  var button = document.getElementById("menu-btn");
  var nav = document.getElementById("site-nav");
  function setOpen(open) {
    nav.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
  }
  button.addEventListener("click", function () { setOpen(!nav.classList.contains("open")); });
  nav.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
  document.getElementById("year").textContent = String(new Date().getFullYear());
})();
