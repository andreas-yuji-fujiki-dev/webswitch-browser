const SVG_NS = 'http://www.w3.org/2000/svg';

// 16x16 line icons drawn with `currentColor`, so they follow the theme and user.css.
const PATHS = {
  back: 'M13 8H3M7.5 3.5L3 8l4.5 4.5',
  forward: 'M3 8h10M8.5 3.5L13 8l-4.5 4.5',
  reload: 'M13 8a5 5 0 1 1-1.46-3.54M12.6 1.8v3.4H9.2',
  stop: 'M4 4l8 8M12 4l-8 8',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  plus: 'M8 3v10M3 8h10',
  user: 'M8 7.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.75 13.75c.55-2.4 2.65-3.75 5.25-3.75s4.7 1.35 5.25 3.75',
  switch: 'M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13',
  download: 'M8 2.5v7M4.75 6.75L8 10l3.25-3.25M3 13h10',
  history: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3.25l2.25 1.5',
  keyboard: 'M2 4.5h12v7H2ZM4.5 7h.01M7.5 7h.01M10.5 7h.01M5 9.5h6',
};

// Three filled dots instead of strokes.
const DOTS = [3.5, 8, 12.5];

export function icon(name: keyof typeof PATHS | 'more'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  if (name === 'more') {
    svg.classList.add('icon--filled');
    for (const cy of DOTS) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', '8');
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', '1.25');
      svg.append(dot);
    }
    return svg;
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}
