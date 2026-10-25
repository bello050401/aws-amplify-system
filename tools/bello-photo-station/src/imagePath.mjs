import path from 'node:path';

// Node's filesystem accepts long Windows paths, while libvips needs the
// extended-length form explicitly. Keep this conversion at image I/O only:
// manifests and the UI continue to contain ordinary, readable paths.
export function imagePath(file) {
  return process.platform === 'win32' ? path.toNamespacedPath(file) : file;
}
