// ANSI-Shadow block art for "ING SRE AGENT" (generated once with figlet and
// embedded — no runtime dependency). Two layouts: a wide single-line wordmark
// for roomy terminals, and a stacked "ING" / "SRE AGENT" for narrow ones (and
// for non-TTY/piped output, which defaults to the narrow width). Box-drawing
// glyphs render in modern terminals; color is gated separately by supportsColor.
const WIDE_ART = `
██╗███╗   ██╗ ██████╗     ███████╗██████╗ ███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██║████╗  ██║██╔════╝     ██╔════╝██╔══██╗██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██║██╔██╗ ██║██║  ███╗    ███████╗██████╔╝█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██║██║╚██╗██║██║   ██║    ╚════██║██╔══██╗██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
██║██║ ╚████║╚██████╔╝    ███████║██║  ██║███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚═╝╚═╝  ╚═══╝ ╚═════╝     ╚══════╝╚═╝  ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝`;

const STACKED_ART = `
██╗███╗   ██╗ ██████╗
██║████╗  ██║██╔════╝
██║██╔██╗ ██║██║  ███╗
██║██║╚██╗██║██║   ██║
██║██║ ╚████║╚██████╔╝
╚═╝╚═╝  ╚═══╝ ╚═════╝

███████╗██████╗ ███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝██╔══██╗██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
███████╗██████╔╝█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
╚════██║██╔══██╗██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████║██║  ██║███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝╚═╝  ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝`;

const TAGLINE = "  ServiceNow + Azure DevOps  ·  GitHub Copilot SDK";

/** The wide wordmark needs this many columns; below it we stack. */
const WIDE_MIN_COLUMNS = 98;

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Whether to emit ANSI color. Off when NO_COLOR is set (any value, per
 * no-color.org), for a `dumb` terminal, or when stdout is not a TTY (piped or
 * redirected) — so banners never inject escape codes into logs or files.
 */
export const supportsColor = (
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY
): boolean => {
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(isTTY);
};

/** Pick the wide wordmark only when the terminal is wide enough; else stack. */
export const chooseLayout = (columns: number): "wide" | "stacked" =>
  columns >= WIDE_MIN_COLUMNS ? "wide" : "stacked";

const paintLines = (block: string, code: string): string =>
  block
    .split("\n")
    .map((line) => (line ? `${code}${line}${RESET}` : line))
    .join("\n");

/** The full banner (art + tagline), adapting to width and coloring per `color`. */
export const banner = ({
  color,
  columns = process.stdout.columns ?? 80
}: {
  color: boolean;
  columns?: number;
}): string => {
  const art = chooseLayout(columns) === "wide" ? WIDE_ART : STACKED_ART;
  if (!color) return `${art}\n${TAGLINE}\n`;
  return `${paintLines(art, CYAN)}\n${DIM}${TAGLINE}${RESET}\n`;
};

/** Print the banner once, auto-detecting color and terminal width. */
export const printBanner = (
  write: (s: string) => void = (s) => process.stdout.write(s),
  opts: { color?: boolean; columns?: number } = {}
): void => {
  write(banner({ color: opts.color ?? supportsColor(), columns: opts.columns }));
};
