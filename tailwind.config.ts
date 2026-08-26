import type { Config } from "tailwindcss";

// Design direction (per product spec): lookbook aesthetic in the vein of
// Vitra / HAY / Artek / Cassina / Fritz Hansen / Herman Miller — white
// ground, large photography, generous whitespace, restrained thin type.
// This is intentionally brand-agnostic: it is the shell every generated
// feature page renders inside, not a single product's identity.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#141312",
        paper: "#ffffff",
        stone: "#f4f3f1",
        line: "#e4e2de",
        muted: "#6f6b64",
        sold: "#b7b2a9",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        body: ["var(--font-body)", "Helvetica Neue", "Arial", "sans-serif"],
      },
      letterSpacing: {
        label: "0.16em",
      },
      maxWidth: {
        content: "1440px",
      },
    },
  },
  plugins: [],
};

export default config;
