/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Quicksand', '"M PLUS Rounded 1c"', 'system-ui', 'sans-serif'],
      },
      colors: {
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          light: 'rgb(var(--color-primary-light) / <alpha-value>)',
          dark: 'rgb(var(--color-primary-dark) / <alpha-value>)',
        },
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        text: {
          DEFAULT: 'rgb(var(--color-text) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        },
        border: 'rgb(var(--color-border) / <alpha-value>)',
      },
      boxShadow: {
        // テーマ primary 色ベースのやわらかいグロー
        glow: '0 8px 24px -6px rgb(var(--color-primary) / 0.35)',
        'glow-sm': '0 4px 14px -4px rgb(var(--color-primary) / 0.30)',
        'glow-lg': '0 16px 40px -8px rgb(var(--color-primary) / 0.40)',
      },
      keyframes: {
        // ふわっと上下に浮く (マスコットのアイドル等)
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        // ポヨンと弾む
        pop: {
          '0%': { transform: 'scale(1)' },
          '40%': { transform: 'scale(1.08)' },
          '70%': { transform: 'scale(0.96)' },
          '100%': { transform: 'scale(1)' },
        },
        // 軽い揺れ
        wiggle: {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '25%': { transform: 'rotate(-4deg)' },
          '75%': { transform: 'rotate(4deg)' },
        },
        // talking 中の口パク感 (上下に小さく弾む)
        bobble: {
          '0%, 100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-3px) scale(1.02)' },
        },
      },
      animation: {
        float: 'float 3.2s ease-in-out infinite',
        pop: 'pop 0.4s ease-out',
        wiggle: 'wiggle 0.5s ease-in-out',
        bobble: 'bobble 0.9s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
