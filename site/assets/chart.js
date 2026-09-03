/**
 * chart.js — the cumulative-cost chart, rendered identically on the server and
 * in the browser so that dragging the hourly-rate slider redraws the same shape
 * the page was built with.
 *
 * Plain SVG path strings. No charting library, no runtime dependency.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExitChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 640, H = 232, PAD = { t: 12, r: 12, b: 26, l: 52 };

  /** A round step (1, 2, 2.5 or 5 x a power of ten) near the requested size. */
  function niceStep(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  var fmtMoney = function (n) {
    if (n >= 1000) return '$' + Math.round(n / 100) / 10 + 'k';
    return '$' + Math.round(n);
  };

  /**
   * @param {Array} curve  [{ month, incumbent, alternative }]
   * @param {object} opts  { breakEven }
   * @returns {{ paths: {inc, alt}, ticks, cross, viewBox }}
   */
  function geometry(curve, opts) {
    opts = opts || {};
    var months = curve[curve.length - 1].month;
    var maxV = 0;
    for (var i = 0; i < curve.length; i++) maxV = Math.max(maxV, curve[i].incumbent, curve[i].alternative);
    // Round tick values matter more than a tidy count: "$1k $2k $3k" reads,
    // "$1.3k $2.5k $3.8k" does not.
    var step = niceStep((maxV * 1.06) / 4);
    var top = Math.max(step, Math.ceil((maxV * 1.06) / step) * step);

    var innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;
    var x = function (m) { return PAD.l + (m / months) * innerW; };
    var y = function (v) { return PAD.t + innerH - (v / top) * innerH; };

    var path = function (key) {
      var d = '';
      for (var i = 0; i < curve.length; i++) d += (i ? 'L' : 'M') + x(curve[i].month).toFixed(1) + ' ' + y(curve[i][key]).toFixed(1);
      return d;
    };

    var yTicks = [];
    for (var v = 0; v <= top + 1e-6; v += step) yTicks.push({ v: v, y: y(v), label: fmtMoney(v) });
    var xTicks = [];
    for (var m = 0; m <= months; m += 12) xTicks.push({ m: m, x: x(m), label: m === 0 ? 'now' : 'yr ' + (m / 12) });

    var cross = null;
    var be = opts.breakEven;
    if (be !== null && be !== undefined && be >= 0 && be <= months) {
      var pt = curve[Math.min(be, curve.length - 1)];
      var cx = x(pt.month), cy = y(pt.incumbent);
      // An early crossing sits in the bottom-left corner where both lines and the
      // axis converge, so the label goes up and to the right; a late one flips.
      cross = { x: cx, y: cy, month: pt.month };
    }

    return {
      viewBox: '0 0 ' + W + ' ' + H,
      paths: { inc: path('incumbent'), alt: path('alternative') },
      yTicks: yTicks, xTicks: xTicks, cross: cross,
      plot: { x0: PAD.l, x1: W - PAD.r, y0: PAD.t, y1: H - PAD.b },
    };
  }

  /** Full SVG markup, used at build time. */
  function svg(curve, opts) {
    var g = geometry(curve, opts);
    var p = g.plot, out = [];
    out.push('<svg viewBox="' + g.viewBox + '" role="img" aria-label="' + (opts && opts.alt || 'Cumulative cost over time') + '">');
    g.yTicks.forEach(function (t) {
      out.push('<line class="grid" x1="' + p.x0 + '" x2="' + p.x1 + '" y1="' + t.y.toFixed(1) + '" y2="' + t.y.toFixed(1) + '"/>');
      out.push('<text x="' + (p.x0 - 8) + '" y="' + (t.y + 3.5).toFixed(1) + '" text-anchor="end">' + t.label + '</text>');
    });
    g.xTicks.forEach(function (t) {
      out.push('<text x="' + t.x.toFixed(1) + '" y="' + (p.y1 + 15) + '" text-anchor="middle">' + t.label + '</text>');
    });
    out.push('<line class="axis" x1="' + p.x0 + '" x2="' + p.x1 + '" y1="' + p.y1 + '" y2="' + p.y1 + '"/>');
    out.push('<path class="l-inc" id="line-inc" d="' + g.paths.inc + '"/>');
    out.push('<path class="l-alt" id="line-alt" d="' + g.paths.alt + '"/>');
    out.push('<g class="cross" id="cross"' + (g.cross ? '' : ' hidden') + '>');
    out.push('<circle cx="' + (g.cross ? g.cross.x.toFixed(1) : 0) + '" cy="' + (g.cross ? g.cross.y.toFixed(1) : 0) + '" r="4.5"/>');
    out.push('</g></svg>');
    return out.join('');
  }

  return { geometry: geometry, svg: svg, W: W, H: H };
});
