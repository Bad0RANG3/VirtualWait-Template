import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f7fafc",
          100: "#eef3f7",
          200: "#d9e4ee",
          300: "#b6c7d6",
          400: "#8aa3b8",
          500: "#6a849c",
          600: "#526a80",
          700: "#425566",
          800: "#384857",
          900: "#313e4b",
          950: "#1f2933",
        },
        mint: {
          50: "#effcf7",
          100: "#d8f7eb",
          200: "#b3eed8",
          300: "#7ddfbe",
          400: "#45c89e",
          500: "#22ad84",
          600: "#148b6a",
          700: "#116f57",
          800: "#115846",
          900: "#10483b",
        },
        coral: {
          50: "#fff5f3",
          100: "#ffe8e4",
          200: "#ffd1c9",
          300: "#ffb0a2",
          400: "#ff8470",
          500: "#f85d48",
          600: "#e43d2c",
          700: "#c02f22",
        },
        sun: {
          50: "#fff9eb",
          100: "#ffefc6",
          200: "#ffdd88",
          300: "#ffc857",
          400: "#f0ad2e",
          500: "#d99214",
        },
        sky: {
          50: "#f3f9ff",
          100: "#e6f2ff",
          200: "#cde5ff",
          300: "#a5d0ff",
          400: "#73b3ff",
          500: "#4a93f5",
        },
      },
      boxShadow: {
        panel: "0 10px 30px rgba(31, 41, 51, 0.06)",
        soft: "0 4px 16px rgba(31, 41, 51, 0.05)",
        lift: "0 14px 36px rgba(31, 41, 51, 0.08)",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
