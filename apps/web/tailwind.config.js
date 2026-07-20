/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          950: "#060a09",
          900: "#0a1210",
          850: "#0d1815",
          800: "#12201c",
          700: "#1a2e28",
          600: "#234139",
        },
        brass: {
          300: "#e8c979",
          400: "#d4af5f",
          500: "#b8923f",
        },
      },
      boxShadow: {
        card: "0 2px 6px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)",
        "card-lg": "0 4px 12px rgba(0,0,0,0.6), 0 16px 48px rgba(0,0,0,0.45)",
        glow: "0 0 0 2px rgba(52,211,153,0.65), 0 0 18px rgba(52,211,153,0.35)",
        "glow-red": "0 0 0 2px rgba(248,113,113,0.7), 0 0 18px rgba(248,113,113,0.35)",
        "glow-blue": "0 0 0 2px rgba(96,165,250,0.7), 0 0 18px rgba(96,165,250,0.35)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-in": "slide-in 200ms ease-out",
        "pop-in": "pop-in 150ms ease-out",
      },
    },
  },
  plugins: [],
};
