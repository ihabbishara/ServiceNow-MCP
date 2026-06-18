import { LION_ART } from "./banner-lion.js";

// ANSI-Shadow block letters for the "ING SRE AGENT" headline (generated once
// with figlet, embedded — no runtime dependency). ING renders ING orange, SRE
// AGENT cyan; a compact lion sits centered above. Color is gated by supportsColor.
const ING_ART = `
██╗███╗   ██╗ ██████╗
██║████╗  ██║██╔════╝
██║██╔██╗ ██║██║  ███╗
██║██║╚██╗██║██║   ██║
██║██║ ╚████║╚██████╔╝
╚═╝╚═╝  ╚═══╝ ╚═════╝
`;

const SRE_ART = `
███████╗██████╗ ███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝██╔══██╗██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
███████╗██████╔╝█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
╚════██║██╔══██╗██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████║██║  ██║███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝╚═╝  ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
`;

const HEADLINE_WIDTH = 72;
const TAGLINE = "  ServiceNow + Azure DevOps  ·  GitHub Copilot SDK";

const ORANGE = "\x1b[38;2;255;98;0m"; // ING brand orange (#FF6200)
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

const paintBlock = (block: string, code: string): string =>
  block
    .split("\n")
    .map((line) => (line ? `${code}${line}${RESET}` : line))
    .join("\n");

/** Left-pad every line so the block is centered within `width` columns. */
const centerBlock = (block: string, width: number): string => {
  const lines = block.split("\n");
  const blockW = Math.max(...lines.map((l) => [...l].length));
  const pad = " ".repeat(Math.max(0, Math.floor((width - blockW) / 2)));
  return lines.map((l) => (l ? pad + l : l)).join("\n");
};

/**
 * The startup banner: a compact ING lion centered above the big "ING SRE AGENT"
 * wordmark (ING orange, SRE AGENT cyan), then the tagline. The lion shows only
 * with color and enough width; piped/redirected output, NO_COLOR, and dumb
 * terminals get the plain text wordmark — no escape codes, no half-block art.
 */
export const banner = ({
  color,
  columns = process.stdout.columns ?? 80
}: {
  color: boolean;
  columns?: number;
}): string => {
  const wordmark = color
    ? `${paintBlock(ING_ART, ORANGE)}\n${paintBlock(SRE_ART, CYAN)}`
    : `${ING_ART}\n${SRE_ART}`;
  const tagline = color ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;

  if (color && columns >= HEADLINE_WIDTH) {
    const lion = paintBlock(centerBlock(LION_ART, HEADLINE_WIDTH), ORANGE);
    return `\n${lion}\n\n${wordmark}\n\n${tagline}\n`;
  }
  return `\n${wordmark}\n\n${tagline}\n`;
};

/** Print the banner once, auto-detecting color and terminal width. */
export const printBanner = (
  write: (s: string) => void = (s) => process.stdout.write(s),
  opts: { color?: boolean; columns?: number } = {}
): void => {
  write(banner({ color: opts.color ?? supportsColor(), columns: opts.columns }));
};
