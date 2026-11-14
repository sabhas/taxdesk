/* UAT runner: renders window.TAXDESK_UAT into #uat-root, keeps results in this browser's
   localStorage (per tester, per browser), and exports a CSV for sign-off. */
(function () {
  'use strict';

  var data = window.TAXDESK_UAT || [];
  var helpers = window.TaxDeskGuide;
  var el = helpers.el;
  var store = helpers.store;
  var KEY = 'taxdesk-uat-results:v1';
  var META_KEY = 'taxdesk-uat-meta:v1';

  var ROLE_LABEL = {
    admin: ['Administrator', 'admin'],
    manager: ['Manager', 'manager'],
    consultant: ['Consultant', 'consultant'],
    billing: ['Billing', 'billing'],
    readonly: ['Read-only', 'readonly'],
    operator: ['Operator', 'operator'],
    any: ['Any role', 'readonly'],
  };

  var results = {};
  try {
    results = JSON.parse(store(KEY) || '{}') || {};
  } catch (e) {
    results = {};
  }
  var meta = {};
  try {
    meta = JSON.parse(store(META_KEY) || '{}') || {};
  } catch (e) {
    meta = {};
  }

  function save() {
    store(KEY, JSON.stringify(results));
  }

  /* Flatten with stable IDs. */
  var all = [];
  data.forEach(function (epic) {
    epic.stories.forEach(function (story) {
      story.cases.forEach(function (c, i) {
        all.push({
          id: 'UAT-' + story.id + '-' + String(i + 1).padStart(2, '0'),
          epic: epic.epic,
          epicTitle: epic.title,
          story: story.id,
          storyTitle: story.title,
          title: c[0],
          role: c[1],
          kind: c[2],
          pre: c[3],
          steps: c[4],
          expect: c[5],
        });
      });
    });
  });

  var root = document.getElementById('uat-root');
  var toolbar = document.getElementById('uat-toolbar');
  if (!root || !toolbar) return;

  /* ---------- Toolbar ---------- */
  function select(id, label, options) {
    var s = el('select', { id: id });
    options.forEach(function (o) {
      s.appendChild(el('option', { value: o[0], text: o[1] }));
    });
    return el('label', { for: id }, [document.createTextNode(label), s]);
  }

  var epicOptions = [['', 'All epics']].concat(
    data.map(function (e) {
      return [e.epic, 'Epic ' + e.epic + ' · ' + e.title];
    }),
  );
  var roleOptions = [['', 'All roles']].concat(
    Object.keys(ROLE_LABEL).map(function (k) {
      return [k, ROLE_LABEL[k][0]];
    }),
  );
  var statusOptions = [
    ['', 'Any result'],
    ['todo', 'Not run'],
    ['pass', 'Pass'],
    ['fail', 'Fail'],
    ['blocked', 'Blocked'],
  ];
  var kindOptions = [
    ['', 'Positive and negative'],
    ['pos', 'Positive only'],
    ['neg', 'Negative only'],
  ];

  var tester = el('input', {
    type: 'text',
    id: 'uat-tester',
    placeholder: 'Tester name',
    'aria-label': 'Tester name',
    value: meta.tester || '',
  });
  var env = el('input', {
    type: 'text',
    id: 'uat-env',
    placeholder: 'Environment + release SHA',
    'aria-label': 'Environment and release',
    value: meta.env || '',
  });
  [tester, env].forEach(function (input) {
    input.addEventListener('change', function () {
      meta.tester = tester.value.trim();
      meta.env = env.value.trim();
      store(META_KEY, JSON.stringify(meta));
    });
  });

  var fEpic = select('f-epic', 'Epic', epicOptions);
  var fRole = select('f-role', 'Role', roleOptions);
  var fStatus = select('f-status', 'Result', statusOptions);
  var fKind = select('f-kind', 'Type', kindOptions);

  var progress = el('div', { class: 'progress' }, [
    el('div', { class: 'progress-bar', 'aria-hidden': 'true' }, [
      el('span', { class: 'p-pass' }),
      el('span', { class: 'p-fail' }),
      el('span', { class: 'p-blocked' }),
    ]),
    el('div', { class: 'progress-text', 'aria-live': 'polite' }),
  ]);

  var exportBtn = el('button', { class: 'btn primary', type: 'button', text: 'Export CSV' });
  var resetBtn = el('button', { class: 'btn', type: 'button', text: 'Clear results' });

  toolbar.appendChild(tester);
  toolbar.appendChild(env);
  toolbar.appendChild(fEpic);
  toolbar.appendChild(fRole);
  toolbar.appendChild(fKind);
  toolbar.appendChild(fStatus);
  toolbar.appendChild(progress);
  toolbar.appendChild(exportBtn);
  toolbar.appendChild(resetBtn);

  /* ---------- Cases ---------- */
  var caseNodes = {};

  function renderCase(c) {
    var r = results[c.id] || {};
    var role = ROLE_LABEL[c.role] || ROLE_LABEL.any;
    var statusSel = el('select', { 'aria-label': 'Result for ' + c.id });
    [
      ['todo', 'Not run'],
      ['pass', 'Pass'],
      ['fail', 'Fail'],
      ['blocked', 'Blocked'],
    ].forEach(function (o) {
      var opt = el('option', { value: o[0], text: o[1] });
      if ((r.status || 'todo') === o[0]) opt.selected = true;
      statusSel.appendChild(opt);
    });
    var notes = el('textarea', {
      rows: '1',
      placeholder: 'Notes, defect link, request ID…',
      'aria-label': 'Notes for ' + c.id,
    });
    notes.value = r.notes || '';

    var steps = el('ol');
    c.steps.forEach(function (s) {
      steps.appendChild(el('li', { text: s }));
    });

    var node = el('article', { class: 'uat-case', id: c.id, 'data-status': r.status || 'todo' }, [
      el('header', null, [
        el('span', { class: 'cid', text: c.id }),
        el('span', { class: 'ctitle', text: c.title }),
        el('span', { class: 'badge ' + role[1], text: role[0] }),
        el('span', {
          class: 'kind' + (c.kind === 'neg' ? ' neg' : ''),
          text: c.kind === 'neg' ? 'Negative' : 'Positive',
        }),
      ]),
      el('dl', null, [
        el('dt', { text: 'Before' }),
        el('dd', { text: c.pre }),
        el('dt', { text: 'Steps' }),
        el('dd', null, [steps]),
        el('dt', { text: 'Expected' }),
        el('dd', { text: c.expect }),
      ]),
      el('div', { class: 'uat-result no-print' }, [statusSel, notes]),
    ]);

    function update() {
      results[c.id] = {
        status: statusSel.value,
        notes: notes.value,
        at: new Date().toISOString(),
      };
      if (statusSel.value === 'todo' && !notes.value) delete results[c.id];
      node.setAttribute('data-status', statusSel.value);
      save();
      refresh();
    }
    statusSel.addEventListener('change', update);
    notes.addEventListener('change', update);
    caseNodes[c.id] = node;
    return node;
  }

  var storyNodes = [];
  var epicNodes = [];
  data.forEach(function (epic) {
    var epicSection = el('section', { 'data-epic': epic.epic }, [
      el('h2', { id: 'epic-' + epic.epic, text: 'Epic ' + epic.epic + ' · ' + epic.title }),
    ]);
    epic.stories.forEach(function (story) {
      var storySection = el('section', { class: 'uat-story', 'data-story': story.id }, [
        el('h3', { id: story.id.toLowerCase() }, [
          el('span', { class: 'sid', text: story.id }),
          document.createTextNode(story.title),
        ]),
      ]);
      all
        .filter(function (c) {
          return c.story === story.id;
        })
        .forEach(function (c) {
          storySection.appendChild(renderCase(c));
        });
      storyNodes.push(storySection);
      epicSection.appendChild(storySection);
    });
    epicNodes.push(epicSection);
    root.appendChild(epicSection);
  });

  function matches(c) {
    var status = (results[c.id] && results[c.id].status) || 'todo';
    var epicV = fEpic.querySelector('select').value;
    var roleV = fRole.querySelector('select').value;
    var statusV = fStatus.querySelector('select').value;
    var kindV = fKind.querySelector('select').value;
    return (
      (!epicV || c.epic === epicV) &&
      (!roleV || c.role === roleV) &&
      (!statusV || status === statusV) &&
      (!kindV || c.kind === kindV)
    );
  }

  function refresh() {
    var counts = { pass: 0, fail: 0, blocked: 0, todo: 0 };
    all.forEach(function (c) {
      var status = (results[c.id] && results[c.id].status) || 'todo';
      counts[status] += 1;
      caseNodes[c.id].hidden = !matches(c);
    });
    storyNodes.forEach(function (s) {
      s.hidden = !s.querySelector('.uat-case:not([hidden])');
    });
    epicNodes.forEach(function (s) {
      s.hidden = !s.querySelector('.uat-story:not([hidden])');
    });
    var total = all.length;
    var bars = progress.querySelectorAll('.progress-bar span');
    bars[0].style.width = (counts.pass / total) * 100 + '%';
    bars[1].style.width = (counts.fail / total) * 100 + '%';
    bars[2].style.width = (counts.blocked / total) * 100 + '%';
    progress.querySelector('.progress-text').textContent =
      counts.pass +
      ' pass · ' +
      counts.fail +
      ' fail · ' +
      counts.blocked +
      ' blocked · ' +
      counts.todo +
      ' not run (of ' +
      total +
      ')';
  }

  [fEpic, fRole, fStatus, fKind].forEach(function (f) {
    f.querySelector('select').addEventListener('change', refresh);
  });

  /* ---------- Export / reset ---------- */
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    /* Neutralise spreadsheet formulas in free text. */
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  exportBtn.addEventListener('click', function () {
    var header = [
      'Case ID',
      'Epic',
      'Story',
      'Story title',
      'Scenario',
      'Role',
      'Type',
      'Expected',
      'Result',
      'Notes',
      'Recorded at',
      'Tester',
      'Environment',
    ];
    var rows = [header.map(csvCell).join(',')];
    all.forEach(function (c) {
      var r = results[c.id] || {};
      rows.push(
        [
          c.id,
          c.epic,
          c.story,
          c.storyTitle,
          c.title,
          (ROLE_LABEL[c.role] || ROLE_LABEL.any)[0],
          c.kind === 'neg' ? 'Negative' : 'Positive',
          c.expect,
          r.status || 'not run',
          r.notes || '',
          r.at || '',
          meta.tester || '',
          meta.env || '',
        ]
          .map(csvCell)
          .join(','),
      );
    });
    var blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var link = el('a', {
      href: URL.createObjectURL(blob),
      download:
        'taxdesk-uat-' +
        (meta.tester ? meta.tester.replace(/[^A-Za-z0-9_-]+/g, '-') + '-' : '') +
        new Date().toISOString().slice(0, 10) +
        '.csv',
    });
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 500);
  });

  resetBtn.addEventListener('click', function () {
    if (!window.confirm('Clear every recorded result in this browser? Export first if you need them.')) return;
    results = {};
    save();
    all.forEach(function (c) {
      var node = caseNodes[c.id];
      node.setAttribute('data-status', 'todo');
      node.querySelector('select').value = 'todo';
      node.querySelector('textarea').value = '';
    });
    refresh();
  });

  /* Optional deep link: scenarios.html?role=billing */
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('role')) fRole.querySelector('select').value = params.get('role');
    if (params.get('epic')) fEpic.querySelector('select').value = params.get('epic');
  } catch (e) {
    /* ignore */
  }

  refresh();

  var count = document.getElementById('uat-count');
  if (count) count.textContent = String(all.length);
})();
