/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#050505',
        foreground: '#f8f1eb',
        primary: {
          DEFAULT: '#f15a24',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT: '#1f1b18',
          foreground: '#f8f1eb',
        },
        muted: {
          DEFAULT: '#1f1b18',
          foreground: '#a8a29e',
        },
        accent: {
          DEFAULT: '#f15a24',
          foreground: '#ffffff',
        },
        brand: {
          orange: '#f15a24',
          'orange-light': '#ff7a30',
          'orange-dark': '#d14a1a',
        },
      },
    },
  },
  plugins: [],
};
