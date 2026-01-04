import { SUPPORTED_FILE_EXTENSIONS } from "../constants/fileTypes";

export function getDisplayTitle(title: string): string {
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  const matchedExt = SUPPORTED_FILE_EXTENSIONS.find((ext) =>
    lower.endsWith(ext),
  );
  if (!matchedExt) return trimmed;
  return trimmed.slice(0, trimmed.length - matchedExt.length);
}

