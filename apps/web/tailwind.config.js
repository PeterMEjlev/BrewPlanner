/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Only apply `hover:` styles on devices that actually support hover. On a
  // touchscreen a tap would otherwise leave the "hover" highlight stuck on a
  // button until you tapped elsewhere (e.g. the Kegs page Select button).
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
