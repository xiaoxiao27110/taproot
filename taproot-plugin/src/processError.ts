export function summarizeProcessError(error: unknown, maxLength = 400): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = [...lines]
    .reverse()
    .find((line) => !line.startsWith('File "') && !line.startsWith('Traceback '));
  const summary = actionable || lines[0] || message;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}...` : summary;
}
