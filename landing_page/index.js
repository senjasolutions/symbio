document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("has-motion");
  const header = document.querySelector(".site-header");
  const revealItems = document.querySelectorAll("[data-reveal]");
  const year = document.querySelector("#year");
  const productStage = document.querySelector("[data-product-stage]");

  if (year) year.textContent = new Date().getFullYear();

  const updateHeader = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 24);
  };

  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.18 });

    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  if (productStage && window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
    productStage.addEventListener("pointermove", (event) => {
      const bounds = productStage.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - .5;
      const y = (event.clientY - bounds.top) / bounds.height - .5;
      productStage.style.setProperty("--product-x", `${x * 4}deg`);
      productStage.style.setProperty("--product-y", `${y * -3}deg`);
    });

    productStage.addEventListener("pointerleave", () => {
      productStage.style.removeProperty("--product-x");
      productStage.style.removeProperty("--product-y");
    });
  }
});
