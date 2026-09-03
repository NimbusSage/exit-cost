/**
 * page.js — the hourly-rate control.
 *
 * The whole comparison is linear in the reader's hourly rate, so every figure on
 * the page can be recomputed exactly as the slider moves. Nothing is fetched and
 * nothing is interpolated; this is the same arithmetic that generated the page.
 */
(function () {
  'use strict';
  var el = document.getElementById('escape-model');
  if (!el || !window.ExitCost || !window.ExitChart) return;

  var M = JSON.parse(el.textContent);
  var slider = document.getElementById('rate');
  var out = document.getElementById('rate-out');
  if (!slider) return;

  var money = function (n, dp) {
    return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp === undefined ? 2 : dp, maximumFractionDigits: dp === undefined ? 2 : dp });
  };
  var set = function (id, text) { var n = document.getElementById(id); if (n) n.textContent = text; };

  var VERDICT_TEXT = {
    switch: ['Switch', 'saves you'],
    marginal: ['Marginal', 'saves you'],
    stay: ['Stay', 'costs you'],
  };

  function render(rate) {
    var r = window.ExitCost.at(M.model, rate);
    var horizon = M.model.horizon_months;

    out.textContent = '$' + rate + '/hr';
    slider.setAttribute('aria-valuetext', '$' + rate + ' per hour');

    // Verdict sentence
    var vt = VERDICT_TEXT[r.verdict];
    var host = document.getElementById('verdict');
    if (host) {
      host.className = 'verdict-line v-' + r.verdict;
      host.innerHTML = '<span class="verdict-word">' + vt[0] + '.</span> At $' + rate +
        ' an hour, ' + M.alternative_short + ' ' + vt[1] + ' <b>' +
        money(r.savings_at_horizon, 0) + '</b> over ' + (horizon / 12) + ' years.';
    }

    set('be-month', r.break_even_month === null ? 'never' : 'month ' + r.break_even_month);
    set('inc-monthly', money(r.incumbent_monthly));
    set('alt-monthly', money(r.alternative_monthly));
    set('alt-upfront', money(r.alternative_upfront));
    set('delta-monthly', (r.delta_monthly < 0 ? '−' : '') + money(r.delta_monthly));
    set('save-1yr', (r.savings_year_1 < 0 ? '−' : '') + money(r.savings_year_1, 0));
    set('save-horizon', (r.savings_at_horizon < 0 ? '−' : '') + money(r.savings_at_horizon, 0));

    // Time lines in the statement
    set('alt-time-monthly', money(M.model.alt_hours_monthly * rate));
    set('alt-time-once', money(M.model.alt_migration_hours * rate));
    set('inc-time-monthly', money((M.model.inc_hours_monthly || 0) * rate));

    ['delta-monthly', 'save-1yr', 'save-horizon'].forEach(function (id) {
      var n = document.getElementById(id);
      if (!n) return;
      var v = id === 'delta-monthly' ? r.delta_monthly : id === 'save-1yr' ? r.savings_year_1 : r.savings_at_horizon;
      n.classList.toggle('neg', v < 0);
      n.classList.toggle('pos', v > 0);
    });

    // Redraw the two cost lines and move the crossing marker.
    var curve = window.ExitCost.curve(M.model, rate, horizon);
    var g = window.ExitChart.geometry(curve, { breakEven: r.break_even_month });
    var inc = document.getElementById('line-inc'), alt = document.getElementById('line-alt');
    if (inc) inc.setAttribute('d', g.paths.inc);
    if (alt) alt.setAttribute('d', g.paths.alt);
    var cross = document.getElementById('cross');
    if (cross) {
      if (g.cross) {
        cross.removeAttribute('hidden');
        cross.querySelector('circle').setAttribute('cx', g.cross.x.toFixed(1));
        cross.querySelector('circle').setAttribute('cy', g.cross.y.toFixed(1));
      } else {
        cross.setAttribute('hidden', '');
      }
    }
  }

  slider.addEventListener('input', function () { render(+slider.value); });
  render(+slider.value);

  // Remember the reader's rate; it is the one thing they personalise, and it is
  // worth carrying from one comparison to the next.
  try {
    var saved = localStorage.getItem('exitcost.rate');
    if (saved !== null && saved !== slider.value) { slider.value = saved; render(+saved); }
    slider.addEventListener('change', function () { try { localStorage.setItem('exitcost.rate', slider.value); } catch (e) {} });
  } catch (e) {}
})();
