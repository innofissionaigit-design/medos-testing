import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: { colors: { brand: { 50: "#eef6ff", 100: "#d9eaff", 500: "#2563eb", 600: "#1d4ed8", 700: "#1e40af" } } } },
  plugins: [],
} satisfies Config;
