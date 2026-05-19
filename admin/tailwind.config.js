/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:     { 0: 'var(--bg-0)', 1: 'var(--bg-1)', 2: 'var(--bg-2)' },
        fg:     { 0: 'var(--fg-0)', 1: 'var(--fg-1)', 2: 'var(--fg-2)' },
        line:   'var(--line)',
        accent: { DEFAULT: 'var(--accent)', fg: 'var(--accent-fg)' },
        danger: 'var(--danger)',
        warn:   'var(--warn)',
        ok:     'var(--ok)',
        brand: {
          50:  '#f0f4ff',
          100: '#dce6ff',
          500: '#4f6ef7',
          600: '#3b5de8',
          700: '#2d4dd4',
          900: '#1a2d8f',
        },
      },
      boxShadow: {
        'd-1': 'var(--d-1)',
        'd-2': 'var(--d-2)',
        'd-3': 'var(--d-3)',
      },
      borderRadius: {
        '1': 'var(--r-1)', '2': 'var(--r-2)', '3': 'var(--r-3)', '4': 'var(--r-4)',
      },
      transitionTimingFunction: {
        'sharp': 'cubic-bezier(.2,.8,.2,1)',
      },
      fontFamily: {
        sans: ['Inter Tight', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
