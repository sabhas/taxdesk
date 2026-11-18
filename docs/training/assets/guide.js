/* TaxDesk training guide — shared behaviour.
   Plain script (no modules, no fetch) so every page works when opened from disk (file://).
   Each page sets <body data-root="../" data-page="staff/clients.html">. */
(function () {
  'use strict';

  /** Site map: order here drives the sidebar and the previous/next links.
      The web build rewrites the array between the site-map markers for /help/. */
  var SITE = /* site-map:start */ [
    {
      track: 'Start',
      pages: [
        { url: 'index.html', title: 'Welcome' },
        { url: 'reference/status-limitations.html', title: 'Release status and limits' },
      ],
    },
    {
      track: 'Operators: set up and run',
      pages: [
        { url: 'operators/architecture.html', title: 'How TaxDesk fits together' },
        { url: 'operators/local-setup.html', title: 'Local development setup' },
        { url: 'operators/configuration.html', title: 'Configuration and secrets' },
        { url: 'operators/staging.html', title: 'Staging environment' },
        { url: 'operators/production.html', title: 'Production go-live' },
        { url: 'operators/onedrive.html', title: 'OneDrive document storage' },
        { url: 'operators/ci-cd.html', title: 'CI and delivery' },
        { url: 'operators/backup-recovery.html', title: 'Backup, restore and lockouts' },
      ],
    },
    {
      track: 'Staff: use TaxDesk',
      pages: [
        { url: 'staff/getting-started.html', title: 'Getting started and MFA' },
        { url: 'staff/roles.html', title: 'Roles and permissions' },
        { url: 'staff/administration.html', title: 'Administration' },
        { url: 'staff/clients.html', title: 'Clients' },
        { url: 'staff/services-workflows.html', title: 'Services and workflows' },
        { url: 'staff/cases.html', title: 'Tax cases' },
        { url: 'staff/documents.html', title: 'Documents' },
        { url: 'staff/billing.html', title: 'Invoices and payments' },
        { url: 'staff/dashboard-reports.html', title: 'Dashboard and reports' },
        { url: 'staff/data-import.html', title: 'Data import' },
        { url: 'staff/quick-reference.html', title: 'Role quick-reference cards' },
      ],
    },
    {
      track: 'Testers: UAT',
      pages: [
        { url: 'testing/training-data.html', title: 'Build a training environment' },
        { url: 'testing/end-to-end.html', title: 'End-to-end walkthrough' },
        { url: 'testing/scenarios.html', title: 'UAT scenario catalogue' },
      ],
    },
    {
      track: 'Reference',
      pages: [
        { url: 'reference/troubleshooting.html', title: 'Troubleshooting' },
        { url: 'reference/security-data-handling.html', title: 'Security and data handling' },
        { url: 'reference/glossary.html', title: 'Glossary' },
      ],
    },
  ] /* site-map:end */;

  var body = document.body;
  var root = body.getAttribute('data-root') || '';
  var current = body.getAttribute('data-page') || 'index.html';
  /* The web build publishes a staff-only subset at /help/ and marks each page
     <body data-edition="help">. See packages/web/build/help-site.ts (TD-806). */
  var isHelp = body.getAttribute('data-edition') === 'help';

  /* List only pages this edition publishes. The search index is generated per
     edition from the pages it contains, so it is the list of what exists. */
  var published = window.TAXDESK_GUIDE_INDEX;
  if (published && published.length) {
    var known = {};
    published.forEach(function (page) {
      known[page.url] = true;
    });
    SITE = SITE.map(function (group) {
      return {
        track: group.track,
        pages: group.pages.filter(function (page) {
          return known[page.url];
        }),
      };
    }).filter(function (group) {
      return group.pages.length > 0;
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) {
      /* Storage can be blocked (private window, file:// policy). The guide still works. */
    }
    return null;
  }

  /* ---------- Theme ---------- */
  var savedTheme = store('taxdesk-guide-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  function effectiveTheme() {
    var forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  /* ---------- Top bar ---------- */
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var menuBtn = el('button', {
      class: 'icon-btn menu-btn',
      type: 'button',
      'aria-label': 'Open navigation',
      'aria-expanded': 'false',
      'aria-controls': 'sidebar',
      text: '☰',
    });
    menuBtn.addEventListener('click', function () {
      var open = body.classList.toggle('nav-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    var brand = el('a', { class: 'brand', href: root + 'index.html' }, [
      el('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'TD' }),
      el('span', {
        class: 'brand-text',
        html: isHelp ? 'TaxDesk <small>Help</small>' : 'TaxDesk <small>Training guide</small>',
      }),
    ]);

    var searchInput = el('input', {
      type: 'search',
      id: 'guide-search',
      placeholder: isHelp ? 'Search help  ( / )' : 'Search the guide  ( / )',
      'aria-label': isHelp ? 'Search help' : 'Search the guide',
      autocomplete: 'off',
      role: 'combobox',
      'aria-expanded': 'false',
      'aria-controls': 'search-results',
    });
    var results = el('ul', { class: 'search-results', id: 'search-results', role: 'listbox' });
    results.hidden = true;
    var searchWrap = el('div', { class: 'search-wrap' }, [searchInput, results]);

    var themeBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Toggle dark mode',
      title: 'Toggle dark mode',
      text: '◐',
    });
    themeBtn.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store('taxdesk-guide-theme', next);
    });

    var printBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Print this page',
      title: 'Print this page',
      text: '⎙',
    });
    printBtn.addEventListener('click', function () {
      window.print();
    });

    topbar.appendChild(menuBtn);
    topbar.appendChild(brand);
    topbar.appendChild(el('span', { class: 'spacer' }));
    topbar.appendChild(searchWrap);
    topbar.appendChild(themeBtn);
    topbar.appendChild(printBtn);
    if (isHelp) {
      topbar.appendChild(
        el('a', { class: 'icon-btn back-link', href: '/', 'aria-label': 'Back to TaxDesk' }, [
          el('span', { class: 'back-long', text: 'Back to ' }),
          document.createTextNode('TaxDesk'),
        ]),
      );
    }

    setupSearch(searchInput, results);
  }

  /* ---------- Sidebar ---------- */
  var sidebar = document.getElementById('sidebar');
  var flat = [];
  SITE.forEach(function (group) {
    group.pages.forEach(function (page) {
      flat.push({ url: page.url, title: page.title, track: group.track });
    });
  });

  if (sidebar) {
    SITE.forEach(function (group) {
      sidebar.appendChild(el('h2', { text: group.track }));
      var list = el('ul');
      group.pages.forEach(function (page) {
        var link = el('a', { href: root + page.url, text: page.title });
        if (page.url === current) link.setAttribute('aria-current', 'page');
        list.appendChild(el('li', null, [link]));
      });
      sidebar.appendChild(list);
    });
    var active = sidebar.querySelector('[aria-current="page"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'center' });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && body.classList.contains('nav-open')) {
      body.classList.remove('nav-open');
      var btn = document.querySelector('.menu-btn');
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    }
  });

  /* ---------- Previous / next ---------- */
  var content = document.querySelector('main .content');
  var index = -1;
  flat.forEach(function (page, i) {
    if (page.url === current) index = i;
  });
  if (content && index >= 0 && !body.hasAttribute('data-no-pager')) {
    var pager = el('nav', { class: 'pager', 'aria-label': 'Previous and next page' });
    var prev = flat[index - 1];
    var next = flat[index + 1];
    if (prev) {
      pager.appendChild(
        el('a', { class: 'prev', href: root + prev.url }, [
          el('span', { text: '← Previous' }),
          document.createTextNode(prev.title),
        ]),
      );
    }
    if (next) {
      pager.appendChild(
        el('a', { class: 'next', href: root + next.url }, [
          el('span', { text: 'Next →' }),
          document.createTextNode(next.title),
        ]),
      );
    }
    content.appendChild(pager);
  }

  /* ---------- Copy buttons on code blocks ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('pre'), function (pre) {
    var button = el('button', { class: 'copy-btn', type: 'button', text: 'Copy' });
    button.addEventListener('click', function () {
      var code = pre.querySelector('code') || pre;
      var text = code.innerText.replace(/\n$/, '');
      var done = function () {
        button.textContent = 'Copied';
        setTimeout(function () {
          button.textContent = 'Copy';
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          fallbackCopy(text);
          done();
        });
      } else {
        fallbackCopy(text);
        done();
      }
    });
    pre.appendChild(button);
  });

  function fallbackCopy(text) {
    var area = el('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(area);
  }

  /* ---------- Search ---------- */
  function setupSearch(input, list) {
    var entries = [];
    var pages = window.TAXDESK_GUIDE_INDEX || [];
    pages.forEach(function (page) {
      entries.push({
        title: page.title,
        url: page.url,
        track: page.track,
        hay: (page.title + ' ' + (page.keywords || '')).toLowerCase(),
      });
      (page.sections || []).forEach(function (section) {
        entries.push({
          title: section[1],
          url: page.url + '#' + section[0],
          track: page.title,
          hay: (section[1] + ' ' + page.title).toLowerCase(),
        });
      });
    });

    var selected = -1;

    function render(query) {
      list.innerHTML = '';
      selected = -1;
      var words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      var hits = entries
        .map(function (entry) {
          var score = 0;
          for (var i = 0; i < words.length; i += 1) {
            var at = entry.hay.indexOf(words[i]);
            if (at < 0) return null;
            score += at === 0 ? 3 : 1;
            if (entry.title.toLowerCase().indexOf(words[i]) >= 0) score += 2;
          }
          return { entry: entry, score: score };
        })
        .filter(Boolean)
        .sort(function (a, b) {
          return b.score - a.score;
        })
        .slice(0, 12);

      if (hits.length === 0) {
        list.appendChild(el('li', null, [el('a', { text: 'No matches', 'aria-disabled': 'true' })]));
      }
      hits.forEach(function (hit, i) {
        var link = el('a', { href: root + hit.entry.url, role: 'option', id: 'sr-' + i }, [
          el('span', { class: 'sr-track', text: hit.entry.track }),
          document.createTextNode(hit.entry.title),
        ]);
        list.appendChild(el('li', null, [link]));
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function move(delta) {
      var options = list.querySelectorAll('a[role="option"]');
      if (options.length === 0) return;
      if (selected >= 0) options[selected].removeAttribute('aria-selected');
      selected = (selected + delta + options.length) % options.length;
      options[selected].setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', options[selected].id);
      options[selected].scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', function () {
      render(input.value);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter') {
        var options = list.querySelectorAll('a[role="option"]');
        var target = options[selected >= 0 ? selected : 0];
        if (target) window.location.href = target.href;
      } else if (event.key === 'Escape') {
        input.value = '';
        render('');
      }
    });
    input.addEventListener('blur', function () {
      setTimeout(function () {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }, 150);
    });
    input.addEventListener('focus', function () {
      if (input.value) render(input.value);
    });
    document.addEventListener('keydown', function (event) {
      var tag = (event.target && event.target.tagName) || '';
      if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag)) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  /* Expose helpers for page scripts (UAT runner). */
  window.TaxDeskGuide = { el: el, store: store };
})();
