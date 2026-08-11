import type { Config } from "tailwindcss";

// Scoped deliberately: the overlay renders inside a closed shadow root with
// `all: initial` (see docs/ARCHITECTURE.md 4.3 and frontend/README.md), so
// Tailwind's reset never touches the host page.
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  // Class, not media: the theme is a stored preference with an explicit
  // "system" option (lib/theme.ts resolves it), so the OS query is consulted
  // once and turned into a class rather than driving the CSS directly.
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
