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

  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fromEmail = document.getElementById('fromEmail').value.trim();
      var subject = document.getElementById('subject').value.trim();
      var body = document.getElementById('body').value.trim();

      var fullBody = body;
      if (fromEmail) {
        fullBody = 'From: ' + fromEmail + '\n\n' + body;
      }

      var mailto = 'mailto:hentusvanwyk@gmail.com'
        + '?subject=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(fullBody);

      window.location.href = mailto;
    });
  }
})();
