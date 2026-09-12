// The gamepad silhouette the mapper is drawn on.
//
// A module of its own, free of the `vscode` API, so test/controller.test.cjs
// can hold the picture to the control set without a window: every shape it
// names has to be a control controllerProfile.cjs declares, and every
// control the brief asks the picture to show has to have a shape.
//
// Inline SVG rather than an asset, because the webview's
// CSP names no image source at all and widening it for a picture of a
// joypad would be a poor trade; and one path plus twenty shapes is smaller
// than most PNGs of the same thing anyway.
//
// The silhouette is the reference device — an 8BitDo SN30 Pro in X-input
// mode, which presents as an Xbox 360-style pad — because a mapper has to
// look like the thing in somebody's hands for "press the one that lights
// up" to mean anything. It is a *picture*, not a model: nothing about
// X-input reaches the stored profile, which is named in 8BitScript's own
// terms (controllerProfile.cjs), and a pad with a different arrangement is
// mapped by the same walkthrough onto the same names.
//
// Every shape a control lives on carries `data-control`, whose value is
// one or more logical control ids, space separated:
//
//   * the shape lights when any of them is active, so the left stick's
//     well lights whichever axis is being pushed;
//   * clicking it queues all of them to be bound in order, so clicking the
//     stick asks for the horizontal axis and then the vertical — which is
//     the only sane way to bind two axes from one picture of one stick.
//
// The two stick knobs additionally carry `data-knob`, and the page
// translates them by the live axis reading; a still knob on a pad somebody
// is waggling is the clearest possible sign the binding is wrong.
const PAD_SVG = `<svg id="pad" viewBox="0 0 312 224" role="img" aria-label="Controller">
  <path class="body" d="M82 40 h148 q40 0 54 36 l26 86 q16 38 -18 54 q-32 14 -50 -18 l-26 -44 h-120 l-26 44 q-18 32 -50 18 q-34 -16 -18 -54 l26 -86 q14 -36 54 -36 z"/>

  <rect class="hit" data-control="lt" x="44" y="2" width="42" height="22" rx="8"/>
  <rect class="hit" data-control="rt" x="226" y="2" width="42" height="22" rx="8"/>
  <rect class="hit" data-control="l" x="34" y="22" width="62" height="24" rx="11"/>
  <rect class="hit" data-control="r" x="216" y="22" width="62" height="24" rx="11"/>

  <rect class="hit dpad" data-control="up" x="63" y="61" width="18" height="24" rx="3"/>
  <rect class="hit dpad" data-control="down" x="63" y="103" width="18" height="24" rx="3"/>
  <rect class="hit dpad" data-control="left" x="39" y="85" width="24" height="18" rx="3"/>
  <rect class="hit dpad" data-control="right" x="81" y="85" width="24" height="18" rx="3"/>
  <rect class="dpad-centre" x="63" y="85" width="18" height="18"/>

  <circle class="hit face" data-control="y" cx="234" cy="69" r="13"/>
  <circle class="hit face" data-control="x" cx="207" cy="96" r="13"/>
  <circle class="hit face" data-control="b" cx="261" cy="96" r="13"/>
  <circle class="hit face" data-control="a" cx="234" cy="123" r="13"/>
  <text class="cap" x="234" y="73">Y</text>
  <text class="cap" x="207" y="100">X</text>
  <text class="cap" x="261" y="100">B</text>
  <text class="cap" x="234" y="127">A</text>

  <rect class="hit pill" data-control="select" x="122" y="88" width="24" height="11" rx="5"/>
  <rect class="hit pill" data-control="start" x="166" y="88" width="24" height="11" rx="5"/>
  <text class="micro" x="134" y="112">SELECT</text>
  <text class="micro" x="178" y="112">START</text>

  <circle class="hit well" data-control="leftStickX leftStickY" cx="136" cy="128" r="19"/>
  <circle class="knob" data-knob="left" cx="136" cy="128" r="10"/>
  <circle class="hit well" data-control="rightStickX rightStickY" cx="196" cy="128" r="19"/>
  <circle class="knob" data-knob="right" cx="196" cy="128" r="10"/>
</svg>`;

module.exports = { PAD_SVG };
