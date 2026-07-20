/** @type {import('tailwindcss').Config} */
// Arena-inspired indigo + gold palette.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Arena-style deep indigo / blue-slate table (name kept for call sites).
        felt: {
          950: "#141332",
          900: "#1b1a42",
          850: "#211f4e",
          800: "#29285e",
          700: "#363677",
          600: "#474696",
        },
        // Warm Arena gold.
        brass: {
          300: "#ffd784",
          400: "#f2b64b",
          500: "#cf9032",
        },
      },
      boxShadow: {
        card: "0 2px 6px rgba(8,6,30,0.55), 0 8px 24px rgba(8,6,30,0.35)",
        "card-lg": "0 4px 12px rgba(8,6,30,0.6), 0 16px 48px rgba(8,6,30,0.45)",
        glow: "0 0 0 2px rgba(251,191,36,0.8), 0 0 20px rgba(251,191,36,0.4)",
        "glow-soft": "0 0 0 1px rgba(251,191,36,0.4), 0 6px 18px rgba(8,6,30,0.5), 0 0 16px rgba(251,191,36,0.22)",
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
        trophy: {
          "0%, 100%": { transform: "translateY(0) rotate(-2deg)" },
          "50%": { transform: "translateY(-7px) rotate(2deg)" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-in": "slide-in 200ms ease-out",
        "pop-in": "pop-in 150ms ease-out",
        trophy: "trophy 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
