export const ACCEPTED_EXTS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt"];

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const validateFile = (
  file: { name: string; size: number },
  maxBytes: number
): { ok: true } | { ok: false; reason: string } => {
  const ext = extOf(file.name);
  if (!ACCEPTED_EXTS.includes(ext)) return { ok: false, reason: `unsupported format: .${ext}` };
  if (file.size > maxBytes)
    return { ok: false, reason: `exceeds ${Math.round(maxBytes / 1048576)} MB limit` };
  return { ok: true };
};
