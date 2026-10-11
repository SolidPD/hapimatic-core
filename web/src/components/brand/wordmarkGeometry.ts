// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Geometry and timing for the W11 title-bar wordmark (#4776): flat white Inter 800
 * outlines, the mint i-dot "nodes", the violet route between them, and the
 * one-shot "bridge" that runs from the at-rest mark to the held T2
 * ("transmission") frame.
 *
 * GENERATED, not hand-typed: every path string below is copied verbatim from the
 * header cut `docs/public-site/motion-mockups/wordmark-bridge-header.svg` at
 * 375ddedf9 on the reference branch hapi-website-launch-design-work (generator:
 * `build-brand-transmission-v2.mjs`), and every scalar was asserted against that
 * file when this module was written. The header cut carries strokes 2.4 times
 * heavier than the full-size cut, a lower route arc, and a tighter frame, because
 * the full cut's hairlines vanish at title-bar size.
 *
 * Units are the asset's font units (the viewBox below). Times are seconds.
 */

export const WORDMARK_VIEWBOX = "-140 -1880 10028 2410";

// Fixed brand colours of the mark. Not swappable UI tokens: a brand mark does not
// recolour with the accent theme, and SMIL from/to need resolved colours.
export const WORDMARK_WHITE = "#ffffff"; // design-tokens-allow: W11 brand-mark letter colour (#4776), fixed brand colour; SMIL from/to need a resolved colour, not var()
export const WORDMARK_MINT = "#5ae6ab"; // design-tokens-allow: brand node mint for the mark's i-dots and traffic (#4776), fixed brand colour; SMIL from/to need a resolved colour, not var()
export const WORDMARK_VIOLET = "#a78bfa"; // design-tokens-allow: brand route violet in the mark (#4776), fixed brand colour, not the swappable accent

const GLYPH_A =
  "M419.1 18.3Q313.4 18.3 231.9 -16.2Q150.4 -50.7 103.8 -120.3Q57.2 -189.9 57.2 -294.9Q57.2 -384.4 89.3 -444.8Q121.4 -505.2 177.8 -543Q234.3 -580.8 308.6 -600.5Q383 -620.2 466.6 -627.1Q561.5 -635 618.3 -644.7Q675.2 -654.4 700.1 -671.9Q725 -689.4 725 -721V-726.5Q725 -757.9 707 -781.5Q689 -805.1 656.2 -818.4Q623.5 -831.8 577.6 -831.8Q530.4 -831.8 495.2 -817.5Q460 -803.3 439.8 -776.9Q419.6 -750.4 415.6 -714.2H95.9Q104 -828.6 162.8 -910.2Q221.6 -991.8 329.1 -1035.4Q436.6 -1079 589.8 -1079Q704.6 -1079 793.5 -1054.4Q882.4 -1029.8 943.3 -982.3Q1004.2 -934.8 1035.2 -866.6Q1066.2 -798.4 1066.2 -711.3V0H729.5V-148.5H725.5Q694.4 -91.5 651.3 -54.5Q608.2 -17.5 551 0.4Q493.8 18.3 419.1 18.3ZM523.7 -207.4Q581.3 -207.4 627.7 -229Q674.1 -250.5 701 -289.2Q728 -328 728 -380.2V-475.8Q714.2 -469.8 695.3 -464.1Q676.4 -458.4 652.7 -453.1Q629 -447.9 600.9 -442.8Q572.7 -437.7 540.6 -432.5Q494.8 -425.2 459.3 -409.9Q423.8 -394.6 403.5 -370.1Q383.2 -345.6 383.2 -310.7Q383.2 -278.4 401 -255.1Q418.7 -231.8 450.2 -219.6Q481.8 -207.4 523.7 -207.4Z";
const GLYPH_I_STEM = "M95.6 0V-1056H440.4V0Z";

/** The nine letter outlines, H a p i m a t i c, each placed at its advance `x`. */
export const WORDMARK_GLYPHS: ReadonlyArray<{
  readonly x: number;
  readonly d: string;
}> = [
  {
    x: 0, // H
    d: "M96.3 0V-1490H455.7V-911.4H1023.2V-1490H1382.6V0H1023.2V-605.5H455.7V0Z",
  },
  { x: 1455, d: GLYPH_A }, // a
  {
    x: 2593, // p
    d: "M95.6 418V-1056H436.4V-918.2H440.7Q472.4 -971.9 517.2 -1007.5Q562 -1043.1 619.5 -1061.1Q677 -1079 745 -1079Q879.2 -1079 981.1 -1009.3Q1083 -939.5 1140.7 -815.6Q1198.5 -691.8 1198.5 -529.5Q1198.5 -363 1141.9 -238.7Q1085.2 -114.4 983 -45.7Q880.8 23 742 23Q672.5 23 615.3 2.4Q558.1 -18.2 514.7 -58.2Q471.3 -98.2 443.9 -157H440.4V418ZM645.3 -252.3Q709.2 -252.3 754.9 -285.5Q800.6 -318.8 825.4 -380.9Q850.2 -443.1 850.2 -529.5Q850.2 -616.2 825.4 -677.6Q800.6 -739 754.9 -772.2Q709.2 -805.4 645.3 -805.4Q580.8 -805.4 531.2 -771.3Q481.6 -737.1 454 -675.4Q426.4 -613.8 426.4 -529.5Q426.4 -445.5 454 -383.1Q481.6 -320.7 531.2 -286.5Q580.8 -252.3 645.3 -252.3Z",
  },
  { x: 3820, d: GLYPH_I_STEM }, // i
  {
    x: 4332, // m
    d: "M95.6 0V-1056H427.3V-809.6H410.8Q437.3 -901.8 488.2 -961.5Q539 -1021.2 607.1 -1050.1Q675.1 -1079 750.2 -1079Q869.6 -1079 959.9 -1009.7Q1050.2 -940.3 1068.2 -809.6H1038.5Q1056.9 -896.6 1109 -956.6Q1161 -1016.6 1235.5 -1047.8Q1310.1 -1079 1395.1 -1079Q1498.7 -1079 1579.3 -1034Q1659.9 -989 1705.7 -904.7Q1751.6 -820.5 1751.6 -702.6V0H1406.8V-626.6Q1406.8 -710.5 1362.3 -755.2Q1317.7 -799.9 1248 -799.9Q1199.6 -799.9 1163.9 -777.8Q1128.3 -755.6 1108.3 -715.7Q1088.4 -675.8 1088.4 -621.8V0H758.8V-631Q758.8 -708.5 715.8 -754.2Q672.8 -799.9 602.3 -799.9Q556.1 -799.9 519.4 -778Q482.8 -756.2 461.6 -714.9Q440.4 -673.6 440.4 -615.1V0Z",
  },
  { x: 6155, d: GLYPH_A }, // a
  {
    x: 7293, // t
    d: "M761 -1056V-789.9H18.8V-1056ZM199.2 -1344H544V-354.8Q544 -304.4 564.2 -285.3Q584.4 -266.1 641.8 -266.1Q667.8 -266.1 705.7 -266.1Q743.6 -266.1 761 -266.1V0Q734.3 0 679.3 0Q624.4 0 566.5 0Q375.8 0 287.5 -71.7Q199.2 -143.3 199.2 -297.3Z",
  },
  { x: 8072, d: GLYPH_I_STEM }, // i
  {
    x: 8584, // c
    d: "M598.5 24Q435 24 312 -45.4Q188.9 -114.7 120.6 -239.1Q52.2 -363.5 52.2 -527.5Q52.2 -691.8 120.6 -816.4Q188.9 -941 312 -1010.5Q435 -1080 598.5 -1080Q708.2 -1080 800.7 -1047.9Q893.2 -1015.9 961.5 -957.3Q1029.9 -898.6 1070 -818.3Q1110 -738 1115.7 -640.6H784.1Q779.6 -678.4 765.6 -709.1Q751.6 -739.7 728.5 -761.8Q705.4 -783.8 674.2 -795.6Q643 -807.4 604.6 -807.4Q540.5 -807.4 494.9 -773.5Q449.2 -739.6 424.9 -677Q400.6 -614.3 400.6 -527.5Q400.6 -441.7 424.9 -378.9Q449.2 -316.2 495.1 -282.4Q541 -248.6 604.6 -248.6Q643 -248.6 674 -260.5Q704.9 -272.5 727.5 -294.5Q750.2 -316.6 764.2 -348.1Q778.2 -379.6 783.4 -418.5H1115.7Q1113 -321.5 1074.1 -240.8Q1035.2 -160.1 966.4 -100.6Q897.5 -41.1 803.9 -8.6Q710.3 24 598.5 24Z",
  },
];

/** The i-dot outline; drawn at both i advances, over every other layer. */
export const WORDMARK_I_DOT_D =
  "M267.2 -1158.6Q184.3 -1158.6 130.9 -1208Q77.5 -1257.4 77.5 -1333Q77.5 -1408.5 130.9 -1457.3Q184.3 -1506.2 266.8 -1506.2Q350 -1506.2 403.5 -1457.4Q457 -1408.7 457 -1332.5Q457 -1257 403.4 -1207.8Q349.9 -1158.6 267.2 -1158.6Z";
/** The sending node (first i) and the receiving node (second i). */
export const SENDER_DOT_X = 3820;
export const RECEIVER_DOT_X = 8072;

/** The violet route from the sending dot to the receiving dot. */
export const ROUTE_D = "M4087.25 -1522.15 Q6213.25 -1932.4 8339.25 -1522.15";
export const ROUTE_WIDTH = 73.92;
export const ROUTE_OPACITY = 0.6;

/** The two mint ripples spreading from the sending dot. */
export const RIPPLE_CENTER = { cx: 4087.25, cy: -1332.4 } as const;
export const RIPPLE_STROKE_WIDTH = 58.08;
export const RIPPLE_START_R = 246.675;
export const RIPPLE_START_OPACITY = 0.75;
export const RIPPLES = [
  { r: 322.575, opacity: 0.45, begin: 0.8 },
  { r: 467.73375, opacity: 0.2, begin: 0.92 },
] as const;

/**
 * The pulse, three layers (tail, body, head). In the bridge each is a dash
 * travelling along ROUTE_D (path length normalised to 100); in the held T2 frame
 * each is the explicit segment `stillD`, ending just short of the receiver.
 */
export const PULSE_LAYERS = [
  {
    dash: 14,
    width: 137.28,
    opacity: 0.35,
    fromOffset: 14,
    toOffset: -80,
    stillD: "M7493.8 -1652.9Q7790.3 -1618.4 8086.7 -1568.0",
  },
  {
    dash: 7,
    width: 116.16,
    opacity: 0.7,
    fromOffset: 7,
    toOffset: -87,
    stillD: "M7790.8 -1614.3Q7938.8 -1593.1 8086.7 -1568.0",
  },
  {
    dash: 2.5,
    width: 147.84,
    opacity: 1,
    fromOffset: 2.5,
    toOffset: -91.5,
    stillD: "M7981.2 -1585.4Q8033.9 -1577.0 8086.7 -1568.0",
  },
] as const;

/** Begin offsets and durations of the bridge, with the spline easings. */
export const BRIDGE_TIMING = {
  senderDot: { begin: 0, dur: 0.2 },
  route: { begin: 0.2, dur: 0.5, keySplines: "0.3 0 0.5 1" },
  receiverDot: { begin: 0.65, dur: 0.1 },
  ripple: { dur: 0.7, keySplines: "0.2 0.7 0.3 1" },
  pulse: { begin: 0.8, dur: 0.9, keySplines: "0.4 0 0.6 1" },
} as const;

/** The bridge's last animation (the pulse) ends at 0.8 s + 0.9 s. */
export const BRIDGE_DURATION_MS = 1700;
