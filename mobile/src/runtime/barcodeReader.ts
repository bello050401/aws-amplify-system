import { BrowserMultiFormatOneDReader,HTMLCanvasElementLuminanceSource } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, Result } from '@zxing/library';
import {decodeWornEanLabel} from './wornBarcode';

// Inventory labels are linear barcodes. Do not spend each unsuccessful frame
// searching for QR, Data Matrix, PDF417 or Aztec symbols.
export const INVENTORY_BARCODE_FORMATS = [
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.CODABAR,
];
export const BARCODE_SCAN_INTERVAL_MS = 80;

class InventoryBarcodeReader extends BrowserMultiFormatOneDReader {
  private lastExtraPass=0;
  override decodeFromCanvas(canvas:HTMLCanvasElement):Result {
    try{return super.decodeFromCanvas(canvas);}catch(error){
      // Keep the normal 80 ms fast path. Run the worn-label pass at most twice/sec.
      const now=Date.now();if(now-this.lastExtraPass<500)throw error;
      this.lastExtraPass=now;
      return decodeWornEanLabel(new HTMLCanvasElementLuminanceSource(canvas));
    }
  }
}
export function createInventoryBarcodeReader() {
  return new InventoryBarcodeReader(
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
