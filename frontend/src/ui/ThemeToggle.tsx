import { THEMES, type Theme } from "../lib/settings";

const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Three-way appearance control, shared by the popup and the side panel.
 *
 * A segmented control rather than a light/dark switch, because "system" is a
 * real third state and not the absence of a choice -- a two-position switch
 * has nowhere to show that the panel is currently following the OS, and
 * flipping it once would silently opt the user out of that forever.
 */
export function ThemeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Appearance"
        className="inline-flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden"
      >
        {THEMES.map((theme) => {
          const selected = value === theme;
          return (
            <button
              key={theme}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(theme)}
              className={[
                "px-2 py-1 text-xs border-r last:border-r-0 border-gray-300 dark:border-gray-600",
                "disabled:opacity-50",
                selected
                  ? "bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700",
              ].join(" ")}
            >
              {LABELS[theme]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
