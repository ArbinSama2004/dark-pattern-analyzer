import type { Config } from "tailwindcss";

// Scoped deliberately: the overlay renders inside a closed shadow root with
// `all: initial` (see docs/ARCHITECTURE.md 4.3 and frontend/README.md), so
// Tailwind's reset never touches the host page.
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
