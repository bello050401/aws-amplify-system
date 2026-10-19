import { BrowserMultiFormatOneDReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Inventory labels are linear barcodes. Do not spend each unsuccessful frame
// searching for QR, Data Matrix, PDF417 or Aztec symbols.
export const INVENTORY_BARCODE_FORMATS = [
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.CODABAR,
];
export const BARCODE_SCAN_INTERVAL_MS = 80;

export function createInventoryBarcodeReader() {
  return new BrowserMultiFormatOneDReader(
    new Map([[DecodeHintType.POSSIBLE_FORMATS, INVENTORY_BARCODE_FORMATS]]),
    { delayBetweenScanAttempts: BARCODE_SCAN_INTERVAL_MS, delayBetweenScanSuccess: BARCODE_SCAN_INTERVAL_MS },
  );
}

export async function focusBarcodeCamera(track: MediaStreamTrack): Promise<void> {
  const capabilities = track.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
  if (!capabilities?.focusMode?.includes('continuous')) return;
  // Optional on Safari. Unsupported focus controls must never block decoding.
  const focus = { focusMode: 'continuous' } as MediaTrackConstraintSet;
  await track.applyConstraints({ advanced: [focus] }).catch(() => undefined);
}
