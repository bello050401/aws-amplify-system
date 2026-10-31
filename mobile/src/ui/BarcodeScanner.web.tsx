import React, { useEffect, useState, type ComponentType } from "react";
import type { ScannerProps } from "./BarcodeScanner";
import { ScannerLayout } from "./ScannerLayout";

/** Download the decoder only when scanning, not on every home/search visit. */
export function BarcodeScanner(props: ScannerProps) {
  const [Camera, setCamera] = useState<ComponentType<ScannerProps> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void import("./BarcodeScannerCamera.web").then(module => {
      // Closing while downloading must never start the camera afterwards.
      if (active) setCamera(() => module.BarcodeScannerCamera);
    }).catch(() => {
      if (active) setError("読み取り機能を読み込めませんでした。通信を確認して、もう一度開いてください。");
    });
    return () => { active = false; };
  }, []);
  return Camera ? <Camera {...props} /> : <ScannerLayout onClose={props.onClose} error={error} loading={!error} />;
}
