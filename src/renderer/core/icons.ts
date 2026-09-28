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
  code: 'M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5M9 3l-2 10',
  chrome:
    'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM9.73 7l3.03-1.75M6.27 7L3.24 5.25M8 10v3.5',
  firefox:
    'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.8 9a2.6 2.6 0 0 0 4.9.9M5.8 9c0-1.6 1.1-2.8 2.7-2.9M10.9 6.5c.4.6.4 1.4.2 2',
  opera:
    'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 4.5c-1.3 0-2.2 1.6-2.2 3.5S6.7 11.5 8 11.5 10.2 9.9 10.2 8 9.3 4.5 8 4.5Z',
  edge: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.4 8.4h5.2c0-1.5-1-2.4-2.6-2.4S5.4 7 5.4 8.6s1 2.4 2.7 2.4c.9 0 1.6-.3 2.1-.8',
  safari: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM10.8 5.2L9 9l-3.8 1.8L7 7Z',
  gear: 'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM6.7 2h2.6l.4 1.6 1.2.7 1.6-.5 1.3 2.2-1.2 1.2v1.6l1.2 1.2-1.3 2.2-1.6-.5-1.2.7-.4 1.6H6.7l-.4-1.6-1.2-.7-1.6.5-1.3-2.2L3.4 9V7.4L2.2 6.2l1.3-2.2 1.6.5 1.2-.7Z',
  palette:
    'M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.25-.6 1-1.3-.3-.8.1-1.7 1-1.7h1.2a2.3 2.3 0 0 0 2.3-2.3C13.5 4.9 11.1 2.5 8 2.5ZM5 8h.01M6.5 5.5h.01M9.5 5.5h.01',
  toggle:
    'M5 4.5h6a3.5 3.5 0 0 1 0 7H5a3.5 3.5 0 0 1 0-7ZM11 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z',
  settings:
    'M2.5 4.5h2M7.5 4.5h6M2.5 11.5h6M11.5 11.5h2M6 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3ZM10 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3Z',
  puzzle: 'M2.5 5h3a1.6 1.6 0 1 1 3.2 0H11v3.3a1.6 1.6 0 1 1 0 3.2V14H2.5Z',
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
