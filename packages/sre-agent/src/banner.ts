// ANSI-Shadow block art for "SRE AGENT" (generated once with figlet, embedded
// here so there is no runtime dependency). Box-drawing glyphs render in modern
// terminals (Windows Terminal, VS Code, iTerm); color is gated separately so
// redirected output and legacy consoles stay clean.
const ART = String.raw`
███████╗██████╗ ███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝██╔══██╗██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
███████╗██████╔╝█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
╚════██║██╔══██╗██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████║██║  ██║███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝╚═╝  ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝`;

const TAGLINE = "  ServiceNow + Azure DevOps  ·  GitHub Copilot SDK";

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

const paintLines = (block: string, code: string): string =>
  block
    .split("\n")
    .map((line) => (line ? `${code}${line}${RESET}` : line))
    .join("\n");

/** The full banner (art + tagline), colored only when `color` is true. */
export const banner = ({ color }: { color: boolean }): string => {
  if (!color) return `${ART}\n${TAGLINE}\n`;
  return `${paintLines(ART, CYAN)}\n${DIM}${TAGLINE}${RESET}\n`;
};

/** Print the banner once, auto-detecting color unless overridden. */
export const printBanner = (
  write: (s: string) => void = (s) => process.stdout.write(s),
  opts: { color?: boolean } = {}
): void => {
  write(banner({ color: opts.color ?? supportsColor() }));
};
