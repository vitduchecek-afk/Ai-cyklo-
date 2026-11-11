import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Writes the file to the cache directory and opens the share sheet. Returns false when sharing is unavailable. */
export async function saveTextFile(filename: string, content: string, mime = 'application/gpx+xml'): Promise<boolean> {
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(content);
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: filename });
  return true;
}
