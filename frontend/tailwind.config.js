/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Functional map/risk colours ──────────────────────────────────
        port: '#D85A30',
        dryport: '#534AB7',
        station: '#1D9E75',
        motorway: '#D85A30',
        trunk: '#EF9F27',
        primary: '#378ADD',
        road_other: '#B4B2A9',
        rail: '#1D9E75',
        intermodal: '#7F77DD',
        route_active: '#534AB7',
        disrupted: '#E24B4A',
        alert_critical: '#E24B4A',
        alert_high: '#EF9F27',
        alert_medium: '#BA7517',
        alert_low: '#3B6D11',
        // ── Landing page geo palette ──────────────────────────────────────
        geo: {
          navy: '#0a0f1c',
          dark: '#070b14',
          cyan: '#00d4ff',
          teal: '#00b8a9',
          orange: '#ff6b35',
          amber: '#f59e0b',
          glass: 'rgba(10, 15, 28, 0.6)',
          glassBorder: 'rgba(0, 212, 255, 0.15)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'gradient-shift': 'gradientShift 20s ease infinite',
        'pulse-glow':     'pulseGlow 3s ease-in-out infinite',
        'float':          'float 6s ease-in-out infinite',
        'scanline':       'scanline 8s linear infinite',
        'grain':          'grain 0.5s steps(10) infinite',
      },
      keyframes: {
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%':      { backgroundPosition: '100% 50%' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%':      { opacity: '0.8', transform: 'scale(1.1)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-20px)' },
        },
        scanline: {
          '0%':   { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        grain: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '10%': { transform: 'translate(-5%, -10%)' },
          '20%': { transform: 'translate(-15%, 5%)' },
          '30%': { transform: 'translate(7%, -25%)' },
          '40%': { transform: 'translate(-5%, 25%)' },
          '50%': { transform: 'translate(-15%, 10%)' },
          '60%': { transform: 'translate(15%, 0%)' },
          '70%': { transform: 'translate(0%, 15%)' },
          '80%': { transform: 'translate(3%, 35%)' },
          '90%': { transform: 'translate(-10%, 10%)' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'mesh-gradient':   'linear-gradient(135deg, #0a0f1c 0%, #0d1b2a 25%, #0a1628 50%, #0d1b2a 75%, #0a0f1c 100%)',
      },
    },
  },
  plugins: [],
}
