/** Downloads a text file in the browser. Returns true when the download was triggered. */
export async function saveTextFile(filename: string, content: string, mime = 'application/gpx+xml'): Promise<boolean> {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
