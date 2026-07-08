/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pizarra: {
          50: '#F8FAFC',
          100: '#F1F5F9',
          200: '#E2E8F0',
          300: '#CBD5E1',
          400: '#94A3B8',
          500: '#64748B',
          600: '#475569',
          700: '#334155',
          800: '#1E293B',
          900: '#0F172A',
        },
        indigo: {
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
        },
        borgona: {
          50: '#FBF3F5',
          100: '#F5E1E6',
          600: '#8E2C48',
          700: '#75203A',
        },
        hilo: '#F6F5F2',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        sastre: '0 1px 2px rgba(15,23,42,0.05), 0 8px 24px -12px rgba(30,41,59,0.18)',
        'sastre-lg': '0 2px 4px rgba(15,23,42,0.04), 0 20px 44px -16px rgba(30,41,59,0.22)',
      },
      transitionDuration: { DEFAULT: '150ms' },
    },
  },
  plugins: [],
};
