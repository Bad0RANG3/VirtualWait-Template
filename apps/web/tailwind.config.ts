import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7f8",
          100: "#eceef1",
          200: "#d8dce2",
          300: "#b5bdc8",
          400: "#8b96a5",
          500: "#6b7685",
          600: "#545e6b",
          700: "#444c57",
          800: "#3a414a",
          900: "#333941",
          950: "#1a1d21",
        },
        mint: {
          50: "#eefbf5",
          100: "#d6f5e7",
          200: "#b0eacf",
          300: "#7ad9b1",
          400: "#42c08f",
          500: "#1eaa76",
          600: "#0f9f75",
          700: "#0c7d5d",
          800: "#0f634b",
          900: "#0e513f",
        },
        coral: {
          50: "#fef4f2",
          100: "#fde6e2",
          200: "#fbcfc7",
          300: "#f7a99c",
          400: "#ef7663",
          500: "#e24b3b",
          600: "#c93728",
          700: "#a72d22",
        },
        sun: {
          50: "#fff8eb",
          100: "#ffefc7",
          200: "#ffdc88",
          300: "#ffc44a",
          400: "#f0a820",
          500: "#d9890f",
        },
        sky: {
          50: "#f2f7ff",
          100: "#e4efff",
          200: "#c9ddff",
          300: "#9fc1ff",
          400: "#6a9cf5",
          500: "#3f7ae0",
        },
      },
      boxShadow: {
        panel: "none",
        soft: "none",
        lift: "none",
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
