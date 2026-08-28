import type { Config } from "tailwindcss";

// BELLO独自デザイントークン。ZAICOの配色・アイコン・ロゴ等の資産は使用せず、
// BELLOブランド用に独自に定義する。
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bello: {
          // BELLO ブランドカラー(独自定義): ディープネイビー + テラコッタのアクセント
          50: "#f4f6fb",
          100: "#e6eaf5",
          200: "#c7d1e8",
          300: "#9fb0d6",
          400: "#6f87bd",
          500: "#4a63a0",
          600: "#374c80",
          700: "#2b3c66",
          800: "#1f2c4d",
          900: "#141d33",
        },
        accent: {
          50: "#fdf3ef",
          100: "#fbe3d8",
          200: "#f5c1a8",
          300: "#ee9e78",
          400: "#e57c4c",
          500: "#d15f2e",
          600: "#ab4a22",
          700: "#82381a",
          800: "#592712",
          900: "#33150a",
        },
        danger: {
          500: "#d92d3a",
          600: "#b31f2b",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f6f7fb",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Hiragino Sans"',
          '"Hiragino Kaku Gothic ProN"',
          '"Noto Sans JP"',
          "Meiryo",
          "sans-serif",
        ],
      },
      borderRadius: {
        bello: "20px",
      },
      spacing: {
        "safe-top": "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
      },
      boxShadow: {
        card: "0 2px 10px 0 rgba(20, 29, 51, 0.08)",
        floating: "0 8px 24px 0 rgba(20, 29, 51, 0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
