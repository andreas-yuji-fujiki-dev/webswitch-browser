# Performance

Webswitch is a full web engine (WebKitGTK) with a thin interface, so it is **not magically lighter than other browsers**. Here are measured numbers, with what they do and do not show.

## Comparison (2026-09-24)

One machine (Linux, Intel + NVIDIA hybrid laptop), Webswitch 0.0.1 (WebKitGTK 2.52.6), Firefox 155.0.1, Google Chrome 153, each with a fresh profile, run by [tools/bench/bench.mjs](../tools/bench/bench.mjs), on local pages served from 127.0.0.1.

|                                      | Webswitch                                  | Firefox | Chrome  |
| ------------------------------------ | ------------------------------------------ | ------- | ------- |
| Start until the page's first request | 0.41 s                                     | 0.94 s  | 0.41 s  |
| Start until the page has loaded      | 0.42 s                                     | 1.10 s  | 0.43 s  |
| Memory, 1 tab (PSS)                  | 218-292 MB                                 | 664 MB  | 242 MB  |
| Memory, 5 heavy tabs (PSS)           | 584-660 MB                                 | 973 MB  | 509 MB  |
| Processes, 1 tab / 5 tabs            | 14 / 38                                    | 19 / 24 | 12 / 16 |
| CPU, idle, 1 tab                     | 0.2 %                                      | 34 %    | 0.3 %   |
| CPU, idle, 5 tabs                    | 0.6 %                                      | 26 %    | 0.4 %   |
| JS/DOM suite, total                  | 691 ms                                     | 702 ms  | 674 ms  |
| On disk (browser only)               | ~120 KB + system WebKitGTK (94 MB, shared) | 282 MB  | 435 MB  |

Reading it honestly:

- **Memory is in the same range as Chrome, well below Firefox in this test, and higher with many tabs than Chrome.** Webswitch starts one web process per tab plus helper processes (38 processes for five tabs), where Chrome shares more. Memory is **PSS** (proportional set size): shared libraries are split between the processes that use them, so it is fair to compare, unlike the RSS column that task managers often show. The Webswitch range is two runs of the same test; the spread is real.
- **Startup is as fast as Chrome's** with a warm disk cache. The first start after boot is slower for every browser.
- **Speed is a tie on the JavaScript/DOM suite.** The nine tests (recursion, sorting, regex, JSON, Map/Set, typed arrays, DOM building, reflow, canvas) differ by engine: JavaScriptCore is fastest at recursion and typed arrays, V8 at Map/Set and reflow, SpiderMonkey at sorting and DOM building. It is a small suite and says nothing about real sites; it only says that no engine is slow.
- **Firefox's idle CPU** is high here; I did not investigate why (likely first-run work on a fresh profile), so treat it as a fresh-profile number. Its first-run behavior was reduced with a few preferences so it would not open its welcome pages.
- Not measured: battery, GPU use, video decoding, extensions (Chrome and Firefox load them, Webswitch has none), and real sites with ads and trackers.

## An honest finding

The first version of this table showed Webswitch at 9 % idle CPU with one tab. The cause was in the browser's own UI: the loading bar of the address bar ran its animation forever, hidden or not, so the UI was repainting constantly. The animation now only runs while a page is loading, and idle CPU is 0.2 %. Only measuring found it.

## What we control

- The interface is small: no framework, one HTML page, a few CSS files.
- The UI web view and the ⋮ menu share one web process.
- The browser makes no background requests and runs no background work.
- Nothing animates unless it is visible or in use.

## Repeating the measurement

```sh
node tools/bench/bench.mjs --out results.json           # all three browsers
node tools/bench/bench.mjs --browsers webswitch          # only ours
```

It starts each browser in its own process group with a temporary profile, sums PSS from `/proc/<pid>/smaps_rollup` over every process in that group, and reads CPU time from `/proc/<pid>/stat`. Results move with the machine, the engine version and the desktop: compare browsers within one run, not across machines.
