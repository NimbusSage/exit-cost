/**
 * page.js — the two controls that make a comparison the reader's own.
 *
 * Everything on the page is linear in the hourly rate and the team size, so
 * both recompute exactly rather than interpolating. This is the same closed
 * form that generated the page; test/linear.test.js asserts they agree across
 * a grid of rates and seat counts.
 */
(function () {
  'use strict';
  var el = document.getElementById('escape-model');
  if (!el || !window.ExitCost || !window.ExitChart) return;

  var M = JSON.parse(el.textContent);
  var slider = document.getElementById('rate');
  var seatSlider = document.getElementById('seats');
  var rateOut = document.getElementById('rate-out');
  var seatsOut = document.getElementById('seats-out');
  if (!slider) return;

  var money = function (n, dp) {
    return '$' + Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: dp === undefined ? 2 : dp,
      maximumFractionDigits: dp === undefined ? 2 : dp,
    });
  };
  var signed = function (n, dp) { return (n < 0 ? '−' : '') + money(n, dp); };
  var set = function (id, text) { var n = document.getElementById(id); if (n) n.textContent = text; };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  var VERDICT = {
    switch: ['Switch', 'saves you'],
    marginal: ['Marginal', 'saves you'],
    stay: ['Stay', 'costs you'],
  };

  function render() {
    var rate = +slider.value;
    var seats = seatSlider ? +seatSlider.value : M.model.seats;
    var r = window.ExitCost.at(M.model, rate, seats);
    var horizon = M.model.horizon_months;

    rateOut.textContent = '$' + rate + '/hr';
    slider.setAttribute('aria-valuetext', '$' + rate + ' per hour');
    if (seatSlider && seatsOut) {
      seatsOut.textContent = seats;
      seatSlider.setAttribute('aria-valuetext', plural(seats, 'seat', 'seats'));
      set('route-seats', plural(seats, 'seat', 'seats'));
      set('seat-note', plural(seats, 'seat', 'seats'));
    }

    var v = VERDICT[r.verdict];
    var host = document.getElementById('verdict');
    if (host) {
      host.className = 'verdict-line v-' + r.verdict;
      host.innerHTML = '<span class="verdict-word">' + v[0] + '.</span> At $' + rate + ' an hour'
        + (M.per_seat ? ' for ' + plural(seats, 'person', 'people') : '') + ', '
        + M.alternative_short + ' ' + v[1] + ' <b>' + money(r.savings_at_horizon, 0) + '</b> over '
        + (horizon / 12) + ' years.';
    }

    // The crossover moves with team size, so the headline figure must too.
    var x = window.ExitCost.crossover(M.model, seats);
    var big = document.getElementById('crossover-figure');
    if (big) {
      if (x === null || x < 0) {
        big.textContent = '—';
        set('crossover-lede', M.alternative_short + ' costs more than ' + M.incumbent_short + ' in cash alone at this size.');
        set('crossover-note', 'No hourly rate makes it pay. Add people, and that changes.');
      } else {
        big.innerHTML = money(x, 2) + '<span class="per">/hr</span>';
        set('crossover-lede', x < 40 ? 'This one only pays off if your hour is worth under'
                                     : 'Worth doing only if your hour is worth less than');
        set('crossover-note', x < 15
          ? 'That is below the minimum wage almost anywhere. In practice it means stay on ' + M.incumbent_short + '.'
          : 'Below that rate, moving to ' + M.alternative_short + ' pays for itself inside ' + (horizon / 12) + ' years. Above it, stay.');
      }
    }

    // The team size at which this starts to pay, at the reader's own rate.
    var th = document.getElementById('threshold');
    if (th && M.per_seat) {
      var n = window.ExitCost.breakEvenSeats(M.model, rate, 200);
      if (n === null) {
        th.innerHTML = 'At $' + rate + ' an hour, no team size makes this worth doing.';
      } else if (n <= 1) {
        th.innerHTML = 'At $' + rate + ' an hour, this is worth doing <b>even for one person</b>.';
      } else {
        th.innerHTML = 'At $' + rate + ' an hour, this starts paying off at <b>' + plural(n, 'person', 'people') + '</b>.';
      }
    }

    set('be-month', r.break_even_month === null ? 'never' : 'month ' + r.break_even_month);
    set('inc-monthly', money(r.incumbent_monthly));
    set('alt-monthly', money(r.alternative_monthly));
    set('alt-upfront', money(r.alternative_upfront));
    set('inc-cash', money(r.incumbent_cash_monthly));
    set('delta-monthly', signed(r.delta_monthly, 2));
    set('save-1yr', signed(r.savings_year_1, 0));
    set('save-horizon', signed(r.savings_at_horizon, 0));
    set('alt-time-monthly', money(M.model.alt_hours_monthly * rate));
    set('alt-time-once', money(M.model.alt_migration_hours * rate));
    set('inc-time-monthly', money((M.model.inc_hours_monthly || 0) * rate));

    [['delta-monthly', r.delta_monthly], ['save-1yr', r.savings_year_1], ['save-horizon', r.savings_at_horizon]]
      .forEach(function (pair) {
        var n = document.getElementById(pair[0]);
        if (!n) return;
        n.classList.toggle('neg', pair[1] < 0);
        n.classList.toggle('pos', pair[1] > 0);
      });

    var curve = window.ExitCost.curve(M.model, rate, seats, horizon);
    var g = window.ExitChart.geometry(curve, { breakEven: r.break_even_month });
    var inc = document.getElementById('line-inc'), alt = document.getElementById('line-alt');
    if (inc) inc.setAttribute('d', g.paths.inc);
    if (alt) alt.setAttribute('d', g.paths.alt);
    // Axis labels move with the scale, or the chart lies about its own values.
    var ticks = document.querySelectorAll('#chart-y-ticks text');
    var lines = document.querySelectorAll('#chart-y-ticks line');
    g.yTicks.forEach(function (t, i) {
      if (ticks[i]) { ticks[i].textContent = t.label; ticks[i].setAttribute('y', (t.y + 3.5).toFixed(1)); }
      if (lines[i]) { lines[i].setAttribute('y1', t.y.toFixed(1)); lines[i].setAttribute('y2', t.y.toFixed(1)); }
    });
    var cross = document.getElementById('cross');
    if (cross) {
      if (g.cross) {
        cross.removeAttribute('hidden');
        var c = cross.querySelector('circle');
        c.setAttribute('cx', g.cross.x.toFixed(1));
        c.setAttribute('cy', g.cross.y.toFixed(1));
      } else {
        cross.setAttribute('hidden', '');
      }
    }
  }

  slider.addEventListener('input', render);
  if (seatSlider) seatSlider.addEventListener('input', render);

  // Both settings are the reader's own and are worth carrying between pages.
  try {
    var savedRate = localStorage.getItem('exitcost.rate');
    if (savedRate !== null) slider.value = savedRate;
    var savedSeats = localStorage.getItem('exitcost.seats');
    if (savedSeats !== null && seatSlider) seatSlider.value = savedSeats;
    slider.addEventListener('change', function () {
      try { localStorage.setItem('exitcost.rate', slider.value); } catch (e) {}
    });
    if (seatSlider) seatSlider.addEventListener('change', function () {
      try { localStorage.setItem('exitcost.seats', seatSlider.value); } catch (e) {}
    });
  } catch (e) {}

  render();
})();
