/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Primary accent
        accent:      '#2F6FED',
        'accent-dk': '#1F5FD5',
        'accent-lt': '#EAF2FF',

        // Neutrals
        charcoal: '#13264B',
        'gray-muted': '#64748B',

        // Surface
        'bg-base':    '#F7F9FC',
        'bg-surface': '#FFFFFF',
        'bg-hover':   '#F1F5FB',

        // Borders
        border:       '#E3EAF3',
        'border-dim': '#EDF1F6',
      },
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card:  '0 1px 3px rgba(0,0,0,0.05)',
        'card-md': '0 2px 8px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
}
