// Weave marketing site — no analytics, no trackers, nothing phones home.

(function () {
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  var track = document.getElementById('whyTrack');
  var carousel = document.getElementById('whyCarousel');
  var dotsWrap = document.getElementById('whyDots');
  var prevBtn = document.getElementById('whyPrev');
  var nextBtn = document.getElementById('whyNext');

  if (track && carousel && dotsWrap && prevBtn && nextBtn) {
    var slides = track.children;
    var count = slides.length;
    var index = 0;
    var AUTO_MS = 35000;
    var timer = null;

    for (var i = 0; i < count; i++) {
      var dot = document.createElement('button');
      dot.className = 'dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'Go to reason ' + (i + 1));
      (function (idx) {
        dot.addEventListener('click', function () { goTo(idx); restart(); });
      })(i);
      dotsWrap.appendChild(dot);
    }
    var dots = dotsWrap.querySelectorAll('.dot');

    function goTo(i) {
      index = (i + count) % count;
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      for (var d = 0; d < dots.length; d++) {
        dots[d].classList.toggle('active', d === index);
      }
    }

    function next() { goTo(index + 1); }
    function prev() { goTo(index - 1); }

    function start() { timer = setInterval(next, AUTO_MS); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function restart() { stop(); start(); }

    prevBtn.addEventListener('click', function () { prev(); restart(); });
    nextBtn.addEventListener('click', function () { next(); restart(); });
    carousel.addEventListener('mouseenter', stop);
    carousel.addEventListener('mouseleave', start);

    goTo(0);
    start();
  }
})();
