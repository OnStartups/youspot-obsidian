/**
 * The YouSpot mark, for the ribbon and anywhere Obsidian asks for an icon.
 *
 * The path is the delivered artwork from `frontend/public/youspot-icon-v5.svg`
 * verbatim — one path, disc and knocked-out "You"/"Spot" as a single shape.
 * The brand source says not to edit the geometry, so it is scaled into
 * Obsidian's 100x100 icon box with a transform rather than rewritten.
 *
 * currentColor, not the brand orange: a ribbon icon has to sit with the rest
 * of Obsidian's chrome and follow the theme. The knockout letters read as
 * whatever is behind them, which is what makes the mark survive being 18px.
 */

export const ICON_ID = "youspot-mark";

export const ICON_SVG =
  `<g transform="scale(0.491352)">` +
  `<path fill="currentColor" d="M101.76,0C45.56,0,0,45.56,0,101.76s45.56,101.76,101.76,101.76c39.86,0,74.35-22.93,91.04-56.31-2.77.94-5.77,1.43-9.01,1.43-7.55,0-13.44-2.49-17.64-7.49-4.21-4.99-6.32-11.61-6.32-19.86v-43.62h17.45v40.63c0,4.86,1.13,8.53,3.39,11,2.26,2.47,5.42,3.71,9.51,3.71,3.69,0,6.85-1.18,9.49-3.53,2.49-8.82,3.85-18.11,3.85-27.72C203.52,45.56,157.96,0,101.76,0ZM70.71,147.34h-18.1v-39.07L19.01,56.18h21.62l21.1,34.9,20.84-34.9h21.62l-33.47,52.09v39.07ZM149.84,130.87c-3.17,5.51-7.55,9.85-13.15,13.02-5.6,3.17-11.91,4.75-18.95,4.75s-13.37-1.58-19.01-4.75c-5.64-3.17-10.05-7.51-13.22-13.02-3.17-5.51-4.75-11.61-4.75-18.3s1.58-12.91,4.75-18.43c3.17-5.51,7.55-9.85,13.15-13.02,5.6-3.17,11.96-4.75,19.08-4.75s13.35,1.61,18.95,4.82c5.6,3.21,9.98,7.57,13.15,13.09,3.17,5.51,4.75,11.61,4.75,18.3s-1.59,12.78-4.75,18.3ZM127.7,94.6c-2.99-1.82-6.32-2.73-9.96-2.73s-6.97.91-9.96,2.73c-3,1.82-5.36,4.32-7.1,7.49-1.74,3.17-2.6,6.66-2.6,10.48s.87,7.18,2.6,10.35c1.74,3.17,4.1,5.66,7.1,7.49,2.99,1.82,6.32,2.73,9.96,2.73s6.97-.91,9.96-2.73c2.99-1.82,5.34-4.3,7.03-7.42,1.69-3.12,2.54-6.6,2.54-10.42s-.85-7.31-2.54-10.48c-1.69-3.17-4.04-5.66-7.03-7.49Z"/>` +
  `</g>`;
