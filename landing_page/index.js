/**
 * Symbio Landing Page — minimal enhancement for copy-to-clipboard.
 */
document.addEventListener("DOMContentLoaded", function () {
  var btns = document.querySelectorAll(".copy-btn");
  btns.forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      var codeBox = this.closest(".code-box");
      var code = codeBox.querySelector("code");
      var text = code.textContent.trim();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showCopied(btn);
        }).catch(function () {
          fallbackCopy(text, btn);
        });
      } else {
        fallbackCopy(text, btn);
      }
    });
  });

  function showCopied(btn) {
    var orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
    btn.classList.add("copied");
    setTimeout(function () {
      btn.innerHTML = orig;
      btn.classList.remove("copied");
    }, 1800);
  }

  function fallbackCopy(text, btn) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showCopied(btn);
    } catch (e) {
      btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      setTimeout(function () {
        btn.innerHTML = '<i class="fa-regular fa-clipboard"></i>';
      }, 1800);
    }
    document.body.removeChild(ta);
  }
});
