/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0f4ff',
          100: '#dce6ff',
          500: '#4f6ef7',
          600: '#3b5de8',
          700: '#2d4dd4',
          900: '#1a2d8f',
        },
      },
    },
  },
  plugins: [],
};
